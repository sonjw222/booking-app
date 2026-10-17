/*
  NICEPAY 런타임 조립 — 라우트가 쓰는 실제 의존성(service_role Supabase + 주입된 fetch)을 만든다. 활성 조건(config.ts)을 만족하지 않으면 아무것도 만들지 않는다(fail-closed).
  service_role 사용 원칙은 Toss와 같다: 호출 전에 Bearer 또는 서명된 return token으로 uid를 확인하고, 주문 소유(pg_order_context(uid))를 확인한 뒤에만 DB RPC를 부른다(라우트/핸들러가 보장).
  이 파일은 NICEPAY 키를 반환하거나 로그에 쓰지 않는다.
*/
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadNicepayConfig, describeConfig, type NicepayConfig } from "./config";
import { nicepayDbDeps } from "./db";
import { handleNicepayRefund, restRefundPort, v3RefundPort } from "./refund";
import type { RestDeps } from "./restLifecycle";
import type { NicepayDeps } from "./lifecycle";
import type { RestFetch } from "./rest";
import type { NicepayFetch } from "./api";
import type { RefundCtx, Reply } from "../lifecycle";
import type { FlowDeps } from "./flow";

export type NotActive = { active: false; status: 503; body: { error: string; code: "nicepay_not_active" } };
export const NOT_ACTIVE_REPLY: NotActive = { active: false, status: 503, body: { error: "온라인 결제는 아직 사용할 수 없어요", code: "nicepay_not_active" } };

export function getActiveNicepayConfig(env: Record<string, string | undefined> = process.env): { active: true; config: NicepayConfig } | NotActive {
  const r = loadNicepayConfig(env);
  if (!r.ok) {
    // 어떤 항목이 비었는지는 서버 로그로만(값 없음). 응답에는 일반 문구만 내린다.
    const info = describeConfig(r);
    if (info.reason === "incomplete") console.warn("[PG_NICEPAY_CONFIG_INCOMPLETE]", JSON.stringify(info.missing));
    return NOT_ACTIVE_REPLY;
  }
  return { active: true, config: r.config };
}

const log: NicepayDeps["log"] = (level, event, fields) => (level === "error" ? console.error : level === "warn" ? console.warn : console.info)(`[${event}]`, JSON.stringify(fields));
// 결제창(심사/출시 노출) 게이트: NICEPAY 활성(config) 위에서, 일반 회원은 NEXT_PUBLIC_PG_CHECKOUT_ENABLED==="true" 일 때만, 그 외에는 심사용 계정 override 만 통과한다.
// override 계정이라도 위 config 활성 조건을 우회하지 못한다(getActiveNicepayConfig가 먼저 호출된다).
export function nicepayGate(admin: SupabaseClient) {
  return async (orderId: string): Promise<boolean> => {
    if (process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED === "true") return true;
    const { data } = await admin.from("orders").select("profiles(accounts(pg_checkout_override))").eq("id", orderId).maybeSingle();
    const prof = (data as { profiles?: { accounts?: { pg_checkout_override?: boolean } | null } | null } | null)?.profiles;
    return !!prof?.accounts?.pg_checkout_override;
  };
}

export function buildRestDeps(admin: SupabaseClient, c: Extract<NicepayConfig, { family: "rest_v1" }>, fetchImpl: RestFetch = globalThis.fetch as unknown as RestFetch): RestDeps {
  return { creds: { clientId: c.clientId, secretKey: c.secretKey, apiBase: c.apiBase }, fetchImpl, now: () => new Date(), gateAllows: nicepayGate(admin), log, ...nicepayDbDeps(admin) };
}
export function buildV3Deps(admin: SupabaseClient, c: Extract<NicepayConfig, { family: "v3_mid" }>, fetchImpl: NicepayFetch = globalThis.fetch as unknown as NicepayFetch): NicepayDeps {
  return { creds: { mid: c.mid, merchantKey: c.merchantKey }, fetchImpl, now: () => new Date(), gateAllows: nicepayGate(admin), log, ...nicepayDbDeps(admin) };
}

/** 회원 소유 확인(주문): pg_order_context(uid) — 소유가 아니면 null. */
export async function ownedOrder(admin: SupabaseClient, orderId: string, uid: string): Promise<{ orderId: string; status: string; amount: number; provider: string | null } | null> {
  const { data, error } = await admin.rpc("pg_order_context", { p_order_id: orderId, p_auth_uid: uid });
  if (error) throw new Error(error.message);
  return (data as { orderId: string; status: string; amount: number; provider: string | null } | null) ?? null;
}

/** buildDeps(deps.ts)가 환불 핸들러를 붙일 때 쓴다. 활성이 아니면 undefined → NICEPAY 환불은 501 fail-closed. */
export function buildNicepayRefund(
  admin: SupabaseClient,
  base: { refundBegin: (m: string, u: string) => Promise<{ state: "locked" | "resumed" | "blocked" | "refunded"; reason?: string }>; refundRelease: (m: string, u: string) => Promise<{ data: unknown; error: { message: string } | null }>; dbRefund: (m: string, u: string, o: { allowPg: boolean; skipTimeCheck: boolean }) => Promise<{ data: unknown; error: { message: string } | null }> },
  env: Record<string, string | undefined> = process.env,
): ((ctx: RefundCtx, uid: string) => Promise<Reply>) | undefined {
  const a = getActiveNicepayConfig(env);
  if (!a.active) return undefined;
  const c = a.config;
  const now = () => new Date();
  const port = c.family === "rest_v1"
    ? restRefundPort({ clientId: c.clientId, secretKey: c.secretKey, apiBase: c.apiBase }, globalThis.fetch as unknown as RestFetch, now, log)
    : v3RefundPort({ mid: c.mid, merchantKey: c.merchantKey }, globalThis.fetch as unknown as NicepayFetch, now);
  const db = nicepayDbDeps(admin);
  return (ctx, uid) => handleNicepayRefund(ctx, uid, {
    port,
    refundBegin: base.refundBegin,
    refundRelease: async (m, u) => { const r = await base.refundRelease(m, u); return { data: (r.data as Record<string, unknown> | null) ?? null, error: r.error }; },
    recordPgCancel: db.recordPgCancel,
    dbRefund: async (m, u, o) => { const r = await base.dbRefund(m, u, o); return { data: (r.data as Record<string, unknown> | null) ?? null, error: r.error }; },
    log,
  });
}

/** 라우트용 FlowDeps — 활성 설정 + 서버 비밀(PAYMENT_RETURN_TOKEN_SECRET은 config가 존재를 이미 확인) */
export function buildFlowDeps(admin: SupabaseClient, c: NicepayConfig, returnTokenSecret: string): FlowDeps {
  return {
    config: c, returnTokenSecret,
    async getAuthUid(token) { const { data, error } = await admin.auth.getUser(token); return error || !data?.user ? null : data.user.id; },
    ownedOrder: (orderId, uid) => ownedOrder(admin, orderId, uid),
    gateAllows: nicepayGate(admin),
    async cancelPendingOrder(orderId) {
      const { data, error } = await admin.from("orders").update({ status: "cancelled" }).eq("id", orderId).eq("status", "pending").eq("payment_provider", "nicepay").select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },
    async orderState(orderId) {
      const { data, error } = await admin.rpc("nicepay_order_context", { p_order_id: orderId });
      if (error) throw new Error(error.message);
      const v = data as { status: string; reviewPending?: boolean } | null;
      return v ? { status: v.status, reviewPending: !!v.reviewPending } : null;
    },
    rest: c.family === "rest_v1" ? buildRestDeps(admin, c) : undefined,
    v3: c.family === "v3_mid" ? buildV3Deps(admin, c) : undefined,
    log,
  };
}
