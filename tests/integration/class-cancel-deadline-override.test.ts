/*
  classes.cancel_deadline_min 개별 수업 취소마감 재지정 우선순위 회귀 테스트.

  ⚠️ 이 파일은 fix_class_cancel_deadline_override.sql이 적용되기 전에는 의도적으로
  FAIL해야 합니다 — 적용 전 cancel_reservation()은 개별 수업 지정값을 완전히 무시하고
  운영설정(calc_deadline)만 쓴다. 적용 후 green이 되어야 정상입니다.

  배경: booking_deadline_min과 같은 계열의 버그 — cancel_reservation()이 calc_deadline()을
  먼저 호출하는데, center_settings 행이 있으면(사실상 항상) 무조건 그 값을 쓰고
  classes.cancel_deadline_min은 그 행 자체가 없는 예외 상황에서만 폴백으로 쓰였다.
  매니저가 "예약취소 가능 시간"을 개별 수업에 저장해도 실제로는 전혀 반영되지 않았다.

  아래 두 테스트는 서로 반대 방향으로 우선순위를 검증한다:
    1) 운영설정은 관대한데 개별 지정이 더 엄격(이미 지남) → 지정값이 이겨서 차단돼야 함
    2) 운영설정은 이미 지났는데 개별 지정은 아직 여유 있음 → 지정값이 이겨서 허용돼야 함
  cancel_deadline_min은 classes 테이블에 직접 쓰기 RLS가 없어(create_class_safe 등 RPC
  전용) admin(service_role) client로 설정한다 — 실제 매니저 UI도 결국 이 컬럼에 값을 쓰는
  경로이므로 검증 목적상 동등하다.
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  createKstSameDayFutureClass,
  createTestMembership,
  fetchMembershipRemaining,
  cleanupTestClass,
  getFixtureAdminClient,
  type TestUser,
} from "./setup";
import { fetchSettings, saveSettings, type CenterSettings } from "../../lib/settings";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const ALWAYS_PAST_CANCEL_TIME = "00:01"; // reservation-cancel-grace-period.test.ts와 동일한 트릭

let managerA: TestUser;
let centerAId: string;
let defaultSettings: CenterSettings;
const createdClassIds: string[] = [];

async function setClassCancelDeadlineMin(classId: string, minutes: number | null): Promise<void> {
  const admin = getFixtureAdminClient();
  const { error } = await admin.from("classes").update({ cancel_deadline_min: minutes }).eq("id", classId);
  if (error) throw new Error(`cancel_deadline_min 설정 실패: ${error.message}`);
}

async function reserveAndGetId(classId: string): Promise<string> {
  const { data, error } = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: managerA.profileId });
  if (error) throw new Error(`예약 실패: ${error.message}`);
  return (data as any).reservation_id;
}

// RES-001(예약 후 10분 이내 무료 취소 예외)이 이 테스트의 관심사(마감 우선순위)를 가려버리는
// 것을 막기 위해, 두 테스트 모두 예약 시각을 10분보다 더 과거로 백데이트해 그 유예를 벗어난다
// (reservation-cancel-grace-period.test.ts와 동일한 방법).
async function backdateCreatedAt(reservationId: string, minutesAgo: number) {
  const ts = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  const { error } = await supabase.from("reservations").update({ created_at: ts }).eq("id", reservationId);
  if (error) throw new Error(`created_at 백데이트 실패: ${error.message}`);
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  defaultSettings = await fetchSettings(centerAId);
}, 30000);

afterEach(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  await saveSettings(centerAId, defaultSettings);
});

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];
  for (const classId of createdClassIds) {
    try { await cleanupTestClass(classId, []); } catch (e: any) { errors.push(e.message); }
  }
  try { await saveSettings(centerAId, defaultSettings); } catch (e: any) { errors.push(e.message); }
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 30000);

describe("개별 수업 취소마감(cancel_deadline_min)이 운영설정보다 우선한다", () => {
  it("운영설정은 관대해도 개별 지정이 이미 지났으면 취소가 차단된다", async () => {
    // 운영설정: 사실상 항상 취소 가능(마감을 아주 멀게)
    await saveSettings(centerAId, { ...defaultSettings, groupCancelDaysBefore: 0, groupCancelTime: "23:59", deductOnLateCancel: false });

    const cls = await createFutureTestClass(centerAId, { title: "CANCEL-OVERRIDE 지정이더엄격", hoursFromNow: 240 });
    createdClassIds.push(cls.id);
    // 시작 240시간(=10일) 전인데 취소마감을 "20일 전까지만"으로 지정 — 이미 지난 상태를 만든다.
    await setClassCancelDeadlineMin(cls.id, 20 * 24 * 60);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const resId = await reserveAndGetId(cls.id);
    await backdateCreatedAt(resId, 15);
    const { error } = await supabase.rpc("cancel_reservation", { p_reservation_id: resId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("취소 마감시간이 지났어요");
  });

  it("운영설정은 이미 지났어도 개별 지정이 아직 여유 있으면 취소가 허용된다", async () => {
    // 운영설정: 당일 취소마감이 이미 지난 것으로(기존 파일과 동일한 트릭)
    await saveSettings(centerAId, {
      ...defaultSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59",
      groupCancelDaysBefore: 0, groupCancelTime: ALWAYS_PAST_CANCEL_TIME,
      deductOnLateCancel: false,
    });
    const cls = await createKstSameDayFutureClass(centerAId, { title: "CANCEL-OVERRIDE 지정이더관대", preferredMinutesFromNow: 120 });
    createdClassIds.push(cls.id);
    // 개별 지정: 수업 시작 1분 전까지 취소 가능 — "지금"은 아직 훨씬 이전이라 여유 있음.
    await setClassCancelDeadlineMin(cls.id, 1);
    const mem = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const resId = await reserveAndGetId(cls.id);
    await backdateCreatedAt(resId, 15);
    const { data, error } = await supabase.rpc("cancel_reservation", { p_reservation_id: resId });
    expect(error).toBeNull();
    expect((data as any)?.cancelled).toBe(true);
    expect(await fetchMembershipRemaining(mem.id)).toBe(3);
  });
});
