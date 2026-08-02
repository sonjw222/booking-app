// Track B 관리자 기능 감사에서 발견: fulfill_order() RPC는 { already_done, membership_id, amount }
// 만 반환하는데, updateOrderStatus()가 존재하지 않는 auto_booked/remaining 필드를 기대해 항상
// 무시되는 죽은 분기를 만들고 있었다. 이 테스트는 그 필드를 더 이상 기대하지 않는지(반환값을
// 그대로 신뢰하지 않는지) 확인한다.
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
const updateMock = vi.fn();

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => ({ update: () => ({ eq: (...args: unknown[]) => updateMock(...args) }) }),
  },
}));

import { updateOrderStatus } from "../../lib/orders";

describe("updateOrderStatus()", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    updateMock.mockReset();
  });

  it("'done' 처리 시 fulfill_order RPC를 호출하고, 존재하지 않는 필드를 반환하지 않는다(void)", async () => {
    rpcMock.mockResolvedValueOnce({
      data: { already_done: false, membership_id: "m-1", amount: 50000 },
      error: null,
    });
    const result = await updateOrderStatus("order-1", "done");
    expect(rpcMock).toHaveBeenCalledWith("fulfill_order", { p_order_id: "order-1" });
    expect(result).toBeUndefined();
  });

  it("RPC가 에러를 반환하면 에러 메시지를 그대로 던진다(접두사 제거)", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "P0001: 이미 처리된 주문이에요" } });
    await expect(updateOrderStatus("order-2", "done")).rejects.toThrow("이미 처리된 주문이에요");
  });

  it("'cancelled' 처리 시 RPC를 호출하지 않고 orders 테이블만 update한다", async () => {
    updateMock.mockResolvedValueOnce({ error: null });
    await updateOrderStatus("order-3", "cancelled");
    expect(rpcMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith("id", "order-3");
  });
});
