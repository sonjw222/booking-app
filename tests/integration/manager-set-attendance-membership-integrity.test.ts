/*
  SEC-115(P1, 금전/수강권 무결성) 회귀 테스트 — manager_set_attendance().

  ⚠ 이 파일은 fix_manager_set_attendance_membership_integrity_draft_proposed.sql이
  적용되기 전에는 의도적으로 FAIL해야 한다(특히 ATT-SEC-B/E — 지금은 각각
  "잘못 +1됨"/"차단 안 됨"이 버그다). 적용 후 전부 green이어야 정상이다.

  waitlisted 예약을 실제로 만들기 위해 capacity=1 수업에 USER_B(확정) → MANAGER_A
  본인(대기) 순서로 reserve_class()를 두 번 호출한다(실제 RPC 경유, membership_id를
  직접 조작하지 않음 — reserve_with_membership()이 waitlisted에 membership_consumed=false를
  정확히 기록하는 것과 동일한 실제 경로를 통해 자연스럽게 "차감 안 된 대기 예약"을
  재현한다).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { fetchSettings, saveSettings, type CenterSettings } from "../../lib/settings";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  createFutureTestClass,
  createTestMembership,
  fetchMembershipRemaining,
  cleanupTestClassAdmin,
  type TestUser,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };
const USER_B = { email: "TEST_USER_B_EMAIL", password: "TEST_USER_B_PASSWORD" };

let managerA: TestUser;
let managerB: TestUser;
let userB: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;

const cleanupClassIds: string[] = [];

// 이 describe 스위트 전체가 makeConfirmedReservation()/makeWaitlistedReservation()을
// 여러 번 호출하며 매번 userB로 새 수업을 예약한다. 공유 테스트센터에 daily_book_limit이
// 켜져 있을 수 있고, ATT-SEC-G는 "attended → confirmed 되돌리기"가 테스트 목적이라
// 일부러 그 예약을 confirmed 상태로 남겨둔다 — 그 상태가 daily_book_limit 카운트에
// 그대로 잡혀 같은 날짜의 다음 호출을 막아버리는 게 실측 확인됨(SEC-115 로직과 무관한
// 순수 테스트 격리 문제). 호출마다 서로 다른 날짜로 흩어 이 충돌 자체를 구조적으로 피한다.
let daySpreadCounter = 0;
function nextHoursFromNow(baseHours: number): number {
  const hours = baseHours + daySpreadCounter * 24;
  daySpreadCounter += 1;
  return hours;
}

async function asManagerA() { return switchToTestUser(MANAGER_A.email, MANAGER_A.password); }
async function asManagerB() { return switchToTestUser(MANAGER_B.email, MANAGER_B.password); }
async function asUserB() { return switchToTestUser(USER_B.email, USER_B.password); }

async function reserveAsCurrentUser(classId: string, profileId: string): Promise<{ id: string; status: string }> {
  const { data, error } = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: profileId });
  if (error) throw new Error(`예약 실패: ${error.message}`);
  return { id: (data as any).reservation_id, status: (data as any).status };
}

async function fetchReservationStatus(reservationId: string): Promise<string> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin.from("reservations").select("status").eq("id", reservationId).single();
  if (error) throw new Error(`예약 조회 실패: ${error.message}`);
  return (data as any).status;
}

// confirmed 예약 1건(잔여 -1 소모된 상태)을 만든다: capacity 넉넉한 수업 + USER_B 멤버십.
async function makeConfirmedReservation(): Promise<{ reservationId: string; membershipId: string; remainingAfterBooking: number }> {
  // classes INSERT는 매니저 권한이 필요하다 — beforeAll이 마지막에 userB로 세션을
  // 남겨두므로(또는 직전 테스트가 userB/managerB로 끝났을 수 있으므로), 수업 생성
  // 전에 명시적으로 managerA 세션을 확정한다.
  await asManagerA();
  const cls = await createFutureTestClass(centerAId, { title: "ATT-SEC 확정", capacity: 8, hoursFromNow: nextHoursFromNow(48) });
  cleanupClassIds.push(cls.id);
  await asUserB();
  await createTestMembership(centerAId, userB.profileId, { remainingCount: 3 });
  const res = await reserveAsCurrentUser(cls.id, userB.profileId);
  expect(res.status).toBe("confirmed");
  // reserve_class()는 p_membership_id를 받지 않고 내부적으로 알아서 소진할 membership을
  // 고른다. 공유 테스트 계정(userB)에는 다른 파일/세션이 남긴 멤버십이 더 있을 수 있어,
  // 방금 만든 것이 아니라 실제로 그 예약에 소진될 membership을 admin으로 다시 확인한다
  // (실측 확인됨 — 방금 만든 membership을 그대로 믿었더니 다른 leftover membership이
  // 대신 소진돼 remaining_count가 안 바뀐 것처럼 보였다).
  const admin = getFixtureAdminClient();
  const { data: resRow, error: resErr } = await admin.from("reservations").select("membership_id").eq("id", res.id).single();
  if (resErr || !(resRow as any)?.membership_id) throw new Error(`예약의 membership_id 조회 실패: ${resErr?.message ?? "membership_id가 null"}`);
  const membershipId = (resRow as any).membership_id as string;
  const remaining = await fetchMembershipRemaining(membershipId);
  return { reservationId: res.id, membershipId, remainingAfterBooking: remaining ?? 0 };
}

// waitlisted 예약 1건(잔여 소모 없음)을 만든다: capacity=1 수업을 USER_B가 먼저 확정으로
// 채운 뒤, MANAGER_A 본인 명의로 같은 수업에 다시 예약해 대기로 밀려나게 한다.
async function makeWaitlistedReservation(): Promise<{ reservationId: string; membershipId: string; remainingBefore: number }> {
  // classes INSERT는 매니저 권한이 필요하다 — 위 makeConfirmedReservation과 동일한 이유로
  // 수업 생성 전에 명시적으로 managerA 세션을 확정한다.
  await asManagerA();
  const cls = await createFutureTestClass(centerAId, { title: "ATT-SEC 대기", capacity: 1, hoursFromNow: nextHoursFromNow(48) });
  cleanupClassIds.push(cls.id);

  await asUserB();
  await createTestMembership(centerAId, userB.profileId, { remainingCount: 3 });
  const fillerRes = await reserveAsCurrentUser(cls.id, userB.profileId);
  expect(fillerRes.status).toBe("confirmed");

  await asManagerA();
  const mem = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
  const remainingBefore = (await fetchMembershipRemaining(mem.id)) ?? 0;
  const res = await reserveAsCurrentUser(cls.id, managerA.profileId);
  expect(res.status).toBe("waitlisted");
  return { reservationId: res.id, membershipId: mem.id, remainingBefore };
}

beforeAll(async () => {
  managerA = await asManagerA();
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  managerB = await asManagerB();
  await getOrCreateOwnedTestCenter(managerB);
  userB = await asUserB();

  // [P2-28 수정] makeWaitlistedReservation()이 waitlisted 예약을 만들려면 이 공유
  // 테스트센터의 waitlist_weekly_limit이 0보다 커야 한다(reserve_class RPC가
  // coalesce(waitlist_weekly_limit, 0) = 0이면 "이 센터는 대기예약을 사용하지 않아요"로
  // 거부함, fix_class_deadline_overrides_same_day_toggle.sql 참고). 이 파일은 지금까지
  // 이 값을 한 번도 명시적으로 설정한 적이 없어 다른 세션이 공유 센터의 이 값을
  // 0으로 바꿔두면(또는 애초에 0인 채로 시작하면) ATT-SEC-B~E가 전부 실패했다.
  // 매 테스트가 만드는 waitlisted 예약이 한 자리씩 차지하므로 넉넉히 999로 설정.
  await asManagerA();
  originalSettings = await fetchSettings(centerAId);
  await saveSettings(centerAId, { ...originalSettings, waitlistWeeklyLimit: 999 });
}, 60000);

afterAll(async () => {
  await asManagerA();
  const errors: string[] = [];
  for (const classId of cleanupClassIds) {
    try { await cleanupTestClassAdmin(classId); } catch (e: any) { errors.push(e.message); }
  }
  try { await saveSettings(centerAId, originalSettings); } catch (e: any) { errors.push(e.message); }
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 30000);

describe("SEC-115 ATT-SEC-A~B: 취소 시 차감 복구 정확성", () => {
  it("ATT-SEC-A: confirmed → cancelled는 실제로 차감했던 membership만 정확히 +1 복구한다", async () => {
    const { reservationId, membershipId, remainingAfterBooking } = await makeConfirmedReservation();
    await asManagerA();
    const { data, error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: reservationId, p_status: "cancelled" });
    expect(error).toBeNull();
    expect((data as any).restored).toBe(true);
    expect(await fetchMembershipRemaining(membershipId)).toBe(remainingAfterBooking + 1);
  });

  it("ATT-SEC-B: waitlisted → cancelled는 remaining_count를 전혀 바꾸지 않는다(SEC-115 핵심 회귀)", async () => {
    const { reservationId, membershipId, remainingBefore } = await makeWaitlistedReservation();
    await asManagerA();
    const { data, error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: reservationId, p_status: "cancelled" });
    expect(error).toBeNull();
    expect((data as any).restored).toBe(false);
    expect(await fetchMembershipRemaining(membershipId)).toBe(remainingBefore);
  });
});

describe("SEC-115 ATT-SEC-C~E: 대기(waitlisted) 상태 전환 차단", () => {
  it("ATT-SEC-C: waitlisted → attended는 거부된다", async () => {
    const { reservationId } = await makeWaitlistedReservation();
    await asManagerA();
    const { error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: reservationId, p_status: "attended" });
    expect(error).not.toBeNull();
    expect(await fetchReservationStatus(reservationId)).toBe("waitlisted");
  });

  it("ATT-SEC-D: waitlisted → no_show는 거부된다", async () => {
    const { reservationId } = await makeWaitlistedReservation();
    await asManagerA();
    const { error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: reservationId, p_status: "no_show" });
    expect(error).not.toBeNull();
    expect(await fetchReservationStatus(reservationId)).toBe("waitlisted");
  });

  it("ATT-SEC-E: waitlisted → confirmed 직접 RPC 호출은 거부된다(무차감 확정 우회 차단)", async () => {
    const { reservationId, membershipId, remainingBefore } = await makeWaitlistedReservation();
    await asManagerA();
    const { error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: reservationId, p_status: "confirmed" });
    expect(error).not.toBeNull();
    expect(await fetchReservationStatus(reservationId)).toBe("waitlisted");
    expect(await fetchMembershipRemaining(membershipId)).toBe(remainingBefore);
  });
});

describe("SEC-115 ATT-SEC-F~H: 확정 이후 전환에서 차감 상태 보존", () => {
  it("ATT-SEC-F: confirmed → attended는 remaining_count를 추가로 바꾸지 않는다", async () => {
    const { reservationId, membershipId, remainingAfterBooking } = await makeConfirmedReservation();
    await asManagerA();
    const { error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: reservationId, p_status: "attended" });
    expect(error).toBeNull();
    expect(await fetchMembershipRemaining(membershipId)).toBe(remainingAfterBooking);
  });

  it("ATT-SEC-G: attended → confirmed(되돌리기)는 remaining_count를 추가로 바꾸지 않는다", async () => {
    const { reservationId, membershipId, remainingAfterBooking } = await makeConfirmedReservation();
    await asManagerA();
    await supabase.rpc("manager_set_attendance", { p_reservation_id: reservationId, p_status: "attended" });
    const { error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: reservationId, p_status: "confirmed" });
    expect(error).toBeNull();
    expect(await fetchMembershipRemaining(membershipId)).toBe(remainingAfterBooking);
  });

  it("ATT-SEC-H: no_show 처리 후에도 원래 차감 상태가 그대로 보존된다(복구되지 않음)", async () => {
    const { reservationId, membershipId, remainingAfterBooking } = await makeConfirmedReservation();
    await asManagerA();
    const { error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: reservationId, p_status: "no_show" });
    expect(error).toBeNull();
    expect(await fetchMembershipRemaining(membershipId)).toBe(remainingAfterBooking);
  });
});

describe("SEC-115 ATT-SEC-I~J: 권한 경계(매니저 소속 센터 확인)", () => {
  it("ATT-SEC-I: 다른 센터 매니저는 이 예약의 출결을 바꿀 수 없다", async () => {
    const { reservationId } = await makeConfirmedReservation();
    await asManagerB();
    const { error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: reservationId, p_status: "attended" });
    expect(error).not.toBeNull();
    expect(await fetchReservationStatus(reservationId)).toBe("confirmed");
  });

  it("ATT-SEC-J: 정상 소속 센터 매니저는 출결을 바꿀 수 있다", async () => {
    const { reservationId } = await makeConfirmedReservation();
    await asManagerA();
    const { error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: reservationId, p_status: "attended" });
    expect(error).toBeNull();
    expect(await fetchReservationStatus(reservationId)).toBe("attended");
  });
});

describe("SEC-115 ATT-SEC-K [2026-08-14 추가]: ADMIN_FREE 배치는 membership_id가 애초에 null이라 취소해도 영향 없다", () => {
  it("ATT-SEC-K: ADMIN_FREE로 배치된 confirmed 예약을 manager_set_attendance로 취소해도 어떤 membership도 변경되지 않는다", async () => {
    await asManagerA();
    const cls = await createFutureTestClass(centerAId, { title: "ATT-SEC-K ADMIN_FREE", capacity: 8, hoursFromNow: nextHoursFromNow(48) });
    cleanupClassIds.push(cls.id);
    const { data, error: assignErr } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id, p_profile_id: userB.profileId, p_assignment_type: "ADMIN_FREE",
      // "PROMO"는 admin_assign_reservation()이 실제로 허용하는 reason_code 목록에 없다
      // (add_admin_assignment.sql — MEMBER_REQUEST/MAKEUP_CLASS/TRIAL/EVENT/
      // SERVICE_COMPENSATION/CENTER_OPERATION/VIP_INVITATION/ERROR_CORRECTION/OTHER만
      // 허용). 이 테스트는 reason_code 자체를 검증하는 게 아니라 ADMIN_FREE 배치 이후의
      // membership 무영향을 확인하는 게 목적이라 유효한 코드로 바꾼다.
      p_membership_id: null, p_reason_code: "EVENT", p_reason_detail: null, p_force_capacity: false,
    });
    if (assignErr) throw new Error(`ADMIN_FREE 배치 실패: ${assignErr.message}`);
    const reservationId = (data as any).reservation_id;

    // membership_id가 null이므로 SEC-115 fix의 "status in (...) and membership_id is not null"
    // 조건에서 membership_id is not null이 애초에 거짓 — restore 블록 자체가 실행되지 않는다.
    const { error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: reservationId, p_status: "cancelled" });
    expect(error).toBeNull();
    const admin = getFixtureAdminClient();
    const { data: resRow } = await admin.from("reservations").select("membership_id").eq("id", reservationId).single();
    expect((resRow as any)?.membership_id).toBeNull();
  });
});
