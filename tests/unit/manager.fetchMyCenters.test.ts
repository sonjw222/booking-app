// ACL-002: /manager/inquiries, /manager/notifications의 "운영 중인 센터가
// 없어요" 가드가 의존하는 fetchMyCenters()를 검증한다. 이번 배치에서 ACL-003/004를
// 위해 managerCenterId/roleId 필드를 추가했으므로 그 매핑도 함께 확인한다.
import { describe, it, expect, vi } from "vitest";

const getUserMock = vi.fn().mockResolvedValue({ data: { user: { id: "auth-1" } } });
const accountSingleMock = vi.fn().mockResolvedValue({ data: { id: "acc-1", is_manager: true }, error: null });
const centersEqMock = vi.fn();

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    auth: { getUser: (...args: unknown[]) => getUserMock(...args) },
    from: (table: string) => {
      if (table === "accounts") {
        return { select: () => ({ eq: () => ({ single: (...args: unknown[]) => accountSingleMock(...args) }) }) };
      }
      // manager_centers
      return { select: () => ({ eq: () => ({ eq: (...args: unknown[]) => centersEqMock(...args) }) }) };
    },
  },
}));

import { fetchMyCenters } from "../../lib/manager";

describe("fetchMyCenters() (ACL-002 / ACL-003 / ACL-004 shared data source)", () => {
  it("returns an empty list for an account with no active centers (triggers the '운영 중인 센터가 없어요' guard)", async () => {
    centersEqMock.mockResolvedValueOnce({ data: [], error: null });
    const centers = await fetchMyCenters();
    expect(centers).toEqual([]);
  });

  it("maps manager_centers rows to ManagedCenter, including managerCenterId/roleId for ACL-003/004", async () => {
    centersEqMock.mockResolvedValueOnce({
      data: [
        {
          id: "mc-1",
          role_id: "role-1",
          status: "active",
          centers: { id: "center-1", name: "테스트 센터" },
          center_roles: { name: "스튜디오 오너", is_owner: true },
        },
      ],
      error: null,
    });
    const centers = await fetchMyCenters();
    expect(centers).toEqual([
      {
        id: "center-1",
        name: "테스트 센터",
        roleName: "스튜디오 오너",
        isOwner: true,
        status: "active",
        managerCenterId: "mc-1",
        roleId: "role-1",
      },
    ]);
  });

  it("filters out rows whose centers join is missing (dangling manager_centers row)", async () => {
    centersEqMock.mockResolvedValueOnce({
      data: [{ id: "mc-2", role_id: null, status: "active", centers: null, center_roles: null }],
      error: null,
    });
    const centers = await fetchMyCenters();
    expect(centers).toEqual([]);
  });
});
