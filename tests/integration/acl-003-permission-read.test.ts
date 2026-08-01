/*
  ACL-003 서버 측 재검증(2026-08-01) 회귀 테스트.

  이 파일은 fix_account_center_permissions_select_draft_proposed.sql이
  실제로 실행되기 전에는 의도적으로 실패해야 합니다(현재 정책의 결함을 증명하는
  "red" 테스트) — 그 SQL을 스테이징/운영에 적용한 뒤에만 통과해야 "green"이 됩니다.
  이번 배치는 그 SQL을 실행하지 않았으므로, 이 테스트도 아직 실행하지 않았습니다
  (docs/CHANGELOG.md·완료 보고에 명시).

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

  필요한 환경변수(.env.test.local, 없으면 requireEnv가 안내):
    TEST_MANAGER_A_EMAIL/PASSWORD, TEST_MANAGER_B_EMAIL/PASSWORD
    (둘 다 admin-assignment-security.test.ts와 공유 — 이 파일 전용 계정 없음)
*/
import { beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, type TestUser } from "./setup";
import { createRole, fetchRoles, inviteStaff, setStaffOverride } from "../../lib/roles";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };

const NO_PERM_ROLE_NAME = "ACL-003 테스트 무권한 역할";
const OVERRIDE_KEY = "customer.member.view";

let managerA: TestUser;
let managerB: TestUser;
let centerAId: string;
let ownerManagerCenterId: string; // centerA에서 managerA(오너) 자신의 manager_centers.id
let staffManagerCenterId: string; // centerA에서 managerB(비오너 스태프)의 manager_centers.id

async function getOrCreateNoPermRole(centerId: string): Promise<string> {
  const roles = await fetchRoles(centerId);
  const existing = roles.find((r) => r.name === NO_PERM_ROLE_NAME);
  if (existing) return existing.id;
  await createRole(centerId, NO_PERM_ROLE_NAME);
  const refreshed = await fetchRoles(centerId);
  const created = refreshed.find((r) => r.name === NO_PERM_ROLE_NAME);
  if (!created) throw new Error("무권한 역할 생성에 실패했어요");
  return created.id;
  // createRole()은 role_permissions을 채우지 않으므로 이 역할은 permission이 0개 —
  // has_permission()이 항상 false를 반환하는 "권한 없는 일반 스태프" fixture로 쓰기에 적합.
}

async function inviteIfNeeded(centerId: string, accountId: string, roleId: string) {
  try {
    await inviteStaff(centerId, accountId, roleId);
  } catch (e: any) {
    if (!e.message.includes("이미 이 센터의 스태프")) throw e;
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

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);

  // managerA(오너)로 돌아와 managerB를 centerA에 무권한 스태프로 초대하고,
  // "다른 사람 것"(오너 본인 행)과 "본인 것"(managerB 행) 개인 권한 예외를 각각 설정한다.
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const roleId = await getOrCreateNoPermRole(centerAId);
  await inviteIfNeeded(centerAId, managerB.accountId, roleId);

  ownerManagerCenterId = await managerCenterIdFor(centerAId, managerA.accountId);
  staffManagerCenterId = await managerCenterIdFor(centerAId, managerB.accountId);

  await setStaffOverride(ownerManagerCenterId, OVERRIDE_KEY, "allow");
  await setStaffOverride(staffManagerCenterId, OVERRIDE_KEY, "allow");
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
