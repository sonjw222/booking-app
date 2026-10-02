/*
  실 PG 결제 서버 라이프사이클(승인/승인 전 취소/전체 환불) — 가짜 의존성으로 검증한다. 실제 토스/Supabase를 호출하지 않는다.
  + fix_pg_payment_lifecycle.sql 소스 계약(권한, search_path, Mock 확정 제한, 환불 core).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleCancel, handleConfirm, handleRefund, maskKey, type LifecycleDeps, type OrderCtx, type RefundCtx } from "../../lib/payments/server/lifecycle";
import { tossCancelPayment, tossConfirmPayment } from "../../lib/payments/server/toss";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const sql = noComments(read("fix_pg_payment_lifecycle.sql"));
const rollback = noComments(read("rollback_fix_pg_payment_lifecycle.sql"));

const OK = { ok: true as const, data: {} };
const baseOrder: OrderCtx = { orderId: "o1", status: "pending", amount: 35000, provider: "toss" };
const baseRefund: RefundCtx = { membershipId: "m1", status: "active", blockReason: null, orderId: "o1", provider: "toss", paymentKey: "pay_abcdef123456", amount: 35000 };

function deps(over: Partial<LifecycleDeps> = {}): LifecycleDeps & { calls: Record<string, ReturnType<typeof vi.fn>> } {
  const calls = {
    tossConfirm: vi.fn(async () => ({ ok: true as const, data: { orderId: "o1", totalAmount: 35000, status: "DONE" } })),
    tossCancel: vi.fn(async () => OK),
    tossGet: vi.fn(async () => ({ ok: true as const, data: { status: "DONE", orderId: "o1" } })),
    dbConfirm: vi.fn(async () => ({ data: { membership_id: "mem" }, error: null })),
    dbCancelOrder: vi.fn(async () => ({ data: { cancelled: true }, error: null })),
    dbRefund: vi.fn(async () => ({ data: { refunded: true, amount: 35000 }, error: null })),
    refundBegin: vi.fn(async () => ({ state: "locked" as const })),
    refundRelease: vi.fn(async () => ({ data: { released: true }, error: null })),
    orderContext: vi.fn(async () => baseOrder as OrderCtx | null),
    refundContext: vi.fn(async () => baseRefund as RefundCtx | null),
    log: vi.fn(),
  };
  return {
    getAuthUid: async (t: string) => (t === "good" ? "uid-1" : null),
    gateAllows: async () => true,
    ...calls, ...over, calls,
  } as any;
}

describe("[1~4] cancel API — 인증/소유권/상태", () => {
  it("비로그인(토큰 없음/무효) → 401, DB·토스 호출 없음", async () => {
    const d = deps();
    expect((await handleCancel({ token: null, orderId: "o1" }, d)).status).toBe(401);
    expect((await handleCancel({ token: "bad", orderId: "o1" }, d)).status).toBe(401);
    expect(d.calls.orderContext).not.toHaveBeenCalled();
    expect(d.calls.dbCancelOrder).not.toHaveBeenCalled();
  });
  it("다른 회원의 orderId → 404(존재 여부를 알려주지 않음), 취소 호출 없음", async () => {
    const d = deps({ orderContext: vi.fn(async () => null) });
    const r = await handleCancel({ token: "good", orderId: "someone-elses" }, d);
    expect(r.status).toBe(404);
    expect((d as any).dbCancelOrder).not.toHaveBeenCalled();
  });
  it("본인 pending PG 주문 → 취소 허용(토스 취소 API는 호출하지 않음)", async () => {
    const d = deps();
    const r = await handleCancel({ token: "good", orderId: "o1" }, d);
    expect(r).toEqual({ status: 200, body: { ok: true, cancelled: true } });
    expect(d.calls.dbCancelOrder).toHaveBeenCalledWith("o1");
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.orderContext).toHaveBeenCalledWith("o1", "uid-1");   // 서버가 토큰에서 얻은 uid로 조회(클라이언트 주장 아님)
  });
  it("done(발급된) 주문 → 단순 취소 거부 409, 이미 cancelled → 멱등 200, direct/mock 주문은 이 경로 거부", async () => {
    let d = deps({ orderContext: vi.fn(async () => ({ ...baseOrder, status: "done" })) });
    expect((await handleCancel({ token: "good", orderId: "o1" }, d)).status).toBe(409);
    expect((d as any).dbCancelOrder).not.toHaveBeenCalled();
    d = deps({ orderContext: vi.fn(async () => ({ ...baseOrder, status: "cancelled" })) });
    expect((await handleCancel({ token: "good", orderId: "o1" }, d)).body).toMatchObject({ cancelled: true, already: true });
    expect((d as any).dbCancelOrder).not.toHaveBeenCalled();
    d = deps({ orderContext: vi.fn(async () => ({ ...baseOrder, provider: "mock" })) });
    expect((await handleCancel({ token: "good", orderId: "o1" }, d)).status).toBe(400);
    d = deps({ orderContext: vi.fn(async () => ({ ...baseOrder, provider: null })) });
    expect((await handleCancel({ token: "good", orderId: "o1" }, d)).status).toBe(400);
  });
});

describe("[5~9][13] confirm — 승인 → DB 확정 → 보상", () => {
  const input = { token: "good", paymentKey: "pay_abcdef123456", orderId: "o1", amount: 35000 };

  it("[5] 토스 승인 실패 → DB 확정/보상 취소 호출 없음", async () => {
    const d = deps({ tossConfirm: vi.fn(async () => ({ ok: false as const, status: 400, code: "REJECT_CARD_COMPANY", message: "카드사 거절" })) });
    const r = await handleConfirm(input, d);
    expect(r.status).toBe(400);
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
  });
  it("[6] 승인 성공 + DB 확정 성공 → 보상 취소 호출 없음, 토스에는 DB 주문 금액으로 승인", async () => {
    const d = deps();
    const r = await handleConfirm(input, d);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, membership_id: "mem" });
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.tossConfirm).toHaveBeenCalledWith({ paymentKey: "pay_abcdef123456", orderId: "o1", amount: 35000, idempotencyKey: "confirm:o1:pay_abcdef123456" });
    expect(d.calls.dbConfirm).toHaveBeenCalledWith("o1", "pay_abcdef123456", 35000);
  });
  it("[7] 승인 성공 + DB 확정 실패 → 서버가 토스 보상 취소 정확히 1회(Idempotency-Key), 주문 취소, 원래 DB 오류 보존", async () => {
    const d = deps({
      dbConfirm: vi.fn(async () => ({ data: null, error: { message: "P0001: 포인트 사용 내역이 확인되지 않아 주문을 처리할 수 없어요" } })),
      orderContext: vi.fn().mockResolvedValueOnce(baseOrder).mockResolvedValueOnce({ ...baseOrder, status: "pending" }),
    });
    const r = await handleConfirm(input, d);
    expect(d.calls.tossCancel).toHaveBeenCalledTimes(1);
    expect(d.calls.tossCancel).toHaveBeenCalledWith("pay_abcdef123456", { cancelReason: "결제 확정 실패로 자동 취소", idempotencyKey: "compensate:o1:pay_abcdef123456" });
    expect(d.calls.dbCancelOrder).toHaveBeenCalledWith("o1");
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "payment_compensated" });
    expect(String(r.body.dbError)).toContain("포인트 사용 내역");   // 원래 오류를 삼키지 않는다
    expect(String(r.body.error)).toContain("자동으로 취소");
  });
  it("[8] 보상 취소까지 실패 → 운영자가 알 수 있는 명확한 오류 + 에러 로그(결제키는 마스킹)", async () => {
    const cancelFail = vi.fn(async () => ({ ok: false as const, status: 500, code: "FAILED_INTERNAL_SYSTEM_PROCESSING", message: "toss down" }));
    const d = deps({
      dbConfirm: vi.fn(async () => ({ data: null, error: { message: "db down" } })),
      tossCancel: cancelFail,
      orderContext: vi.fn().mockResolvedValueOnce(baseOrder).mockResolvedValueOnce(baseOrder),
    });
    const r = await handleConfirm(input, d);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "compensation_failed", orderId: "o1", dbError: "db down", cancelError: "toss down" });
    expect(String(r.body.error)).toContain("승인됐지만");
    const [level, event, fields] = d.calls.log.mock.calls.find((c) => c[1] === "PG_COMPENSATION_FAILED")!;
    expect(level).toBe("error");
    expect(JSON.stringify(fields)).not.toContain("pay_abcdef123456");   // 전체 paymentKey는 로그에 남기지 않는다
    expect(fields.paymentKey).toBe(maskKey("pay_abcdef123456"));
    expect(cancelFail).toHaveBeenCalledTimes(1);   // 재시도 폭주 없음
  });
  it("DB 확정이 실제로는 커밋됐다면(응답 유실, 재조회 done) 보상 취소하지 않는다 / 재조회까지 실패하면 자동 취소하지 않고 운영 알림", async () => {
    let d = deps({
      dbConfirm: vi.fn(async () => ({ data: null, error: { message: "timeout" } })),
      orderContext: vi.fn().mockResolvedValueOnce(baseOrder).mockResolvedValueOnce({ ...baseOrder, status: "done" }),
    });
    let r = await handleConfirm(input, d);
    expect(r.status).toBe(200);
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    d = deps({
      dbConfirm: vi.fn(async () => ({ data: null, error: { message: "timeout" } })),
      orderContext: vi.fn().mockResolvedValueOnce(baseOrder).mockRejectedValueOnce(new Error("db unreachable")),
    });
    r = await handleConfirm(input, d);
    expect(r.body).toMatchObject({ code: "confirm_state_unknown" });
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.log).toHaveBeenCalledWith("error", "PG_CONFIRM_STATE_UNKNOWN", expect.anything());
  });
  it("[9] 동일 confirm 재요청: 이미 done이면 토스/DB를 다시 호출하지 않고 성공(이중 발급·이중 취소 없음)", async () => {
    const d = deps({ orderContext: vi.fn(async () => ({ ...baseOrder, status: "done" })) });
    const r = await handleConfirm(input, d);
    expect(r).toEqual({ status: 200, body: { ok: true, already_done: true } });
    expect(d.calls.tossConfirm).not.toHaveBeenCalled();
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
  });
  it("[13] 변조 방어: 비로그인 401 / 남의 주문 404 / amount 불일치 400 / provider 불일치 400 — 모두 토스 호출 전에 차단", async () => {
    let d = deps();
    expect((await handleConfirm({ ...input, token: null }, d)).status).toBe(401);
    d = deps({ orderContext: vi.fn(async () => null) });
    expect((await handleConfirm(input, d)).status).toBe(404);
    d = deps();
    expect((await handleConfirm({ ...input, amount: 1000 }, d)).status).toBe(400);   // 클라이언트가 낮춘 금액
    expect(d.calls.tossConfirm).not.toHaveBeenCalled();
    d = deps({ orderContext: vi.fn(async () => ({ ...baseOrder, provider: "mock" })) });
    expect((await handleConfirm(input, d)).status).toBe(400);
    d = deps({ orderContext: vi.fn(async () => ({ ...baseOrder, provider: null })) });
    expect((await handleConfirm(input, d)).status).toBe(400);
    expect(d.calls.tossConfirm).not.toHaveBeenCalled();
    expect((await handleConfirm({ ...input, paymentKey: 123 as any }, deps())).status).toBe(400);
  });
  it("[14] cancelled 주문은 결제/확정 불가(토스 호출 전 409)", async () => {
    const d = deps({ orderContext: vi.fn(async () => ({ ...baseOrder, status: "cancelled" })) });
    const r = await handleConfirm(input, d);
    expect(r.status).toBe(409);
    expect(d.calls.tossConfirm).not.toHaveBeenCalled();
  });
  it("토스 승인 응답의 orderId/금액이 주문과 다르면 DB 확정 대신 보상 취소", async () => {
    const d = deps({ tossConfirm: vi.fn(async () => ({ ok: true as const, data: { orderId: "other-order", totalAmount: 35000 } })) });
    const r = await handleConfirm(input, d);
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
    expect(d.calls.tossCancel).toHaveBeenCalledTimes(1);
    expect(r.body).toMatchObject({ code: "payment_compensated" });
  });
  it("PG 게이트가 꺼져 있으면 토스 호출 전에 403", async () => {
    const d = deps({ gateAllows: async () => false });
    expect((await handleConfirm(input, d)).status).toBe(403);
    expect(d.calls.tossConfirm).not.toHaveBeenCalled();
  });
  it("승인 요청의 응답을 못 받으면(네트워크) 토스 결제 조회로 확인: 미승인이면 DB 확정/취소 없이 오류, DONE이면 이어서 확정", async () => {
    const net = { ok: false as const, status: 0, code: "NETWORK_ERROR", message: "timeout" };
    let d = deps({ tossConfirm: vi.fn(async () => net), tossGet: vi.fn(async () => ({ ok: false as const, status: 404, code: "NOT_FOUND_PAYMENT", message: "no" })) });
    expect((await handleConfirm(input, d)).body).toMatchObject({ code: "toss_confirm_unknown" });
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    d = deps({ tossConfirm: vi.fn(async () => net) });   // tossGet 기본: DONE
    expect((await handleConfirm(input, d)).status).toBe(200);
    expect(d.calls.dbConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("[10~12] 전체 환불", () => {
  const input = { token: "good", membershipId: "m1" };
  it("[10] 인증/본인 소유 확인: 비로그인 401, 남의 수강권 404 — 토스/DB 환불 호출 없음", async () => {
    let d = deps();
    expect((await handleRefund({ ...input, token: null }, d)).status).toBe(401);
    d = deps({ refundContext: vi.fn(async () => null) });
    expect((await handleRefund(input, d)).status).toBe(404);
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.dbRefund).not.toHaveBeenCalled();
  });
  it("실 PG 환불: 토스 취소(전액, 멱등키) → DB 환불(PG 허용 + 조건 재검사 생략) 순서", async () => {
    const order: string[] = [];
    const d = deps({
      tossCancel: vi.fn(async () => { order.push("toss"); return OK; }),
      dbRefund: vi.fn(async () => { order.push("db"); return { data: { refunded: true, amount: 35000 }, error: null }; }),
    });
    const r = await handleRefund(input, d);
    expect(r.status).toBe(200);
    expect(order).toEqual(["toss", "db"]);
    expect((d as any).tossCancel).toHaveBeenCalledWith("pay_abcdef123456", { cancelReason: "회원 환불 요청", idempotencyKey: "refund:m1" });
    expect((d as any).dbRefund).toHaveBeenCalledWith("m1", "uid-1", { allowPg: true, skipTimeCheck: true });
  });
  it("토스 취소 실패 → DB 환불을 하지 않는다(돈도 수강권도 그대로, 다시 시도 가능)", async () => {
    const d = deps({ tossCancel: vi.fn(async () => ({ ok: false as const, status: 500, code: "FAILED", message: "x" })) });
    const r = await handleRefund(input, d);
    expect(r.body).toMatchObject({ code: "pg_cancel_failed" });
    expect(d.calls.dbRefund).not.toHaveBeenCalled();
  });
  it("토스 취소 성공 + DB 환불 실패 → 1회 재시도 후 운영 로그/명확한 오류, 같은 요청 재시도는 토스 '이미 취소됨'으로 DB만 이어서 처리", async () => {
    const fail = vi.fn(async () => ({ data: null, error: { message: "db error" } }));
    const d = deps({ dbRefund: fail });
    const r = await handleRefund(input, d);
    expect(fail).toHaveBeenCalledTimes(2);
    expect(r.body).toMatchObject({ code: "refund_db_failed_after_pg_cancel", dbError: "db error" });
    expect(d.calls.log).toHaveBeenCalledWith("error", "PG_REFUND_DB_FAILED_AFTER_PG_CANCEL", expect.anything());
    // 재시도: 토스는 이미 취소됨 → 성공으로 취급하고 DB만 마무리
    const retry = deps({ tossCancel: vi.fn(async () => ({ ok: false as const, status: 400, code: "ALREADY_CANCELED_PAYMENT", message: "이미 취소됨" })) });
    expect((await handleRefund(input, retry)).status).toBe(200);
    expect(retry.calls.dbRefund).toHaveBeenCalledTimes(1);
  });
  it("환불 불가(blocked, 24시간 경과 등)이고 토스가 아직 승인 상태면 토스 취소 없이 거부, 이미 CANCELED(이전 요청의 DB 실패)면 이어서 마무리", async () => {
    const reason = "결제 후 24시간이 지나 셀프 환불이 어려워요. 센터에 문의해주세요.";
    let d = deps({ refundBegin: vi.fn(async () => ({ state: "blocked" as const, reason })) });
    let r = await handleRefund(input, d);
    expect(r).toMatchObject({ status: 409 });
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.dbRefund).not.toHaveBeenCalled();
    d = deps({ refundBegin: vi.fn(async () => ({ state: "blocked" as const, reason })), tossGet: vi.fn(async () => ({ ok: true as const, data: { status: "CANCELED" } })) });
    r = await handleRefund(input, d);
    expect(r.status).toBe(200);
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.dbRefund).toHaveBeenCalledWith("m1", "uid-1", { allowPg: true, skipTimeCheck: true });
  });
  it("[11] direct/manual/mock 환불: 토스를 호출하지 않고 기존 DB 환불(PG 허용 없음)", async () => {
    for (const provider of [null, "mock"]) {
      const d = deps({ refundContext: vi.fn(async () => ({ ...baseRefund, provider, paymentKey: null })) });
      const r = await handleRefund(input, d);
      expect(r.status).toBe(200);
      expect(d.calls.tossCancel).not.toHaveBeenCalled();
      expect(d.calls.tossGet).not.toHaveBeenCalled();
      expect(d.calls.dbRefund).toHaveBeenCalledWith("m1", "uid-1", { allowPg: false, skipTimeCheck: false });
    }
  });
  it("0원 PG 주문(포인트/쿠폰 전액)은 토스 취소 없이 DB 환불만, PG인데 결제키가 없으면 환불 보류", async () => {
    let d = deps({ refundContext: vi.fn(async () => ({ ...baseRefund, amount: 0 })) });
    expect((await handleRefund(input, d)).status).toBe(200);
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.dbRefund).toHaveBeenCalledWith("m1", "uid-1", { allowPg: true, skipTimeCheck: false });
    d = deps({ refundContext: vi.fn(async () => ({ ...baseRefund, paymentKey: null })) });
    expect((await handleRefund(input, d)).body).toMatchObject({ code: "no_payment_key" });
    expect(d.calls.dbRefund).not.toHaveBeenCalled();
  });
  it("[12] 동일 환불 재요청: 이미 환불된 수강권은 409(토스/DB 재호출 없음), 동시 요청의 DB '이미 환불'은 성공으로 수렴", async () => {
    let d = deps({ refundContext: vi.fn(async () => ({ ...baseRefund, status: "refunded" })) });
    expect((await handleRefund(input, d)).body).toMatchObject({ code: "already_refunded" });
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    d = deps({ dbRefund: vi.fn(async () => ({ data: null, error: { message: "P0001: 이미 환불된 수강권이에요" } })) });
    expect((await handleRefund(input, d)).body).toMatchObject({ refunded: true, already: true });
    expect((d as any).dbRefund).toHaveBeenCalledTimes(1);   // '이미 환불'은 재시도하지 않는다
  });
});

describe("[1] ALREADY_PROCESSED_PAYMENT 복구 — 토스 실제 상태 기준 수렴", () => {
  const input = { token: "good", paymentKey: "pay_abcdef123456", orderId: "o1", amount: 35000 };
  const already = { ok: false as const, status: 409, code: "ALREADY_PROCESSED_PAYMENT", message: "이미 처리된 결제" };
  const doneData = { status: "DONE", orderId: "o1", totalAmount: 35000 };

  it("DB가 이미 done이면 기존처럼 성공(토스 조회/DB 재확정 없음)", async () => {
    const d = deps({ tossConfirm: vi.fn(async () => already), orderContext: vi.fn().mockResolvedValueOnce(baseOrder).mockResolvedValueOnce({ ...baseOrder, status: "done" }) });
    expect((await handleConfirm(input, d)).body).toMatchObject({ already_done: true });
    expect(d.calls.tossGet).not.toHaveBeenCalled();
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
  });
  it("DB pending + 토스 DONE(주문/금액 일치) → DB 확정을 이어서 실행해 성공(승인은 다시 하지 않음)", async () => {
    const d = deps({ tossConfirm: vi.fn(async () => already), tossGet: vi.fn(async () => ({ ok: true as const, data: doneData })) });
    const r = await handleConfirm(input, d);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, membership_id: "mem" });
    expect(d.calls.dbConfirm).toHaveBeenCalledWith("o1", "pay_abcdef123456", 35000);
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
  });
  it("복구 중 DB 확정이 실패하면 기존 경로(상태 재조회 → 필요 시 보상 취소 1회)를 재사용", async () => {
    const d = deps({
      tossConfirm: vi.fn(async () => already), tossGet: vi.fn(async () => ({ ok: true as const, data: doneData })),
      dbConfirm: vi.fn(async () => ({ data: null, error: { message: "P0001: 주문 금액이 서버 계산 금액과 달라요" } })),
    });
    const r = await handleConfirm(input, d);
    expect(d.calls.tossCancel).toHaveBeenCalledTimes(1);
    expect(r.body).toMatchObject({ code: "payment_compensated" });
  });
  it("토스 orderId 불일치 → DB 확정 금지(남의 결제를 취소하지도 않음)", async () => {
    const d = deps({ tossConfirm: vi.fn(async () => already), tossGet: vi.fn(async () => ({ ok: true as const, data: { ...doneData, orderId: "other" } })) });
    const r = await handleConfirm(input, d);
    expect(r.body).toMatchObject({ code: "payment_mismatch" });
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
  });
  it("토스 금액 불일치 → DB 확정 금지", async () => {
    const d = deps({ tossConfirm: vi.fn(async () => already), tossGet: vi.fn(async () => ({ ok: true as const, data: { ...doneData, totalAmount: 1000 } })) });
    expect((await handleConfirm(input, d)).body).toMatchObject({ code: "payment_mismatch" });
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
  });
  it("토스 CANCELED → DB 주문도 cancelled로 수렴(dbCancelOrder, 포인트 복원은 DB 트리거), 새 승인/취소 없음", async () => {
    const d = deps({ tossConfirm: vi.fn(async () => already), tossGet: vi.fn(async () => ({ ok: true as const, data: { status: "CANCELED" } })) });
    const r = await handleConfirm(input, d);
    expect(r.body).toMatchObject({ code: "payment_canceled" });
    expect(d.calls.dbCancelOrder).toHaveBeenCalledWith("o1");
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
  });
  it("토스 CANCELED + DB가 이미 cancelled → 멱등(추가 호출 없음)", async () => {
    const d = deps({
      tossConfirm: vi.fn(async () => already), tossGet: vi.fn(async () => ({ ok: true as const, data: { status: "CANCELED" } })),
      orderContext: vi.fn().mockResolvedValueOnce(baseOrder).mockResolvedValueOnce({ ...baseOrder, status: "cancelled" }),
    });
    expect((await handleConfirm(input, d)).body).toMatchObject({ code: "payment_canceled", already: true });
    expect(d.calls.dbCancelOrder).not.toHaveBeenCalled();
  });
  it("토스 조회 실패/알 수 없는 상태 → state_unknown + 운영 로그, DB 확정/취소를 임의로 실행하지 않음", async () => {
    for (const get of [
      vi.fn(async () => ({ ok: false as const, status: 500, code: null, message: "toss down" })),
      vi.fn(async () => ({ ok: true as const, data: { status: "WAITING_FOR_DEPOSIT" } })),
    ]) {
      const d = deps({ tossConfirm: vi.fn(async () => already), tossGet: get });
      const r = await handleConfirm(input, d);
      expect(r.body).toMatchObject({ code: "state_unknown" });
      expect(d.calls.dbConfirm).not.toHaveBeenCalled();
      expect(d.calls.dbCancelOrder).not.toHaveBeenCalled();
      expect(d.calls.tossCancel).not.toHaveBeenCalled();
      expect(d.calls.log).toHaveBeenCalledWith("error", "PG_CONFIRM_STATE_UNKNOWN", expect.anything());
    }
  });
  it("토스 DONE인데 DB 주문이 이미 cancelled → 돈만 승인된 상태이므로 보상 취소로 정리", async () => {
    const d = deps({
      tossConfirm: vi.fn(async () => already), tossGet: vi.fn(async () => ({ ok: true as const, data: doneData })),
      orderContext: vi.fn().mockResolvedValueOnce(baseOrder).mockResolvedValueOnce({ ...baseOrder, status: "cancelled" }),
    });
    await handleConfirm(input, d);
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
    expect(d.calls.tossCancel).toHaveBeenCalledTimes(1);
  });
  it("동시 복구 요청: 둘 다 dbConfirm을 부르지만 DB(confirm_real_payment)가 주문 행 잠금 + done 선처리로 한 번만 발급 — 두 번째는 already_done", async () => {
    const calls: string[] = [];
    let issued = 0;
    const dbConfirm = vi.fn(async () => { calls.push("c"); if (issued++ === 0) return { data: { membership_id: "mem" }, error: null }; return { data: { already_done: true }, error: null }; });
    const mk = () => deps({ tossConfirm: vi.fn(async () => already), tossGet: vi.fn(async () => ({ ok: true as const, data: doneData })), dbConfirm });
    const [a, b] = await Promise.all([handleConfirm(input, mk()), handleConfirm(input, mk())]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(issued).toBe(2);   // 호출은 2번이지만 발급은 첫 번째만(두 번째는 already_done)
    expect([a.body.membership_id, b.body.membership_id].filter(Boolean)).toHaveLength(1);
    expect(read("fix_order_point_lifecycle.sql")).toContain("if v_order.status = 'done' then");
  });
  it("토스가 이미 CANCELED인 결제를 다시 승인 요청하면(ALREADY_CANCELED_PAYMENT) 같은 복구 경로로 DB 주문을 정리", async () => {
    const d = deps({
      tossConfirm: vi.fn(async () => ({ ok: false as const, status: 400, code: "ALREADY_CANCELED_PAYMENT", message: "이미 취소됨" })),
      tossGet: vi.fn(async () => ({ ok: true as const, data: { status: "CANCELED" } })),
    });
    expect((await handleConfirm(input, d)).body).toMatchObject({ code: "payment_canceled" });
    expect(d.calls.dbCancelOrder).toHaveBeenCalledTimes(1);
  });
});

describe("[1] DB cancelled + 토스 DONE 복구(취소/승인 경합)", () => {
  const input = { token: "good", paymentKey: "pay_abcdef123456", orderId: "o1", amount: 35000 };
  const cancelled = { ...baseOrder, status: "cancelled" };
  const doneData = { status: "DONE", orderId: "o1", totalAmount: 35000 };

  it("DB cancelled + 토스 DONE + 주문/금액 일치 → 토스 승인 취소 정확히 1회(멱등키), 새 승인/DB 확정은 절대 없음", async () => {
    const d = deps({ orderContext: vi.fn(async () => cancelled), tossGet: vi.fn(async () => ({ ok: true as const, data: doneData })) });
    const r = await handleConfirm(input, d);
    expect(d.calls.tossCancel).toHaveBeenCalledTimes(1);
    expect(d.calls.tossCancel).toHaveBeenCalledWith("pay_abcdef123456", expect.objectContaining({ idempotencyKey: "compensate:o1:pay_abcdef123456" }));
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
    expect((d as any).tossConfirm).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ code: "payment_compensated" });
  });
  it("orderId 불일치 → 토스 취소 0회(남의 결제를 취소하지 않음) + payment_mismatch + 운영 로그", async () => {
    const d = deps({ orderContext: vi.fn(async () => cancelled), tossGet: vi.fn(async () => ({ ok: true as const, data: { ...doneData, orderId: "other" } })) });
    const r = await handleConfirm(input, d);
    expect(r.body).toMatchObject({ code: "payment_mismatch" });
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
    expect(d.calls.log).toHaveBeenCalledWith("error", "PG_RECOVER_MISMATCH", expect.anything());
  });
  it("금액 불일치 → 토스 취소 0회", async () => {
    const d = deps({ orderContext: vi.fn(async () => cancelled), tossGet: vi.fn(async () => ({ ok: true as const, data: { ...doneData, totalAmount: 1000 } })) });
    expect((await handleConfirm(input, d)).body).toMatchObject({ code: "payment_mismatch" });
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
  });
  it("토스 CANCELED → 멱등 payment_canceled, 새 토스 cancel/confirm과 DB 호출 없음", async () => {
    const d = deps({ orderContext: vi.fn(async () => cancelled), tossGet: vi.fn(async () => ({ ok: true as const, data: { status: "CANCELED" } })) });
    const r = await handleConfirm(input, d);
    expect(r.body).toMatchObject({ code: "payment_canceled", already: true });
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect((d as any).tossConfirm).not.toHaveBeenCalled();
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
    expect(d.calls.dbCancelOrder).not.toHaveBeenCalled();
  });
  it("토스 조회 실패/기타 상태 → state_unknown, 금전·DB 변경 없음", async () => {
    for (const get of [
      vi.fn(async () => ({ ok: false as const, status: 0, code: "NETWORK_ERROR", message: "timeout" })),
      vi.fn(async () => ({ ok: true as const, data: { status: "IN_PROGRESS" } })),
    ]) {
      const d = deps({ orderContext: vi.fn(async () => cancelled), tossGet: get });
      expect((await handleConfirm(input, d)).body).toMatchObject({ code: "state_unknown" });
      expect(d.calls.tossCancel).not.toHaveBeenCalled();
      expect(d.calls.dbConfirm).not.toHaveBeenCalled();
      expect(d.calls.dbCancelOrder).not.toHaveBeenCalled();
    }
  });
  it("cancelled 경로에서도 로그인/소유권/금액 검증이 먼저 적용된다(401/404/400 — 토스 조회 전)", async () => {
    let d = deps({ orderContext: vi.fn(async () => cancelled) });
    expect((await handleConfirm({ ...input, token: null }, d)).status).toBe(401);
    expect((await handleConfirm({ ...input, amount: 1 }, d)).status).toBe(400);
    d = deps({ orderContext: vi.fn(async () => null) });
    expect((await handleConfirm(input, d)).status).toBe(404);
    expect(d.calls.tossGet).not.toHaveBeenCalled();
  });
  it("done은 즉시 성공, pending은 기존 승인 흐름(토스 confirm 호출)", async () => {
    let d = deps({ orderContext: vi.fn(async () => ({ ...baseOrder, status: "done" })) });
    expect((await handleConfirm(input, d)).body).toMatchObject({ already_done: true });
    expect(d.calls.tossGet).not.toHaveBeenCalled();
    d = deps();
    await handleConfirm(input, d);
    expect(d.calls.tossConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("[2][4] 예약 트리거 직렬화 / 활성 예약 포함 미사용 판정 — SQL 계약", () => {
  const guard = sql.slice(sql.indexOf("create or replace function reservations_guard_pg_refund_lock"), sql.indexOf("revoke all on function reservations_guard_pg_refund_lock"));
  it("reservations 트리거: BEFORE INSERT OR UPDATE OF status, membership_id (취소/복구 경로는 별도 처리)", () => {
    expect(sql).toContain("before insert or update of status, membership_id on reservations");
  });
  it("수강권 행을 FOR UPDATE로 잠근 뒤 표시를 확인한다(pg_refund_begin과 같은 잠금) — 일반 SELECT/exists 확인이 아니다", () => {
    expect(guard).toContain("select pg_refund_started_at into v_started from memberships where id = new.membership_id for update;");
    expect(guard).not.toMatch(/exists\s*\(\s*select 1 from memberships/);
    const b = sql.slice(sql.indexOf("create or replace function pg_refund_begin"), sql.indexOf("create or replace function pg_refund_release"));
    expect(b).toContain("for update;");   // begin도 같은 FOR UPDATE
    expect(guard.indexOf("for update;")).toBeLessThan(guard.indexOf("if v_started is not null then"));
  });
  it("활성 상태(confirmed/waitlisted/attended/no_show)로 들어가거나 수강권이 바뀌는 경우만 검사 — cancelled로 가는 경로와 변화 없는 UPDATE는 통과", () => {
    expect(guard).toContain("new.status not in ('confirmed', 'waitlisted', 'attended', 'no_show')");
    expect(guard).toContain("new.status is not distinct from old.status and new.membership_id is not distinct from old.membership_id");
    expect(guard.indexOf("new.status not in")).toBeLessThan(guard.indexOf("for update;"));   // cancelled는 잠금도 잡지 않고 즉시 통과
  });
  it("대기→확정 승격 / 취소 복구 / 잠긴 수강권으로의 변경이 같은 검사에 걸린다(status 또는 membership_id 변경)", () => {
    expect(guard).toContain("tg_op = 'UPDATE'");
    expect(guard).toContain("환불 처리 중인 수강권이라 지금은 예약에 사용할 수 없어요");
  });
  it("트리거 함수 권한: PUBLIC/anon/authenticated 실행 차단, SECURITY DEFINER + search_path", () => {
    expect(sql).toContain("revoke all on function reservations_guard_pg_refund_lock() from public, anon, authenticated;");
    expect(guard).toContain("security definer");
    expect(guard).toContain("set search_path = public");
  });
  it("미사용 판정(_refund_block_reason)이 횟수 소비 + 현재 활성 예약을 함께 본다(무제한/대기 포함), cancelled 제외, skip은 시간 조건에만", () => {
    const h = sql.slice(sql.indexOf("create or replace function _refund_block_reason"), sql.indexOf("revoke all on function _refund_block_reason"));
    expect(h).toContain("from reservations r");
    expect(h).toContain("r.membership_id = p_mem.id and r.status in ('confirmed', 'waitlisted', 'attended', 'no_show')");
    expect(h).not.toContain("'cancelled'");   // 취소된 예약은 환불을 막지 않는다
    expect(h).toContain("v_hours > 24 and not coalesce(p_skip_time, false)");
    const after = h.slice(h.indexOf("p_mem.remaining_count is distinct"));
    expect(after).not.toContain("p_skip_time");   // 횟수/예약 검사는 skip과 무관
    expect(h).toContain("stable");
  });
  it("begin / core / context가 모두 같은 _refund_block_reason을 쓴다(source of truth 하나)", () => {
    expect((sql.match(/_refund_block_reason\(v_mem/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it("lock 순서: begin/core는 수강권 행만 잠그고 예약/수업 행을 잠그지 않는다(역방향 대기 없음) — 예약 RPC 본문은 수정하지 않는다", () => {
    const begin = sql.slice(sql.indexOf("create or replace function pg_refund_begin"), sql.indexOf("create or replace function pg_refund_release"));
    expect(begin).not.toMatch(/from (reservations|classes)[^;]*for update/);
    expect(sql).not.toMatch(/create or replace function (public\.)?(cancel_reservation|reserve_class|reserve_with_membership|manager_set_attendance)\(/i);
  });
  it("적용 후 검증 SQL: 예약 트리거 이벤트/잠금/미사용 판정/권한/정체 표시", () => {
    const raw = read("fix_pg_payment_lifecycle.sql");
    for (const x of ["reservation_guard_event_must_be_true", "reservation_guard_locks_membership_must_be_true", "unused_check_includes_reservations_must_be_true", "reservation_guard_auth_must_be_false", "block_reason_auth_must_be_false", "stuck_refund_locks_should_be_0"]) expect(raw).toContain(x);
  });
  it("동시성 Production QA 후보는 별도 명령으로만 존재하고 기본 테스트에 섞이지 않는다(로컬 Postgres 없음 — 순차+병렬 불변식)", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts["qa:production:pg-refund-lock"]).toBe("vitest run --config vitest.qa-production.config.ts tests/qa/scenarios/pg-refund-lock.qa.test.ts");
    for (const k of ["test", "test:integration"]) expect(scripts[k] ?? "").not.toMatch(/qa/);
    const sc = read("tests/qa/scenarios/pg-refund-lock.qa.test.ts");
    for (const x of ["pg_refund_begin", "환불 처리 중", "waitlisted", "무제한", "locked && active", "cleanupFixtures"]) expect(sc).toContain(x);
  });
});

describe("[2] 보상 취소 후 DB 주문 정리 실패", () => {
  const input = { token: "good", paymentKey: "pay_abcdef123456", orderId: "o1", amount: 35000 };
  const dbFail = { data: null, error: { message: "P0001: 포인트 사용 내역이 확인되지 않아요" } };
  const mkFail = (cancelOrder: ReturnType<typeof vi.fn>) => deps({
    dbConfirm: vi.fn(async () => dbFail), dbCancelOrder: cancelOrder as any,
    orderContext: vi.fn().mockResolvedValueOnce(baseOrder).mockResolvedValueOnce(baseOrder),
  });
  it("토스 취소 성공 + dbCancel 1회 실패 후 2회차 성공 → 일반 payment_compensated(최대 1회 재시도)", async () => {
    const cancelOrder = vi.fn().mockResolvedValueOnce({ data: null, error: { message: "blip" } }).mockResolvedValueOnce({ data: { cancelled: true }, error: null });
    const d = mkFail(cancelOrder);
    const r = await handleConfirm(input, d);
    expect(cancelOrder).toHaveBeenCalledTimes(2);
    expect(r.body).toMatchObject({ code: "payment_compensated" });
    expect(d.calls.tossCancel).toHaveBeenCalledTimes(1);   // 토스는 한 번만 취소
  });
  it("dbCancel 2회 모두 실패 → payment_compensated_db_cleanup_failed(카드 취소됨/주문·포인트 정리 미완료/주문번호 문의) + 로그", async () => {
    const cancelOrder = vi.fn(async () => ({ data: null, error: { message: "db down" } }));
    const d = mkFail(cancelOrder);
    const r = await handleConfirm(input, d);
    expect(cancelOrder).toHaveBeenCalledTimes(2);   // 최대 1회 재시도
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "payment_compensated_db_cleanup_failed", orderId: "o1", dbError: "db down" });
    expect(String(r.body.error)).toContain("승인은 취소됐지만");
    expect(String(r.body.error)).toContain("주문번호");
    const [level, , fields] = d.calls.log.mock.calls.find((c) => c[1] === "PG_COMPENSATION_DB_CLEANUP_FAILED")!;
    expect(level).toBe("error");
    expect(JSON.stringify(fields)).not.toContain("pay_abcdef123456");
    expect(fields.originalError).toContain("포인트 사용 내역");   // 원래 DB 오류 보존
    expect(d.calls.tossCancel).toHaveBeenCalledTimes(1);
  });
  it("이후 재요청: 토스가 이미 CANCELED → 새 승인/취소 없이 dbCancelOrder로 정리 수렴", async () => {
    const d = deps({
      tossConfirm: vi.fn(async () => ({ ok: false as const, status: 400, code: "ALREADY_CANCELED_PAYMENT", message: "이미 취소됨" })),
      tossGet: vi.fn(async () => ({ ok: true as const, data: { status: "CANCELED" } })),
    });
    const r = await handleConfirm(input, d);
    expect(d.calls.dbCancelOrder).toHaveBeenCalledWith("o1");
    expect(r.body).toMatchObject({ code: "payment_canceled" });
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.dbConfirm).not.toHaveBeenCalled();
  });
  it("복구 경로의 정리가 계속 실패해도 같은 cleanup_failed 코드로 구분되어 보고", async () => {
    const d = deps({
      tossConfirm: vi.fn(async () => ({ ok: false as const, status: 409, code: "ALREADY_PROCESSED_PAYMENT", message: "x" })),
      tossGet: vi.fn(async () => ({ ok: true as const, data: { status: "CANCELED" } })),
      dbCancelOrder: vi.fn(async () => ({ data: null, error: { message: "db down" } })),
    });
    expect((await handleConfirm(input, d)).body).toMatchObject({ code: "payment_compensated_db_cleanup_failed" });
  });
});

describe("[3] PG 환불 TOCTOU — DB 환불 진행 표시", () => {
  const input = { token: "good", membershipId: "m1" };
  it("환불은 begin(DB 행 잠금 + 조건 확인 + 표시) → 토스 취소 → DB 환불 순서이고, begin 이후에는 skipTimeCheck=true로 시간 조건만 건너뛴다", async () => {
    const order: string[] = [];
    const d = deps({
      refundBegin: vi.fn(async () => { order.push("begin"); return { state: "locked" as const }; }),
      tossCancel: vi.fn(async () => { order.push("toss"); return OK; }),
      dbRefund: vi.fn(async () => { order.push("db"); return { data: { refunded: true }, error: null }; }),
    });
    expect((await handleRefund(input, d)).status).toBe(200);
    expect(order).toEqual(["begin", "toss", "db"]);
    expect((d as any).dbRefund).toHaveBeenCalledWith("m1", "uid-1", { allowPg: true, skipTimeCheck: true });
  });
  it("begin이 '이미 사용함' 등으로 blocked를 돌려주면 토스 취소를 하지 않는다(표시도 걸리지 않음)", async () => {
    const d = deps({ refundBegin: vi.fn(async () => ({ state: "blocked" as const, reason: "이미 사용한 수강권은 셀프 환불이 어려워요. 센터에 문의해주세요." })) });
    const r = await handleRefund(input, d);
    expect(r.status).toBe(409);
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.dbRefund).not.toHaveBeenCalled();
  });
  it("토스 취소가 명확히 실패하면 표시를 해제해 수강권을 이용 가능 상태로 복구하고 DB 환불은 하지 않는다", async () => {
    const d = deps({ tossCancel: vi.fn(async () => ({ ok: false as const, status: 400, code: "INVALID_REQUEST", message: "거절" })) });
    const r = await handleRefund(input, d);
    expect(r.body).toMatchObject({ code: "pg_cancel_failed" });
    expect(d.calls.refundRelease).toHaveBeenCalledWith("m1", "uid-1");
    expect(d.calls.dbRefund).not.toHaveBeenCalled();
  });
  it("결과가 불확실한 토스 실패(네트워크/5xx): 토스 조회로 확인 — 미취소면 해제, 이미 CANCELED면 해제하지 않고 DB 환불 진행, 조회도 실패하면 표시를 유지", async () => {
    const net = { ok: false as const, status: 0, code: "NETWORK_ERROR", message: "timeout" };
    let d = deps({ tossCancel: vi.fn(async () => net), tossGet: vi.fn(async () => ({ ok: true as const, data: { status: "DONE" } })) });
    expect((await handleRefund(input, d)).body).toMatchObject({ code: "pg_cancel_failed" });
    expect(d.calls.refundRelease).toHaveBeenCalledTimes(1);
    d = deps({ tossCancel: vi.fn(async () => net), tossGet: vi.fn(async () => ({ ok: true as const, data: { status: "CANCELED" } })) });
    expect((await handleRefund(input, d)).status).toBe(200);
    expect(d.calls.refundRelease).not.toHaveBeenCalled();
    expect(d.calls.dbRefund).toHaveBeenCalledTimes(1);
    d = deps({ tossCancel: vi.fn(async () => net), tossGet: vi.fn(async () => ({ ok: false as const, status: 500, code: null, message: "down" })) });
    expect((await handleRefund(input, d)).body).toMatchObject({ code: "pg_cancel_unknown" });
    expect(d.calls.refundRelease).not.toHaveBeenCalled();   // 취소됐을 수 있으므로 수강권을 풀지 않는다
    expect(d.calls.dbRefund).not.toHaveBeenCalled();
  });
  it("토스 취소 성공 + DB 환불 실패 → 표시는 남고(해제 호출 없음), 재요청은 resumed로 이어서 토스(이미 취소됨) → DB 환불 완료", async () => {
    const dbFail = vi.fn(async () => ({ data: null, error: { message: "db error" } }));
    let d = deps({ dbRefund: dbFail });
    expect((await handleRefund(input, d)).body).toMatchObject({ code: "refund_db_failed_after_pg_cancel" });
    expect(d.calls.refundRelease).not.toHaveBeenCalled();
    d = deps({
      refundBegin: vi.fn(async () => ({ state: "resumed" as const })),
      tossCancel: vi.fn(async () => ({ ok: false as const, status: 400, code: "ALREADY_CANCELED_PAYMENT", message: "이미 취소됨" })),
    });
    expect((await handleRefund(input, d)).status).toBe(200);
    expect(d.calls.dbRefund).toHaveBeenCalledWith("m1", "uid-1", { allowPg: true, skipTimeCheck: true });
    expect(d.calls.refundRelease).not.toHaveBeenCalled();
  });
  it("중복 환불 요청: begin이 refunded면 409, 동시 두 요청 중 하나가 먼저 끝나면 두 번째 DB '이미 환불'은 성공으로 수렴(토스 멱등키 동일)", async () => {
    let d = deps({ refundBegin: vi.fn(async () => ({ state: "refunded" as const })) });
    expect((await handleRefund(input, d)).body).toMatchObject({ code: "already_refunded" });
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    const a = deps(); const b = deps({ refundBegin: vi.fn(async () => ({ state: "resumed" as const })), dbRefund: vi.fn(async () => ({ data: null, error: { message: "이미 환불된 수강권이에요" } })) });
    const [ra, rb] = await Promise.all([handleRefund(input, a), handleRefund(input, b)]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect((a as any).tossCancel.mock.calls[0][1].idempotencyKey).toBe("refund:m1");
    expect((b as any).tossCancel.mock.calls[0][1].idempotencyKey).toBe("refund:m1");
  });
  it("direct/manual/mock 환불은 환불 표시/토스를 거치지 않는다(회귀)", async () => {
    const d = deps({ refundContext: vi.fn(async () => ({ ...baseRefund, provider: null, paymentKey: null })) });
    expect((await handleRefund(input, d)).status).toBe(200);
    expect(d.calls.refundBegin).not.toHaveBeenCalled();
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
  });
});

describe("[3] 환불 진행 중 사용 차단 — SQL 계약", () => {
  const trig = sql.slice(sql.indexOf("create or replace function memberships_guard_pg_refund"), sql.indexOf("create or replace function reservations_guard_pg_refund_lock"));
  it("durable 표시: memberships.pg_refund_started_at(nullable) — 서버 재시작 후에도 식별 가능", () => {
    expect(sql).toContain("alter table memberships add column if not exists pg_refund_started_at timestamptz;");
  });
  it("표시 중에는 remaining_count 감소(모든 예약/출석 차감 경로)를 거부하고 복구(증가)는 허용, 환불 core/begin/release만 서버 쓰기로 예외", () => {
    expect(trig).toContain("old.pg_refund_started_at is not null and not v_writer");
    expect(trig).toContain("new.remaining_count < old.remaining_count");
    expect(trig).toContain("환불 처리 중인 수강권이라 지금은 사용할 수 없어요");
    expect(sql).toContain("before update of remaining_count, pg_refund_started_at on memberships");
    expect((sql.match(/set_config\('app\.pg_refund_write', 'on', true\)/g) ?? []).length).toBe(3);   // core, begin, release
    expect((sql.match(/set_config\('app\.pg_refund_write', '', true\)/g) ?? []).length).toBe(3);
  });
  it("회원/매니저가 REST로 표시를 만들거나 풀 수 없다(JWT 있는 직접 변경은 42501), service_role/서버 함수만 변경", () => {
    expect(trig).toContain("new.pg_refund_started_at is distinct from old.pg_refund_started_at and not v_writer and auth.uid() is not null");
    expect(trig).toContain("using errcode = '42501'");
    expect(sql).toContain("grant execute on function pg_refund_begin(uuid, uuid) to service_role;");
    expect(sql).toContain("grant execute on function pg_refund_release(uuid, uuid) to service_role;");
    expect(sql).not.toMatch(/grant execute on function pg_refund_(begin|release)\(uuid, uuid\) to [^;]*authenticated/);
    expect(read("lib/members.ts")).not.toContain("pg_refund_started_at");
  });
  it("새 reservations INSERT도 표시된 수강권으로는 거부(횟수 차감이 없는 무제한/차감 없는 예약 포함)", () => {
    const r = sql.slice(sql.indexOf("create or replace function reservations_guard_pg_refund_lock"), sql.indexOf("drop trigger if exists reservations_guard_pg_refund_lock"));
    expect(r).toContain("select pg_refund_started_at into v_started from memberships where id = new.membership_id for update;");
    expect(r).toContain("if v_started is not null then");
    expect(sql).toContain("before insert or update of status, membership_id on reservations");
  });
  it("begin은 행 잠금(FOR UPDATE) 아래에서 조건을 확인하고 표시를 건다 — 조건 확인과 표시 사이에 다른 트랜잭션이 끼어들 수 없다", () => {
    const b = sql.slice(sql.indexOf("create or replace function pg_refund_begin"), sql.indexOf("create or replace function pg_refund_release"));
    expect(b).toContain("for update;");
    expect(b.indexOf("for update;")).toBeLessThan(b.indexOf("_refund_block_reason(v_mem)"));
    expect(b.indexOf("_refund_block_reason(v_mem)")).toBeLessThan(b.indexOf("update memberships set pg_refund_started_at = now()"));
    expect(b).toContain("'state', 'resumed'");
    expect(b).toContain("'state', 'refunded'");
  });
  it("release는 환불되지 않은 수강권의 표시만 해제, 본인 소유만", () => {
    const r = sql.slice(sql.indexOf("create or replace function pg_refund_release"), sql.indexOf("revoke all on function pg_refund_release"));
    expect(r).toContain("status <> 'refunded' and pg_refund_started_at is not null");
    expect(r).toContain("profile_id in (select id from profiles where account_id = v_account)");
  });
  it("force는 24시간 조건만 건너뛴다 — '이미 사용함'은 skip과 무관하게 항상 확인(코드 순서/조건 확인)", () => {
    const h = sql.slice(sql.indexOf("create or replace function _refund_block_reason"), sql.indexOf("revoke all on function _refund_block_reason"));
    expect(h).toContain("if v_hours > 24 and not coalesce(p_skip_time, false) then");
    const usage = h.slice(h.indexOf("if not v_unlimited"));
    expect(usage).toContain("p_mem.remaining_count is distinct from p_mem.total_count");
    expect(usage).not.toContain("p_skip_time");
    expect(sql).toContain("set status = 'refunded', remaining_count = 0, pg_refund_started_at = null");
  });
  it("예약 RPC 본문은 수정하지 않는다(라이브 정의 보존) — 트리거로만 차단", () => {
    for (const f of ["reserve_class", "reserve_with_membership", "reserve_with_goods", "manager_book_member", "admin_assign_reservation", "_auto_book_membership_core", "manager_set_attendance"]) {
      expect(sql).not.toMatch(new RegExp(`function (public\\.)?${f}\\(`, "i"));
    }
  });
  it("rollback: 트리거/함수/컬럼 제거", () => {
    for (const x of ["drop trigger if exists reservations_guard_pg_refund_lock", "drop trigger if exists memberships_guard_pg_refund", "drop function if exists pg_refund_begin(", "drop function if exists pg_refund_release(",
      "alter table memberships drop column if exists pg_refund_started_at;", "drop function if exists _refund_block_reason(memberships, boolean);"]) expect(rollback).toContain(x);
    expect(rollback.indexOf("drop trigger if exists memberships_guard_pg_refund")).toBeLessThan(rollback.indexOf("drop column if exists pg_refund_started_at"));
  });
  it("검증 쿼리에 환불 표시 컬럼/트리거/권한/정체된 표시 확인 포함", () => {
    const raw = read("fix_pg_payment_lifecycle.sql");
    for (const x of ["refund_lock_column_must_be_1", "refund_lock_triggers_must_be_2", "refund_begin_auth_must_be_false", "stuck_refund_locks_should_be_0"]) expect(raw).toContain(x);
  });
});

describe("토스 API 호출 모듈(fetch 주입 — 실제 호출 없음)", () => {
  it("승인/취소 요청 형식: Basic 인증, Idempotency-Key, 전액 취소(cancelAmount 없음), 네트워크 오류는 status 0", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    await tossConfirmPayment("sk_test_x", { paymentKey: "pk", orderId: "o", amount: 100, idempotencyKey: "k1" }, f as any);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://api.tosspayments.com/v1/payments/confirm");
    expect(init.headers.Authorization).toBe("Basic " + Buffer.from("sk_test_x:").toString("base64"));
    expect(init.headers["Idempotency-Key"]).toBe("k1");
    expect(JSON.parse(init.body)).toEqual({ paymentKey: "pk", orderId: "o", amount: 100 });
    await tossCancelPayment("sk_test_x", "pk/1", { cancelReason: "사유", idempotencyKey: "k2" }, f as any);
    const [curl, cinit] = f.mock.calls[1] as any;
    expect(curl).toBe("https://api.tosspayments.com/v1/payments/pk%2F1/cancel");
    expect(JSON.parse(cinit.body)).toEqual({ cancelReason: "사유" });
    const net = await tossConfirmPayment("k", { paymentKey: "p", orderId: "o", amount: 1 }, (async () => { throw new Error("boom"); }) as any);
    expect(net).toMatchObject({ ok: false, status: 0, code: "NETWORK_ERROR" });
  });
});

describe("라우트/클라이언트 계약", () => {
  it("cancel/confirm/refund 라우트는 Bearer 토큰 필수(401)이고 서버 라우트에 profileId/centerId 입력이 없다", async () => {
    vi.resetModules();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "x"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://x"); vi.stubEnv("TOSS_SECRET_KEY", "s");
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: null }, error: { message: "bad" } }) }, rpc: vi.fn() }) }));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const mk = (path: string, body: object) => new Request(`http://localhost/api/payments/${path}`, { method: "POST", body: JSON.stringify(body) });
    const cancel = await import("../../app/api/payments/cancel/route");
    const refund = await import("../../app/api/payments/refund/route");
    const confirm = await import("../../app/api/payments/confirm/route");
    expect((await cancel.POST(mk("cancel", { orderId: "o" }))).status).toBe(401);
    expect((await refund.POST(mk("refund", { membershipId: "m" }))).status).toBe(401);
    expect((await confirm.POST(mk("confirm", { paymentKey: "p", orderId: "o", amount: 1 }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();   // 토스 호출 없음
    vi.doUnmock("@supabase/supabase-js"); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    for (const f of ["app/api/payments/cancel/route.ts", "app/api/payments/refund/route.ts", "app/api/payments/confirm/route.ts"]) {
      expect(read(f)).not.toMatch(/profileId|centerId/);
    }
  });
  it("브라우저는 환불에서 refund_membership RPC를 직접 호출하지 않고 서버 라우트를 부른다(Bearer 토큰 전송)", () => {
    const m = read("lib/mypage.ts");
    expect(m).toContain("await refundMembershipApi(membershipId);");
    expect(m).not.toContain('rpc("refund_membership"');
    const api = read("lib/payments/tossPaymentApi.ts");
    expect(api).toContain('fetch("/api/payments/refund"');
    expect(api).toContain("Authorization: `Bearer ${token}`");
    expect(api).not.toMatch(/SECRET|secret/);
  });
  it("토스 시크릿은 서버 모듈에서만 쓰이고 NEXT_PUBLIC_ 접두사/클라이언트 코드에 없다", () => {
    for (const f of ["lib/payments/tossPaymentApi.ts", "lib/payments/TossPaymentProvider.ts", "app/checkout/page.tsx", "app/checkout/success/page.tsx"]) {
      expect(read(f)).not.toContain("TOSS_SECRET_KEY");
    }
    expect(read("lib/payments/server/toss.ts")).not.toContain("process.env");
    expect(read("lib/payments/server/deps.ts")).not.toContain("process.env.TOSS_SECRET_KEY");   // 키는 라우트가 읽어 주입
    expect(read("app/api/payments/confirm/route.ts")).toContain("process.env.TOSS_SECRET_KEY");
  });
});

describe("SQL 계약 — fix_pg_payment_lifecycle.sql", () => {
  it("BEGIN/COMMIT, 새 테이블/RLS 정책 변경 없음", () => {
    expect(sql.trim().startsWith("BEGIN;")).toBe(true);
    expect(sql).toContain("COMMIT;");
    expect(sql).not.toMatch(/create table|(create|drop|alter) policy/i);
  });
  it("[15] 포인트/쿠폰 복원 로직을 환불 core가 그대로 유지(회귀 방지)", () => {
    const core = sql.slice(sql.indexOf("create or replace function _refund_membership_core"), sql.indexOf("revoke all on function _refund_membership_core"));
    for (const s of ["perform _restore_order_points(v_order_id, '환불 포인트 복원');", "set status = 'available', used_at = null, order_id = null", "set status = 'refunded', remaining_count = 0",
      "-v_amount", "'앱 셀프 환불'", "set status = 'expired'", "이미 환불된 수강권이에요"]) expect(core).toContain(s);
    expect(core).toContain("v_reason := _refund_block_reason(v_mem, coalesce(p_skip_time_check, false));");
    expect(core).toContain("if v_reason is not null then");   // 사유가 있으면 항상 거부 — skip은 24시간 조건에만 적용(아래 helper)
  });
  it("브라우저 refund_membership은 core 래퍼(allow_pg=false, skip_time=false) — 실 PG 주문 직접 호출 거부, 서버 전용 함수만 PG/시간조건 건너뜀 허용", () => {
    expect(sql).toContain("return _refund_membership_core(p_membership_id, my_account_id(), false, false);");
    expect(sql).toContain("o.payment_provider in ('toss', 'portone')");
    expect(sql).toContain("카드/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요");
    expect(sql).toContain("revoke all on function refund_membership_server(uuid, uuid, boolean, boolean) from public, anon, authenticated;");
    expect(sql).not.toContain("p_force");
    expect(sql).toContain("grant execute on function refund_membership_server(uuid, uuid, boolean, boolean) to service_role;");
    expect(sql).toContain("revoke all on function refund_membership(uuid) from public, anon;");
    expect(sql).toContain("grant execute on function refund_membership(uuid) to authenticated;");
  });
  it("내부/서버 함수는 PUBLIC/anon/authenticated 실행 차단 + SECURITY DEFINER + search_path 고정", () => {
    for (const sig of ["_account_id_for_auth(uuid)", "_refund_block_reason(memberships, boolean)", "_refund_membership_core(uuid, uuid, boolean, boolean)", "orders_force_server_fields_on_insert()"]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
    }
    for (const sig of ["pg_refund_context(uuid, uuid)", "pg_order_context(uuid, uuid)"]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function ${sig} to service_role;`);
    }
    const fns = [...sql.matchAll(/create or replace function (\w+)\([^)]*\)[\s\S]*?\$\$;/g)].map((m) => m[0]);
    expect(fns.length).toBeGreaterThanOrEqual(8);
    for (const f of fns) { expect(f).toMatch(/security definer|language sql[\s\S]*security definer/); expect(f).toContain("set search_path = public"); }
  });
  it("cancel_real_payment / _issue_membership_and_record_payment는 본문 변경 없이 search_path만 고정(ALTER)", () => {
    expect(sql).toContain("alter function cancel_real_payment(uuid) set search_path = public;");
    expect(sql).toContain("alter function _issue_membership_and_record_payment(orders, text, text) set search_path = public;");
    expect(sql).not.toMatch(/create or replace function (cancel_real_payment|_issue_membership_and_record_payment)/);
  });
  it("Mock 결제 확정(confirm_test_payment)은 내부 QA 센터에서만, anon 실행 차단 — 회원이 mock 주문으로 무료 발급받는 경로 차단", () => {
    const f = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.confirm_test_payment"), sql.indexOf("revoke all on function confirm_test_payment"));
    expect(f).toContain("coalesce(is_internal, false)");
    expect(f).toContain("SET search_path TO 'public'");
    expect(f).toContain("본인 주문만 확정할 수 있어요");   // 기존 소유 검증 유지
    expect(f).toContain("_issue_membership_and_record_payment(v_order, p_provider_ref");
    expect(sql).toContain("revoke all on function confirm_test_payment(uuid, text) from public, anon;");
  });
  it("회원 INSERT 주문은 verified=false/pending으로 고정(verified=true로 금액 검증을 건너뛰는 위조 방지), 서버 작업은 영향 없음", () => {
    expect(sql).toContain("if auth.uid() is not null then");
    expect(sql).toContain("new.verified := false;");
    expect(sql).toContain("new.status := 'pending';");
    expect(sql).toContain("before insert on orders");
  });
  it("[14] cancelled 재확정 방지(이전 migration)와 상태 전이 가드는 이 migration이 건드리지 않는다", () => {
    expect(sql).not.toMatch(/function (public\.)?(fulfill_order|confirm_real_payment|orders_guard_status_transition)\(/i);
  });
  it("rollback: 신규 함수/트리거 제거, refund_membership/confirm_test_payment를 적용 전 정의로 복원, search_path 원복", () => {
    for (const s of ["drop trigger if exists orders_force_server_fields_on_insert", "drop function if exists refund_membership_server(", "drop function if exists _refund_membership_core(",
      "alter function cancel_real_payment(uuid) reset search_path;", "FUNCTION public.refund_membership(", "FUNCTION public.confirm_test_payment("]) expect(rollback).toContain(s);
    expect(rollback).not.toContain("is_internal");
    expect(rollback).toContain("grant execute on function confirm_test_payment(uuid, text) to anon, authenticated, service_role;");
  });
  it("적용 전/후 read-only 검증 쿼리 포함", () => {
    const raw = read("fix_pg_payment_lifecycle.sql");
    for (const s of ["cancel_real_search_path_must_be_true", "test_confirm_anon_must_be_false", "test_confirm_internal_only_must_be_true", "insert_guard_trigger_must_be_1", "refund_server_auth_must_be_false", "core_auth_must_be_false"]) expect(raw).toContain(s);
  });
});

describe("Production QA / 기본 테스트 격리", () => {
  it("이번 배치는 Production QA 스크립트를 새로 만들지 않고, 기본 test 계열에 qa가 섞이지 않는다", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    // Production QA 후보(pg-refund-lock)는 실행하지 않는 별도 명령으로만 존재한다
    expect(Object.keys(scripts).filter((k) => /pg|toss|refund/i.test(k))).toEqual(["qa:production:pg-refund-lock"]);
    for (const k of ["test", "test:integration"]) expect(scripts[k] ?? "").not.toMatch(/qa/);
  });
});
