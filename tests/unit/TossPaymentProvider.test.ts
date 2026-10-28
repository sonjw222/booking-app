/*
  TossPaymentProvider.createPayment()이 실제 토스 v2 SDK에 넘기는 requestPayment() 파라미터
  형태를 검증한다.

  배경(2026-08-31 실측 버그): 계좌이체(method:"TRANSFER") 요청에 `card: undefined`처럼 값만
  비운 채로 `card` 키 자체를 항상 포함시켰더니, 실제 토스 v2 SDK가 "card는 정의되지 않은
  파라미터입니다"로 즉시 거부했다(로컬 실브라우저로 실제 게이트웨이까지 재현해 확인) — 키의
  값이 아니라 키의 존재 자체를 검사하는 것으로 보인다. 이 파일은 그 회귀를 막는다: TRANSFER
  요청에는 `card` 키가 아예 없어야(hasOwnProperty가 false) 하고, CARD/간편결제 요청에는
  있어야 한다.

  environment: "node"(vitest.config.ts)라 window가 없으므로, 이 파일 안에서만 최소한으로
  window.TossPayments를 흉내 낸 뒤 각 테스트가 끝나면 지운다.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TossPaymentProvider } from "../../lib/payments/TossPaymentProvider";

const ORIGINAL_CLIENT_KEY = process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY;

let requestPayment: ReturnType<typeof vi.fn>;
let paymentFactory: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY = "test_ck_dummy";
  requestPayment = vi.fn().mockResolvedValue(undefined);
  const paymentInstance = { requestPayment };
  paymentFactory = vi.fn().mockReturnValue(paymentInstance);
  (globalThis as any).window = { TossPayments: vi.fn().mockReturnValue({ payment: paymentFactory }) };
});

afterEach(() => {
  process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY = ORIGINAL_CLIENT_KEY;
  delete (globalThis as any).window;
});

const baseInput = {
  orderId: "order-1",
  amount: 15000,
  orderName: "테스트 상품",
  customerKey: "user-1",
  successUrl: "https://example.com/success",
  failUrl: "https://example.com/fail",
};

describe("TossPaymentProvider.createPayment", () => {
  it("일반 카드결제는 method:CARD, card 키가 없다(easyPay 미지정)", async () => {
    const provider = new TossPaymentProvider();
    await provider.createPayment(baseInput);
    const params = requestPayment.mock.calls[0][0];
    expect(params.method).toBe("CARD");
    expect(Object.prototype.hasOwnProperty.call(params, "card")).toBe(false);
  });

  it("간편결제(카카오페이)는 method:CARD + card.flowMode:DIRECT + card.easyPay:KAKAOPAY", async () => {
    const provider = new TossPaymentProvider();
    await provider.createPayment({ ...baseInput, easyPay: "KAKAOPAY" });
    const params = requestPayment.mock.calls[0][0];
    expect(params.method).toBe("CARD");
    expect(params.card).toEqual({ flowMode: "DIRECT", easyPay: "KAKAOPAY" });
  });

  it("계좌이체는 method:TRANSFER이고 card 키가 아예 없어야 한다(값이 undefined인 것만으로는 부족)", async () => {
    const provider = new TossPaymentProvider();
    await provider.createPayment({ ...baseInput, method: "TRANSFER" });
    const params = requestPayment.mock.calls[0][0];
    expect(params.method).toBe("TRANSFER");
    expect(Object.prototype.hasOwnProperty.call(params, "card")).toBe(false);
  });

  it("계좌이체는 easyPay가 실수로 같이 와도 card 키를 넣지 않는다", async () => {
    const provider = new TossPaymentProvider();
    await provider.createPayment({ ...baseInput, method: "TRANSFER", easyPay: "TOSSPAY" });
    const params = requestPayment.mock.calls[0][0];
    expect(params.method).toBe("TRANSFER");
    expect(Object.prototype.hasOwnProperty.call(params, "card")).toBe(false);
  });
});
