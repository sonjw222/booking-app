// updateOrderStatus(): 'done'이면 fulfill_order RPC 결과(2026-10-01 이후 auto_book_requested/
// auto_booked_count/unplaced_count/auto_book_reason/auto_book_error 포함)를 매핑해 돌려주고, 구버전 RPC도 안전하게 처리한다.
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
const updateMock = vi.fn();
const selectMock = vi.fn();

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => ({
      update: () => ({
        eq: (...args: unknown[]) => {
          updateMock(...args);
          return { select: (...selectArgs: unknown[]) => selectMock(...selectArgs) };
        },
      }),
    }),
  },
}));

import { updateOrderStatus } from "../../lib/orders";

describe("updateOrderStatus()", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    updateMock.mockReset();
    selectMock.mockReset();
  });

  it("'done' 처리 시 fulfill_order RPC를 호출하고 자동예약 결과를 매핑해 돌려준다", async () => {
    rpcMock.mockResolvedValueOnce({
      data: {
        already_done: false, membership_id: "m-1", amount: 50000,
        auto_book_requested: true, auto_booked_count: 2, unplaced_count: 2, auto_book_reason: "outside_membership_period",
      },
      error: null,
    });
    const result = await updateOrderStatus("order-1", "done");
    expect(rpcMock).toHaveBeenCalledWith("fulfill_order", { p_order_id: "order-1" });
    expect(result).toMatchObject({ membershipId: "m-1", autoBookRequested: true, autoBookedCount: 2, unplacedCount: 2 });
  });

  it("구버전 RPC(자동예약 필드 없음)도 안전하게 매핑한다", async () => {
    rpcMock.mockResolvedValueOnce({ data: { already_done: false, membership_id: "m-1", amount: 1 }, error: null });
    const result = await updateOrderStatus("order-1", "done");
    expect(result).toMatchObject({ autoBookRequested: false, autoBookedCount: 0, unplacedCount: null });
  });

  it("RPC가 에러를 반환하면 에러 메시지를 그대로 던진다(접두사 제거)", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "P0001: 이미 처리된 주문이에요" } });
    await expect(updateOrderStatus("order-2", "done")).rejects.toThrow("이미 처리된 주문이에요");
  });

  it("'cancelled' 처리 시 RPC를 호출하지 않고 orders 테이블만 update한다", async () => {
    selectMock.mockResolvedValueOnce({ data: [{ id: "order-3" }], error: null });
    await updateOrderStatus("order-3", "cancelled");
    expect(rpcMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith("id", "order-3");
    expect(selectMock).toHaveBeenCalledWith("id");
  });

  it("취소 update가 0행이면 이미 처리된 주문으로 안내한다", async () => {
    selectMock.mockResolvedValueOnce({ data: [], error: null });
    await expect(updateOrderStatus("order-4", "cancelled")).rejects.toThrow(
      "이미 처리됐거나 취소할 수 없는 상태의 주문이에요",
    );
  });
});
