import { describe, expect, it } from "vitest";
import { handleReturnPost, type FlowDeps } from "../../lib/payments/server/nicepay/flow";
import { mintReturnToken } from "../../lib/payments/server/returnToken";
import { nicepaySign } from "../../lib/payments/server/nicepay/signature";

const OID = "11111111-1111-4111-8111-111111111111"; const SECRET = "unit-secret"; const MID = "UNITMID01m"; const KEY = "unit-merchant-key";
const rt = mintReturnToken(SECRET, { orderId: OID, uid: "u1" });
const calls: string[] = [];
const deps = (): FlowDeps => ({
  config: { family: "v3_mid", mid: MID, merchantKey: KEY, env: "sandbox", returnBaseUrl: "https://app.example.test" }, returnTokenSecret: SECRET,
  getAuthUid: async () => "u1", ownedOrder: async () => ({ orderId: OID, status: "pending", amount: 1000, provider: "nicepay" }), gateAllows: async () => true,
  cancelPendingOrder: async () => true, orderState: async () => ({ status: "pending", reviewPending: false }), log: () => {},
  v3: { creds: { mid: MID, merchantKey: KEY }, fetchImpl: (async (u: string) => { calls.push(u); throw new Error("must not call"); }) as never, now: () => new Date(), orderContext: async () => ({ orderId: OID, status: "pending", amount: 1000, provider: "nicepay" }),
    gateAllows: async () => true, claimOrder: async () => null, releaseOrder: async () => true, recordVerifiedApproval: async () => ({ data: null, error: null }), recordPgCancel: async () => ({ data: null, error: null }), markReview: async () => {}, dbConfirm: async () => ({ data: null, error: null }), log: () => {} },
});
const good = { Moid: OID, AuthResultCode: "0000", AuthToken: "tok", Amt: "1000", MID, TxTid: "tid", NextAppURL: "https://webapi.nicepay.co.kr/webapi/pay_process.jsp", NetCancelURL: "https://webapi.nicepay.co.kr/webapi/net_cancel.jsp", Signature: nicepaySign.authResult({ authToken: "tok", mid: MID, amt: "1000" }, KEY) };

describe("NICEPAY return — 서버가 인증 결과를 명확히 거절하면 결과 화면이 바로 실패로 안내(failed=1), 승인 호출은 없다", () => {
  it("서명 불일치·금액 불일치·MID 불일치 → failed=1, fetch 호출 0", async () => {
    for (const bad of [{ Signature: "0".repeat(64) }, { Amt: "2000", Signature: nicepaySign.authResult({ authToken: "tok", mid: MID, amt: "2000" }, KEY) }, { MID: "OTHERMID", Signature: nicepaySign.authResult({ authToken: "tok", mid: "OTHERMID", amt: "1000" }, KEY) }]) {
      const r = await handleReturnPost({ ...good, ...bad }, rt, deps());
      expect(r.location).toContain("&failed=1"); expect(r.location).toContain(`orderId=${OID}`);
    }
    expect(calls).toEqual([]);
  });
  it("정상 서명인데 선점 실패(다른 요청이 처리 중, 409 in_progress)면 failed 를 붙이지 않고 계속 확인", async () => {
    const r = await handleReturnPost(good, rt, deps());
    expect(r.location).not.toContain("failed=1");
  });
  it("복귀 토큰이 없거나 위조면 invalid=1(승인 경로 진입 없음)", async () => {
    expect((await handleReturnPost(good, null, deps())).location).toContain("invalid=1");
    expect((await handleReturnPost(good, "forged.token", deps())).location).toContain("invalid=1");
  });
});
