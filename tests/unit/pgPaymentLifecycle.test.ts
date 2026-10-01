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
  it("동시 중복 승인(토스 ALREADY_PROCESSED_PAYMENT): 새로 취소/확정하지 않고 DB 상태만 확인", async () => {
    const d = deps({
      tossConfirm: vi.fn(async () => ({ ok: false as const, status: 409, code: "ALREADY_PROCESSED_PAYMENT", message: "이미 처리된 결제" })),
      orderContext: vi.fn().mockResolvedValueOnce(baseOrder).mockResolvedValueOnce({ ...baseOrder, status: "done" }),
    });
    expect((await handleConfirm(input, d)).body).toMatchObject({ already_done: true });
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
    expect((d as any).dbRefund).toHaveBeenCalledWith("m1", "uid-1", { allowPg: true, force: true });
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
  it("환불 불가 사유(24시간 경과 등)가 있고 토스가 아직 승인 상태면 토스 취소 없이 거부, 이미 CANCELED(이전 요청의 DB 실패)면 이어서 마무리", async () => {
    const blocked: RefundCtx = { ...baseRefund, blockReason: "결제 후 24시간이 지나 셀프 환불이 어려워요. 센터에 문의해주세요." };
    let d = deps({ refundContext: vi.fn(async () => blocked) });
    let r = await handleRefund(input, d);
    expect(r).toMatchObject({ status: 409 });
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.dbRefund).not.toHaveBeenCalled();
    d = deps({ refundContext: vi.fn(async () => blocked), tossGet: vi.fn(async () => ({ ok: true as const, data: { status: "CANCELED" } })) });
    r = await handleRefund(input, d);
    expect(r.status).toBe(200);
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.dbRefund).toHaveBeenCalledWith("m1", "uid-1", { allowPg: true, force: true });
  });
  it("[11] direct/manual/mock 환불: 토스를 호출하지 않고 기존 DB 환불(PG 허용 없음)", async () => {
    for (const provider of [null, "mock"]) {
      const d = deps({ refundContext: vi.fn(async () => ({ ...baseRefund, provider, paymentKey: null })) });
      const r = await handleRefund(input, d);
      expect(r.status).toBe(200);
      expect(d.calls.tossCancel).not.toHaveBeenCalled();
      expect(d.calls.tossGet).not.toHaveBeenCalled();
      expect(d.calls.dbRefund).toHaveBeenCalledWith("m1", "uid-1", { allowPg: false, force: false });
    }
  });
  it("0원 PG 주문(포인트/쿠폰 전액)은 토스 취소 없이 DB 환불만, PG인데 결제키가 없으면 환불 보류", async () => {
    let d = deps({ refundContext: vi.fn(async () => ({ ...baseRefund, amount: 0 })) });
    expect((await handleRefund(input, d)).status).toBe(200);
    expect(d.calls.tossCancel).not.toHaveBeenCalled();
    expect(d.calls.dbRefund).toHaveBeenCalledWith("m1", "uid-1", { allowPg: true, force: false });
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
    expect(core).toContain("v_reason := _refund_block_reason(v_mem);");
    expect(core).toContain("if v_reason is not null and not coalesce(p_force, false) then");
  });
  it("브라우저 refund_membership은 core 래퍼(allow_pg=false, force=false) — 실 PG 주문 직접 호출 거부, 서버 전용 함수만 PG/force 허용", () => {
    expect(sql).toContain("return _refund_membership_core(p_membership_id, my_account_id(), false, false);");
    expect(sql).toContain("o.payment_provider in ('toss', 'portone')");
    expect(sql).toContain("카드/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요");
    expect(sql).toContain("revoke all on function refund_membership_server(uuid, uuid, boolean, boolean) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function refund_membership_server(uuid, uuid, boolean, boolean) to service_role;");
    expect(sql).toContain("revoke all on function refund_membership(uuid) from public, anon;");
    expect(sql).toContain("grant execute on function refund_membership(uuid) to authenticated;");
  });
  it("내부/서버 함수는 PUBLIC/anon/authenticated 실행 차단 + SECURITY DEFINER + search_path 고정", () => {
    for (const sig of ["_account_id_for_auth(uuid)", "_refund_block_reason(memberships)", "_refund_membership_core(uuid, uuid, boolean, boolean)", "orders_force_server_fields_on_insert()"]) {
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
    expect(Object.keys(scripts).filter((k) => /pg|toss|refund/i.test(k))).toEqual([]);
    for (const k of ["test", "test:integration"]) expect(scripts[k] ?? "").not.toMatch(/qa/);
  });
});
