/*
  실브라우저 QA에서 "당일 예약 OFF가 여전히 작동하지 않는다"는 보고를 받고 재검증하는 통합
  테스트다. 이전 배치에서는 SQL 코드를 눈으로 읽고 "reserve_class()에 배선돼 있다"로 결론
  냈을 뿐, 실제로 lib/settings.ts의 saveSettings()(관리자 설정 화면이 호출하는 것과 동일한
  경로)로 저장한 값이 reserve_class()에서 정말로 읽히는지를 자동 테스트로 검증한 적이
  없었다 — 이 파일이 그 공백을 메운다.

  raw SQL로 center_settings를 직접 UPDATE하지 않고, 반드시 fetchSettings/saveSettings(관리자
  설정 화면이 실제로 쓰는 함수)만 사용한다 — "테스트가 DB 값을 직접 넣어 UI 저장 버그를
  놓친 것"이 되지 않도록 하기 위함이다.
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  createTestMembership,
  cleanupTestClass,
  type TestUser,
} from "./setup";
import { fetchSettings, saveSettings, type CenterSettings } from "../../lib/settings";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };

let managerA: TestUser;
let centerAId: string;
let defaultSettings: CenterSettings;
const createdClassIds: string[] = [];

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

describe("운영설정 재검증: 관리자 설정 화면과 동일한 저장 경로(saveSettings)로 당일 예약 허용을 껐을 때", () => {
  it("당일 수업 예약이 실제로 차단된다", async () => {
    // 예약 마감(booking) 자체가 먼저 걸리지 않도록 그룹 예약 오픈/마감을 넉넉히 열어둔다 —
    // 이 테스트가 검증하려는 건 "당일 예약 허용" 플래그 하나뿐이다.
    await saveSettings(centerAId, {
      ...defaultSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59",
      allowSameDayBooking: false,
    });
    const cls = await createFutureTestClass(centerAId, { title: "SETTINGS-REAUDIT 당일예약OFF", hoursFromNow: 3 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("당일 예약은 허용되지 않아요");
  });

  it("(대조군) 당일 예약 허용을 켜두면 같은 조건에서 정상 예약된다", async () => {
    await saveSettings(centerAId, {
      ...defaultSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59",
      allowSameDayBooking: true,
    });
    const cls = await createFutureTestClass(centerAId, { title: "SETTINGS-REAUDIT 당일예약ON", hoursFromNow: 3 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).toBeNull();
    expect((data as any).status).toBe("confirmed");
  });
});

describe("운영설정 재검증: 예약 오픈 시점(그룹)이 취소 마감 설정이 아니라 진짜 오픈 설정을 쓴다", () => {
  it("오픈 기한을 60일 전으로 저장하면, 5일 뒤 수업은 아직 예약이 열리지 않았다고 차단된다", async () => {
    // ⚠️ calc_deadline()이 'open' kind를 처리하지 못하던 버그(fix_calc_deadline_open_kind_draft_proposed.sql
    // 적용 전)에서는 'open' 호출이 조용히 group_cancel_days_before(기본 1일 전)로 대체돼,
    // 5일 뒤 수업이 "이미 열림"으로 잘못 판정되어 이 테스트가 의도적으로 FAIL한다.
    await saveSettings(centerAId, {
      ...defaultSettings,
      groupBookDaysBefore: 90, groupBookTime: "00:00", // 예약 마감에 안 걸리도록 넉넉히
      groupOpenDaysBefore: 60, groupOpenTime: "15:00",
      groupCancelDaysBefore: 1, groupCancelTime: "22:00", // 오픈 설정과 값이 겹치지 않도록 확실히 다르게
    });
    const cls = await createFutureTestClass(centerAId, { title: "SETTINGS-REAUDIT 오픈시점", hoursFromNow: 5 * 24 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("아직 예약이 열리지 않았어요");
  });

  it("(대조군) 오픈 기한을 10일 전으로 저장하면, 5일 뒤 수업은 정상 예약된다", async () => {
    await saveSettings(centerAId, {
      ...defaultSettings,
      groupBookDaysBefore: 90, groupBookTime: "00:00",
      groupOpenDaysBefore: 10, groupOpenTime: "00:00",
      groupCancelDaysBefore: 1, groupCancelTime: "22:00",
    });
    const cls = await createFutureTestClass(centerAId, { title: "SETTINGS-REAUDIT 오픈시점정상", hoursFromNow: 5 * 24 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).toBeNull();
    expect((data as any).status).toBe("confirmed");
  });
});
