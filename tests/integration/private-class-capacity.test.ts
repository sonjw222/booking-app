/*
  P2: 프라이빗(1:1) 수업 정원/중복예약/동시진행 제한 — fix_private_class_capacity_and_
  concurrency_draft_proposed.sql이 아직 Supabase에 적용되지 않았다면 이 파일의 모든
  테스트는 실패한다(최종 보고서 "SQL 필요 여부"에 기록 — 적용 전엔 실패가 "예상된 실패"임).

  검증 대상 세 가지(코드 감사로 확인한 실제 버그, fix_private_class_capacity_and_
  concurrency_draft_proposed.sql 헤더 주석 참고):
    1) 프라이빗 수업이 차 있으면 대기예약(waitlist) 없이 바로 거부된다.
    2) 관리자 직접배치는 프라이빗 수업에 대해 정원 초과 강제 배치(force_capacity)를
       허용하지 않는다.
    3) center_settings.private_max_concurrent(_enabled)이 실제로 예약/배치를 막는다
       (그동안 스키마·설정화면에만 있고 아무 효과가 없던 설정).

  ⚠ memberships는 관리자만 만들 수 있다(RLS — admin-assignment-security.test.ts와 동일
  관례). 그래서 두 회원의 수강권을 매니저 세션에서 미리 다 만들어둔 뒤에만 각자
  세션으로 전환해 예약 RPC를 호출한다.
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

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MEMBER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };
const MEMBER_B = { email: "TEST_USER_B_EMAIL", password: "TEST_USER_B_PASSWORD" };

let managerA: TestUser;
let memberA: TestUser;
let memberB: TestUser;
let centerAId: string;
let originalPmc: { enabled: boolean; limit: number | null };

const cleanupTargets: { classId: string; reservationIds: string[] }[] = [];
function trackClass(classId: string) {
  const entry = { classId, reservationIds: [] as string[] };
  cleanupTargets.push(entry);
  return entry;
}

async function asManagerA() {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
}
async function asMemberA() {
  await switchToTestUser(MEMBER_A.email, MEMBER_A.password);
}
async function asMemberB() {
  await switchToTestUser(MEMBER_B.email, MEMBER_B.password);
}

async function setPrivateMaxConcurrent(enabled: boolean, limit: number | null) {
  const admin = getFixtureAdminClient();
  const { error } = await admin
    .from("center_settings")
    .update({ private_max_concurrent_enabled: enabled, private_max_concurrent: limit })
    .eq("center_id", centerAId);
  if (error) throw new Error(`private_max_concurrent 설정 실패: ${error.message}`);
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  memberA = await switchToTestUser(MEMBER_A.email, MEMBER_A.password);
  memberB = await switchToTestUser(MEMBER_B.email, MEMBER_B.password);

  const admin = getFixtureAdminClient();
  const { data: settingsRow } = await admin
    .from("center_settings")
    .select("private_max_concurrent_enabled, private_max_concurrent")
    .eq("center_id", centerAId)
    .single();
  originalPmc = {
    enabled: settingsRow?.private_max_concurrent_enabled ?? false,
    limit: settingsRow?.private_max_concurrent ?? null,
  };
}, 30000);

afterAll(async () => {
  await setPrivateMaxConcurrent(originalPmc.enabled, originalPmc.limit);
  await asManagerA();
  for (const target of cleanupTargets) {
    await cleanupTestClass(target.classId, target.reservationIds);
  }
  await signOutTestSession();
}, 30000);

beforeEach(async () => {
  await asManagerA();
  await setPrivateMaxConcurrent(false, null);
});

describe("프라이빗 수업 — 정원 마감 시 대기예약 없이 바로 거부", () => {
  it("reserve_with_membership: 이미 1명이 확정된 프라이빗 수업에 다른 회원이 예약하면 대기 없이 거부된다", async () => {
    const cls = await createFutureTestClass(centerAId, { classFormat: "private", hoursFromNow: 72, title: "P2 프라이빗 정원마감" });
    const track = trackClass(cls.id);
    const memA = await createTestMembership(centerAId, memberA.profileId, { remainingCount: 5 });
    const memB = await createTestMembership(centerAId, memberB.profileId, { remainingCount: 5 });

    await asMemberA();
    const r1 = await supabase.rpc("reserve_with_membership", {
      p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: memA.id,
    });
    expect(r1.error).toBeNull();
    expect(r1.data.status).toBe("confirmed");

    await asMemberB();
    const r2 = await supabase.rpc("reserve_with_membership", {
      p_class_id: cls.id, p_profile_id: memberB.profileId, p_membership_id: memB.id,
    });
    expect(r2.error).not.toBeNull();
    expect(r2.error!.message).toContain("이미 다른 회원이 예약한 프라이빗 수업");

    await asManagerA();
    const { data: rows } = await supabase.from("reservations").select("id, profile_id, status").eq("class_id", cls.id);
    track.reservationIds.push(...(rows ?? []).map((r: any) => r.id as string));
    expect((rows ?? []).filter((r: any) => r.status !== "cancelled").length).toBe(1);
  });

  it("admin_assign_reservation: 정원 초과 강제 배치(force_capacity)가 프라이빗 수업에서는 거부된다", async () => {
    const cls = await createFutureTestClass(centerAId, { classFormat: "private", hoursFromNow: 73, title: "P2 프라이빗 강제배치거부" });
    const track = trackClass(cls.id);
    const memA = await createTestMembership(centerAId, memberA.profileId, { remainingCount: 5 });
    const memB = await createTestMembership(centerAId, memberB.profileId, { remainingCount: 5 });

    const assign1 = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id, p_profile_id: memberA.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT", p_membership_id: memA.id,
    });
    expect(assign1.error).toBeNull();
    expect(assign1.data.status).toBe("confirmed");
    track.reservationIds.push(assign1.data.reservation_id);

    // needs_capacity_confirm 흐름을 거치지 않고 곧바로 force_capacity=true로 보내도
    // (관리자 UI가 실제로 이렇게 재호출함) 프라이빗은 예외 없이 거부돼야 한다.
    const assign2 = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id, p_profile_id: memberB.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT", p_membership_id: memB.id,
      p_reason_code: "MEMBER_REQUEST", p_force_capacity: true,
    });
    expect(assign2.error).not.toBeNull();
    expect(assign2.error!.message).toContain("추가로 배치할 수 없어요");
  });
});

describe("프라이빗 수업 — 동시 진행 최대 개수(private_max_concurrent) 실제 적용", () => {
  it("설정 OFF면 겹치는 시간대 프라이빗 수업이 여러 개 있어도 모두 예약된다(대조군)", async () => {
    const cls1 = await createFutureTestClass(centerAId, { classFormat: "private", hoursFromNow: 96, title: "P2 동시OFF-1" });
    const cls2 = await createFutureTestClass(centerAId, { classFormat: "private", hoursFromNow: 96, title: "P2 동시OFF-2" });
    trackClass(cls1.id);
    trackClass(cls2.id);
    const memA = await createTestMembership(centerAId, memberA.profileId, { remainingCount: 5 });
    const memB = await createTestMembership(centerAId, memberB.profileId, { remainingCount: 5 });

    await asMemberA();
    const r1 = await supabase.rpc("reserve_with_membership", { p_class_id: cls1.id, p_profile_id: memberA.profileId, p_membership_id: memA.id });
    expect(r1.error).toBeNull();

    await asMemberB();
    const r2 = await supabase.rpc("reserve_with_membership", { p_class_id: cls2.id, p_profile_id: memberB.profileId, p_membership_id: memB.id });
    expect(r2.error).toBeNull();
  });

  it("설정 ON(최대 1개)이면 같은 시간대 두 번째 프라이빗 수업 예약은 거부된다", async () => {
    const cls1 = await createFutureTestClass(centerAId, { classFormat: "private", hoursFromNow: 120, title: "P2 동시ON-1" });
    const cls2 = await createFutureTestClass(centerAId, { classFormat: "private", hoursFromNow: 120, title: "P2 동시ON-2" });
    trackClass(cls1.id);
    trackClass(cls2.id);
    const memA = await createTestMembership(centerAId, memberA.profileId, { remainingCount: 5 });
    const memB = await createTestMembership(centerAId, memberB.profileId, { remainingCount: 5 });
    await setPrivateMaxConcurrent(true, 1);

    await asMemberA();
    const r1 = await supabase.rpc("reserve_with_membership", { p_class_id: cls1.id, p_profile_id: memberA.profileId, p_membership_id: memA.id });
    expect(r1.error).toBeNull();

    await asMemberB();
    const r2 = await supabase.rpc("reserve_with_membership", { p_class_id: cls2.id, p_profile_id: memberB.profileId, p_membership_id: memB.id });
    expect(r2.error).not.toBeNull();
    expect(r2.error!.message).toContain("같은 시간대에 진행 가능한 프라이빗 수업");
  });

  it("설정 ON이어도 시간대가 겹치지 않으면(연속 시간) 막히지 않는다", async () => {
    const cls1 = await createFutureTestClass(centerAId, { classFormat: "private", hoursFromNow: 144, durationMinutes: 60, title: "P2 동시비겹침-1" });
    // cls2를 cls1 종료 직후(연속, 겹치지 않음)로 만든다.
    const cls2 = await createFutureTestClass(centerAId, { classFormat: "private", hoursFromNow: 145, durationMinutes: 60, title: "P2 동시비겹침-2" });
    trackClass(cls1.id);
    trackClass(cls2.id);
    const memA = await createTestMembership(centerAId, memberA.profileId, { remainingCount: 5 });
    const memB = await createTestMembership(centerAId, memberB.profileId, { remainingCount: 5 });
    await setPrivateMaxConcurrent(true, 1);

    await asMemberA();
    const r1 = await supabase.rpc("reserve_with_membership", { p_class_id: cls1.id, p_profile_id: memberA.profileId, p_membership_id: memA.id });
    expect(r1.error).toBeNull();

    await asMemberB();
    const r2 = await supabase.rpc("reserve_with_membership", { p_class_id: cls2.id, p_profile_id: memberB.profileId, p_membership_id: memB.id });
    expect(r2.error).toBeNull();
  });

  it("admin_assign_reservation도 같은 동시진행 한도를 적용받는다", async () => {
    const cls1 = await createFutureTestClass(centerAId, { classFormat: "private", hoursFromNow: 168, title: "P2 배치동시-1" });
    const cls2 = await createFutureTestClass(centerAId, { classFormat: "private", hoursFromNow: 168, title: "P2 배치동시-2" });
    const track1 = trackClass(cls1.id);
    trackClass(cls2.id);
    const memA = await createTestMembership(centerAId, memberA.profileId, { remainingCount: 5 });
    const memB = await createTestMembership(centerAId, memberB.profileId, { remainingCount: 5 });
    await setPrivateMaxConcurrent(true, 1);

    const assign1 = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls1.id, p_profile_id: memberA.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT", p_membership_id: memA.id,
    });
    expect(assign1.error).toBeNull();
    track1.reservationIds.push(assign1.data.reservation_id);

    const assign2 = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls2.id, p_profile_id: memberB.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT", p_membership_id: memB.id,
    });
    expect(assign2.error).not.toBeNull();
    expect(assign2.error!.message).toContain("같은 시간대에 진행 가능한 프라이빗 수업");
  });
});
