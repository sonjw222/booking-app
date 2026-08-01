// ACL-002: /manager/inquiries, /manager/notifications의 "운영 중인 센터가
// 없어요" 가드가 의존하는 fetchMyCenters()를 검증한다. 이번 배치에서 ACL-003/004를
// 위해 managerCenterId/roleId 필드를 추가했으므로 그 매핑도 함께 확인한다.
//
// ACL-005: 매니저 진입 조건은 accounts.is_manager(스태프 초대 시 RLS로 인해 갱신되지
// 않을 수 있는 별도 플래그)가 아니라 active manager_centers 소속 존재 여부로 판단한다
// (lib/manager.ts의 getMyAccountId()). accounts select는 더 이상 is_manager를 읽지
// 않으므로, 이 파일의 목(mock)도 accounts 조회 1회 + manager_centers 조회 2회(진입
// 조건 count 체크 → 실제 목록 조회)를 반영한다.
import { describe, it, expect, vi } from "vitest";

const getUserMock = vi.fn().mockResolvedValue({ data: { user: { id: "auth-1" } } });
const accountSingleMock = vi.fn().mockResolvedValue({ data: { id: "acc-1" }, error: null });
const managerCenterCountMock = vi.fn();
const centersListMock = vi.fn();

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    auth: { getUser: (...args: unknown[]) => getUserMock(...args) },
    from: (table: string) => {
      if (table === "accounts") {
        return { select: () => ({ eq: () => ({ single: (...args: unknown[]) => accountSingleMock(...args) }) }) };
      }
      // manager_centers: getMyAccountId()의 active 소속 count 체크(select(..., {head:true}))와
      // fetchMyCenters()의 실제 목록 조회를 select() 호출 인자로 구분한다.
      return {
        select: (_cols: string, opts?: { head?: boolean }) => {
          if (opts?.head) {
            return { eq: () => ({ eq: (...args: unknown[]) => managerCenterCountMock(...args) }) };
          }
          return { eq: () => ({ eq: (...args: unknown[]) => centersListMock(...args) }) };
        },
      };
    },
  },
}));

import { fetchMyCenters } from "../../lib/manager";

describe("fetchMyCenters() (ACL-002 / ACL-003 / ACL-004 / ACL-005 shared data source)", () => {
  it("ACL-005: throws when the account has no active manager_centers membership, even if the account row itself resolves fine (never-invited member)", async () => {
    managerCenterCountMock.mockResolvedValueOnce({ count: 0, error: null });
    await expect(fetchMyCenters()).rejects.toThrow("매니저 권한이 없는 계정이에요");
  });

  it("ACL-005: succeeds for an account with an active manager_centers row regardless of the stale accounts.is_manager flag (QA repro: invited staff via inviteStaff())", async () => {
    managerCenterCountMock.mockResolvedValueOnce({ count: 1, error: null });
    centersListMock.mockResolvedValueOnce({
      data: [
        {
          id: "mc-1",
          role_id: "role-1",
          status: "active",
          centers: { id: "center-1", name: "테스트 센터" },
          center_roles: { name: "일반 스태프", is_owner: false },
        },
      ],
      error: null,
    });
    const centers = await fetchMyCenters();
    expect(centers).toEqual([
      {
        id: "center-1",
        name: "테스트 센터",
        roleName: "일반 스태프",
        isOwner: false,
        status: "active",
        managerCenterId: "mc-1",
        roleId: "role-1",
      },
    ]);
  });

  it("maps manager_centers rows to ManagedCenter, including managerCenterId/roleId for ACL-003/004", async () => {
    managerCenterCountMock.mockResolvedValueOnce({ count: 1, error: null });
    centersListMock.mockResolvedValueOnce({
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
    managerCenterCountMock.mockResolvedValueOnce({ count: 1, error: null });
    centersListMock.mockResolvedValueOnce({
      data: [{ id: "mc-2", role_id: null, status: "active", centers: null, center_roles: null }],
      error: null,
    });
    const centers = await fetchMyCenters();
    expect(centers).toEqual([]);
  });
});
