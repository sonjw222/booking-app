/*
  P3(출석/체크인 배치): manager_set_attendance()의 실제 정책 통합테스트.

  기존 구조 감사 결과: 출석 기능(스키마 status enum, RPC, 관리자 UI 두 곳, 회원 화면 상태
  표시)은 전부 이미 구현돼 있었다 — 새로 만들지 않는다. 다만 manager_set_attendance()가
  이 저장소 안에 서로 다른 버전으로 4곳(add_attendance.sql, reservation_functions.sql 안에
  2개, add_admin_assignment.sql)에 정의돼 있었고, 어느 버전이 실제 운영 DB에 살아있는지
  git 파일만으로는 알 수 없었다(docs/TODO.md P0-3에 이미 알려진 migration ledger 갭).
  이 테스트는:
    1) "이미 취소된 예약을 다시 출결 상태로 바꿀 수 없다"가 실제로 지켜지는지 확인해 어느
       버전이 라이브인지 실제 동작으로 못박고,
    2) fix_attendance_consolidate_and_guard_draft_proposed.sql이 새로 추가하는 "대기 중인
       예약은 출석/결석으로 표시할 수 없다" 가드(SQL 미적용 시 실패 — 예상된 실패)와,
    3) 타 센터 매니저 차단, 프라이빗/그룹 수업 동일 동작을 검증한다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  signOutTestSession,
  type TestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  createTestMembership,
  cleanupTestClassAdmin,
  getFixtureAdminClient,
} from "./setup";
import { fetchSettings, saveSettings, type CenterSettings } from "../../lib/settings";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };
const MEMBER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };
const MEMBER_B = { email: "TEST_USER_B_EMAIL", password: "TEST_USER_B_PASSWORD" };

let managerA: TestUser;
let managerB: TestUser;
let memberA: TestUser;
let memberB: TestUser;
let centerAId: string;
let centerBId: string;
let defaultSettings: CenterSettings;
const createdClassIds: string[] = [];

async function asManagerA() { await switchToTestUser(MANAGER_A.email, MANAGER_A.password); }
async function asManagerB() { await switchToTestUser(MANAGER_B.email, MANAGER_B.password); }
async function asMemberA() { await switchToTestUser(MEMBER_A.email, MEMBER_A.password); }
async function asMemberB() { await switchToTestUser(MEMBER_B.email, MEMBER_B.password); }

async function reserveAndGetId(classId: string, profileId: string): Promise<string> {
  const { data, error } = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: profileId });
  if (error) throw new Error(`예약 실패: ${error.message}`);
  return (data as any).reservation_id;
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  centerBId = await getOrCreateOwnedTestCenter(managerB);
  memberA = await switchToTestUser(MEMBER_A.email, MEMBER_A.password);
  memberB = await switchToTestUser(MEMBER_B.email, MEMBER_B.password);

  // P1-14 self-healing: 이 파일이 만드는 "P3 출결-*" 수업은 테스트 성격상 waitlisted/
  // confirmed 상태로 끝나는 경우가 있어(대기 거부 가드 테스트가 그 예) afterAll의 raw
  // delete가 RLS("매니저 취소예약 정리" 정책, status in ('cancelled','no_show')만 허용)에
  // 막혀 조용히 실패할 수 있었다(실측: memberB의 waitlisted 예약이 3일간 13건 누적 —
  // docs/TODO.md P1-14). afterAll을 admin 기반(cleanupTestClassAdmin)으로 바꿔 근본적으로
  // 막았지만, 과거에 이미 남은 잔여물과 혹시 모를 예외 상황(afterAll 자체가 실행되지 못한
  // 경우 등)에 대비해 이번 실행 시작 전에도 이 파일 전용 제목의 잔여 수업/예약을 admin으로
  // 한 번 더 정리한다(get-or-create/self-healing beforeAll cleanup 패턴).
  {
    const admin = getFixtureAdminClient();
    const staleTitles = [
      "P3 출결-취소최종", "P3 출결-대기거부", "P3 출결-대기취소",
      "P3 출결-타센터차단", "P3 출결-프라이빗",
    ];
    const { data: staleClasses, error: staleErr } = await admin
      .from("classes")
      .select("id")
      .eq("center_id", centerAId)
      .in("title", staleTitles);
    if (staleErr) throw new Error(`P1-14 self-healing 조회 실패: ${staleErr.message}`);
    for (const c of staleClasses ?? []) {
      await cleanupTestClassAdmin((c as any).id);
    }
  }

  // "대기 중인 예약은 출석 대상이 아니다" 테스트는 실제로 waitlisted 예약이 생겨야 하는데,
  // 이 공유 센터의 현재 설정이 waitlist_weekly_limit=0(대기예약 미사용)이면 정원 초과 시
  // reserve_class()가 대기 대신 즉시 거부한다(실제로 CI에서 재현됨) — 이 describe 블록이
  // 끝나면 원래 값으로 되돌린다(reservation-cancel-grace-period.test.ts와 동일한 패턴).
  await asManagerA();
  defaultSettings = await fetchSettings(centerAId);
  await saveSettings(centerAId, { ...defaultSettings, waitlistWeeklyLimit: 10 });
}, 30000);

afterAll(async () => {
  // P1-14: 세션 기반(cleanupTestClass) 대신 admin(service_role) 기반으로 정리한다 — RLS의
  // "매니저 취소예약 정리" 정책이 cancelled/no_show 상태만 삭제를 허용해, 이 파일의 waitlisted
  // 상태로 끝나는 테스트에서는 세션 기반 delete가 매번 조용히 실패했다(위 beforeAll 주석 참고).
  for (const id of createdClassIds) {
    try { await cleanupTestClassAdmin(id); } catch { /* 무시 — 다음 실행의 self-healing이 정리 */ }
  }
  try {
    await asManagerA();
    await saveSettings(centerAId, defaultSettings);
  } catch { /* 무시 */ }
  await signOutTestSession();
}, 30000);

describe("manager_set_attendance(): 취소는 최종 상태", () => {
  it("취소된 예약은 다시 출석/결석/노쇼로 바꿀 수 없다", async () => {
    await asManagerA();
    const cls = await createFutureTestClass(centerAId, { title: "P3 출결-취소최종", hoursFromNow: 200 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 2 });
    const resId = await reserveAndGetId(cls.id, managerA.profileId);

    const cancelRes = await supabase.rpc("manager_set_attendance", { p_reservation_id: resId, p_status: "cancelled" });
    expect(cancelRes.error).toBeNull();

    const reopenRes = await supabase.rpc("manager_set_attendance", { p_reservation_id: resId, p_status: "attended" });
    expect(reopenRes.error).not.toBeNull();
    expect(reopenRes.error!.message).toContain("이미 취소된 예약");
  });
});

describe("manager_set_attendance(): 대기 중인 예약은 출석/결석 대상이 아니다 (SQL 가드, 미적용 시 실패 — 예상된 실패)", () => {
  it("정원이 찬 그룹 수업에서 대기(waitlisted)로 등록된 예약은 attended로 바꿀 수 없다", async () => {
    // createTestMembership()은 RLS상 그 센터 매니저 권한으로만 성공한다 — memberA/B의
    // 수강권도 managerA 세션인 채로 먼저 만들어두고, 예약 자체만 각자 세션으로 전환해 호출한다
    // (private-class-capacity.test.ts 등 기존 테스트와 동일한 순서).
    await asManagerA();
    const cls = await createFutureTestClass(centerAId, { title: "P3 출결-대기거부", hoursFromNow: 201, capacity: 1 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 2 });
    await createTestMembership(centerAId, memberA.profileId, { remainingCount: 2 });
    await createTestMembership(centerAId, memberB.profileId, { remainingCount: 2 });

    await asMemberA();
    const confirmedId = await reserveAndGetId(cls.id, memberA.profileId); // 정원 1명 채움 → confirmed

    await asMemberB();
    const waitlistedId = await reserveAndGetId(cls.id, memberB.profileId); // 정원 초과 → waitlisted

    await asManagerA();
    const { data: waitRow } = await supabase.from("reservations").select("status").eq("id", waitlistedId).single();
    expect(waitRow?.status).toBe("waitlisted"); // 전제 확인(대기가 실제로 생겼는지)

    const attendRes = await supabase.rpc("manager_set_attendance", { p_reservation_id: waitlistedId, p_status: "attended" });
    expect(attendRes.error).not.toBeNull();
    expect(attendRes.error!.message).toContain("대기 중인 예약");

    // 대조군: 확정된 예약은 정상적으로 출석 처리된다.
    const confirmAttendRes = await supabase.rpc("manager_set_attendance", { p_reservation_id: confirmedId, p_status: "attended" });
    expect(confirmAttendRes.error).toBeNull();
  });

  it("대기 중인 예약도 취소(waitlist 철회)는 여전히 허용된다", async () => {
    await asManagerA();
    const cls = await createFutureTestClass(centerAId, { title: "P3 출결-대기취소", hoursFromNow: 202, capacity: 1 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, memberA.profileId, { remainingCount: 2 });
    await createTestMembership(centerAId, memberB.profileId, { remainingCount: 2 });

    await asMemberA();
    await reserveAndGetId(cls.id, memberA.profileId);

    await asMemberB();
    const waitlistedId = await reserveAndGetId(cls.id, memberB.profileId);

    await asManagerA();
    const cancelRes = await supabase.rpc("manager_set_attendance", { p_reservation_id: waitlistedId, p_status: "cancelled" });
    expect(cancelRes.error).toBeNull();
  });
});

describe("manager_set_attendance(): 타 센터 매니저 차단", () => {
  it("centerB의 매니저는 centerA 예약의 출결을 바꿀 수 없다", async () => {
    await asManagerA();
    const cls = await createFutureTestClass(centerAId, { title: "P3 출결-타센터차단", hoursFromNow: 203 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 2 });
    const resId = await reserveAndGetId(cls.id, managerA.profileId);

    await asManagerB();
    const { error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: resId, p_status: "attended" });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("권한이 없어요");
  });
});

describe("manager_set_attendance(): 프라이빗 수업도 그룹과 동일하게 동작한다", () => {
  it("프라이빗 수업(capacity=1)의 확정 예약을 출석/노쇼로 표시할 수 있다", async () => {
    await asManagerA();
    const cls = await createFutureTestClass(centerAId, { title: "P3 출결-프라이빗", hoursFromNow: 204, classFormat: "private" });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 2 });
    const resId = await reserveAndGetId(cls.id, managerA.profileId);

    const attendRes = await supabase.rpc("manager_set_attendance", { p_reservation_id: resId, p_status: "attended" });
    expect(attendRes.error).toBeNull();

    const noShowRes = await supabase.rpc("manager_set_attendance", { p_reservation_id: resId, p_status: "no_show" });
    expect(noShowRes.error).toBeNull();
  });
});
