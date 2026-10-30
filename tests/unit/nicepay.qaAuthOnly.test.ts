// @vitest-environment node
/* NICEPAY 격리 QA "인증만(auth-only)" — 승인(돈이 움직이는) API 호출 0건을 여러 층에서 검증한다. 실제 NICEPAY·운영 DB 접근 없음(가짜 의존성·가짜 fetch).
   층: ① 환경 판정(운영 MID·운영 DB·운영 도메인·production·일반회원 결제 ON 거부) ② 설정 fail-closed ③ lifecycle(서명·금액 검증 후 승인 전에 멈춤, claim 없음) ④ flow(주문 정리·QA 안내) ⑤ fetch 래퍼(NICEPAY 호스트 전부 차단) ⑥ 승인 함수가 직접 불려도 fetch 에 닿지 못함. */
import { describe, expect, it } from "vitest";
import { evaluateQaAuthOnly, guardFetch, NICEPAY_PUBLIC_TEST_MID, NicepayQaBlockedError } from "../../lib/payments/server/nicepay/qaAuthOnly";
import { loadNicepayConfig } from "../../lib/payments/server/nicepay/config";
import { handleNicepayAuthReturn, type NicepayDeps } from "../../lib/payments/server/nicepay/lifecycle";
import { handleReturnPost, type FlowDeps } from "../../lib/payments/server/nicepay/flow";
import { nicepayApprove, nicepayNetCancel, nicepayCancel } from "../../lib/payments/server/nicepay/api";
import { mintReturnToken } from "../../lib/payments/server/returnToken";
import { nicepaySign } from "../../lib/payments/server/nicepay/signature";

const OID = "11111111-1111-4111-8111-111111111111", SECRET = "unit-secret", MID = NICEPAY_PUBLIC_TEST_MID, KEY = "FAKE_UNIT_TEST_KEY_NOT_REAL";
const SAFE_ENV = { NICEPAY_CHECKOUT_ENABLED: "true", NICEPAY_API_FAMILY: "v3_mid", NICEPAY_ENV: "sandbox", NICEPAY_RETURN_BASE_URL: "https://qa-preview.example.test", PAYMENT_RETURN_TOKEN_SECRET: "s", NICEPAY_MID: MID, NICEPAY_MERCHANT_KEY: KEY, NICEPAY_QA_AUTH_ONLY: "true", NEXT_PUBLIC_SUPABASE_URL: "https://qa-project.supabase.example.test" } as Record<string, string>;
const cfgOf = (over: Record<string, string | undefined> = {}) => loadNicepayConfig({ ...SAFE_ENV, ...over }, { codeFlag: true });

describe("① 환경 판정 evaluateQaAuthOnly", () => {
  it("안전한 QA 설정은 통과", () => { expect(evaluateQaAuthOnly(SAFE_ENV)).toEqual({ requested: true, ok: true, problems: [] }); });
  it("공용 테스트 MID 이면 플래그가 없어도 auth-only 가 강제된다(깜빡해도 승인 없음)", () => {
    const e = { ...SAFE_ENV }; delete (e as Record<string, string | undefined>).NICEPAY_QA_AUTH_ONLY;
    expect(evaluateQaAuthOnly(e)).toMatchObject({ requested: true, ok: true });
  });
  it("플래그가 켜졌는데 운영·정기결제·임의 MID 면 거부 — 항목 이름만 보고(값 없음)", () => {
    for (const mid of ["mwhabit01m", "mwhabit02m", "other00m", ""]) { const r = evaluateQaAuthOnly({ ...SAFE_ENV, NICEPAY_MID: mid }); expect(r.ok, mid).toBe(false); expect(r.problems.join()).toContain("NICEPAY_MID"); expect(JSON.stringify(r)).not.toContain(KEY); }
  });
  it("운영 Supabase·운영 도메인·production 환경·일반회원 결제 ON·sandbox 아님·v3 아님은 모두 거부", () => {
    const bad: Array<[Record<string, string | undefined>, string]> = [
      [{ NEXT_PUBLIC_SUPABASE_URL: "https://bxntqggkfwnhcczsbqtj.supabase.co" }, "SUPABASE"], [{ NEXT_PUBLIC_SUPABASE_URL: undefined }, "SUPABASE"],
      [{ NICEPAY_RETURN_BASE_URL: "https://mwhabit.com" }, "RETURN_BASE_URL"], [{ NICEPAY_RETURN_BASE_URL: "https://www.mwhabit.com" }, "RETURN_BASE_URL"],
      [{ VERCEL_ENV: "production" }, "VERCEL_ENV"], [{ NEXT_PUBLIC_PG_CHECKOUT_ENABLED: "true" }, "PG_CHECKOUT"], [{ NICEPAY_ENV: "production" }, "NICEPAY_ENV"], [{ NICEPAY_API_FAMILY: "rest_v1" }, "FAMILY"],
    ];
    for (const [over, name] of bad) { const r = evaluateQaAuthOnly({ ...SAFE_ENV, ...over }); expect(r.ok, name).toBe(false); expect(r.problems.join()).toContain(name); }
  });
  it("auth-only 가 요청되지 않으면(운영 MID 등) 이 모듈은 아무 제한도 하지 않는다 — 운영 동작 불변", () => {
    expect(evaluateQaAuthOnly({ NICEPAY_MID: "mwhabit01m", NICEPAY_ENV: "production" })).toEqual({ requested: false, ok: true, problems: [] });
  });
});

describe("② 설정 loadNicepayConfig — fail-closed", () => {
  it("안전하면 qaAuthOnly=true 설정, 위험하면 NICEPAY 전체 비활성(reason=qa_unsafe)", () => {
    const ok = cfgOf(); expect(ok.ok && ok.config.family === "v3_mid" && ok.config.qaAuthOnly).toBe(true);
    for (const over of [{ NICEPAY_MID: "mwhabit01m" }, { NEXT_PUBLIC_SUPABASE_URL: "https://bxntqggkfwnhcczsbqtj.supabase.co" }, { VERCEL_ENV: "production" }, { NICEPAY_RETURN_BASE_URL: "https://mwhabit.com" }]) {
      const r = cfgOf(over); expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe("qa_unsafe");
    }
  });
  it("공용 테스트 MID 는 플래그 없이도 qaAuthOnly, 운영 MID(요청 안 됨)는 qaAuthOnly 없음(기존 동작)", () => {
    const e = { ...SAFE_ENV } as Record<string, string | undefined>; delete e.NICEPAY_QA_AUTH_ONLY;
    const t = loadNicepayConfig(e, { codeFlag: true }); expect(t.ok && t.config.family === "v3_mid" && t.config.qaAuthOnly).toBe(true);
    const p = loadNicepayConfig({ ...e, NICEPAY_MID: "mwhabit01m", NICEPAY_ENV: "production", NICEPAY_RETURN_BASE_URL: "https://mwhabit.com" }, { codeFlag: true });
    expect(p.ok && p.config.family === "v3_mid" && p.config.qaAuthOnly).toBeFalsy();
  });
  it("서버 스위치가 꺼져 있으면(기본) auth-only 설정이어도 비활성", () => { const r = cfgOf({ NICEPAY_CHECKOUT_ENABLED: "false" }); expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe("disabled"); });
});

const auth = (over: Record<string, unknown> = {}) => { const base = { Moid: OID, AuthResultCode: "0000", AuthToken: "tok", Amt: "1000", MID, TxTid: "tid", NextAppURL: "https://webapi.nicepay.co.kr/webapi/pay_process.jsp", NetCancelURL: "https://webapi.nicepay.co.kr/webapi/net_cancel.jsp", ...over }; return { ...base, Signature: (over.Signature as string) ?? nicepaySign.authResult({ authToken: String(base.AuthToken), mid: String(base.MID), amt: String(base.Amt) }, KEY) }; };
const mkDeps = (qa: boolean, rec: { fetch: string[]; claim: number }): NicepayDeps => ({
  creds: { mid: MID, merchantKey: KEY }, qaAuthOnly: qa, now: () => new Date(),
  fetchImpl: (async (u: string) => { rec.fetch.push(u); throw new Error("must not call"); }) as never,
  orderContext: async () => ({ orderId: OID, status: "pending", amount: 1000, provider: "nicepay" } as never), gateAllows: async () => true,
  claimOrder: async () => { rec.claim++; return null; }, releaseOrder: async () => true, recordVerifiedApproval: async () => ({ data: null, error: null }), recordPgCancel: async () => ({ data: null, error: null }), markReview: async () => {}, dbConfirm: async () => ({ data: null, error: null }), log: () => {},
} as unknown as NicepayDeps);

describe("③ lifecycle — 인증 검증 후 승인 전에 멈춤", () => {
  it("정상 인증 결과: qa_auth_only 응답, claimOrder·fetch(승인/망취소) 호출 0", async () => {
    const rec = { fetch: [] as string[], claim: 0 }; const r = await handleNicepayAuthReturn(auth() as never, mkDeps(true, rec));
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ qa_auth_only: true, approved: false }); expect(rec.claim).toBe(0); expect(rec.fetch).toEqual([]);
  });
  it("서명 위변조·금액 불일치·MID 불일치는 여전히 거절(검증은 그대로)", async () => {
    for (const over of [{ Signature: "0".repeat(64) }, { Amt: "2000" }, { MID: "OTHERMID", Signature: nicepaySign.authResult({ authToken: "tok", mid: "OTHERMID", amt: "1000" }, KEY) }]) {
      const rec = { fetch: [] as string[], claim: 0 }; const r = await handleNicepayAuthReturn(auth(over) as never, mkDeps(true, rec));
      expect(r.status, JSON.stringify(Object.keys(over))).toBeGreaterThanOrEqual(400); expect(rec.claim).toBe(0); expect(rec.fetch).toEqual([]);
    }
  });
  it("(대조) qaAuthOnly=false 이면 기존대로 승인 경로로 들어간다 — 이 시험의 차단이 모드 때문임을 증명", async () => {
    const rec = { fetch: [] as string[], claim: 0 }; await handleNicepayAuthReturn(auth() as never, mkDeps(false, rec)); expect(rec.claim).toBe(1);
  });
});

describe("④ flow — 주문 정리·QA 안내·승인 0", () => {
  const rt = mintReturnToken(SECRET, { orderId: OID, uid: "u1" });
  const flowDeps = (rec: { fetch: string[]; claim: number; cancelled: number }): FlowDeps => ({
    config: { family: "v3_mid", mid: MID, merchantKey: KEY, env: "sandbox", returnBaseUrl: "https://qa-preview.example.test", qaAuthOnly: true }, returnTokenSecret: SECRET,
    getAuthUid: async () => "u1", ownedOrder: async () => ({ orderId: OID, status: "pending", amount: 1000, provider: "nicepay" }), gateAllows: async () => true,
    cancelPendingOrder: async () => { rec.cancelled++; return true; }, orderState: async () => ({ status: "cancelled", reviewPending: false }), log: () => {}, v3: mkDeps(true, rec),
  } as unknown as FlowDeps);
  it("인증 성공 복귀 → 대기 주문 정리 1회, 결과 URL 에 qa=auth_only, 승인·망취소 fetch 0, claim 0", async () => {
    const rec = { fetch: [] as string[], claim: 0, cancelled: 0 }; const r = await handleReturnPost(auth() as never, rt, flowDeps(rec));
    expect(r.location).toContain("qa=auth_only"); expect(r.location).not.toContain("failed=1"); expect(rec.cancelled).toBe(1); expect(rec.claim).toBe(0); expect(rec.fetch).toEqual([]);
  });
});

describe("⑤⑥ fetch 래퍼 · 승인 함수 직접 호출", () => {
  it("auth-only 에서는 NICEPAY 호스트(승인·망취소·취소·조회 전부) 요청이 네트워크 전에 던져지고, 그 밖의 호스트는 통과", async () => {
    const seen: string[] = []; const inner = (async (u: string) => { seen.push(u); return { ok: true, status: 200, json: async () => ({}) }; }) as never as (u: string, i?: never) => Promise<unknown>;
    const g = guardFetch(inner as never, true) as unknown as (u: string) => Promise<unknown>;
    for (const u of ["https://webapi.nicepay.co.kr/webapi/pay_process.jsp", "https://dc1-api.nicepay.co.kr/x", "https://api.nicepay.co.kr/v1/payments/1/cancel", "https://sandbox-api.nicepay.co.kr/v1", "https://pg-web.nicepay.co.kr/v3/x", "not a url"]) await expect(g(u), u).rejects.toBeInstanceOf(NicepayQaBlockedError);
    await g("https://example.test/ok"); expect(seen).toEqual(["https://example.test/ok"]);
    expect(guardFetch(inner as never, false)).toBe(inner);   // 모드가 꺼져 있으면 래핑하지 않는다(기존 동작)
  });
  it("승인·망취소·취소 함수를 직접 불러도 래핑된 fetch 에 닿는 순간 막혀 결과는 '네트워크 오류'(실제 호출 0)", async () => {
    const seen: string[] = []; const inner = (async (u: string) => { seen.push(u); return { ok: true, status: 200, json: async () => ({ ResultCode: "3001" }) }; }) as never as (u: string, i: never) => Promise<unknown>;
    const g = guardFetch(inner as never, true) as never;
    const a = await nicepayApprove(g, { mid: MID, merchantKey: KEY }, { nextAppUrl: "https://webapi.nicepay.co.kr/webapi/pay_process.jsp", tid: "t", authToken: "a", amount: 1000, now: new Date() });
    const n = await nicepayNetCancel(g, { mid: MID, merchantKey: KEY }, { netCancelUrl: "https://webapi.nicepay.co.kr/webapi/net_cancel.jsp", tid: "t", authToken: "a", amount: 1000, now: new Date() });
    const c = await nicepayCancel(g, { mid: MID, merchantKey: KEY }, { cancelUrl: "https://webapi.nicepay.co.kr/webapi/cancel_process.jsp", tid: "t", cancelMoid: "m", amount: 1000, reason: "qa", now: new Date() });
    for (const r of [a, n, c]) expect(r.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe("정적: 승인 경로 접점이 모두 래핑·차단된다", () => {
  const fs = require("node:fs") as typeof import("node:fs"); // eslint-disable-line @typescript-eslint/no-require-imports
  const rd = (p: string) => fs.readFileSync(p, "utf8");
  it("runtime.ts 의 v3 deps·환불 포트는 guardFetch 로 감싸고, lifecycle 은 claim 전에 qaAuthOnly 로 멈춘다, 테스트 MID/운영 MID 상수는 한 곳", () => {
    const rt = rd("lib/payments/server/nicepay/runtime.ts"); expect(rt).toContain("guardFetch(fetchImpl, c.qaAuthOnly"); expect(rt).toContain("guardFetch(globalThis.fetch as unknown as NicepayFetch, c.qaAuthOnly");
    const lc = rd("lib/payments/server/nicepay/lifecycle.ts"); expect(lc.indexOf("if (d.qaAuthOnly)")).toBeGreaterThan(-1); expect(lc.indexOf("if (d.qaAuthOnly)")).toBeLessThan(lc.indexOf("await d.claimOrder(ctx.orderId)"));
    expect(rd("lib/payments/server/nicepay/config.ts")).toContain("evaluateQaAuthOnly(env)");
  });
  it("MerchantKey·MID 값이 코드·문서·테스트에 하드코딩되지 않는다(테스트의 가짜 값 제외)", () => {
    const files = ["lib/payments/server/nicepay/qaAuthOnly.ts", "lib/payments/server/nicepay/config.ts", "app/checkout/nicepay/result/page.tsx"];
    for (const f of files) expect(rd(f)).not.toMatch(/MerchantKey\s*[:=]\s*["'][A-Za-z0-9+/=]{16,}["']/);
  });
});
