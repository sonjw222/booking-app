import { test, expect, type Page } from "@playwright/test";
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
  운영설정 "당일 예약 허용"을 실제 관리자 화면에서 끄고/켜서, 실제 회원 화면에서 그 효과가
  나타나는지 끝까지 검증한다(코드 확인이 아니라 브라우저 클릭 기준 — 이 항목은 과거 "코드로는
  맞는데 실브라우저에서 안 된다"는 보고가 있었던 항목이라, 반드시 UI 토글 → 저장 → 회원
  예약 시도까지 전 과정을 브라우저로 확인한다).

  Node 쪽에서 미리 세팅해두는 것: 예약 마감(book deadline)만 넉넉하게 열어둬서, 이 테스트가
  검증하려는 "당일 예약 허용" 하나만 결과에 영향을 주게 한다 — "당일 예약 허용" 토글/저장
  자체는 반드시 브라우저로 수행한다.
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
    dailyBookLimitEnabled: false,
    allowSameDayBooking: true, // 시작 기준값 — 이 값을 브라우저에서 OFF로 바꾸는 것부터 테스트한다
  });
  await createTestMembership(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  for (const id of createdClassIds) {
    await cleanupTestClass(id, []);
  }
  await saveSettings(centerAId, originalSettings);
});

async function toggleSameDayBooking(page: Page, turnOn: boolean) {
  await page.goto("/manager/settings");
  const row = page.locator(".set-row", { hasText: "당일 예약 허용" });
  const toggle = row.locator("button.switch");
  const isOn = (await toggle.getAttribute("class"))?.includes(" on") ?? false;
  if (isOn !== turnOn) {
    await toggle.click();
    await page.locator("button.header-action").click();
    await expect(page.locator(".toast")).toHaveText("설정을 저장했어요");
  }
}

test("당일예약 OFF → 회원 예약 실패 → ON → 회원 예약 성공 (실브라우저 end-to-end)", async ({ page, browser }) => {
  // ① 관리자: 당일 예약 허용 OFF (실제 토글 클릭 + 저장 버튼 클릭)
  await toggleSameDayBooking(page, false);

  // ② DB 값 변경 확인
  const afterOff = await fetchSettings(centerAId);
  expect(afterOff.allowSameDayBooking).toBe(false);

  // ③④⑤ 회원 화면에서 오늘 수업을 예약 시도 → RPC가 거부 → 실패 토스트 확인
  const classOff = await createKstSameDayFutureClass(centerAId, { title: "E2E 당일예약OFF" });
  createdClassIds.push(classOff.id);

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(classOff.id, classOff.startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".toast")).toContainText("당일 예약은 허용되지 않아요");
  await memberContext.close();

  // ① 관리자: 당일 예약 허용 ON으로 되돌림
  await toggleSameDayBooking(page, true);
  const afterOn = await fetchSettings(centerAId);
  expect(afterOn.allowSameDayBooking).toBe(true);

  // ③④⑤ 같은 흐름으로, 이번엔 성공해야 한다
  const classOn = await createKstSameDayFutureClass(centerAId, { title: "E2E 당일예약ON" });
  createdClassIds.push(classOn.id);

  const memberContext2 = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage2 = await memberContext2.newPage();
  await memberPage2.goto(reservationDeepLink(classOn.id, classOn.startTime));
  await memberPage2.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage2.locator(".toast")).toContainText("예약이 완료됐어요");
  await memberContext2.close();
});
