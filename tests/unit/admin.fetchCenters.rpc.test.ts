// fetchCenters는 centers 테이블을 직접 읽지 않고 관리자 전용 RPC admin_list_centers만 호출한다(민감 컬럼 SELECT 차단과 짝).
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
const fromMock = vi.fn();
vi.mock("../../lib/supabaseClient", () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: (...a: unknown[]) => fromMock(...a) },
}));
vi.mock("../../lib/authAccount", () => ({ getMyAccountId: vi.fn() }));

import { fetchCenters } from "../../lib/admin";

const ROW = {
  id: "c1", name: "강남 필라테스", address: "서울", phone: "02-000-0000",
  business_number: "123-45-67890", business_license_url: "uid/license.pdf",
  status: "pending", reject_reason: null, created_at: "2026-10-01T03:00:00Z",
  owner_name: "홍길동", owner_phone: "010-0000-0000",
};

describe("fetchCenters() — admin_list_centers RPC", () => {
  beforeEach(() => { rpcMock.mockReset(); fromMock.mockReset(); });

  it("RPC를 p_status로 호출하고 centers 테이블을 직접 조회하지 않는다", async () => {
    rpcMock.mockResolvedValueOnce({ data: [ROW], error: null });
    await fetchCenters("pending");
    expect(rpcMock).toHaveBeenCalledWith("admin_list_centers", { p_status: "pending" });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("기존 관리자 화면이 쓰는 PendingCenter 구조를 그대로 돌려준다", async () => {
    rpcMock.mockResolvedValueOnce({ data: [ROW], error: null });
    const [c] = await fetchCenters("rejected");
    expect(c).toEqual({
      id: "c1", name: "강남 필라테스", address: "서울", phone: "02-000-0000",
      businessNumber: "123-45-67890", businessLicenseUrl: "uid/license.pdf",
      status: "pending", rejectReason: null, createdAt: expect.stringMatching(/2026/),
      ownerName: "홍길동", ownerPhone: "010-0000-0000",
    });
  });

  it("오너 정보가 없으면 null, 결과가 비면 빈 배열", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ ...ROW, owner_name: null, owner_phone: null }], error: null });
    const [c] = await fetchCenters("approved");
    expect([c.ownerName, c.ownerPhone]).toEqual([null, null]);
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    expect(await fetchCenters("approved")).toEqual([]);
  });

  it("RPC 오류(예: 관리자가 아님 → forbidden)는 사용자 메시지로 던진다", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "forbidden" } });
    await expect(fetchCenters("pending")).rejects.toThrow("센터 목록을 불러오지 못했어요: forbidden");
  });
});
