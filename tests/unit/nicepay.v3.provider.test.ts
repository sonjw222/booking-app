// @vitest-environment jsdom
/* NicepayPaymentProvider 의 v3(MID) 분기 — 서버 prepare 응답을 검증해 goPay 결제창만 연다(승인 호출 없음). prepare/세션/스크립트 로딩은 가짜. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORDER = "44444444-4444-4444-8444-444444444444";
const prepared = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../../lib/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } }));
vi.mock("../../lib/payments/PaymentProviderFactory", () => ({ NICEPAY_CHECKOUT_ACTIVATED: true }));
const prepareNicepay = vi.fn(async () => prepared.value);
const abandonNicepayOrder = vi.fn(async () => ({ ok: true, status: 200, data: {} }));
vi.mock("../../lib/payments/nicepayClientApi", () => ({ prepareNicepay, abandonNicepayOrder, fetchNicepayStatus: vi.fn(), pollNicepayStatus: vi.fn() }));
const { NicepayPaymentProvider } = await import("../../lib/payments/NicepayPaymentProvider");

const v3 = (over: Record<string, unknown> = {}) => ({ ok: true, status: 200, data: { ok: true, family: "v3_mid", params: { MID: "testmid01m", Moid: ORDER, Amt: "4000", GoodsName: "수강권", EdiDate: "20261029120000", SignData: "b".repeat(64), ReturnURL: `${window.location.origin}/api/payments/nicepay/return?rt=x`, PayMethod: "CARD", CharSet: "utf-8", ...over } } });
beforeEach(() => { document.body.innerHTML = ""; prepareNicepay.mockClear(); abandonNicepayOrder.mockClear(); (window as unknown as { goPay?: unknown }).goPay = vi.fn(); });

describe("NicepayPaymentProvider v3 분기", () => {
  it("서버 prepare 응답이 주문과 일치하면 goPay 로 결제창을 열고 pending(redirected)을 돌려준다 — 승인(confirm)은 호출하지 않는다", async () => {
    prepared.value = v3();
    const r = await new NicepayPaymentProvider().createPayment({ orderId: ORDER, amount: 4000, orderName: "수강권" } as never);
    expect(r).toMatchObject({ status: "pending", redirected: true, paymentKey: ORDER });
    expect((window as unknown as { goPay: ReturnType<typeof vi.fn> }).goPay).toHaveBeenCalledTimes(1);
  });
  it("금액·주문번호가 어긋나면 결제창을 열지 않는다", async () => {
    prepared.value = v3({ Amt: "3999" });
    await expect(new NicepayPaymentProvider().createPayment({ orderId: ORDER, amount: 4000, orderName: "x" } as never)).rejects.toThrow(/금액/);
    prepared.value = v3({ Moid: "other" });
    await expect(new NicepayPaymentProvider().createPayment({ orderId: ORDER, amount: 4000, orderName: "x" } as never)).rejects.toThrow(/주문번호/);
    expect((window as unknown as { goPay: ReturnType<typeof vi.fn> }).goPay).not.toHaveBeenCalled();
  });
  it("서버가 거부(게이트 off 등)하면 결제창을 열지 않고 오류", async () => {
    prepared.value = { ok: false, status: 403, data: { error: "온라인 결제는 아직 사용할 수 없어요" } };
    await expect(new NicepayPaymentProvider().createPayment({ orderId: ORDER, amount: 4000, orderName: "x" } as never)).rejects.toThrow(/사용할 수 없/);
    expect((window as unknown as { goPay: ReturnType<typeof vi.fn> }).goPay).not.toHaveBeenCalled();
  });
});
