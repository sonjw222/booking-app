/*
  MockPaymentProvider의 시나리오 분기 로직만 검증한다(실제 Supabase 호출 없음).
  confirmTestPaymentRpc/cancelTestPaymentRpc를 vi.mock으로 대체해, "어떤 시나리오일 때
  어떤 RPC가 호출되는지/호출되지 않는지"만 확인한다 — RPC 자체의 동작(권한/중복 방지 등)은
  tests/integration에서 실제 DB로 검증한다.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockPaymentProvider } from "../../lib/payments/MockPaymentProvider";
import * as mockPaymentApi from "../../lib/payments/mockPaymentApi";

vi.mock("../../lib/payments/mockPaymentApi", () => ({
  confirmTestPaymentRpc: vi.fn(),
  cancelTestPaymentRpc: vi.fn(),
  fetchOrderPaymentStatus: vi.fn(),
}));

const confirmTestPaymentRpc = vi.mocked(mockPaymentApi.confirmTestPaymentRpc);
const cancelTestPaymentRpc = vi.mocked(mockPaymentApi.cancelTestPaymentRpc);
const fetchOrderPaymentStatus = vi.mocked(mockPaymentApi.fetchOrderPaymentStatus);

beforeEach(() => {
  confirmTestPaymentRpc.mockReset();
  cancelTestPaymentRpc.mockReset();
  fetchOrderPaymentStatus.mockReset();
});

describe("MockPaymentProvider.createPayment", () => {
  it("항상 pending 상태의 paymentKey를 즉시 발급한다(네트워크 호출 없음)", async () => {
    const provider = new MockPaymentProvider("success");
    const result = await provider.createPayment({ orderId: "order-1", amount: 10000 });
    expect(result.status).toBe("pending");
    expect(result.paymentKey).toContain("order-1");
    expect(confirmTestPaymentRpc).not.toHaveBeenCalled();
  });
});

describe("MockPaymentProvider.confirmPayment - success 시나리오", () => {
  it("confirm_test_payment RPC만 호출하고 성공 결과를 반환한다", async () => {
    confirmTestPaymentRpc.mockResolvedValue({ membershipId: "mem-1", alreadyDone: false });
    const provider = new MockPaymentProvider("success");

    const result = await provider.confirmPayment("key-1", "order-1");

    expect(result).toEqual({ status: "paid", membershipId: "mem-1" });
    expect(confirmTestPaymentRpc).toHaveBeenCalledWith("order-1", "key-1");
    expect(cancelTestPaymentRpc).not.toHaveBeenCalled();
  });
});

describe("MockPaymentProvider.confirmPayment - failed 시나리오", () => {
  it("어떤 RPC도 호출하지 않고 즉시 failed를 반환한다(주문은 pending으로 남음)", async () => {
    const provider = new MockPaymentProvider("failed");

    const result = await provider.confirmPayment("key-1", "order-1");

    expect(result.status).toBe("failed");
    expect(confirmTestPaymentRpc).not.toHaveBeenCalled();
    expect(cancelTestPaymentRpc).not.toHaveBeenCalled();
  });
});

describe("MockPaymentProvider.confirmPayment - cancelled 시나리오", () => {
  it("cancel_test_payment RPC만 호출하고 cancelled를 반환한다", async () => {
    cancelTestPaymentRpc.mockResolvedValue(undefined);
    const provider = new MockPaymentProvider("cancelled");

    const result = await provider.confirmPayment("key-1", "order-1");

    expect(result.status).toBe("cancelled");
    expect(cancelTestPaymentRpc).toHaveBeenCalledWith("order-1");
    expect(confirmTestPaymentRpc).not.toHaveBeenCalled();
  });
});

describe("MockPaymentProvider.cancelPayment", () => {
  it("cancel_test_payment RPC를 호출한다", async () => {
    cancelTestPaymentRpc.mockResolvedValue(undefined);
    const provider = new MockPaymentProvider("success");

    const result = await provider.cancelPayment("order-1");

    expect(result).toEqual({ status: "cancelled" });
    expect(cancelTestPaymentRpc).toHaveBeenCalledWith("order-1");
  });
});

describe("MockPaymentProvider.getPaymentStatus", () => {
  it("orders 상태를 그대로 전달한다", async () => {
    fetchOrderPaymentStatus.mockResolvedValue("paid");
    const provider = new MockPaymentProvider("success");

    const result = await provider.getPaymentStatus("order-1");

    expect(result).toEqual({ orderId: "order-1", status: "paid" });
  });
});

describe("시나리오 override 우선순위", () => {
  it("생성자에 override를 주면 NEXT_PUBLIC_PAYMENT_SCENARIO보다 우선한다", async () => {
    const originalEnv = process.env.NEXT_PUBLIC_PAYMENT_SCENARIO;
    process.env.NEXT_PUBLIC_PAYMENT_SCENARIO = "success";
    try {
      const provider = new MockPaymentProvider("failed"); // override
      const result = await provider.confirmPayment("key-1", "order-1");
      expect(result.status).toBe("failed"); // env가 success여도 override(failed)가 이김
    } finally {
      process.env.NEXT_PUBLIC_PAYMENT_SCENARIO = originalEnv;
    }
  });
});
