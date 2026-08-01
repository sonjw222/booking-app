// ACL-005: 마이페이지의 "관리자 모드로 전환" 노출 조건(profile.isManager)이
// accounts.is_manager(스태프 초대 시 RLS로 인해 갱신되지 않을 수 있는 별도 플래그)가
// 아니라 active manager_centers 소속 존재 여부로 계산되는지 확인한다.
// lib/manager.ts의 getMyAccountId()와 반드시 같은 기준을 써야 하므로(ACL-005 원인),
// 두 파일의 판정 결과가 항상 일치해야 한다.
import { describe, it, expect, vi } from "vitest";

const state = vi.hoisted(() => ({ activeManagerCenterCount: 0 }));

function makeChain(resolved: unknown): any {
  const chain: any = {};
  for (const m of ["select", "eq", "neq", "in", "order", "limit"]) chain[m] = () => chain;
  chain.single = () => Promise.resolve(resolved);
  chain.maybeSingle = () => Promise.resolve(resolved);
  chain.then = (resolve: any, reject?: any) => Promise.resolve(resolved).then(resolve, reject);
  return chain;
}

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "auth-1" } } }) },
    from: (table: string) => {
      if (table === "accounts") {
        return makeChain({ data: { id: "acc-1", name: "홍길동", phone: null, is_member: true, is_platform_admin: false }, error: null });
      }
      if (table === "manager_centers") {
        return makeChain({ count: state.activeManagerCenterCount, error: null });
      }
      if (table === "profiles") {
        return makeChain({
          data: [{ id: "prof-1", is_primary: true, created_at: "2026-01-01T00:00:00Z", name: "홍길동", nickname: null, label: null }],
          error: null,
        });
      }
      // memberships / reservations: 이 테스트의 관심사(isManager)와 무관 — 빈 목록으로 충분
      return makeChain({ data: [], error: null });
    },
  },
}));

import { fetchMyPage } from "../../lib/mypage";

describe("fetchMyPage() → profile.isManager (ACL-005)", () => {
  it("is false when the account has no active manager_centers membership (never-invited general member)", async () => {
    state.activeManagerCenterCount = 0;
    const { profile } = await fetchMyPage();
    expect(profile.isManager).toBe(false);
  });

  it("is true when the account has an active manager_centers row, regardless of the stale accounts.is_manager flag (QA repro: invited staff via inviteStaff())", async () => {
    state.activeManagerCenterCount = 1;
    const { profile } = await fetchMyPage();
    expect(profile.isManager).toBe(true);
  });
});
