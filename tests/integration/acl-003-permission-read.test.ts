/*
  ACL-003 서버 측 재검증(2026-08-01) 회귀 테스트.

  이 파일은 fix_account_center_permissions_select_draft_proposed.sql이
  실제로 실행되기 전에는 의도적으로 실패해야 합니다(현재 정책의 결함을 증명하는
  "red" 테스트) — 그 SQL을 스테이징/운영에 적용한 뒤에만 통과해야 "green"이 됩니다.
  이번 배치는 그 SQL을 실행하지 않았으므로, 이 테스트도 아직 실행하지 않았습니다
  (docs/CHANGELOG.md·완료 보고에 명시).

  시나리오: 센터 A에 오너(managerA)와 facility.role_permission이 전혀 없는 일반
  스태프 2명(staffA, staffB)을 둔다. managerA가 staffB에게 개인 권한 예외
  (allow) 하나를 설정한다. staffA로 로그인해 Supabase SDK로 직접
  `account_center_permissions`를 조회하면(화면 가드를 완전히 우회) staffB의
  행이 보이면 안 된다 — 현재(수정 전) 정책은 "같은 센터 소속"이기만 하면
  통과시키므로 이 시점에는 실패(FAIL 재현)한다.

  필요한 환경변수(.env.test.local, 없으면 requireEnv가 안내):
    TEST_MANAGER_A_EMAIL/PASSWORD (기존 admin-assignment-security.test.ts와 공유)
    TEST_STAFF_A_EMAIL/PASSWORD, TEST_STAFF_B_EMAIL/PASSWORD (신규)
*/
import { beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, type TestUser } from "./setup";
import { createRole, fetchRoles, inviteStaff, setStaffOverride } from "../../lib/roles";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const STAFF_A = { email: "TEST_STAFF_A_EMAIL", password: "TEST_STAFF_A_PASSWORD" };
const STAFF_B = { email: "TEST_STAFF_B_EMAIL", password: "TEST_STAFF_B_PASSWORD" };

const NO_PERM_ROLE_NAME = "ACL-003 테스트 무권한 역할";

let managerA: TestUser;
let staffA: TestUser;
let staffB: TestUser;
let centerAId: string;
let staffBManagerCenterId: string;

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

async function myManagerCenterId(centerId: string, accountId: string): Promise<string> {
  const { data, error } = await supabase
    .from("manager_centers")
    .select("id")
    .eq("center_id", centerId)
    .eq("account_id", accountId)
    .single();
  if (error || !data) throw new Error("본인 manager_centers 행을 찾지 못했어요: " + error?.message);
  return (data as { id: string }).id;
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  staffA = await switchToTestUser(STAFF_A.email, STAFF_A.password);
  staffB = await switchToTestUser(STAFF_B.email, STAFF_B.password);

  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const roleId = await getOrCreateNoPermRole(centerAId);
  await inviteIfNeeded(centerAId, staffA.accountId, roleId);
  await inviteIfNeeded(centerAId, staffB.accountId, roleId);

  staffBManagerCenterId = await myManagerCenterId(centerAId, staffB.accountId);
  // 오너가 staffB에게 개인 허용 예외를 하나 설정해둔다 — staffA가 이 행을 볼 수 있는지가 테스트 대상.
  await setStaffOverride(staffBManagerCenterId, "customer.member.view", "allow");
}, 30000);

describe("ACL-003: account_center_permissions SELECT는 본인 것 또는 facility.role_permission 권한 보유자만 (서버 재검증)", () => {
  it("facility.role_permission이 없는 일반 스태프(staffA)는 다른 스태프(staffB)의 개인 권한 행을 직접 조회할 수 없다", async () => {
    await switchToTestUser(STAFF_A.email, STAFF_A.password);
    const { data, error } = await supabase
      .from("account_center_permissions")
      .select("permission_key, grant_type")
      .eq("manager_center_id", staffBManagerCenterId);

    // RLS가 올바르면 0건(또는 에러) — 현재(수정 전) 정책 기준으로는 1건이 보여 이 assertion이 실패한다.
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("본인(staffB)은 자기 자신의 개인 권한 행을 여전히 조회할 수 있다(fetchMyEffectivePermissionKeys 회귀 방지)", async () => {
    await switchToTestUser(STAFF_B.email, STAFF_B.password);
    const { data, error } = await supabase
      .from("account_center_permissions")
      .select("permission_key, grant_type")
      .eq("manager_center_id", staffBManagerCenterId);

    expect(error).toBeNull();
    expect((data ?? []).some((r: any) => r.permission_key === "customer.member.view" && r.grant_type === "allow")).toBe(true);
  });

  it("오너(managerA)는 facility.role_permission 전권으로 다른 스태프(staffB)의 개인 권한 행을 조회할 수 있다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const { data, error } = await supabase
      .from("account_center_permissions")
      .select("permission_key, grant_type")
      .eq("manager_center_id", staffBManagerCenterId);

    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});
