import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createKstSameDayFutureClassAdmin,
  cleanupTestClassAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { waitForToastText } from "../fixtures/pageHelpers";

/*
  운영설정 "일일 예약 가능 횟수"를 관리자 화면에서 켜고 2회로 저장한 뒤, 회원이 같은 날
  3번째 수업을 예약하려 하면 실제로 막히는지(정확한 안내 문구까지) 브라우저로 검증한다.
  Node 쪽 픽스처는 전부 admin client로만 만든다(이유: tests/e2e/fixtures/testData.ts
  파일 상단 설명 — managerA/userA로 Node에서 재로그인하면 브라우저 세션이 무효화됨).
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  originalSettings = await fetchSettingsAdmin(centerAId);
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    allowSameDayBooking: true,
    dailyBookLimitEnabled: false, // 이 값을 브라우저에서 켜는 것부터 테스트한다
  });
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
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
  // toast(2.5초 자동소멸) 대신 저장 버튼 자체의 상태 전이로 저장 성공을 확인한다.
  await expect(page.locator("button.header-action")).toHaveText("저장됨");

  // ② DB 값 변경 확인
  const saved = await fetchSettingsAdmin(centerAId);
  expect(saved.dailyBookLimitEnabled).toBe(true);
  expect(saved.dailyBookLimit).toBe(2);

  // 같은 날 서로 다른 시간의 수업 3개 준비
  const classes = await Promise.all([
    createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 일일한도 1", preferredMinutesFromNow: 60 }),
    createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 일일한도 2", preferredMinutesFromNow: 90 }),
    createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 일일한도 3", preferredMinutesFromNow: 120 }),
  ]);
  createdClassIds.push(...classes.map((c) => c.id));

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();

  // ③④⑤ 1회째: 성공 — 모달이 닫히고 그 수업 행이 "취소" 버튼으로 바뀌는 실제 상태 변화로 확인
  await memberPage.goto(reservationDeepLink(classes[0].id, classes[0].startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    memberPage.locator(".class-row", { hasText: "E2E 일일한도 1" }).getByRole("button", { name: "취소" })
  ).toBeVisible();

  // 2회째: 성공
  await memberPage.goto(reservationDeepLink(classes[1].id, classes[1].startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    memberPage.locator(".class-row", { hasText: "E2E 일일한도 2" }).getByRole("button", { name: "취소" })
  ).toBeVisible();

  // 3회째: 실패 + 정확한 안내 문구 — 모달이 안 닫히는 것으로 먼저 확인하고, 정확한 사유는
  // waitForToastText(locator.waitFor 기반, 2.5초 자동소멸을 피함)로 확정한다.
  await memberPage.goto(reservationDeepLink(classes[2].id, classes[2].startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toBeVisible();
  const limitToastText = await waitForToastText(memberPage);
  expect(limitToastText).toContain("하루 예약 가능 횟수");

  await memberContext.close();
});
