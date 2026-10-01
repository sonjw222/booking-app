/*
  라우트가 쓰는 실제 의존성(service_role Supabase + 토스). 시크릿/서비스 롤 키는 서버 환경변수에서만 읽고 어디에도 기록하지 않는다.
  service_role은 RLS를 우회하는 용도이며, 호출 전에 Bearer 토큰 검증 + pg_*_context(본인 소유 확인)가 항상 먼저 수행된다(lifecycle.ts).
*/
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { tossCancelPayment, tossConfirmPayment, tossGetPayment } from "./toss";
import type { LifecycleDeps } from "./lifecycle";

const NO_SECRET = { ok: false as const, status: 500, code: "NO_SECRET", message: "결제 서버 설정이 없어요(TOSS_SECRET_KEY)" };

export function bearerToken(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export function createAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function buildDeps(admin: SupabaseClient, tossSecretKey: string): LifecycleDeps {
  return {
    async getAuthUid(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data?.user ? null : data.user.id;
    },
    async orderContext(orderId, uid) {
      const { data, error } = await admin.rpc("pg_order_context", { p_order_id: orderId, p_auth_uid: uid });
      if (error) throw new Error(error.message);
      return data ?? null;
    },
    // PG 게이트(2026-10-01): NEXT_PUBLIC_PG_CHECKOUT_ENABLED가 정확히 "true"가 아니면 일반 주문은 온라인 결제 승인을 거치지 않는다.
    // 예외는 심사관 전용 계정(accounts.pg_checkout_override)이 만든 주문뿐. 토스 호출보다 먼저 판정한다.
    async gateAllows(orderId) {
      if (process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED === "true") return true;
      const { data: ord } = await admin.from("orders").select("profiles(accounts(pg_checkout_override))").eq("id", orderId).maybeSingle();
      return !!(ord as any)?.profiles?.accounts?.pg_checkout_override;
    },
    // 시크릿이 없으면 토스를 호출하지 않고 실패로 처리한다(취소/환불 라우트는 키가 없어도 토스와 무관한 경로가 동작해야 하므로 여기서 막는다).
    tossConfirm: (p) => (tossSecretKey ? tossConfirmPayment(tossSecretKey, p) : Promise.resolve(NO_SECRET)),
    tossCancel: (paymentKey, p) => (tossSecretKey ? tossCancelPayment(tossSecretKey, paymentKey, p) : Promise.resolve(NO_SECRET)),
    tossGet: (paymentKey) => (tossSecretKey ? tossGetPayment(tossSecretKey, paymentKey) : Promise.resolve(NO_SECRET)),
    async dbConfirm(orderId, paymentKey, amount) {
      const { data, error } = await admin.rpc("confirm_real_payment", { p_order_id: orderId, p_payment_key: paymentKey, p_amount: amount });
      return { data, error: error ? { message: error.message } : null };
    },
    async dbCancelOrder(orderId) {
      const { data, error } = await admin.rpc("cancel_real_payment", { p_order_id: orderId });
      return { data, error: error ? { message: error.message } : null };
    },
    async refundContext(membershipId, uid) {
      const { data, error } = await admin.rpc("pg_refund_context", { p_membership_id: membershipId, p_auth_uid: uid });
      if (error) throw new Error(error.message);
      return data ?? null;
    },
    async dbRefund(membershipId, uid, opts) {
      const { data, error } = await admin.rpc("refund_membership_server", {
        p_membership_id: membershipId, p_auth_uid: uid, p_allow_pg: opts.allowPg, p_force: opts.force,
      });
      return { data, error: error ? { message: error.message } : null };
    },
    log(level, event, fields) {
      // 운영자가 Vercel 로그에서 "[PG_...]" 로 검색할 수 있게 구조화해서 남긴다(결제키는 이미 마스킹된 값만 들어온다).
      (level === "error" ? console.error : level === "warn" ? console.warn : console.info)(`[${event}]`, JSON.stringify(fields));
    },
  };
}
