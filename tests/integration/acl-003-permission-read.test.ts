/*
  ACL-003 서버 측 재검증(2026-08-01) 회귀 테스트.

  fix_account_center_permissions_select_draft_proposed.sql은 2026-08-02에 사용자가
  Supabase SQL Editor에서 직접 실행해 이미 적용되었습니다(PR #19에 포함되어 main 병합
  완료, docs/CHANGELOG.md·docs/TODO.md P0-4에 기록). 이 파일은 이제 항상 green이어야
  정상입니다 — 과거(SQL 적용 전) 이 파일은 의도적으로 fail하는 "red" 테스트였습니다.

  전용 스태프 계정(TEST_STAFF_A/B) 없이 기존 TEST_MANAGER_A/B 두 계정만으로 검증한다:
    - centerA(TEST_MANAGER_A가 오너)에 TEST_MANAGER_B 계정을 facility.role_permission이
      전혀 없는 새 역할로 "일반 스태프"로 초대한다(TEST_MANAGER_B가 자기 센터 B의 오너라는
      사실은 centerA RLS 판정과 무관 — has_permission()/RLS는 항상 특정 center_id 기준으로
      그 계정의 manager_centers 행을 보므로, centerB 오너십이 centerA에서의 권한에 영향을
      주지 않는다).
    - 오너(managerA)가 "다른 사람의 행"으로 쓸 개인 권한 예외를 자기 자신의(오너) manager_center_id에
      하나, "본인 것" 시나리오용으로 managerB(스태프)의 manager_center_id에 하나 설정해둔다.
    - managerB(centerA에서는 비오너·무권한 스태프)로 로그인해 오너의 행을 직접 조회하면
      RLS가 올바를 때 0건이어야 하고(다른 사람 것 차단), 본인 행은 조회할 수 있어야 한다.
    - managerA(오너)는 둘 다 조회할 수 있어야 한다.

  TEST-002 fixture 격리 (2026-08-01 추가):
    이전 버전은 managerB를 centerA에 초대한 뒤 정리하지 않아, admin-assignment-security.test.ts의
    "다른 센터의 관리자는 이 센터에 배치를 시도할 수 없다" 검증이 깨지는 실제 fixture 오염을
    일으켰다(TEST-002). 이번 버전은 이 파일이 "이번 실행에서 새로 만든 것"만 정확히 추적해
    afterAll에서 역순으로 정리한다 — 실행 전부터 이미 있던 데이터(예: 과거 오염이 아직
    정리되지 않은 경우)는 건드리지 않는다(그 경우는 cleanup_acl003_test_fixture_proposed.sql로
    별도 정리). 정리는 테스트 성공/실패와 무관하게 항상 시도되고, 실패하면 조용히 무시하지
    않고 명확한 오류로 모아 던진다.

  필요한 환경변수(.env.test.local, 없으면 requireEnv가 안내):
    TEST_MANAGER_A_EMAIL/PASSWORD, TEST_MANAGER_B_EMAIL/PASSWORD
    (둘 다 admin-assignment-security.test.ts와 공유 — 이 파일 전용 계정 없음)
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, type TestUser } from "./setup";
import { createRole, fetchRoles, inviteStaff, removeStaff, deleteRole, setStaffOverride } from "../../lib/roles";
import { fetchMyCenters } from "../../lib/manager";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };

const NO_PERM_ROLE_NAME = "ACL-003 테스트 무권한 역할";
const OVERRIDE_KEY = "customer.member.view";

let managerA: TestUser;
let managerB: TestUser;
let centerAId: string;
let ownerManagerCenterId: string; // centerA에서 managerA(오너) 자신의 manager_centers.id
let staffManagerCenterId: string; // centerA에서 managerB(비오너 스태프)의 manager_centers.id

// 이번 테스트 실행이 실제로 "새로 만든" 것만 기록한다 — beforeAll 이전부터 이미 있던 행은
// 여기 기록되지 않고, 따라서 afterAll에서도 지우지 않는다(요구사항: 사전 존재 데이터 보존).
let createdRoleId: string | null = null;
let createdStaffManagerCenterId: string | null = null;
let createdOwnerOverride = false;
let createdStaffOverride = false;

async function getOrCreateNoPermRole(centerId: string): Promise<{ id: string; created: boolean }> {
  const roles = await fetchRoles(centerId);
  const existing = roles.find((r) => r.name === NO_PERM_ROLE_NAME);
  if (existing) return { id: existing.id, created: false };
  await createRole(centerId, NO_PERM_ROLE_NAME);
  const refreshed = await fetchRoles(centerId);
  const created = refreshed.find((r) => r.name === NO_PERM_ROLE_NAME);
  if (!created) throw new Error("무권한 역할 생성에 실패했어요");
  return { id: created.id, created: true };
  // createRole()은 role_permissions을 채우지 않으므로 이 역할은 permission이 0개 —
  // has_permission()이 항상 false를 반환하는 "권한 없는 일반 스태프" fixture로 쓰기에 적합.
}

// true를 반환하면 이번 호출로 실제로 새 manager_centers 행이 생겼다는 뜻(정리 대상으로 기록해야 함).
async function inviteIfNeeded(centerId: string, accountId: string, roleId: string): Promise<boolean> {
  try {
    await inviteStaff(centerId, accountId, roleId);
    return true;
  } catch (e: any) {
    if (e.message.includes("이미 이 센터의 스태프")) return false;
    throw e;
  }
}

async function managerCenterIdFor(centerId: string, accountId: string): Promise<string> {
  const { data, error } = await supabase
    .from("manager_centers")
    .select("id")
    .eq("center_id", centerId)
    .eq("account_id", accountId)
    .single();
  if (error || !data) throw new Error("manager_centers 행을 찾지 못했어요: " + error?.message);
  return (data as { id: string }).id;
}

async function overrideExists(managerCenterId: string, key: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("account_center_permissions")
    .select("id")
    .eq("manager_center_id", managerCenterId)
    .eq("permission_key", key)
    .maybeSingle();
  if (error) throw new Error("개인 권한 예외 확인 실패: " + error.message);
  return !!data;
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);

  // managerA(오너)로 돌아와 managerB를 centerA에 무권한 스태프로 초대하고,
  // "다른 사람 것"(오너 본인 행)과 "본인 것"(managerB 행) 개인 권한 예외를 각각 설정한다.
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const role = await getOrCreateNoPermRole(centerAId);
  if (role.created) createdRoleId = role.id;

  const invited = await inviteIfNeeded(centerAId, managerB.accountId, role.id);

  ownerManagerCenterId = await managerCenterIdFor(centerAId, managerA.accountId);
  staffManagerCenterId = await managerCenterIdFor(centerAId, managerB.accountId);
  if (invited) createdStaffManagerCenterId = staffManagerCenterId;

  const ownerOverrideAlready = await overrideExists(ownerManagerCenterId, OVERRIDE_KEY);
  await setStaffOverride(ownerManagerCenterId, OVERRIDE_KEY, "allow");
  if (!ownerOverrideAlready) createdOwnerOverride = true;

  const staffOverrideAlready = await overrideExists(staffManagerCenterId, OVERRIDE_KEY);
  await setStaffOverride(staffManagerCenterId, OVERRIDE_KEY, "allow");
  if (!staffOverrideAlready) createdStaffOverride = true;
}, 30000);

// vitest는 이 안의 테스트가 실패해도 afterAll을 항상 실행한다 — 성공/실패와 무관하게 정리됨.
afterAll(async () => {
  // 정리는 항상 오너 권한으로 시도한다(직전 테스트가 managerB로 로그인된 채 끝났을 수 있음).
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);

  const errors: string[] = [];

  // 역순으로 정리: override(자식) → manager_centers → role(부모).
  // manager_centers.role_id는 center_roles를 ON DELETE 절 없이 참조하므로(=RESTRICT),
  // role을 먼저 지우면 FK 위반으로 실패한다 — 반드시 manager_centers보다 나중에 지운다.
  if (createdStaffOverride && staffManagerCenterId) {
    try {
      await setStaffOverride(staffManagerCenterId, OVERRIDE_KEY, null);
    } catch (e: any) {
      errors.push(`staff override 정리 실패(manager_center=${staffManagerCenterId}): ${e.message}`);
    }
  }
  if (createdOwnerOverride && ownerManagerCenterId) {
    try {
      await setStaffOverride(ownerManagerCenterId, OVERRIDE_KEY, null);
    } catch (e: any) {
      errors.push(`owner override 정리 실패(manager_center=${ownerManagerCenterId}): ${e.message}`);
    }
  }
  if (createdStaffManagerCenterId) {
    try {
      await removeStaff(createdStaffManagerCenterId);
    } catch (e: any) {
      errors.push(`manager_centers 정리 실패(id=${createdStaffManagerCenterId}): ${e.message}`);
    }
  }
  if (createdRoleId) {
    try {
      await deleteRole(createdRoleId);
    } catch (e: any) {
      errors.push(`역할 정리 실패(id=${createdRoleId}): ${e.message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`ACL-003 fixture cleanup 실패 — 공유 개발 DB에 잔여 데이터가 남았을 수 있습니다:\n${errors.join("\n")}`);
  }
}, 30000);

describe("ACL-003: account_center_permissions SELECT는 본인 것 또는 facility.role_permission 권한 보유자만 (서버 재검증)", () => {
  it("centerA에서 facility.role_permission이 없는 일반 스태프(managerB)는 다른 사람(오너 managerA)의 개인 권한 행을 직접 조회할 수 없다", async () => {
    // managerB는 자기 센터(B)에서는 오너지만, 여기서는 centerA의 일반(무권한) 스태프로
    // 초대된 상태 — has_permission()/RLS는 항상 조회 대상 행의 center_id 기준으로 판정하므로
    // centerB 오너십은 이 조회 결과에 영향을 주지 않는다.
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase
      .from("account_center_permissions")
      .select("permission_key, grant_type")
      .eq("manager_center_id", ownerManagerCenterId);

    // RLS가 올바르면 0건(또는 에러) — 현재(수정 전) 정책 기준으로는 1건이 보여 이 assertion이 실패한다.
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("본인(managerB, centerA에서는 비오너 스태프)은 자기 자신의 개인 권한 행을 여전히 조회할 수 있다(fetchMyEffectivePermissionKeys 회귀 방지)", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase
      .from("account_center_permissions")
      .select("permission_key, grant_type")
      .eq("manager_center_id", staffManagerCenterId);

    expect(error).toBeNull();
    expect((data ?? []).some((r: any) => r.permission_key === OVERRIDE_KEY && r.grant_type === "allow")).toBe(true);
  });

  it("오너(managerA)는 facility.role_permission 전권으로 다른 스태프(managerB)의 개인 권한 행을 조회할 수 있다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const { data, error } = await supabase
      .from("account_center_permissions")
      .select("permission_key, grant_type")
      .eq("manager_center_id", staffManagerCenterId);

    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});

describe("ACL-005: 관리자 진입 조건(fetchMyCenters/getMyAccountId)은 accounts.is_manager가 아니라 active manager_centers 소속으로 판단한다", () => {
  // 이 beforeAll에서 이미 managerB를 centerA에 "일반 스태프"(무권한 역할)로 초대해둔 상태를
  // 재사용한다 — 실제 버그 재현(일반 회원을 스태프로 등록했더니 관리자 모드에 진입 못 함)과
  // 동일한 초대 경로(lib/roles.ts의 inviteStaff())로 만들어진 fixture이므로, 이 테스트가
  // 그 재현 시나리오를 실제 라이브 Supabase RLS로 검증한다.
  it("스태프로 초대된 managerB는 fetchMyCenters()에서 centerA를 관리 대상으로 볼 수 있다(관리자 모드 진입 가능)", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const centers = await fetchMyCenters();
    const centerA = centers.find((c) => c.id === centerAId);
    expect(centerA).toBeDefined();
    expect(centerA?.isOwner).toBe(false);
    expect(centerA?.managerCenterId).toBe(staffManagerCenterId);
  });

  it("오너(managerA)도 여전히 fetchMyCenters()에서 자신의 센터를 오너로 본다(회귀 방지)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const centers = await fetchMyCenters();
    const centerA = centers.find((c) => c.id === centerAId);
    expect(centerA).toBeDefined();
    expect(centerA?.isOwner).toBe(true);
  });
});
