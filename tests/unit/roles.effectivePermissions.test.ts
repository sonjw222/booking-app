// ACL-004: 매니저 홈 메뉴 노출이 의존하는 두 함수를 검증한다.
//   1) fetchMyEffectivePermissionKeys() — 역할 권한 + 개인 예외(allow/deny)를
//      합쳐 "실제로 화면에 보여줘도 되는 권한 키 집합"을 계산 (역할판정/개인예외 override 시나리오)
//   2) canSeeManagerMenu() — 그 집합을 가지고 메뉴 한 항목의 노출 여부를 결정
//      (메뉴 숨김/오너 예외 시나리오)
// 두 함수 모두 서버 SQL 함수 has_permission()과 동일한 우선순위(오너 전권 →
// 개인 deny → 개인 allow → 역할)를 따라야 하므로, effectiveState()/isEffectivelyAllowed()
// 기준과의 일치 여부도 함께 확인한다(URL 직접 접근과 메뉴 노출의 판정 일관성).
import { describe, it, expect, vi } from "vitest";

const rolePermRows: { permission_key: string }[] = [];
const overrideRows: { permission_key: string; grant_type: string }[] = [];

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, val: string) => {
          if (table === "role_permissions") {
            return Promise.resolve({ data: rolePermRows, error: null });
          }
          // account_center_permissions
          return Promise.resolve({ data: overrideRows, error: null });
        },
      }),
    }),
  },
}));

import {
  fetchMyEffectivePermissionKeys,
  canSeeManagerMenu,
  effectiveState,
  isEffectivelyAllowed,
} from "../../lib/roles";

describe("fetchMyEffectivePermissionKeys() (ACL-004)", () => {
  it("includes a key granted by the role", async () => {
    rolePermRows.length = 0;
    rolePermRows.push({ permission_key: "board.notice.view" });
    overrideRows.length = 0;

    const keys = await fetchMyEffectivePermissionKeys("mc-1", "role-1");
    expect(keys.has("board.notice.view")).toBe(true);
  });

  it("excludes a role-granted key when a personal 'deny' override exists", async () => {
    rolePermRows.length = 0;
    rolePermRows.push({ permission_key: "facility.staff.view" });
    overrideRows.length = 0;
    overrideRows.push({ permission_key: "facility.staff.view", grant_type: "deny" });

    const keys = await fetchMyEffectivePermissionKeys("mc-1", "role-1");
    expect(keys.has("facility.staff.view")).toBe(false);
  });

  it("includes a key the role does NOT grant when a personal 'allow' override exists", async () => {
    rolePermRows.length = 0;
    overrideRows.length = 0;
    overrideRows.push({ permission_key: "pass.sales.view", grant_type: "allow" });

    const keys = await fetchMyEffectivePermissionKeys("mc-1", "role-1");
    expect(keys.has("pass.sales.view")).toBe(true);
  });

  it("returns an empty set when there's no role and no overrides", async () => {
    rolePermRows.length = 0;
    overrideRows.length = 0;

    const keys = await fetchMyEffectivePermissionKeys("mc-1", null);
    expect(keys.size).toBe(0);
  });
});

describe("canSeeManagerMenu() (ACL-004 menu visibility)", () => {
  it("shows every menu item to an owner regardless of computed permissions", () => {
    expect(canSeeManagerMenu(true, new Set(), "facility.info")).toBe(true);
    expect(canSeeManagerMenu(true, null, "facility.info")).toBe(true);
  });

  it("hides a menu item for a non-owner without the matching permission key", () => {
    expect(canSeeManagerMenu(false, new Set(["board.notice.view"]), "facility.info")).toBe(false);
  });

  it("shows a menu item for a non-owner who has the matching permission key", () => {
    expect(canSeeManagerMenu(false, new Set(["facility.info"]), "facility.info")).toBe(true);
  });

  it("hides all menu items while permissions are still loading (myPerms === null) to avoid a flash of forbidden items", () => {
    expect(canSeeManagerMenu(false, null, "facility.info")).toBe(false);
  });
});

describe("client/server precedence consistency (URL 직접 접근 vs 메뉴 노출)", () => {
  // has_permission() SQL 함수의 문서화된 우선순위: 개인 deny > 개인 allow > 역할.
  // effectiveState()/isEffectivelyAllowed()가 그 우선순위와 어긋나면, 메뉴에서는
  // 숨겼는데 실제 RLS/RPC는 통과시키는(또는 그 반대) 불일치가 생긴다.
  it("personal deny always wins even if the role also grants the key", () => {
    const state = effectiveState("pass.create", new Set(["pass.create"]), { "pass.create": "deny" });
    expect(state).toBe("deny");
    expect(isEffectivelyAllowed(state)).toBe(false);
  });

  it("personal allow wins when the role does not grant the key", () => {
    const state = effectiveState("pass.create", new Set(), { "pass.create": "allow" });
    expect(state).toBe("allow");
    expect(isEffectivelyAllowed(state)).toBe(true);
  });

  // 나머지 조합까지 포함한 role(있음/없음) × 개인예외(없음/allow/deny) 2x3 전수 매트릭스.
  // has_permission() SQL의 우선순위(개인 deny > 개인 allow > 역할)와 정확히 일치해야 한다.
  it("role grants + personal allow (redundant override) is still allowed", () => {
    const state = effectiveState("pass.create", new Set(["pass.create"]), { "pass.create": "allow" });
    expect(state).toBe("allow");
    expect(isEffectivelyAllowed(state)).toBe(true);
  });

  it("role does not grant + personal deny (redundant override) stays denied", () => {
    const state = effectiveState("pass.create", new Set(), { "pass.create": "deny" });
    expect(state).toBe("deny");
    expect(isEffectivelyAllowed(state)).toBe(false);
  });

  it("no role grant and no override falls back to denied", () => {
    const state = effectiveState("pass.create", new Set(), {});
    expect(state).toBe("role-off");
    expect(isEffectivelyAllowed(state)).toBe(false);
  });

  it("falls back to the role grant when there is no personal override", () => {
    const state = effectiveState("pass.create", new Set(["pass.create"]), {});
    expect(state).toBe("role-on");
    expect(isEffectivelyAllowed(state)).toBe(true);
  });
});
