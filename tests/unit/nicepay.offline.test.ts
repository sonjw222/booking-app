// @vitest-environment node
/* NICEPAY 사전 구현 오프라인 테스트 — 실제 NICEPAY/DB/네트워크 없음(가짜 fetch·가짜 의존성). MID/KEY는 테스트용 가짜 값. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nicepaySign, signatureMatches, amtString, parseAmt } from "../../lib/payments/server/nicepay/signature";
import { isAllowedNicepayUrl } from "../../lib/payments/server/nicepay/types";
import { redactNicepayForLog } from "../../lib/payments/server/nicepay/redact";
import { ediDateOf, nicepayApprove, nicepayCancel, nicepayNetCancel, type NicepayFetch } from "../../lib/payments/server/nicepay/api";
import { handleNicepayAuthReturn, classifyNicepayWebhook, type NicepayDeps, type NicepayOrderCtx } from "../../lib/payments/server/nicepay/lifecycle";
import { NicepayPaymentProvider } from "../../lib/payments/NicepayPaymentProvider";
import { resolveProviderName, isOnlinePgCheckoutAvailable } from "../../lib/payments/PaymentProviderFactory";

const MID = "nicepay00m", KEY = "TEST_MERCHANT_KEY_NOT_REAL", TOKEN = "AUTHTOKEN_TEST_1234567890", TID = "nicepay00m01012610161200000001", ORDER = "order-1", AMT = 12000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const APP = "https://dc1-api.nicepay.co.kr/webapi/pay_process.jsp", NET = "https://dc1-api.nicepay.co.kr/webapi/net_cancel.jsp";

describe("서명 공식(공식 문서와 동일한 연결 순서)", () => {
  it("각 서명이 문서 공식과 일치한다", () => {
    expect(nicepaySign.payRequest({ ediDate: "20261016120000", mid: MID, amt: "12000" }, KEY)).toBe(sha("20261016120000" + MID + "12000" + KEY));
    expect(nicepaySign.authResult({ authToken: TOKEN, mid: MID, amt: "12000" }, KEY)).toBe(sha(TOKEN + MID + "12000" + KEY));
    expect(nicepaySign.approveRequest({ authToken: TOKEN, mid: MID, amt: "12000", ediDate: "E" }, KEY)).toBe(sha(TOKEN + MID + "12000" + "E" + KEY));
    expect(nicepaySign.approveResponse({ tid: TID, mid: MID, amt: "12000" }, KEY)).toBe(sha(TID + MID + "12000" + KEY));
    expect(nicepaySign.cancelRequest({ mid: MID, cancelAmt: "12000", ediDate: "E" }, KEY)).toBe(sha(MID + "12000" + "E" + KEY));
    expect(nicepaySign.cancelResponse({ tid: TID, mid: MID, cancelAmt: "12000" }, KEY)).toBe(sha(TID + MID + "12000" + KEY));
  });
  it("비교는 길이·타입·빈값을 거부하고 다른 키/금액이면 불일치", () => {
    const good = nicepaySign.authResult({ authToken: TOKEN, mid: MID, amt: "12000" }, KEY);
    expect(signatureMatches(good, good)).toBe(true);
    for (const bad of [undefined, null, 1, "", "abc", good.slice(1), nicepaySign.authResult({ authToken: TOKEN, mid: MID, amt: "12001" }, KEY), nicepaySign.authResult({ authToken: TOKEN, mid: MID, amt: "12000" }, "other")]) expect(signatureMatches(good, bad)).toBe(false);
  });
  it("금액 문자열 변환", () => {
    expect(amtString(1000)).toBe("1000");
    for (const bad of [0, -1, 1.5, NaN, Infinity]) expect(() => amtString(bad)).toThrow();
    expect(parseAmt("000000012000")).toBe(12000); expect(parseAmt("12a")).toBeNull(); expect(parseAmt("")).toBeNull(); expect(parseAmt("1".repeat(13))).toBeNull(); expect(parseAmt(undefined)).toBeNull();
  });
  it("EdiDate는 KST 14자리", () => expect(ediDateOf(new Date("2026-10-16T03:04:05Z"))).toBe("20261016120405"));
});

describe("NextAppURL/NetCancelURL 허용 호스트", () => {
  it("공식 도메인 https만 허용", () => {
    for (const u of ["https://dc1-api.nicepay.co.kr/webapi/pay_process.jsp", "https://dc2-api.nicepay.co.kr/x", "https://pg-api.nicepay.co.kr/", "https://webapi.nicepay.co.kr/x"]) expect(isAllowedNicepayUrl(u)).toBe(true);
    for (const u of ["http://dc1-api.nicepay.co.kr/x", "https://evil.example/dc1-api.nicepay.co.kr", "https://dc1-api.nicepay.co.kr.evil.example/", "https://u:p@dc1-api.nicepay.co.kr/", "https://dc1-api.nicepay.co.kr:8443/", "https://169.254.169.254/", "", undefined, 3]) expect(isAllowedNicepayUrl(u)).toBe(false);
  });
});

describe("로그 redact — 개인정보·키·토큰·서명 제거", () => {
  it("허용 목록 필드만 남기고 TID/Moid는 뒤 6자리만", () => {
    const out = redactNicepayForLog({ ResultCode: "3001", Amt: "12000", TID: TID, Moid: ORDER + "abcdef", CardNo: "123456******1234", BuyerEmail: "a@b.c", BuyerTel: "010", BuyerName: "홍길동", AuthToken: TOKEN, Signature: "sig", SignData: "sd", EncData: "enc", BID: "BIKYtest", MerchantKey: KEY });
    const json = JSON.stringify(out);
    for (const secret of ["123456", "a@b.c", "홍길동", TOKEN, "sig", "enc", "BIKY", KEY, TID]) expect(json).not.toContain(secret);
    expect(out.ResultCode).toBe("3001"); expect(String(out.TID)).toMatch(/^….{6}$/);
  });
});

type Fake = NicepayDeps & {
  logs: string[]; calls: { url: string; body: URLSearchParams }[];
  setApprove(r: Record<string, unknown>): void; setNetOk(v: boolean): void; setThrow(v: boolean): void;
  claim: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; dbConfirm: ReturnType<typeof vi.fn>; review: ReturnType<typeof vi.fn>;
};
function fakeDeps(over: { ctx?: NicepayOrderCtx | null; claimOrder?: () => Promise<string | null>; dbConfirm?: () => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>; orderContext?: () => Promise<NicepayOrderCtx | null>; gateAllows?: () => Promise<boolean> } = {}): Fake {
  const logs: string[] = [];
  const calls: Fake["calls"] = [];
  let approveResp: Record<string, unknown> = {}; let netOk = true; let approveThrows = false;
  const respond = (url: string): Record<string, unknown> => {
    if (url === APP) { if (approveThrows) throw new Error("timeout"); return approveResp; }
    if (url === NET) return netOk ? { ResultCode: "2001" } : { ResultCode: "9999", ErrorCD: "E1" };
    return {};
  };
  const fetchImpl: NicepayFetch = async (url, init) => { calls.push({ url, body: new URLSearchParams(init.body) }); return { ok: true, status: 200, async json() { return respond(url); } }; };
  const ctx = over.ctx === undefined ? { orderId: ORDER, status: "pending", amount: AMT, provider: "nicepay" } : over.ctx;
  const claim = vi.fn(over.claimOrder ?? (async () => "claim-1"));
  const release = vi.fn(async (_o: string, _c: string, _b: string) => {});
  const review = vi.fn(async () => {});
  const dbConfirm = vi.fn(over.dbConfirm ?? (async () => ({ data: { membershipId: "m1" }, error: null })));
  const d: Fake = {
    creds: { mid: MID, merchantKey: KEY }, fetchImpl, now: () => new Date("2026-10-16T03:00:00Z"),
    orderContext: over.orderContext ?? (async () => ctx), gateAllows: over.gateAllows ?? (async () => true), claimOrder: claim, releaseOrder: release, markReview: review, dbConfirm,
    log: (l, e, f) => { logs.push(`${l} ${e} ${JSON.stringify(f)}`); },
    logs, calls, setApprove: (r) => { approveResp = r; }, setNetOk: (v) => { netOk = v; }, setThrow: (v) => { approveThrows = v; },
    claim, release, review,
  };
  d.setApprove(goodApprove());
  return d;
}
const goodApprove = (o: Record<string, unknown> = {}) => ({ ResultCode: "3001", Amt: String(AMT), MID, Moid: ORDER, TID, Signature: nicepaySign.approveResponse({ tid: TID, mid: MID, amt: String(AMT) }, KEY), ...o });
const authInput = (o: Record<string, unknown> = {}) => ({ AuthResultCode: "0000", AuthToken: TOKEN, MID, Moid: ORDER, Amt: String(AMT), TxTid: TID, NextAppURL: APP, NetCancelURL: NET, Signature: nicepaySign.authResult({ authToken: TOKEN, mid: MID, amt: String(AMT) }, KEY), ...o });

describe("handleNicepayAuthReturn — 정상/멱등", () => {
  it("정상: 서명·금액 검증 후 DB 금액으로 승인 → DB 확정", async () => {
    const d = fakeDeps(); const r = await handleNicepayAuthReturn(authInput(), d);
    expect(r.status).toBe(200); expect(r.body.ok).toBe(true);
    expect(d.calls).toHaveLength(1); expect(d.calls[0].url).toBe(APP);
    expect(d.calls[0].body.get("Amt")).toBe("12000"); expect(d.calls[0].body.get("CharSet")).toBe("utf-8");
    expect(d.calls[0].body.get("SignData")).toBe(nicepaySign.approveRequest({ authToken: TOKEN, mid: MID, amt: "12000", ediDate: "20261016120000" }, KEY));
    expect(JSON.stringify([...d.calls[0].body])).not.toContain(KEY);
    expect(d.dbConfirm).toHaveBeenCalledWith(ORDER, "claim-1", TID, AMT); expect(d.release).not.toHaveBeenCalled();
  });
  it("이미 done이면 승인 호출 없이 멱등 성공", async () => {
    const d = fakeDeps({ ctx: { orderId: ORDER, status: "done", amount: AMT, provider: "nicepay" } }); const r = await handleNicepayAuthReturn(authInput(), d);
    expect(r.body.already_done).toBe(true); expect(d.calls).toHaveLength(0); expect(d.dbConfirm).not.toHaveBeenCalled();
  });
  it("PG 게이트 OFF면 NICEPAY 승인 호출·선점 없이 403", async () => {
    const d = fakeDeps({ gateAllows: async () => false }); const r = await handleNicepayAuthReturn(authInput(), d);
    expect(r.status).toBe(403); expect(d.calls).toHaveLength(0); expect(d.claim).not.toHaveBeenCalled(); expect(d.dbConfirm).not.toHaveBeenCalled();
  });
  it("동시 중복 확정: 선점 실패 시 승인 호출 없음", async () => {
    const d = fakeDeps({ claimOrder: async () => null }); const r = await handleNicepayAuthReturn(authInput(), d);
    expect(r.status).toBe(409); expect(d.calls).toHaveLength(0); expect(d.dbConfirm).not.toHaveBeenCalled();
  });
});

describe("handleNicepayAuthReturn — 승인 전 거부(NICEPAY 승인 호출 없음)", () => {
  const cases: [string, Record<string, unknown>, number][] = [
    ["인증 실패 코드", { AuthResultCode: "0001" }, 400],
    ["서명 변조", { Signature: "0".repeat(64) }, 400],
    ["금액 변조(서명도 맞춰 바꿈)", { Amt: "100", Signature: nicepaySign.authResult({ authToken: TOKEN, mid: MID, amt: "100" }, KEY) }, 400],
    ["다른 MID", { MID: "other00000" }, 400],
    ["필수값 누락", { AuthToken: "" }, 400],
    ["NextAppURL이 허용 호스트 아님(토큰 유출 시도)", { NextAppURL: "https://evil.example/pay" }, 400],
    ["NetCancelURL이 허용 호스트 아님", { NetCancelURL: "http://169.254.169.254/" }, 400],
  ];
  for (const [name, o, st] of cases) it(name, async () => { const d = fakeDeps(); const r = await handleNicepayAuthReturn(authInput(o), d); expect(r.status).toBe(st); expect(d.calls).toHaveLength(0); expect(d.claim).not.toHaveBeenCalled(); expect(d.dbConfirm).not.toHaveBeenCalled(); });
  it("주문 없음/다른 provider/취소·기타 상태/DB 금액 불일치", async () => {
    for (const ctx of [null, { orderId: ORDER, status: "pending", amount: AMT, provider: "toss" }, { orderId: ORDER, status: "cancelled", amount: AMT, provider: "nicepay" }, { orderId: ORDER, status: "approving", amount: AMT, provider: "nicepay" }, { orderId: ORDER, status: "pending", amount: AMT + 1, provider: "nicepay" }]) {
      const d = fakeDeps({ ctx }); const r = await handleNicepayAuthReturn(authInput(), d); expect(r.status).toBeGreaterThanOrEqual(400); expect(d.calls).toHaveLength(0);
    }
  });
});

describe("handleNicepayAuthReturn — 승인 이후 실패는 망취소", () => {
  const netCalls = (d: Fake) => d.calls.filter((c) => c.url === NET);
  it("승인 응답 네트워크 오류 → 망취소(응답 유실 가정)", async () => {
    const d = fakeDeps(); d.setThrow(true); const r = await handleNicepayAuthReturn(authInput(), d);
    expect(r.status).toBe(502); expect(netCalls(d)).toHaveLength(1); expect(netCalls(d)[0].body.get("NetCancel")).toBe("1"); expect(d.release).toHaveBeenCalledWith(ORDER, "claim-1", "netcancel_confirmed"); expect(d.dbConfirm).not.toHaveBeenCalled();
  });
  it("승인 거절 코드 → 돈 이동 없음: 망취소 안 함, 주문 pending 복귀", async () => {
    const d = fakeDeps(); d.setApprove(goodApprove({ ResultCode: "3011" })); const r = await handleNicepayAuthReturn(authInput(), d);
    expect(r.status).toBe(400); expect(netCalls(d)).toHaveLength(0); expect(d.release).toHaveBeenCalledWith(ORDER, "claim-1", "approve_rejected"); expect(d.dbConfirm).not.toHaveBeenCalled();
  });
  for (const [name, resp] of [["응답 서명 불일치", { Signature: "f".repeat(64) }], ["응답 금액 불일치", { Amt: "1", Signature: nicepaySign.approveResponse({ tid: TID, mid: MID, amt: "1" }, KEY) }], ["응답 주문번호 불일치", { Moid: "other" }], ["응답 TID 불일치", { TID: "other", Signature: nicepaySign.approveResponse({ tid: "other", mid: MID, amt: String(AMT) }, KEY) }]] as const)
    it(`${name} → DB 확정 없이 망취소`, async () => { const d = fakeDeps(); d.setApprove(goodApprove(resp)); const r = await handleNicepayAuthReturn(authInput(), d); expect(r.status).toBe(409); expect(netCalls(d)).toHaveLength(1); expect(d.dbConfirm).not.toHaveBeenCalled(); });
  it("DB 확정 실패 + 재조회 pending → 망취소", async () => {
    const d = fakeDeps({ dbConfirm: async () => ({ data: null, error: { message: "boom" } }) }); const r = await handleNicepayAuthReturn(authInput(), d);
    expect(r.status).toBe(500); expect(netCalls(d)).toHaveLength(1);
  });
  it("DB 확정 실패했지만 실제로는 done(응답 유실) → 취소하지 않음", async () => {
    let n = 0; const d = fakeDeps({ dbConfirm: async () => ({ data: null, error: { message: "lost" } }), orderContext: async () => (n++ === 0 ? { orderId: ORDER, status: "pending", amount: AMT, provider: "nicepay" } : { orderId: ORDER, status: "done", amount: AMT, provider: "nicepay" }) });
    const r = await handleNicepayAuthReturn(authInput(), d); expect(r.status).toBe(200); expect(netCalls(d)).toHaveLength(0);
  });
  it("DB 확정 실패 + 상태 재조회 실패 → 자동 취소하지 않고 운영 알림", async () => {
    let n = 0; const d = fakeDeps({ dbConfirm: async () => ({ data: null, error: { message: "x" } }), orderContext: async () => { if (n++ === 0) return { orderId: ORDER, status: "pending", amount: AMT, provider: "nicepay" }; throw new Error("db down"); } });
    const r = await handleNicepayAuthReturn(authInput(), d); expect(r.body.code).toBe("confirm_state_unknown"); expect(netCalls(d)).toHaveLength(0); expect(d.review).toHaveBeenCalledWith(ORDER, "claim-1", "confirm_state_unknown"); expect(d.logs.join("\n")).toContain("PG_NICEPAY_CONFIRM_STATE_UNKNOWN");
  });
  it("망취소마저 실패 → 주문을 pending으로 풀지 않고(재승인 방지) 운영 알림", async () => {
    const d = fakeDeps(); d.setApprove(goodApprove({ Moid: "other" })); d.setNetOk(false); const r = await handleNicepayAuthReturn(authInput(), d);
    expect(r.body.code).toBe("compensation_failed"); expect(d.release).not.toHaveBeenCalled(); expect(d.review).toHaveBeenCalledWith(ORDER, "claim-1", "netcancel_failed"); expect(d.logs.join("\n")).toContain("PG_NICEPAY_NETCANCEL_FAILED");
  });
  it("모든 로그에 토큰·키·서명·카드/구매자 정보가 없다", async () => {
    const d = fakeDeps(); d.setApprove(goodApprove({ Moid: "other", CardNo: "123456******9999", BuyerEmail: "x@y.z" })); await handleNicepayAuthReturn(authInput(), d);
    const all = d.logs.join("\n"); for (const secret of [TOKEN, KEY, "123456******9999", "x@y.z", TID, nicepaySign.authResult({ authToken: TOKEN, mid: MID, amt: "12000" }, KEY)]) expect(all).not.toContain(secret);
  });
});

describe("결과 불명 처리 — 성공/실패를 임의로 확정하지 않는다", () => {
  it("2xx인데 승인 응답 본문을 해석할 수 없으면 승인 성공으로도 실패 확정으로도 처리하지 않고 망취소 → 성공 시에만 pending 복귀", async () => {
    const calls: string[] = []; const d = fakeDeps();
    d.fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, async json() { if (url === APP) throw new Error("garbled"); return { ResultCode: "2001" }; } }; };
    const r = await handleNicepayAuthReturn(authInput(), d);
    expect(r.status).toBe(502); expect(calls).toEqual([APP, NET]); expect(d.release).toHaveBeenCalled(); expect(d.dbConfirm).not.toHaveBeenCalled();
  });
  it("승인 5xx도 결과 불명 → 망취소", async () => {
    const calls: string[] = []; const d = fakeDeps();
    d.fetchImpl = async (url) => { calls.push(url); return url === APP ? { ok: false, status: 503, async json() { return {}; } } : { ok: true, status: 200, async json() { return { ResultCode: "2001" }; } }; };
    await handleNicepayAuthReturn(authInput(), d); expect(calls).toEqual([APP, NET]);
  });
  it("승인 4xx(확정 거절)는 망취소하지 않는다", async () => {
    const calls: string[] = []; const d = fakeDeps();
    d.fetchImpl = async (url) => { calls.push(url); return { ok: false, status: 400, async json() { return {}; } }; };
    const r = await handleNicepayAuthReturn(authInput(), d); expect(r.status).toBe(400); expect(calls).toEqual([APP]);
  });
  it("결과 불명 + 망취소 실패 → 영속 표시(markReview)·approving 유지로 재승인 불가, 응답은 운영자 문의", async () => {
    const d = fakeDeps(); d.setThrow(true); d.setNetOk(false);
    const r = await handleNicepayAuthReturn(authInput(), d);
    expect(r.body.code).toBe("compensation_failed"); expect(d.review).toHaveBeenCalledTimes(1); expect(d.release).not.toHaveBeenCalled();
  });
  it("망취소는 요청마다 1회만(중복 취소 요청 없음)", async () => {
    const d = fakeDeps(); d.setApprove(goodApprove({ Moid: "other" })); await handleNicepayAuthReturn(authInput(), d);
    expect(d.calls.filter((c) => c.url === NET)).toHaveLength(1);
  });
  it("재시도 시 이미 approving(선점됨)이면 새 승인·망취소 모두 하지 않는다", async () => {
    const d = fakeDeps({ ctx: { orderId: ORDER, status: "approving", amount: AMT, provider: "nicepay" } }); const r = await handleNicepayAuthReturn(authInput(), d);
    expect(r.status).toBe(409); expect(d.calls).toHaveLength(0);
  });
});

describe("api — 주입 fetch, 허용 호스트, 전액 취소", () => {
  it("허용되지 않은 URL이면 fetch를 호출하지 않는다", async () => {
    const f = vi.fn(); const r = await nicepayApprove(f as unknown as NicepayFetch, { mid: MID, merchantKey: KEY }, { nextAppUrl: "https://evil.example/", tid: TID, authToken: TOKEN, amount: AMT, now: new Date() });
    expect(r.ok).toBe(false); expect(f).not.toHaveBeenCalled();
  });
  it("취소: 전액(PartialCancelCode=0), 서명은 MID+CancelAmt+EdiDate+Key, 성공 코드 2001/2211", async () => {
    const seen: URLSearchParams[] = []; const f: NicepayFetch = async (_u, i) => { seen.push(new URLSearchParams(i.body)); return { ok: true, status: 200, async json() { return { ResultCode: "2211" }; } }; };
    const r = await nicepayCancel(f, { mid: MID, merchantKey: KEY }, { cancelUrl: "https://pg-api.nicepay.co.kr/webapi/cancel_process.jsp", tid: TID, cancelMoid: "cancel-1", amount: AMT, reason: "고객 요청", now: new Date("2026-10-16T03:00:00Z") });
    expect(r.ok).toBe(true); expect(seen[0].get("PartialCancelCode")).toBe("0"); expect(seen[0].get("SignData")).toBe(sha(MID + "12000" + "20261016120000" + KEY));
  });
  it("취소 거절 코드는 실패로 반환", async () => {
    const f: NicepayFetch = async () => ({ ok: true, status: 200, async json() { return { ResultCode: "2013", ErrorCD: "E" }; } });
    expect((await nicepayCancel(f, { mid: MID, merchantKey: KEY }, { cancelUrl: "https://pg-api.nicepay.co.kr/x", tid: TID, cancelMoid: "c", amount: AMT, reason: "r", now: new Date() })).ok).toBe(false);
    expect((await nicepayNetCancel(f, { mid: MID, merchantKey: KEY }, { netCancelUrl: NET, tid: TID, authToken: TOKEN, amount: AMT, now: new Date() })).ok).toBe(false);
  });
});

describe("웹훅은 힌트 전용 — 상태를 바꾸지 않고 분류만", () => {
  const wh = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ MID, MOID: ORDER, TID, Amt: String(AMT), StateCd: "0", ...o });
  const run = (payload: Record<string, unknown>, ctx: NicepayOrderCtx | null) => { const d = fakeDeps({ ctx }); return classifyNicepayWebhook(payload, d); };
  it("분류", async () => {
    const p = { orderId: ORDER, amount: AMT, provider: "nicepay" };
    expect(await run(wh(), { ...p, status: "pending" })).toBe("confirm_needed");
    expect(await run(wh(), { ...p, status: "done" })).toBe("ignore");
    expect(await run(wh({ Amt: "1" }), { ...p, status: "pending" })).toBe("mismatch");
    expect(await run(wh({ StateCd: "2" }), { ...p, status: "done" })).toBe("mismatch");
    expect(await run(wh(), null)).toBe("unknown_order");
    expect(await run(wh({ MID: "x" }), { ...p, status: "pending" })).toBe("bad_payload");
    expect(await run({}, null)).toBe("bad_payload");
  });
});

describe("비활성 보장 / 카드정보 미수집 (정적)", () => {
  it("NicepayPaymentProvider는 모든 메서드가 throw, 팩토리는 nicepay를 선택해도 결제창 진입이 잠겨 있다", async () => {
    const p = new NicepayPaymentProvider();
    await expect(p.createPayment({ orderId: "o", amount: 1 })).rejects.toThrow(/활성화되지 않았/);
    await expect(p.confirmPayment("k", "o")).rejects.toThrow(); await expect(p.cancelPayment("o")).rejects.toThrow(); await expect(p.getPaymentStatus("o")).rejects.toThrow();
    const prev = process.env.NEXT_PUBLIC_PAYMENT_PROVIDER; process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = "nicepay";
    try { expect(resolveProviderName()).toBe("nicepay"); expect(isOnlinePgCheckoutAvailable()).toBe(false); } finally { if (prev === undefined) delete process.env.NEXT_PUBLIC_PAYMENT_PROVIDER; else process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = prev; }
  });
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? (n === "node_modules" ? [] : walk(p)) : /\.(ts|tsx)$/.test(p) ? [p] : []; });
  it("서버 NICEPAY 모듈(lib/payments/server/nicepay)은 app/ 라우트에 연결되지 않았다(연결 금지) — 클라이언트 Provider만 팩토리에 연결", () => {
    expect(walk("app").filter((f) => /from\s+["'][^"']*server\/nicepay/i.test(readFileSync(f, "utf8")))).toEqual([]);
    expect(walk("lib").filter((f) => !f.includes(`${path.sep}nicepay${path.sep}`)).filter((f) => /from\s+["'][^"']*server\/nicepay/i.test(readFileSync(f, "utf8")))).toEqual([]);
    expect(walk("app").filter((f) => /from\s+["'][^"']*NicepayPaymentProvider/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
  it("카드번호·유효기간·생년월일/사업자번호·비밀번호 수집/전송 필드가 코드에 없다", () => {
    const re = /\b(CardPw|ExpYear|ExpMonth|IDNo|EncData)\b|CardNo\s*[=:]/;
    expect(walk("app").concat(walk("lib")).filter((f) => re.test(readFileSync(f, "utf8")))).toEqual([]);
  });
  it("NICEPAY 키는 코드에서 환경변수로 읽지 않는다(이번 범위: 키 로딩 코드 없음)", () => {
    expect(walk("lib").concat(walk("app")).filter((f) => /process\.env\.NICEPAY|NICEPAY_(MID|MERCHANT|KEY|SECRET)/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
