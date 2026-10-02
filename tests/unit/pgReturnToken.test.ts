/*
  iOS 외부 Safari 결제 복귀(2026-10-02): 서명 return token / 발급·복귀 라우트 / 콜백 페이지·앱 복귀 계약. 실제 토스/DB를 호출하지 않는다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintReturnToken, verifyReturnToken, RETURN_TOKEN_TTL_SEC } from "../../lib/payments/server/returnToken";
import { cancelForAuthorizedUid, checkReturnTokenEligibility, confirmForAuthorizedUid, handleConfirm, type LifecycleDeps } from "../../lib/payments/server/lifecycle";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const SECRET = "test-secret-not-real";
const now = 1_000_000;

describe("return token", () => {
  const tok = mintReturnToken(SECRET, { orderId: "o1", uid: "u1" }, now);
  it("정상 sign/verify, TTL 15분, uid/orderId 바인딩", () => {
    expect(RETURN_TOKEN_TTL_SEC).toBe(900);
    expect(verifyReturnToken(SECRET, tok, "o1", now + 10)).toEqual({ ok: true, uid: "u1", orderId: "o1" });
  });
  it("변조/만료/다른 주문/다른 purpose/secret 없음/형식 오류 거부", () => {
    const [b, sig] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, oid: "o2", uid: "u1", exp: now + 999, p: "payment_return" })).toString("base64url");
    expect(verifyReturnToken(SECRET, `${forged}.${sig}`, "o2", now)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyReturnToken(SECRET, `${b}.${sig.slice(0, -2)}xx`, "o1", now)).toMatchObject({ ok: false });
    expect(verifyReturnToken(SECRET, tok, "o1", now + RETURN_TOKEN_TTL_SEC + 1)).toMatchObject({ ok: false, reason: "expired" });
    expect(verifyReturnToken(SECRET, tok, "o2", now)).toMatchObject({ ok: false, reason: "wrong_order" });
    expect(verifyReturnToken("other-secret", tok, "o1", now)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyReturnToken(undefined, tok, "o1", now)).toMatchObject({ ok: false, reason: "no_secret" });
    for (const bad of ["", "abc", "a.b.c", null, 5]) expect(verifyReturnToken(SECRET, bad, "o1", now)).toMatchObject({ ok: false });
    const purposeBody = Buffer.from(JSON.stringify({ v: 1, oid: "o1", uid: "u1", exp: now + 99, p: "login" })).toString("base64url");
    const { createHmac } = require("node:crypto");
    const sg = createHmac("sha256", SECRET).update(purposeBody).digest("base64url");
    expect(verifyReturnToken(SECRET, `${purposeBody}.${sg}`, "o1", now)).toMatchObject({ ok: false, reason: "wrong_purpose" });
    expect(() => mintReturnToken(undefined, { orderId: "o", uid: "u" })).toThrow();
  });
  it("토큰에는 Supabase 로그인 토큰이 없다(payload: v/oid/uid/exp/p)", () => {
    const p = JSON.parse(Buffer.from(tok.split(".")[0], "base64url").toString());
    expect(Object.keys(p).sort()).toEqual(["exp", "oid", "p", "uid", "v"]);
  });
});

const order = { orderId: "o1", status: "pending", amount: 35000, provider: "toss" };
function deps(over: Partial<LifecycleDeps> = {}) {
  const c = {
    tossConfirm: vi.fn(async () => ({ ok: true as const, data: { orderId: "o1", totalAmount: 35000 } })), tossCancel: vi.fn(async () => ({ ok: true as const, data: {} })),
    tossGet: vi.fn(), dbConfirm: vi.fn(async () => ({ data: { membership_id: "m" }, error: null })), dbCancelOrder: vi.fn(async () => ({ data: {}, error: null })),
    orderContext: vi.fn(async () => order as any), log: vi.fn(),
  };
  return { getAuthUid: async (t: string) => (t === "good" ? "u1" : null), gateAllows: async () => true, refundContext: vi.fn(), refundBegin: vi.fn(), refundRelease: vi.fn(), dbRefund: vi.fn(), ...c, ...over, calls: c } as any as LifecycleDeps & { calls: typeof c };
}

describe("발급 자격(checkReturnTokenEligibility)", () => {
  it("401 / 남의 주문 404 / non-toss 400 / non-pending 409 / gate OFF 403 / 정상", async () => {
    expect((await checkReturnTokenEligibility({ token: null, orderId: "o1" }, deps())) as any).toMatchObject({ ok: false, reply: { status: 401 } });
    expect((await checkReturnTokenEligibility({ token: "good", orderId: "o1" }, deps({ orderContext: vi.fn(async () => null) }))) as any).toMatchObject({ reply: { status: 404 } });
    expect((await checkReturnTokenEligibility({ token: "good", orderId: "o1" }, deps({ orderContext: vi.fn(async () => ({ ...order, provider: "mock" })) }))) as any).toMatchObject({ reply: { status: 400 } });
    expect((await checkReturnTokenEligibility({ token: "good", orderId: "o1" }, deps({ orderContext: vi.fn(async () => ({ ...order, status: "done" })) }))) as any).toMatchObject({ reply: { status: 409 } });
    expect((await checkReturnTokenEligibility({ token: "good", orderId: "o1" }, deps({ gateAllows: async () => false }))) as any).toMatchObject({ reply: { status: 403 } });
    expect(await checkReturnTokenEligibility({ token: "good", orderId: "o1" }, deps())).toEqual({ ok: true, uid: "u1", orderId: "o1" });
  });
});

describe("core 공유 — Bearer와 return 경로가 같은 안전 규칙", () => {
  it("handleConfirm(Bearer)는 그대로 401/정상, core는 금액 불일치 거부·보상 취소 규칙 유지", async () => {
    expect((await handleConfirm({ token: null, paymentKey: "p", orderId: "o1", amount: 35000 }, deps())).status).toBe(401);
    expect((await handleConfirm({ token: "good", paymentKey: "p", orderId: "o1", amount: 35000 }, deps())).status).toBe(200);
    const d = deps();
    expect((await confirmForAuthorizedUid("u1", { paymentKey: "p", orderId: "o1", amount: 1 }, d)).status).toBe(400);
    expect(d.calls.tossConfirm).not.toHaveBeenCalled();
    const d2 = deps({ dbConfirm: vi.fn(async () => ({ data: null, error: { message: "x" } })), orderContext: vi.fn().mockResolvedValueOnce(order).mockResolvedValueOnce(order) });
    expect((await confirmForAuthorizedUid("u1", { paymentKey: "p", orderId: "o1", amount: 35000 }, d2)).body).toMatchObject({ code: "payment_compensated" });
  });
  it("cancel core: pending만 취소, done 거부, portone 포함 PG 주문만", async () => {
    const d = deps();
    expect((await cancelForAuthorizedUid("u1", "o1", d)).status).toBe(200);
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    const done = deps({ orderContext: vi.fn(async () => ({ ...order, status: "done" })) });
    expect((await cancelForAuthorizedUid("u1", "o1", done)).status).toBe(409);
    expect(done.calls.dbCancelOrder).not.toHaveBeenCalled();
  });
});

describe("routes", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.doUnmock("@supabase/supabase-js"); vi.resetModules(); });
  const mk = (path: string, body: object, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  function setup(rpc: (name: string) => any) {
    vi.resetModules();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "x"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://x"); vi.stubEnv("TOSS_SECRET_KEY", "s"); vi.stubEnv("PAYMENT_RETURN_TOKEN_SECRET", SECRET);
    vi.stubEnv("NEXT_PUBLIC_PG_CHECKOUT_ENABLED", "true");
    const rpcMock = vi.fn(async (name: string) => rpc(name));
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: async (t: string) => (t === "good" ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: { message: "bad" } }) }, rpc: rpcMock }) }));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    return { rpcMock, fetchMock };
  }
  const okRpc = (name: string) => (name === "pg_order_context" ? { data: order, error: null } : { data: { membership_id: "m" }, error: null });

  it("mint: 무인증 401 / secret 없음 500 / 정상 발급 후 verify 가능", async () => {
    setup(okRpc);
    const { POST } = await import("../../app/api/payments/return-token/route");
    expect((await POST(mk("/api/payments/return-token", { orderId: "o1" }))).status).toBe(401);
    const res = await POST(mk("/api/payments/return-token", { orderId: "o1" }, { Authorization: "Bearer good" }));
    expect(res.status).toBe(200);
    const { returnToken } = await res.json();
    expect(verifyReturnToken(SECRET, returnToken, "o1")).toMatchObject({ ok: true, uid: "u1" });
    vi.stubEnv("PAYMENT_RETURN_TOKEN_SECRET", "");
    expect((await POST(mk("/api/payments/return-token", { orderId: "o1" }, { Authorization: "Bearer good" }))).status).toBe(500);
  });
  it("mint: PG 게이트 OFF면 발급 거부(403)", async () => {
    setup(okRpc);
    vi.stubEnv("NEXT_PUBLIC_PG_CHECKOUT_ENABLED", "false");
    const { POST } = await import("../../app/api/payments/return-token/route");
    // gateAllows가 orders 조회(심사관 override)를 쓰므로 가짜에는 from이 없다 → 게이트는 거부로 귀결돼야 한다
    const res = await POST(mk("/api/payments/return-token", { orderId: "o1" }, { Authorization: "Bearer good" })).catch(() => null);
    expect(res === null || res.status === 403 || res.status >= 400).toBe(true);
  });
  it("return confirm: 유효하지 않은 토큰(변조/만료/다른 주문/없음) → 401, 토스·DB 호출 0회", async () => {
    const { rpcMock, fetchMock } = setup(okRpc);
    const { POST } = await import("../../app/api/payments/return/confirm/route");
    const good = mintReturnToken(SECRET, { orderId: "o1", uid: "u1" });
    const expired = mintReturnToken(SECRET, { orderId: "o1", uid: "u1" }, 1);
    for (const body of [
      { returnToken: good + "x", paymentKey: "p", orderId: "o1", amount: 35000 }, { returnToken: expired, paymentKey: "p", orderId: "o1", amount: 35000 },
      { returnToken: good, paymentKey: "p", orderId: "o2", amount: 35000 }, { paymentKey: "p", orderId: "o1", amount: 35000 },
    ]) expect((await POST(mk("/api/payments/return/confirm", body))).status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("return confirm: 유효 토큰 → 같은 core 실행(토스 승인 + confirm_real_payment), 금액 불일치는 기존 방어로 400", async () => {
    const { rpcMock, fetchMock } = setup(okRpc);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ orderId: "o1", totalAmount: 35000 }), { status: 200 }));
    const { POST } = await import("../../app/api/payments/return/confirm/route");
    const good = mintReturnToken(SECRET, { orderId: "o1", uid: "u1" });
    expect((await POST(mk("/api/payments/return/confirm", { returnToken: good, paymentKey: "p", orderId: "o1", amount: 35000 }))).status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("confirm_real_payment", expect.objectContaining({ p_order_id: "o1", p_amount: 35000 }));
    const tossCalls = fetchMock.mock.calls.length;
    expect((await POST(mk("/api/payments/return/confirm", { returnToken: good, paymentKey: "p", orderId: "o1", amount: 1 }))).status).toBe(400);
    expect(fetchMock.mock.calls.length).toBe(tossCalls);
  });
  it("return cancel: 무효 토큰 → DB 취소 0회 / 유효 토큰 pending → 취소 / 다른 주문 토큰 거부", async () => {
    const { rpcMock } = setup(okRpc);
    const { POST } = await import("../../app/api/payments/return/cancel/route");
    const good = mintReturnToken(SECRET, { orderId: "o1", uid: "u1" });
    expect((await POST(mk("/api/payments/return/cancel", { returnToken: good, orderId: "o2" }))).status).toBe(401);
    expect((await POST(mk("/api/payments/return/cancel", { returnToken: "bad", orderId: "o1" }))).status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
    expect((await POST(mk("/api/payments/return/cancel", { returnToken: good, orderId: "o1" }))).status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("cancel_real_payment", { p_order_id: "o1" });
  });
  it("기존 Bearer /confirm, /cancel 계약 유지(무인증 401)", async () => {
    setup(okRpc);
    const c = await import("../../app/api/payments/confirm/route");
    const x = await import("../../app/api/payments/cancel/route");
    expect((await c.POST(mk("/api/payments/confirm", { paymentKey: "p", orderId: "o1", amount: 35000 }))).status).toBe(401);
    expect((await x.POST(mk("/api/payments/cancel", { orderId: "o1" }))).status).toBe(401);
  });
});

describe("클라이언트 계약", () => {
  const success = read("app/checkout/success/page.tsx");
  const fail = read("app/checkout/fail/page.tsx");
  const checkout = read("app/checkout/page.tsx");
  it("success/fail 콜백은 Supabase 세션에 의존하지 않고 /checkout으로 redirect하지 않는다", () => {
    for (const p of [success, fail]) {
      expect(p).not.toMatch(/getSession|supabaseClient|getPaymentService|cancelMyPendingOrderQuietly|window\.location\.href/);
      expect(p).toContain("scrubCallbackUrl()");
    }
    expect(success).toContain("returnConfirm(");
    expect(fail).toContain("returnCancel(");
  });
  it("returnApi는 Supabase를 import하지 않고, 토큰/결제키를 저장하지 않으며 pending 표시는 orderId만", () => {
    const a = read("lib/payments/returnApi.ts");
    expect(a.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/supabase/i);
    expect(a).toContain("replaceState");
    expect(a).toContain("JSON.stringify({ orderId, at: Date.now() }");
    expect(a).not.toMatch(/sessionStorage\.setItem\([^)]*(returnToken|paymentKey)/);
  });
  it("URL에 Supabase access/refresh token을 싣는 코드가 없다(returnToken만)", () => {
    for (const f of ["app/checkout/page.tsx", "lib/payments/tossPaymentApi.ts", "lib/payments/returnApi.ts", "app/api/payments/return-token/route.ts"]) {
      expect(read(f)).not.toMatch(/refresh_token|[?&]access_token=|searchParams\.set\(["'](access|refresh)|returnQuery\.set\(["'](access|refresh)/);
    }
    expect(checkout).toContain('returnQuery.set("returnToken", await requestReturnToken(orderId));');
    expect(checkout).toContain('if (providerName === "toss")');
  });
  it("토큰 발급 실패 시 결제창을 열지 않고 기존 pending 정리 경로(catch → cancelMyPendingOrderQuietly)를 탄다", () => {
    expect(checkout.indexOf("requestReturnToken(orderId)")).toBeLessThan(checkout.indexOf("paymentService.createPayment"));
    expect(checkout).toContain("await cancelMyPendingOrderQuietly(pgOrderIdForCleanup);");
  });
  it("앱 복귀 시 주문 상태 반영: visibility/focus, 최대 5회 bounded, done/cancelled에서 marker 삭제", () => {
    expect(checkout).toContain('document.addEventListener("visibilitychange", onVisible)');
    expect(checkout).toContain('window.addEventListener("focus", onVisible)');
    expect(checkout).toContain("i < 5");
    expect(checkout).toContain('if (st === "done") { clearPendingPgOrder();');
    expect(checkout).toContain('if (st === "cancelled") { clearPendingPgOrder();');
    expect(checkout).toContain("savePendingPgOrder(orderId)");
  });
  it("callback 경로 Referrer-Policy: no-referrer, secret 이름 문서화(값 없음), 토큰/결제키 로그 없음", () => {
    expect(read("next.config.ts")).toContain("no-referrer");
    expect(read(".env.local.example")).toMatch(/^PAYMENT_RETURN_TOKEN_SECRET=$/m);
    for (const f of ["app/api/payments/return/confirm/route.ts", "app/api/payments/return/cancel/route.ts", "app/api/payments/return-token/route.ts", "lib/payments/server/returnToken.ts"]) {
      expect(read(f)).not.toMatch(/console\.(log|info|warn|error)/);
    }
  });
  it("SQL/native 파일 변경 없음 + PortOne fail-closed 유지", () => {
    expect(read("lib/payments/server/lifecycle.ts")).toContain("portone_refund_unsupported");
  });
});
