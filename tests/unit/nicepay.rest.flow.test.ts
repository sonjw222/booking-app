// @vitest-environment node
/* NICEPAY REST(v1) 구매·환불 흐름 오프라인 QA — 가짜 PG + 가짜 DB(실제 SQL 의미 그대로). 실제 NICEPAY/DB/돈 없음. */
import { describe, expect, it } from "vitest";
import { handleNicepayRestAuthReturn, classifyRestWebhook } from "../../lib/payments/server/nicepay/restLifecycle";
import { handleNicepayRefund, restRefundPort, type NicepayRefundDeps } from "../../lib/payments/server/nicepay/refund";
import { handleAbandon, handlePrepare, handleReturnPost, handleStatus, handleWebhook, type FlowDeps } from "../../lib/payments/server/nicepay/flow";
import { investigateByOrderId } from "../../lib/payments/server/nicepay/recovery";
import { restSign } from "../../lib/payments/server/nicepay/rest";
import { mintReturnToken } from "../../lib/payments/server/returnToken";
import { handleRefund, type LifecycleDeps } from "../../lib/payments/server/lifecycle";
import { CLIENT_ID, CREDS, FakeDb, FakePg, SECRET, makeRestDeps } from "./helpers/nicepayFakes";

const ORDER = "11111111-1111-4111-8111-111111111111", UID = "user-1", AMT = 12000;
const TOKEN_SECRET = "return_token_secret_for_tests";
function setup(over: { amount?: number } = {}) {
  const db = new FakeDb(), pg = new FakePg();
  db.addOrder({ id: ORDER, uid: UID, amount: over.amount ?? AMT });
  const d = makeRestDeps(db, pg);
  return { db, pg, d };
}
const authFor = (pg: FakePg, orderId = ORDER, amount = AMT, over: Record<string, unknown> = {}) => pg.authorize(orderId, amount, over);

describe("정상 승인 · 상태 전이 · 발급", () => {
  it("인증 → 서버 승인 → 검증 → 승인 기록 → DB 확정 → 수강권 1개, 승인 요청 금액은 DB 금액", async () => {
    const { db, pg, d } = setup();
    const r = await handleNicepayRestAuthReturn(authFor(pg), d);
    expect(r.status).toBe(200);
    expect(db.orders.get(ORDER)!.status).toBe("done");
    expect(db.memberships).toHaveLength(1); expect(db.payments.filter((p) => p.kind === "new")).toHaveLength(1);
    expect(db.approvals).toHaveLength(1); expect(pg.count("approve")).toBe(1); expect(pg.calls[0].amount).toBe(AMT);
    expect(d.logs.join("\n")).not.toContain(SECRET); expect(d.logs.join("\n")).not.toContain("AT_");
  });
  it("승인 거부(카드 한도 등)는 수강권 없이 approving → pending 복귀(재시도 가능), 다시 인증하면 성공", async () => {
    const { db, pg, d } = setup();
    pg.faults.approve = "reject";
    const r = await handleNicepayRestAuthReturn(authFor(pg), d);
    expect(r.body.code).toBe("approve_failed"); expect(db.orders.get(ORDER)!.status).toBe("pending"); expect(db.memberships).toHaveLength(0);
    pg.faults = {};
    expect((await handleNicepayRestAuthReturn(authFor(pg), d)).status).toBe(200); expect(db.memberships).toHaveLength(1);
  });
  it("HTTP 4xx 확정 거절도 복귀(망취소 아님)", async () => {
    const { db, pg, d } = setup(); pg.faults.approve = "http400";
    const r = await handleNicepayRestAuthReturn(authFor(pg), d);
    expect(r.body.code).toBe("approve_failed"); expect(pg.count("netcancel")).toBe(0); expect(db.orders.get(ORDER)!.status).toBe("pending");
  });
});

describe("위변조 · 잘못된 입력 — 승인 호출 자체가 일어나지 않는다", () => {
  it.each([
    ["금액 위변조(인증 amount ≠ DB)", (pg: FakePg) => authFor(pg, ORDER, AMT, { amount: "100", signature: restSign.authResult({ authToken: "AT", clientId: CLIENT_ID, amount: "100" }, SECRET), authToken: "AT" }), "amount_mismatch"],
    ["잘못된 서명", (pg: FakePg) => authFor(pg, ORDER, AMT, { signature: "0".repeat(64) }), "signature_mismatch"],
    ["다른 가맹점 clientId", (pg: FakePg) => authFor(pg, ORDER, AMT, { clientId: "other" }), "mid_mismatch"],
    ["인증 실패 코드", (pg: FakePg) => authFor(pg, ORDER, AMT, { authResultCode: "A101" }), "auth_failed"],
    ["authToken 누락", (pg: FakePg) => authFor(pg, ORDER, AMT, { authToken: "" }), "bad_request"],
  ])("%s", async (_n, make, code) => {
    const { db, pg, d } = setup();
    const r = await handleNicepayRestAuthReturn(make(pg), d);
    expect(r.body.code).toBe(code); expect(pg.count("approve")).toBe(0); expect(db.orders.get(ORDER)!.status).toBe("pending"); expect(db.memberships).toHaveLength(0);
  });
  it("존재하지 않는 주문번호는 404, NICEPAY가 아닌 주문(toss)은 거부, 취소된 주문은 승인하지 않는다", async () => {
    const { db, pg, d } = setup();
    expect((await handleNicepayRestAuthReturn(authFor(pg, "ghost"), d)).status).toBe(404);
    db.addOrder({ id: "t-1", uid: UID, provider: "toss" }); expect((await handleNicepayRestAuthReturn(authFor(pg, "t-1"), d)).status).toBe(400);
    db.orders.get(ORDER)!.status = "cancelled"; expect((await handleNicepayRestAuthReturn(authFor(pg), d)).status).toBe(409);
    expect(pg.count("approve")).toBe(0);
  });
  it("PG 게이트가 닫혀 있으면(심사 계정 아님/일반 비노출) 승인하지 않는다", async () => {
    const { db, pg, d } = setup(); db.gateOpen = false;
    expect((await handleNicepayRestAuthReturn(authFor(pg), d)).body.code).toBe("gate_off"); expect(pg.count("approve")).toBe(0);
  });
  it.each([
    ["승인 응답 서명 위조", "bad_signature"], ["승인 응답 금액 변조", "amount_tamper"], ["승인 응답의 주문번호가 다름", "wrong_order"], ["승인 응답 status가 paid가 아님", "status_ready"],
  ] as const)("%s → 승인 수강권 발급 없이 망취소 후 복귀", async (_n, fault) => {
    const { db, pg, d } = setup(); pg.faults.approve = fault;
    const r = await handleNicepayRestAuthReturn(authFor(pg), d);
    expect(r.body.code).toBe("approve_mismatch"); expect(pg.count("netcancel")).toBe(1);
    expect(db.memberships).toHaveLength(0); expect(db.orders.get(ORDER)!.status).toBe("pending"); expect(db.approvals).toHaveLength(0);
  });
});

describe("장애 복구 — 불명확한 거래는 임의로 확정하지 않는다", () => {
  it("승인 요청 중 네트워크 끊김(PG는 이미 승인함) → 망취소 전에 조회: paid+금액 일치면 취소하지 않고 구매를 이어서 확정", async () => {
    const { db, pg, d } = setup(); pg.faults.approve = "timeout_after";
    const r = await handleNicepayRestAuthReturn(authFor(pg), d);
    expect(r.status).toBe(200); expect(pg.count("lookup")).toBe(1); expect(pg.count("netcancel")).toBe(0); expect(pg.count("cancel")).toBe(0);
    expect([...pg.txs.values()][0].status).toBe("paid"); expect(db.orders.get(ORDER)!.status).toBe("done"); expect(db.memberships).toHaveLength(1); expect(db.approvals).toHaveLength(1);
  });
  it("승인 요청이 PG에 닿기 전에 끊김(돈 안 움직임) → 조회로 미승인 확인 → 망취소 없이 pending 복귀", async () => {
    const { db, pg, d } = setup(); pg.faults.approve = "timeout_before";
    const r = await handleNicepayRestAuthReturn(authFor(pg), d);
    expect(r.body.code).toBe("approve_unknown"); expect(pg.count("lookup")).toBe(1); expect(pg.count("netcancel")).toBe(0);
    expect(db.orders.get(ORDER)!.status).toBe("pending"); expect(db.memberships).toHaveLength(0);
  });
  it("승인 응답 5xx/해석 불가(PG는 승인함)도 조회로 확인해 구매 확정, 망취소 없음", async () => {
    for (const f of ["http500_after", "unreadable"] as const) {
      const { db, pg, d } = setup(); pg.faults.approve = f;
      expect((await handleNicepayRestAuthReturn(authFor(pg), d)).status).toBe(200); expect(pg.count("netcancel")).toBe(0); expect(db.orders.get(ORDER)!.status).toBe("done");
    }
  });
  it("승인 결과 불명 + 조회도 실패/서명 불일치 → 그때서야 망취소, 망취소 뒤 재조회로 확인되면 pending 복귀", async () => {
    for (const lookupFault of ["fail", "bad_signature"] as const) {
      const { db, pg, d } = setup(); pg.faults = { approve: "timeout_after" };
      // 첫 조회(망취소 전)만 실패시키고, 망취소 뒤 재조회는 정상 응답이도록 호출 횟수로 제어
      const orig = pg.faults; let n = 0; const realFetch = pg.fetch.bind(pg);
      d.fetchImpl = (async (url: string, init: Parameters<typeof realFetch>[1]) => { if (url.includes("?ediDate") && init.method === "GET" && n++ === 0) pg.faults = { ...orig, lookup: lookupFault }; else pg.faults = orig; return realFetch(url, init); }) as typeof d.fetchImpl;
      const r = await handleNicepayRestAuthReturn(authFor(pg), d);
      expect(r.body.code).toBe("approve_unknown"); expect(pg.count("netcancel")).toBe(1); expect(pg.count("lookup")).toBe(2);
      expect([...pg.txs.values()][0].status).toBe("cancelled"); expect(db.orders.get(ORDER)!.status).toBe("pending"); expect(db.memberships).toHaveLength(0);
    }
  });
  it("망취소는 성공 응답이어도 재조회를 신뢰할 수 없으면 release하지 않고 운영자 확인", async () => {
    const { db, pg, d } = setup(); pg.faults = { approve: "timeout_after", lookup: "bad_signature" };
    const r = await handleNicepayRestAuthReturn(authFor(pg), d);
    expect(r.body.code).toBe("compensation_failed"); expect(pg.count("netcancel")).toBe(1); expect(db.orders.get(ORDER)!.status).toBe("approving"); expect(db.reviews).toEqual([{ orderId: ORDER, reason: "netcancel_failed" }]);
  });
  it("망취소 실패 → 주문은 approving 유지 + 운영자 확인(review) 표시, 재승인/성공 처리 없음", async () => {
    const { db, pg, d } = setup(); pg.faults = { approve: "timeout_after", lookup: "fail", netcancel: "fail" };
    const r = await handleNicepayRestAuthReturn(authFor(pg), d);
    expect(r.body.code).toBe("compensation_failed"); expect(db.orders.get(ORDER)!.status).toBe("approving"); expect(db.reviews).toEqual([{ orderId: ORDER, reason: "netcancel_failed" }]);
    pg.faults = {}; expect((await handleNicepayRestAuthReturn(authFor(pg), d)).status).toBe(409);   // 선점 중이라 새 승인 불가
    expect(pg.count("approve")).toBe(1);
  });
  it("PG 승인 성공 후 DB 확정 실패 → 일반 취소 + 조회 재확인 + 취소 기록 + 복귀(수강권 없음, 승인 기록과 취소 기록이 함께 남음)", async () => {
    const { db, pg, d } = setup(); db.faults.confirm = true;
    const r = await handleNicepayRestAuthReturn(authFor(pg), d);
    expect(r.body.code).toBe("db_confirm_failed"); expect(pg.count("cancel")).toBe(1); expect(pg.count("lookup")).toBe(1);
    expect(db.cancels).toHaveLength(1); expect(db.cancels[0].cancelTid).not.toBe(db.approvals[0].tid);
    expect(db.orders.get(ORDER)!.status).toBe("pending"); expect(db.memberships).toHaveLength(0);
  });
  it("DB 확정 후 응답 유실(확정은 커밋됨) → 취소하지 않고 성공, 재요청은 멱등(already_done, 수강권 1개)", async () => {
    const { db, pg, d } = setup(); db.faults.confirmOnce = true;
    // 확정 RPC가 실패한 것처럼 보이지만 실제로는 커밋됐다고 가정: 실패 응답 직전에 done 처리
    const orig = db.dbConfirm; let first = true;
    db.dbConfirm = async (...a) => { if (first) { first = false; db.faults.confirmOnce = false; await orig(...a); return { data: null, error: { message: "응답 유실" } }; } return orig(...a); };
    const d2 = { ...d, dbConfirm: db.dbConfirm };
    const r = await handleNicepayRestAuthReturn(authFor(pg), d2);
    expect(r.status).toBe(200); expect(pg.count("cancel") + pg.count("netcancel")).toBe(0); expect(db.memberships).toHaveLength(1);
    expect((await handleNicepayRestAuthReturn(authFor(pg), d2)).body.already_done).toBe(true); expect(db.memberships).toHaveLength(1);
  });
  it("확정 실패 + 주문 상태 재조회도 실패 → 자동 취소하지 않고 review(confirm_state_unknown)", async () => {
    const { db, pg, d } = setup(); db.faults.confirm = true; db.faults.orderContextAfterConfirmFail = true;
    const r = await handleNicepayRestAuthReturn(authFor(pg), d);
    expect(r.body.code).toBe("confirm_state_unknown"); expect(pg.count("cancel") + pg.count("netcancel")).toBe(0); expect(db.reviews[0].reason).toBe("confirm_state_unknown");
  });
  it("승인 기록 저장 실패 → 돈은 승인됐는데 DB 기록이 없다 → 임의 정리 없이 review", async () => {
    const { db, pg, d } = setup(); db.faults.recordApproval = true;
    const r = await handleNicepayRestAuthReturn(authFor(pg), d);
    expect(r.body.code).toBe("compensation_failed"); expect(db.orders.get(ORDER)!.status).toBe("approving"); expect(db.reviews).toHaveLength(1); expect(db.memberships).toHaveLength(0);
  });
  it("일반 취소가 확인되지 않으면(조회 서명 불일치) 복귀하지 않고 review", async () => {
    const { db, pg, d } = setup(); db.faults.confirm = true; pg.faults.lookup = "bad_signature";
    const r = await handleNicepayRestAuthReturn(authFor(pg), d);
    expect(r.body.code).toBe("compensation_failed"); expect(db.orders.get(ORDER)!.status).toBe("approving"); expect(db.cancels).toHaveLength(0);
  });
});

describe("중복·경합", () => {
  it("같은 주문의 동시 인증 결과 2건 → 승인은 1번, 한쪽은 in_progress/already_done, 수강권 1개", async () => {
    const { db, pg, d } = setup();
    const a = authFor(pg), b = authFor(pg);
    const [r1, r2] = await Promise.all([handleNicepayRestAuthReturn(a, d), handleNicepayRestAuthReturn(b, d)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]); expect(pg.count("approve")).toBe(1); expect(db.memberships).toHaveLength(1);
    expect((await handleNicepayRestAuthReturn(authFor(pg), d)).body.already_done).toBe(true); expect(pg.count("approve")).toBe(1);
  });
  it("같은 거래번호를 다른 주문이 쓰려 하면 승인 기록이 거부된다(거래번호 중복 방지)", async () => {
    const { db } = setup(); db.addOrder({ id: "o2", uid: UID });
    const c1 = await db.claimOrder(ORDER), c2 = await db.claimOrder("o2");
    expect((await db.recordVerifiedApproval(ORDER, c1!, "SAME_TID", AMT)).error).toBeNull();
    expect((await db.recordVerifiedApproval("o2", c2!, "SAME_TID", AMT)).error?.message).toMatch(/이미 다른 주문/);
  });
  it("결제·취소 경합: 승인 진행 중(approving) 사용자의 주문 취소는 거부, 취소된 주문은 선점 불가", async () => {
    const { db, pg } = setup();
    const flow = { cancelPendingOrder: db.cancelPendingOrder } as FlowDeps;
    const claim = await db.claimOrder(ORDER); expect(claim).toBeTruthy();
    expect(await flow.cancelPendingOrder(ORDER)).toBe(false); expect(db.orders.get(ORDER)!.status).toBe("approving");
    db.orders.get(ORDER)!.status = "pending"; db.orders.get(ORDER)!.claimId = null;
    expect(await flow.cancelPendingOrder(ORDER)).toBe(true);
    expect(await db.claimOrder(ORDER)).toBeNull(); void pg;
  });
});

// ---------------------------------------------------------------- HTTP 경계(flow) ----
const cfg = { family: "rest_v1" as const, clientId: CLIENT_ID, secretKey: SECRET, env: "sandbox" as const, apiBase: CREDS.apiBase, sdkUrl: "https://sandbox-pay.nicepay.co.kr/v1/js/", returnBaseUrl: "https://app.example.test" };
function flowSetup(over: { amount?: number } = {}) {
  const s = setup(over);
  const flow: FlowDeps = { config: cfg, returnTokenSecret: TOKEN_SECRET, getAuthUid: async (t) => (t === "tok-user-1" ? UID : t === "tok-user-2" ? "user-2" : null), ownedOrder: s.db.ownedOrder, gateAllows: s.db.gateAllows, cancelPendingOrder: s.db.cancelPendingOrder, orderState: s.db.orderState, rest: s.d, log: () => {} };
  return { ...s, flow };
}
describe("결제 준비(prepare) · 복귀(return) · 결과(status)", () => {
  it("prepare: 금액은 DB 주문 금액, 로그인·본인 주문·pending·게이트 필요, 타인 주문은 404, 키는 응답에 없다", async () => {
    const { db, flow } = flowSetup();
    const ok = await handlePrepare({ token: "tok-user-1", orderId: ORDER, orderName: "필라테스 10회권" }, flow);
    expect(ok.status).toBe(200);
    const p = (ok.body.params as Record<string, unknown>); expect(p.amount).toBe(AMT); expect(p.orderId).toBe(ORDER); expect(String(p.returnUrl)).toContain("/api/payments/nicepay/return?rt=");
    expect(JSON.stringify(ok.body)).not.toContain(SECRET);
    expect((await handlePrepare({ token: null, orderId: ORDER }, flow)).status).toBe(401);
    expect((await handlePrepare({ token: "tok-user-2", orderId: ORDER }, flow)).status).toBe(404);
    db.gateOpen = false; expect((await handlePrepare({ token: "tok-user-1", orderId: ORDER }, flow)).status).toBe(403); db.gateOpen = true;
    db.orders.get(ORDER)!.status = "approving"; expect((await handlePrepare({ token: "tok-user-1", orderId: ORDER }, flow)).status).toBe(409);
    db.addOrder({ id: "t-2", uid: UID, provider: "toss" }); expect((await handlePrepare({ token: "tok-user-1", orderId: "t-2" }, flow)).status).toBe(400);
  });
  it("return(모바일 외부 브라우저 복귀): 복귀 토큰 + 본인 주문이면 승인 후 결과 화면으로, 결과는 DB 상태로만 확인", async () => {
    const { db, pg, flow } = flowSetup();
    const rt = mintReturnToken(TOKEN_SECRET, { orderId: ORDER, uid: UID });
    const { location } = await handleReturnPost(authFor(pg) as Record<string, unknown>, rt, flow);
    expect(location).toContain("/checkout/nicepay/result?orderId=" + ORDER); expect(location).not.toContain("failed=1");
    expect(db.orders.get(ORDER)!.status).toBe("done");
    const st = await handleStatus({ token: null, returnToken: rt, orderId: ORDER }, flow);
    expect(st.body).toMatchObject({ state: "done", final: true });
  });
  it("return: 토큰 없음/만료/다른 주문/타인 토큰이면 PG를 호출하지 않고 invalid 화면", async () => {
    const { db, pg, flow } = flowSetup(); db.addOrder({ id: "o2", uid: "user-2" });
    const form = authFor(pg) as Record<string, unknown>;
    expect((await handleReturnPost(form, null, flow)).location).toContain("invalid=1");
    expect((await handleReturnPost(form, "garbage", flow)).location).toContain("invalid=1");
    const expired = mintReturnToken(TOKEN_SECRET, { orderId: ORDER, uid: UID }, Math.floor(Date.now() / 1000) - 3600);   // 인증 만료
    expect((await handleReturnPost(form, expired, flow)).location).toContain("invalid=1");
    const wrongOrder = mintReturnToken(TOKEN_SECRET, { orderId: "o2", uid: "user-2" });
    expect((await handleReturnPost(form, wrongOrder, flow)).location).toContain("invalid=1");
    const otherUser = mintReturnToken(TOKEN_SECRET, { orderId: ORDER, uid: "user-2" });   // 타인 주문
    expect((await handleReturnPost(form, otherUser, flow)).location).toContain("invalid=1");
    expect(pg.count("approve")).toBe(0); expect(db.orders.get(ORDER)!.status).toBe("pending");
  });
  it("return: 사용자가 결제창에서 취소/인증 실패 → pending 주문만 취소, 승인 호출 없음", async () => {
    const { db, pg, flow } = flowSetup();
    const rt = mintReturnToken(TOKEN_SECRET, { orderId: ORDER, uid: UID });
    const { location } = await handleReturnPost({ authResultCode: "A101", orderId: ORDER, clientId: CLIENT_ID }, rt, flow);
    expect(location).toContain("failed=1"); expect(db.orders.get(ORDER)!.status).toBe("cancelled"); expect(pg.count("approve")).toBe(0);
  });
  it("status: 결제 결과 화면에 '들어온 것'은 성공이 아니다 — pending/approving은 완료가 아니고 review는 별도, 타인은 조회 불가", async () => {
    const { db, flow } = flowSetup();
    const st = (t: string | null = "tok-user-1") => handleStatus({ token: t, orderId: ORDER }, flow);
    expect((await st()).body.state).toBe("pending");
    db.orders.get(ORDER)!.status = "approving"; expect((await st()).body).toMatchObject({ state: "processing", final: false });
    db.orders.get(ORDER)!.review = true; expect((await st()).body).toMatchObject({ state: "review", final: true });
    expect((await st("tok-user-2")).status).toBe(404); expect((await st(null)).status).toBe(401);
  });
  it("abandon: 승인 전 주문만 취소 / 승인 진행 중이면 거부 / 이미 취소는 멱등", async () => {
    const { db, flow } = flowSetup();
    db.orders.get(ORDER)!.status = "approving"; expect((await handleAbandon({ token: "tok-user-1", orderId: ORDER }, flow)).status).toBe(409);
    db.orders.get(ORDER)!.status = "pending"; expect((await handleAbandon({ token: "tok-user-1", orderId: ORDER }, flow)).status).toBe(200);
    expect((await handleAbandon({ token: "tok-user-1", orderId: ORDER }, flow)).body.already).toBe(true);
    expect((await handleAbandon({ token: "tok-user-2", orderId: ORDER }, flow)).status).toBe(404);
  });
  it("웹훅: 서명 검증 + 분류만(상태 변경 없음). 서명 불일치 401, 승인됐는데 미확정이면 confirm_needed, 금액 불일치는 mismatch", async () => {
    const { db, flow } = flowSetup();
    const sign = (amount: number, status: string, over: Record<string, unknown> = {}) => { const ediDate = "2026-10-17T12:00:00+0900"; return { tid: "WH_TID_1", orderId: ORDER, amount, ediDate, status, signature: restSign.response({ tid: "WH_TID_1", amount: String(amount), ediDate }, SECRET), ...over }; };
    expect(await handleWebhook(sign(AMT, "paid", { signature: "0".repeat(64) }), flow)).toMatchObject({ status: 401, text: "FAIL" });
    expect(await handleWebhook(sign(AMT, "paid"), flow)).toMatchObject({ status: 200, text: "OK", verdict: "confirm_needed" });
    expect((await handleWebhook(sign(AMT - 1, "paid"), flow)).verdict).toBe("mismatch");
    expect((await handleWebhook(sign(AMT, "paid", { orderId: "ghost" }), flow)).verdict).toBe("unknown_order");
    expect(db.orders.get(ORDER)!.status).toBe("pending"); expect(db.memberships).toHaveLength(0);   // 웹훅은 아무것도 확정하지 않는다
    db.addPaidMembership(ORDER); expect((await handleWebhook(sign(AMT, "paid"), flow)).verdict).toBe("ignore");
    expect((await handleWebhook(sign(AMT, "cancelled"), flow)).verdict).toBe("mismatch");   // 취소 통보인데 DB는 done → 운영 확인
    void classifyRestWebhook;
  });
});

// ---------------------------------------------------------------- 환불 ----
function refundSetup() {
  const s = setup(); s.db.addPaidMembership(ORDER);
  const tid = s.db.orders.get(ORDER)!.tid!;
  s.pg.txs.set(tid, { orderId: ORDER, amount: AMT, status: "paid" });
  const logs: string[] = [];
  const deps: NicepayRefundDeps = {
    port: restRefundPort(CREDS, s.pg.fetch, () => new Date("2026-10-17T03:00:00Z"), (l, e) => { logs.push(`${l} ${e}`); }),
    refundBegin: s.db.refundBegin, refundRelease: s.db.refundRelease, recordPgCancel: s.db.recordPgCancel, dbRefund: s.db.dbRefund, log: (l, e) => { logs.push(`${l} ${e}`); },
  };
  const memId = `m-${ORDER}`;
  const ctx = async () => (await s.db.refundContext(memId, UID))!;
  return { ...s, deps, memId, ctx, tid, logs };
}
describe("환불 — PG 취소 확인 없이는 내부 환불하지 않는다", () => {
  it("정상: 환불 표시 → PG 취소 → 조회로 취소 확인 → 취소 기록 → DB 환불. 환불 금액 = 원거래 금액 = 취소 기록 금액", async () => {
    const { db, pg, deps, ctx, tid } = refundSetup();
    const r = await handleNicepayRefund(await ctx(), UID, deps);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ refunded: true, amount: AMT });
    expect(pg.txs.get(tid)!.status).toBe("cancelled"); expect(pg.calls.find((c) => c.kind === "cancel")!.orderId).toBe(`cx-${ORDER}`);
    expect(db.cancels).toHaveLength(1); expect(db.cancels[0].amount).toBe(AMT); expect(db.cancels[0].cancelTid).not.toBe(tid);
    expect(db.payments.find((p) => p.kind === "refund")!.amount).toBe(-AMT); expect(db.memberships[0].status).toBe("refunded");
  });
  it("PG 취소 거절(여전히 승인 상태) → 내부 환불 없음 + 환불 표시 해제", async () => {
    const { db, pg, deps, ctx } = refundSetup(); pg.faults.cancel = "ok_but_stay_paid";
    const r = await handleNicepayRefund(await ctx(), UID, deps);
    expect(r.body.code).toBe("pg_cancel_failed"); expect(db.memberships[0].status).toBe("active"); expect(db.memberships[0].marker).toBe(false); expect(db.cancels).toHaveLength(0);
  });
  it("PG 취소 결과 불명(타임아웃 + 조회도 실패) → 임의 확정 없음, 환불 표시 유지, 재시도하면 이어서 처리", async () => {
    const { db, pg, deps, ctx } = refundSetup(); pg.faults = { cancel: "timeout_after", lookup: "fail" };
    const r = await handleNicepayRefund(await ctx(), UID, deps);
    expect(r.body.code).toBe("pg_cancel_unknown"); expect(db.memberships[0].status).toBe("active"); expect(db.memberships[0].marker).toBe(true); expect(db.cancels).toHaveLength(0);
    pg.faults = {};
    const r2 = await handleNicepayRefund(await ctx(), UID, deps);   // 재요청: 이미 취소된 거래 → (거절 응답) → 조회로 취소 확인 → 이어서 완료
    expect(r2.status).toBe(200); expect(db.memberships[0].status).toBe("refunded"); expect(db.cancels).toHaveLength(1);
  });
  it("타임아웃인데 실제로는 취소됨 → 조회로 확인되면 성공으로 이어간다(이미 취소된 거래의 재요청 포함)", async () => {
    const { db, pg, deps, ctx } = refundSetup(); pg.faults.cancel = "timeout_after";
    const r = await handleNicepayRefund(await ctx(), UID, deps);
    expect(r.status).toBe(200); expect(db.cancels).toHaveLength(1); expect(db.memberships[0].status).toBe("refunded");
  });
  it("PG 취소 성공 후 취소 기록 실패 → 환불 안 됨(표시 유지) → 같은 요청 재시도로 완료(취소 재요청은 PG 중복 취소 없이 조회로 확인)", async () => {
    const { db, pg, deps, ctx } = refundSetup(); db.faults.recordCancelOnce = true;
    const r = await handleNicepayRefund(await ctx(), UID, deps);
    expect(r.body.code).toBe("refund_record_failed_after_pg_cancel"); expect(db.memberships[0].status).toBe("active");
    const r2 = await handleNicepayRefund(await ctx(), UID, deps);
    expect(r2.status).toBe(200); expect(db.cancels).toHaveLength(1); expect(db.memberships[0].status).toBe("refunded");
    expect(pg.txs.size).toBe(1);
  });
  it("환불 성공 후 DB 환불 기록 실패 → 재시도로 이어서 완료, 환불 행은 정확히 1개", async () => {
    const { db, deps, ctx } = refundSetup(); db.faults.refund = true;
    const r = await handleNicepayRefund(await ctx(), UID, deps);
    expect(r.body.code).toBe("refund_db_failed_after_pg_cancel"); expect(db.payments.filter((p) => p.kind === "refund")).toHaveLength(0);
    db.faults.refund = false;
    expect((await handleNicepayRefund(await ctx(), UID, deps)).status).toBe(200); expect(db.payments.filter((p) => p.kind === "refund")).toHaveLength(1);
  });
  it("환불 동시성: 같은 수강권을 동시에 2번 환불해도 환불 행은 1개(PG 취소 거래도 1건)", async () => {
    const { db, pg, deps, ctx } = refundSetup();
    const c = await ctx();
    const [a, b] = await Promise.all([handleNicepayRefund(c, UID, deps), handleNicepayRefund(c, UID, deps)]);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(db.payments.filter((p) => p.kind === "refund")).toHaveLength(1); expect(db.cancels).toHaveLength(1);
    expect([...pg.txs.values()].filter((t) => t.status === "cancelled")).toHaveLength(1);
  });
  it("이미 환불된 수강권 / 24시간 경과(blocked)는 PG를 호출하지 않는다 — 단 이전에 취소가 확인된 건은 이어서 마무리", async () => {
    const { db, pg, deps, ctx } = refundSetup(); db.faults.blocked24h = true;
    const r = await handleNicepayRefund(await ctx(), UID, deps);
    expect(r.status).toBe(409); expect(pg.count("cancel")).toBe(0);
    // 이전 요청에서 PG는 취소했지만 DB 환불이 실패한 건: blocked여도 조회로 취소가 확인되면 마무리
    const tx = [...pg.txs.values()][0]; tx.status = "cancelled";
    const r2 = await handleNicepayRefund(await ctx(), UID, deps);
    expect(r2.status).toBe(200); expect(db.memberships[0].status).toBe("refunded");
    expect((await handleNicepayRefund({ ...(await ctx()), status: "refunded" }, UID, deps)).status).toBe(409);
  });
  it("원거래 이후 후속 수기 결제가 있어도 취소 금액은 원거래 금액(ctx.amount) 전액이며 PG에 보낸 요청에는 부분취소 금액이 없다", async () => {
    const { db, pg, deps, ctx } = refundSetup(); db.payments.push({ orderId: null, amount: 5000, kind: "new" });
    expect((await handleNicepayRefund(await ctx(), UID, deps)).body.amount).toBe(AMT);
    expect(pg.calls.filter((c) => c.kind === "cancel")).toHaveLength(1);
  });
  it("lifecycle.handleRefund 연결: nicepayRefund 핸들러가 없으면(비활성/설정 불완전) 금액>0 NICEPAY 환불은 501 fail-closed, 있으면 위임. toss/portone/직접결제 경로는 영향 없음", async () => {
    const { db, deps } = refundSetup();
    const base = { getAuthUid: async () => UID, refundContext: db.refundContext, log: () => {} } as unknown as LifecycleDeps;
    expect((await handleRefund({ token: "t", membershipId: `m-${ORDER}` }, base)).status).toBe(501);
    const withHandler = { ...base, nicepayRefund: (c: Parameters<NonNullable<LifecycleDeps["nicepayRefund"]>>[0], u: string) => handleNicepayRefund(c, u, deps) } as LifecycleDeps;
    expect((await handleRefund({ token: "t", membershipId: `m-${ORDER}` }, withHandler)).status).toBe(200);
    expect(db.cancels).toHaveLength(1);
    // portone 금액>0 은 여전히 501(핸들러가 있어도 NICEPAY 전용)
    const pc = { ...withHandler, refundContext: async () => ({ membershipId: "m", status: "active", blockReason: null, orderId: "o", provider: "portone", paymentKey: "k", amount: 1000 }) } as LifecycleDeps;
    expect((await handleRefund({ token: "t", membershipId: "m" }, pc)).status).toBe(501);
  });
});

describe("불명확한 거래 조사(읽기 전용 권고) — 자동 확정 없음", () => {
  const inv = (pg: FakePg, amount = AMT) => investigateByOrderId(pg.fetch, CREDS, { orderId: ORDER, orderAmount: amount, orderDate: "20261017", now: new Date("2026-10-17T03:00:00Z") });
  it("paid + 금액 일치 → confirm_candidate, paid + 금액 다름 → cancel_candidate, 취소/미승인 → release_candidate, 거래 없음·조회 실패 → operator_required", async () => {
    const { pg } = setup(); const tid = "WHTID_1";
    pg.txs.set(tid, { orderId: ORDER, amount: AMT, status: "paid" });
    expect((await inv(pg)).action).toBe("confirm_candidate");
    expect((await inv(pg, AMT + 1)).action).toBe("cancel_candidate");
    pg.txs.get(tid)!.status = "cancelled"; expect((await inv(pg)).action).toBe("release_candidate");
    pg.txs.clear(); expect((await inv(pg)).action).toBe("operator_required");
  });
  it("조회 응답 서명이 틀리면 믿지 않는다(operator_required)", async () => {
    const { pg } = setup(); pg.txs.set("T1", { orderId: ORDER, amount: AMT, status: "paid" });
    const bad: typeof pg.fetch = async (u, i) => { const r = await pg.fetch(u, i); return { ok: r.ok, status: r.status, json: async () => ({ ...(await r.json() as Record<string, unknown>), signature: "0".repeat(64) }) }; };
    expect((await investigateByOrderId(bad, CREDS, { orderId: ORDER, orderAmount: AMT, orderDate: "20261017", now: new Date() })).action).toBe("operator_required");
  });
});

describe("결제 도메인 분리 — 회원 수강권 결제 ↔ 센터 구독료", () => {
  it("구독 주문번호/비 UUID는 회원 결제 라우트 핸들러에서 PG·DB 호출 전에 거부된다", async () => {
    const { flow } = flowSetup();
    const sub = "sub-recur-11111111-1111-4111-8111-111111111111-2026-11-01";
    expect((await handlePrepare({ token: "tok-user-1", orderId: sub }, flow)).status).toBe(400);
    expect((await handleStatus({ token: "tok-user-1", orderId: sub }, flow)).status).toBe(400);
    expect((await handleAbandon({ token: "tok-user-1", orderId: sub }, flow)).status).toBe(400);
    expect((await handleReturnPost({ authResultCode: "0000", orderId: sub }, "x", flow)).location).toContain("invalid=1");
  });
  it("도메인 판별", async () => {
    const { paymentDomainOfMoid, isMemberPassMoid } = await import("../../lib/payments/domains");
    expect(paymentDomainOfMoid(ORDER)).toBe("member_pass"); expect(isMemberPassMoid(ORDER)).toBe(true);
    expect(paymentDomainOfMoid("sub-first-11111111-1111-4111-8111-111111111111-20261017120000")).toBe("center_subscription");
    for (const bad of [undefined, null, 1, "", "abc", "sub-other-x"]) expect(paymentDomainOfMoid(bad)).toBeNull();
  });
});
