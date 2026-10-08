import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeBillingConfirm, type BillingAuthDeps } from "../../lib/payments/server/billingAuth";

const CENTER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const deps = (over: Partial<BillingAuthDeps> = {}): BillingAuthDeps => ({
  verifyToken: async (t) => (t === "good" ? "uid-1" : null),
  isCenterOwner: async (_t, c) => c === CENTER,
  ...over,
});

describe("authorizeBillingConfirm (순수)", () => {
  it("토큰 없음 → 401", async () => expect(await authorizeBillingConfirm(null, CENTER, deps())).toMatchObject({ ok: false, status: 401, code: "unauthenticated" }));
  it("유효하지 않은 토큰 → 401", async () => expect(await authorizeBillingConfirm("bad", CENTER, deps())).toMatchObject({ ok: false, status: 401 }));
  it("다른 센터(오너 아님) → 403", async () => expect(await authorizeBillingConfirm("good", OTHER, deps())).toMatchObject({ ok: false, status: 403, code: "not_center_owner" }));
  it("센터 오너 → 허용", async () => expect(await authorizeBillingConfirm("good", CENTER, deps())).toEqual({ ok: true, uid: "uid-1" }));
  it("검증/확인 중 예외는 거부(fail closed)", async () => {
    expect(await authorizeBillingConfirm("good", CENTER, deps({ isCenterOwner: async () => { throw new Error("db"); } }))).toMatchObject({ ok: false, status: 403 });
    expect(await authorizeBillingConfirm("good", CENTER, deps({ verifyToken: async () => { throw new Error("auth"); } }))).toMatchObject({ ok: false, status: 401 });
  });
});

// 라우트 수준: supabase-js를 가짜로 바꿔 "인증 실패 시 이후 단계(게이트·claim·Toss)가 호출되지 않음"과 "오너면 기존 흐름으로 넘어감"을 확인한다.
const calls = { from: 0, fetch: 0, rpcOwner: 0 };
let ownerAnswer = true;
vi.mock("@supabase/supabase-js", () => {
  const chain: any = { update: () => chain, eq: () => chain, in: () => chain, or: () => chain, select: () => chain, insert: () => chain, maybeSingle: async () => ({ data: null, error: null }) };
  return {
    createClient: () => ({
      auth: { getUser: async (t: string) => (t === "good" ? { data: { user: { id: "uid-1" } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
      rpc: async (name: string) => { if (name === "is_center_owner") { calls.rpcOwner++; return { data: ownerAnswer, error: null }; } return { data: null, error: null }; },
      from: () => { calls.from++; return chain; },
    }),
  };
});

async function post(headers: Record<string, string>, body: object) {
  const { POST } = await import("../../app/api/billing/confirm/route");
  return POST(new Request("http://localhost/api/billing/confirm", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
}
describe("POST /api/billing/confirm", () => {
  beforeEach(() => {
    calls.from = 0; calls.fetch = 0; calls.rpcOwner = 0; ownerAnswer = true; vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co"; process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon"; process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    process.env.TOSS_BILLING_SECRET_KEY = "toss"; process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    vi.stubGlobal("fetch", async () => { calls.fetch++; return new Response("{}", { status: 200 }); });
  });
  const body = { authKey: "a", customerKey: `center-${CENTER}`, centerId: CENTER };
  it("로그인 토큰 없음 → 401, DB claim/토스 호출 없음", async () => {
    const res = await post({}, body); expect(res.status).toBe(401);
    expect(calls.from).toBe(0); expect(calls.fetch).toBe(0);
  });
  it("무효 토큰 → 401", async () => { expect((await post({ Authorization: "Bearer bad" }, body)).status).toBe(401); expect(calls.from).toBe(0); });
  it("다른 센터의 오너가 아닌 사용자 → 403, DB claim/토스 호출 없음", async () => {
    ownerAnswer = false;
    const res = await post({ Authorization: "Bearer good" }, body); expect(res.status).toBe(403);
    expect(calls.rpcOwner).toBe(1); expect(calls.from).toBe(0); expect(calls.fetch).toBe(0);
  });
  it("센터 오너 → 인증 통과 후 기존 흐름(여기서는 이미 처리된 구독이라 409)으로 진행", async () => {
    const res = await post({ Authorization: "Bearer good" }, body);
    expect(res.status).toBe(409); expect(calls.from).toBeGreaterThan(0); expect(calls.fetch).toBe(0);   // 토스 호출 전 단계
  });
  it("형식 검증은 그대로(필수값 누락 400, customerKey 불일치 400)", async () => {
    expect((await post({ Authorization: "Bearer good" }, { authKey: "a", centerId: CENTER })).status).toBe(400);
    expect((await post({ Authorization: "Bearer good" }, { ...body, customerKey: `center-${OTHER}` })).status).toBe(400);
  });
});

describe("정적 계약", () => {
  const route = readFileSync("app/api/billing/confirm/route.ts", "utf8");
  it("인증은 게이트/claim/토스보다 먼저이고 body centerId만 믿지 않는다", () => {
    const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const i = code.indexOf("authorizeBillingConfirm("), g = code.indexOf("if (!billingEnabled)"), c = code.indexOf('.from("center_subscriptions")'), t = code.indexOf("api.tosspayments.com");
    expect(i).toBeGreaterThan(-1); expect(g).toBeGreaterThan(-1);
    expect(i).toBeLessThan(g); expect(i).toBeLessThan(c); expect(i).toBeLessThan(t);
  });
  it("클라이언트는 세션 토큰을 Bearer로 보낸다", () => {
    const lib = readFileSync("lib/centerSubscription.ts", "utf8");
    expect(lib).toContain("supabase.auth.getSession()"); expect(lib).toContain("Authorization: `Bearer ${token}`");
  });
  it("provider/금액/PG 플래그 로직은 변경되지 않았다(금액은 서버 조회 유지)", () => {
    expect(route).toContain("subscription_plans(name, monthly_price)"); expect(route).toContain("const amount = plan?.monthly_price ?? 0;");
    expect(route).toContain('process.env.NEXT_PUBLIC_BILLING_ENABLED === "true"');
  });
});
