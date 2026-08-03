import { test, expect } from "@playwright/test";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createTestMembership,
  createKstSameDayFutureClass,
  cleanupTestClass,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import { fetchSettings, saveSettings, type CenterSettings } from "../../../lib/settings";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  운영설정 "일일 예약 가능 횟수"를 관리자 화면에서 켜고 2회로 저장한 뒤, 회원이 같은 날
  3번째 수업을 예약하려 하면 실제로 막히는지(정확한 안내 문구까지) 브라우저로 검증한다.
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];

test.beforeAll(async () => {
  managerA = await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  userA = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");

  await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  originalSettings = await fetchSettings(centerAId);
  await saveSettings(centerAId, {
    ...originalSettings,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    allowSameDayBooking: true,
    dailyBookLimitEnabled: false, // 이 값을 브라우저에서 켜는 것부터 테스트한다
  });
  await createTestMembership(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  for (const id of createdClassIds) await cleanupTestClass(id, []);
  await saveSettings(centerAId, originalSettings);
});

test("일일 예약 2회 제한 저장 → 회원 1·2회 성공, 3회째 실패 메시지 확인 (실브라우저 end-to-end)", async ({ page, browser }) => {
  // ① 관리자: 일일 예약 횟수 제한 ON + 하루 최대 2회로 저장
  await page.goto("/manager/settings");
  const enableRow = page.locator(".set-row", { hasText: "일일 예약 횟수 제한" });
  await enableRow.locator("button.switch").click();
  const limitInput = page.locator(".set-row", { hasText: "하루 최대" }).locator("input.set-num");
  await limitInput.fill("2");
  await limitInput.blur();
  await page.locator("button.header-action").click();
  await expect(page.locator(".toast")).toHaveText("설정을 저장했어요");

  // ② DB 값 변경 확인
  const saved = await fetchSettings(centerAId);
  expect(saved.dailyBookLimitEnabled).toBe(true);
  expect(saved.dailyBookLimit).toBe(2);

  // 같은 날 서로 다른 시간의 수업 3개 준비
  const classes = await Promise.all([
    createKstSameDayFutureClass(centerAId, { title: "E2E 일일한도 1", preferredMinutesFromNow: 60 }),
    createKstSameDayFutureClass(centerAId, { title: "E2E 일일한도 2", preferredMinutesFromNow: 90 }),
    createKstSameDayFutureClass(centerAId, { title: "E2E 일일한도 3", preferredMinutesFromNow: 120 }),
  ]);
  createdClassIds.push(...classes.map((c) => c.id));

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();

  // ③④⑤ 1회째: 성공
  await memberPage.goto(reservationDeepLink(classes[0].id, classes[0].startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".toast")).toContainText("예약이 완료됐어요");

  // 2회째: 성공
  await memberPage.goto(reservationDeepLink(classes[1].id, classes[1].startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".toast")).toContainText("예약이 완료됐어요");

  // 3회째: 실패 + 정확한 안내 문구
  await memberPage.goto(reservationDeepLink(classes[2].id, classes[2].startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".toast")).toContainText("하루 예약 가능 횟수");

  await memberContext.close();
});
