import { test, expect } from "@playwright/test";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createTestMembership,
  createFutureTestClassWithDeadlines,
  cleanupTestClass,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import { fetchSettings, saveSettings, type CenterSettings } from "../../../lib/settings";
import { supabase } from "../../../lib/supabaseClient";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  "수업 시작 후" 예약/취소 차단 — 마감 설정과 무관하게, 수업이 이미 시작됐으면 서버가
  무조건 막아야 한다(reserve_class()/cancel_reservation() 양쪽 다).
  수업 start_time을 과거로 "되돌릴" 방법이 없으므로(테스트 계정으로 실제 시간이 흐르길
  기다리는 것 외에는 조작 수단이 없음), 몇 초 뒤 시작하는 짧은 수업을 만들고 실제로 그
  시각이 지날 때까지 기다린 뒤 클릭한다(tests/integration/reserve-class-block-after-start.test.ts와
  동일하게 이미 검증된 방식).
*/

test.use({ storageState: MEMBER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];

test.beforeAll(async () => {
  managerA = await switchToTestUser(process.env.TEST_MANAGER_A_EMAIL!, process.env.TEST_MANAGER_A_PASSWORD!);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  originalSettings = await fetchSettings(centerAId);
  await saveSettings(centerAId, {
    ...originalSettings,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    groupCancelDaysBefore: 0,
    groupCancelTime: "23:59",
    allowSameDayBooking: true,
    dailyBookLimitEnabled: false,
  });

  userA = await switchToTestUser(process.env.TEST_USER_A_EMAIL!, process.env.TEST_USER_A_PASSWORD!);
  await switchToTestUser(process.env.TEST_MANAGER_A_EMAIL!, process.env.TEST_MANAGER_A_PASSWORD!);
  await createTestMembership(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  await switchToTestUser(process.env.TEST_MANAGER_A_EMAIL!, process.env.TEST_MANAGER_A_PASSWORD!);
  for (const id of createdClassIds) await cleanupTestClass(id, []);
  await saveSettings(centerAId, originalSettings);
});

test("수업 시작 후 예약 시도 → 실패 확인 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassWithDeadlines(centerAId, {
    title: "E2E 시작후예약차단", hoursFromNow: 8 / 3600, // 약 8초 뒤 시작
  });
  createdClassIds.push(cls.id);

  await page.waitForTimeout(12_000); // 수업 시작 시각을 확실히 지나도록 대기

  await page.goto(reservationDeepLink(cls.id, cls.startTime));
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".toast")).toContainText("수업이 시작되었습니다");
});

test("수업 시작 후 취소 시도 → 실패 확인 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassWithDeadlines(centerAId, {
    title: "E2E 시작후취소차단", hoursFromNow: 8 / 3600,
  });
  createdClassIds.push(cls.id);

  // 시작 전에 먼저 예약을 만들어둔다(취소 대상 확보) — 이 예약 자체는 검증 대상이 아니다.
  await switchToTestUser(process.env.TEST_USER_A_EMAIL!, process.env.TEST_USER_A_PASSWORD!);
  const { error: reserveErr } = await supabase.rpc("reserve_class", {
    p_class_id: cls.id, p_profile_id: userA.profileId,
  });
  if (reserveErr) throw new Error("사전 예약 실패: " + reserveErr.message);

  await page.waitForTimeout(12_000); // 수업 시작 시각을 확실히 지나도록 대기

  await page.goto("/reservation");
  page.once("dialog", (d) => d.accept());
  await page.locator(".class-row", { hasText: "E2E 시작후취소차단" }).getByRole("button", { name: "취소" }).click();
  await expect(page.locator(".toast")).toContainText("이미 시작되어 취소할 수 없어요");
});
