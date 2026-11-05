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

// Only Auth reads and table SELECTs are exposed; no order, claim, approval, cancellation or refund port.
export function reviewReadPort(admin: SupabaseClient): ReviewReadPort {
  return {
    async authenticatedUid(token) {
      const { data, error } = await admin.auth.getUser(token);
      return !error && data.user?.id === REVIEW_UID && data.user.email?.toLowerCase() === REVIEW_EMAIL && data.user.email_confirmed_at ? REVIEW_UID : null;
    },
    async target(uid, productId) {
      if (uid !== REVIEW_UID) return null;
      const { data: auth, error: ae } = await admin.auth.admin.getUserById(uid);
      if (ae || auth.user?.email?.toLowerCase() !== REVIEW_EMAIL || !auth.user.email_confirmed_at) return null;
      const [{ data: account, error: ue }, { data: center, error: ce }, { data: product, error: pe }] = await Promise.all([
        admin.from("accounts").select("nicepay_review_access,is_member,deactivated_at,merged_into").eq("auth_id", uid).maybeSingle(),
        admin.from("centers").select("is_nicepay_review,is_internal,status").eq("id", REVIEW_CENTER).maybeSingle(),
        admin.from("products").select("id,center_id,name,price,is_active,is_on_sale").eq("id", productId).maybeSingle(),
      ]);
      if (ue || ce || pe || !account || !center || !product) return null;
      if (account.nicepay_review_access !== true || account.is_member !== true || account.deactivated_at || account.merged_into) return null;
      if (center.is_nicepay_review !== true || center.is_internal !== false || center.status !== "approved") return null;
      if (product.id !== productId || product.center_id !== REVIEW_CENTER || product.is_active !== true || product.is_on_sale !== true) return null;
      const amount = Number(product.price);
      if (!Number.isSafeInteger(amount) || amount <= 0 || typeof product.name !== "string") return null;
      return { productId, name: product.name, amount };
    },
  };
}
