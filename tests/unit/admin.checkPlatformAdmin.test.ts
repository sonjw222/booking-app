// ACL-001: /admin/categories, /admin/banners에 새로 붙인 접근 가드가
// 실제로 의존하는 checkPlatformAdmin()의 3가지 경계 상황을 검증한다.
// (guard blocking / allow 시나리오)
import { describe, it, expect, vi } from "vitest";

const singleMock = vi.fn();
const getUserMock = vi.fn();

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    auth: { getUser: (...args: unknown[]) => getUserMock(...args) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: (...args: unknown[]) => singleMock(...args) }),
      }),
    }),
  },
}));

import { checkPlatformAdmin } from "../../lib/admin";

describe("checkPlatformAdmin() (ACL-001)", () => {
  it("returns false when no user is logged in (blocks admin pages)", async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    expect(await checkPlatformAdmin()).toBe(false);
  });

  it("returns false for a logged-in account that is not a platform admin (blocks)", async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: { id: "auth-1" } } });
    singleMock.mockResolvedValueOnce({ data: { is_platform_admin: false } });
    expect(await checkPlatformAdmin()).toBe(false);
  });

  it("returns true for a platform admin account (allows admin pages)", async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: { id: "auth-2" } } });
    singleMock.mockResolvedValueOnce({ data: { is_platform_admin: true } });
    expect(await checkPlatformAdmin()).toBe(true);
  });
});
