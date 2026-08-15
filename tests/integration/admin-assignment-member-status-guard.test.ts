/*
  P1-10: 관리자 직접배치에서 탈퇴/휴면 회원은 customer.member.assign_any_status 권한이 있어야
  배치 가능(오너는 자동 통과). add_admin_assignment_member_status_guard.sql이 사용자 확인
  적용 완료(2026-08-15) — 이 테스트는 그 라이브 동작을 실제로 검증한다.

  Fixture 전략은 acl-003-permission-read.test.ts와 동일: MANAGER_B를 centerA에 권한 0개인
  역할로 초대해 "일반 스태프" 역할을 하게 한다. 이 파일 전용 역할 이름을 써서 다른 테스트
  파일과 fixture가 섞이지 않게 한다.

  member(TEST_USER_A)의 centerA center_members.status를 이 테스트 동안만 'dormant'로
  바꿨다가, 원래 값(없었으면 행 자체를 삭제, 있었으면 원래 값)으로 반드시 되돌린다 — 이
  프로필은 다른 통합테스트 파일들도 공유하는 fixture라 상태를 남기면 안 된다.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  signOutTestSession,
  type TestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  createTestMembership,
  cleanupTestClass,
  getFixtureAdminClient,
} from "./setup";
import { createRole, inviteStaff, removeStaff, deleteRole, setStaffOverride } from "../../lib/roles";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };
const MEMBER = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };

const ROLE_NAME = "P1-10 테스트 무권한 역할";
const PERM_KEY = "customer.member.assign_any_status";

let managerA: TestUser;
let managerB: TestUser;
let member: TestUser;
let centerAId: string;
let roleId: string | null = null;
let staffManagerCenterId: string | null = null;
let originalMemberStatus: string | null | undefined; // undefined = 아직 조회 전, null = 행 자체가 없었음

const cleanupTargets: { classId: string; reservationIds: string[] }[] = [];
function trackClass(classId: string) {
  const entry = { classId, reservationIds: [] as string[] };
  cleanupTargets.push(entry);
  return entry;
}

async function asManagerA() {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
}
async function asManagerB() {
  await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
}

async function setMemberStatus(status: string) {
  const admin = getFixtureAdminClient();
  const { error } = await admin
    .from("center_members")
    .upsert({ center_id: centerAId, profile_id: member.profileId, status }, { onConflict: "center_id,profile_id" });
  if (error) throw new Error("center_members 상태 변경 실패: " + error.message);
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  member = await switchToTestUser(MEMBER.email, MEMBER.password);

  await asManagerA();

  const admin = getFixtureAdminClient();
  const { data: existingRole } = await supabase
    .from("center_roles").select("id").eq("center_id", centerAId).eq("name", ROLE_NAME).maybeSingle();
  if (existingRole) {
    roleId = existingRole.id;
  } else {
    await createRole(centerAId, ROLE_NAME);
    const { data: created } = await supabase
      .from("center_roles").select("id").eq("center_id", centerAId).eq("name", ROLE_NAME).single();
    roleId = created!.id;
  }

  const { data: existingStaff } = await supabase
    .from("manager_centers").select("id").eq("center_id", centerAId).eq("account_id", managerB.accountId).maybeSingle();
  if (existingStaff) {
    staffManagerCenterId = existingStaff.id;
    // 이전 실행 잔여물이면 역할이 무권한 역할인지 보장(다른 목적으로 남아있으면 곤란)
    await admin.from("manager_centers").update({ role_id: roleId }).eq("id", existingStaff.id);
  } else {
    await inviteStaff(centerAId, managerB.accountId, roleId!);
    const { data: created } = await supabase
      .from("manager_centers").select("id").eq("center_id", centerAId).eq("account_id", managerB.accountId).single();
    staffManagerCenterId = created!.id;
  }

  const { data: memRow } = await admin
    .from("center_members").select("status").eq("center_id", centerAId).eq("profile_id", member.profileId).maybeSingle();
  originalMemberStatus = memRow ? memRow.status : null;
}, 30000);

afterAll(async () => {
  await asManagerA();
  for (const target of cleanupTargets) {
    await cleanupTestClass(target.classId, target.reservationIds);
  }

  const admin = getFixtureAdminClient();
  if (originalMemberStatus === null) {
    await admin.from("center_members").delete().eq("center_id", centerAId).eq("profile_id", member.profileId);
  } else if (originalMemberStatus !== undefined) {
    await admin.from("center_members")
      .update({ status: originalMemberStatus }).eq("center_id", centerAId).eq("profile_id", member.profileId);
  }

  try { await setStaffOverride(staffManagerCenterId!, PERM_KEY, null); } catch { /* 이미 없으면 무시 */ }
  if (staffManagerCenterId) { try { await removeStaff(staffManagerCenterId); } catch { /* 무시 */ } }
  if (roleId) { try { await deleteRole(roleId); } catch { /* 무시 */ } }

  await signOutTestSession();
}, 30000);

// 기본 세션: 매니저 A. 각 테스트는 스태프 세션이 필요할 때 내부에서 명시적으로 전환한다
// (앞 테스트가 managerB로 끝나도 다음 테스트의 fixture 준비(수업/수강권 생성)는 항상
// managerA 권한으로 시작해야 한다 — admin-assignment-security.test.ts와 동일한 관례).
beforeEach(async () => {
  await asManagerA();
});

describe("P1-10: 관리자 직접배치 — 탈퇴/휴면 회원은 customer.member.assign_any_status 권한 필요", () => {
  it("권한 없는 스태프가 휴면 회원을 배치하려 하면 거부된다", async () => {
    await setMemberStatus("dormant");
    const cls = await createFutureTestClass(centerAId, { title: "P1-10 휴면-무권한거부" });
    const entry = trackClass(cls.id);
    const membership = await createTestMembership(centerAId, member.profileId, { remainingCount: 5 });

    await asManagerB();
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id, p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT", p_membership_id: membership.id,
      p_reason_code: "MEMBER_REQUEST", p_reason_detail: null, p_force_capacity: false,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("이용정지·탈퇴·휴면");
    expect(data).toBeNull();
    void entry;
  });

  it("customer.member.assign_any_status 권한을 부여하면 같은 스태프가 휴면 회원도 배치할 수 있다", async () => {
    await setMemberStatus("dormant");
    const cls = await createFutureTestClass(centerAId, { title: "P1-10 휴면-권한부여성공" });
    const entry = trackClass(cls.id);
    const membership = await createTestMembership(centerAId, member.profileId, { remainingCount: 5 });

    await asManagerA();
    await setStaffOverride(staffManagerCenterId!, PERM_KEY, "allow");

    await asManagerB();
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id, p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT", p_membership_id: membership.id,
      p_reason_code: "MEMBER_REQUEST", p_reason_detail: null, p_force_capacity: false,
    });
    expect(error).toBeNull();
    expect((data as any).reservation_id).toBeTruthy();
    entry.reservationIds.push((data as any).reservation_id);

    await asManagerA();
    await setStaffOverride(staffManagerCenterId!, PERM_KEY, null);
  });

  it("오너는 이 권한 없이도 휴면 회원을 배치할 수 있다", async () => {
    await setMemberStatus("dormant");
    const cls = await createFutureTestClass(centerAId, { title: "P1-10 휴면-오너성공" });
    const entry = trackClass(cls.id);
    const membership = await createTestMembership(centerAId, member.profileId, { remainingCount: 5 });

    await asManagerA();
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id, p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT", p_membership_id: membership.id,
      p_reason_code: "MEMBER_REQUEST", p_reason_detail: null, p_force_capacity: false,
    });
    expect(error).toBeNull();
    expect((data as any).reservation_id).toBeTruthy();
    entry.reservationIds.push((data as any).reservation_id);
  });

  it("활성 회원은 권한 없는 스태프도 정상 배치할 수 있다(대조군 — 게이트가 활성 회원까지 막지 않음)", async () => {
    await setMemberStatus("active");
    const cls = await createFutureTestClass(centerAId, { title: "P1-10 활성-무권한성공" });
    const entry = trackClass(cls.id);
    const membership = await createTestMembership(centerAId, member.profileId, { remainingCount: 5 });

    await asManagerB();
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id, p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT", p_membership_id: membership.id,
      p_reason_code: "MEMBER_REQUEST", p_reason_detail: null, p_force_capacity: false,
    });
    expect(error).toBeNull();
    expect((data as any).reservation_id).toBeTruthy();
    entry.reservationIds.push((data as any).reservation_id);
  });
});
