import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { REVIEW_CENTER, REVIEW_EMAIL, REVIEW_UID, type ReviewReadPort } from "./reviewWindow";

// Keep this route's dependency graph separate from the real-payment runtime and its approval APIs.
export function reviewAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
}
export function reviewBearer(request: Request): string | null {
  return /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1].trim() || null;
}

const KST_TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

/* 대상 판정(호출마다 재확인): 지정 계정·심사 권한·활성 상품 + 다음 중 하나.
   (a) 기존 심사 센터(REVIEW_CENTER, is_nicepay_review·approved·비내부)의 상품  (b) 심사관에게 허용된 실제 센터의 상품 — nicepay_review_center_grants 행이 있고(조회 전용이어도 됨),
   센터가 approved·비내부·비심사 센터이며, 상품이 활성·판매 중이고 고정 만료일이 지나지 않았을 때. 허용 테이블이 아직 없으면(SQL 적용 전) (b)는 거부된다. */
async function readTarget(admin: SupabaseClient, uid: string, productId: string) {
  const { data: auth, error: ae } = await admin.auth.admin.getUserById(uid);
  if (ae || auth.user?.email?.toLowerCase() !== REVIEW_EMAIL || !auth.user.email_confirmed_at) return null;
  const [{ data: account, error: ue }, { data: center, error: ce }, { data: product, error: pe }] = await Promise.all([
    admin.from("accounts").select("id,nicepay_review_access,is_member,deactivated_at,merged_into").eq("auth_id", uid).maybeSingle(),
    admin.from("centers").select("is_nicepay_review,is_internal,status").eq("id", REVIEW_CENTER).maybeSingle(),
    admin.from("products").select("id,center_id,name,price,is_active,is_on_sale,expiry_mode,expiry_date").eq("id", productId).maybeSingle(),
  ]);
  if (ue || ce || pe || !account || !center || !product) return null;
  if (account.nicepay_review_access !== true || account.is_member !== true || account.deactivated_at || account.merged_into) return null;
  if (product.id !== productId || product.is_active !== true || product.is_on_sale !== true) return null;
  const amount = Number(product.price);
  if (!Number.isSafeInteger(amount) || amount <= 0 || typeof product.name !== "string") return null;
  if (product.center_id === REVIEW_CENTER) {
    if (center.is_nicepay_review !== true || center.is_internal !== false || center.status !== "approved") return null;
    return { productId, name: product.name, amount };
  }
  // (b) 허용된 실제 센터
  if (typeof product.center_id !== "string") return null;
  if (product.expiry_mode === "date" && typeof product.expiry_date === "string" && product.expiry_date < KST_TODAY()) return null;
  const { data: real, error: re } = await admin.from("centers").select("is_nicepay_review,is_internal,status").eq("id", product.center_id).maybeSingle();
  if (re || !real || real.is_nicepay_review !== false || real.is_internal !== false || real.status !== "approved") return null;
  const { data: grant, error: ge } = await admin.from("nicepay_review_center_grants").select("center_id").eq("account_id", account.id).eq("center_id", product.center_id).maybeSingle();
  if (ge || !grant || grant.center_id !== product.center_id) return null;
  return { productId, name: product.name, amount, centerId: product.center_id };
}

// Only Auth reads and table SELECTs are exposed; no order, claim, approval, cancellation or refund port.
export function reviewReadPort(admin: SupabaseClient): ReviewReadPort {
  return {
    async authenticatedUid(token) {
      const { data, error } = await admin.auth.getUser(token);
      return !error && data.user?.id === REVIEW_UID && data.user.email?.toLowerCase() === REVIEW_EMAIL && data.user.email_confirmed_at ? REVIEW_UID : null;
    },
    async target(uid, productId) {
      if (uid !== REVIEW_UID) return null;
      try { return await readTarget(admin, uid, productId); } catch { return null; }   // 읽기 오류·테이블 없음 등은 모두 거부(fail-closed)
    },
  };
}
