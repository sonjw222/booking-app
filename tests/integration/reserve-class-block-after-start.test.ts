/*
  Track 2 회귀 테스트 — 수업 시작 후 reserve_class()가 서버에서 반드시 차단하는지 검증.

  ⚠️ 이 파일은 fix_reserve_class_block_after_start_draft_proposed.sql이 적용되기 전에는
  의도적으로 FAIL해야 한다(현재 reserve_class()에는 "이미 시작됨" 체크 자체가 없어, 운영
  설정에 따라 이미 시작한 수업도 예약이 통과될 수 있음). 적용 후 green이 되어야 정상이다.

  수업 시작 시각 자체는 흉내낼 수 없어(reservation-cancel-grace-period.test.ts와 동일한
  이유), 아주 가까운 미래(몇 초 뒤)에 수업을 만들고 실제로 그 시각이 지나가길 기다린다.
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

describe("Track 2: reserve_class()는 수업 시작 이후 예약을 서버에서 차단한다", () => {
  it("예약 마감이 수업 시작보다 훨씬 늦게 설정돼 있어도, 시작 시각이 지나면 예약이 거부된다", async () => {
    // 예약 마감을 아주 관대하게(당일 23:59) 설정 — "마감 체크"가 아니라 "시작 이후 차단"이
    // 별도로 동작하는지를 검증하려는 것이므로, 마감 자체는 걸리지 않게 한다.
    await saveSettings(centerAId, { ...defaultSettings, groupBookDaysBefore: 0, groupBookTime: "23:59" });

    const hoursFromNow = 8 / 3600; // 약 8초 뒤
    const cls = await createFutureTestClass(centerAId, { title: "RESERVE-차단 시작후예약", hoursFromNow });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    // 수업 시작이 확실히 지날 때까지 대기(여유 있게 12초)
    await new Promise((r) => setTimeout(r, 12000));

    const { error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("수업이 시작되었습니다");
  }, 20000);
});
