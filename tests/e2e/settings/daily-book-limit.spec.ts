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
  kstDateStr,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { gotoManagerSettings, saveManagerSettings, selectKstCalendarDay, setSettingNumber, toggleSettingSwitch, waitForToastText } from "../fixtures/pageHelpers";

/*
  운영설정 "일일 예약 가능 횟수"를 실제 관리자 화면에서 켜고 끄면서 검증한다 — 사용자가
  요청한 정확한 흐름 그대로:
    OFF → 예약 여러 번 → 모두 성공 → ON(2회 제한) → 1회 성공 → 2회 성공 → 3회 실패 →
    "하루 최대 예약 횟수를 초과했어요" 확인

  같은 파일의 다른 describe에서 다른 확정 예약을 만들지 않으므로(=별도 diagnose 테스트
  에서 발견됐던 "이전 describe 잔여 예약이 이월되는" 문제 없음), OFF 단계에서 만든
  예약들이 ON 단계 카운트에 섞이지 않도록 OFF 단계 예약은 검증 직후 전부 취소한다.
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
    dailyBookLimitEnabled: false, // 시작값 OFF — 사용자가 요청한 순서(OFF부터) 그대로
  });
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

test("일일예약제한 OFF→모두성공, ON+2회제한→1·2회 성공 3회 실패 (실브라우저 end-to-end)", async ({ page, browser }) => {
  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();

  // ① OFF 상태 — 같은 날 여러 번 예약해도 전부 성공해야 한다.
  const offTitles = ["E2E 일일제한OFF 1", "E2E 일일제한OFF 2", "E2E 일일제한OFF 3"];
  const offClasses = await Promise.all([
    createKstSameDayFutureClassAdmin(centerAId, { title: offTitles[0], preferredMinutesFromNow: 30 }),
    createKstSameDayFutureClassAdmin(centerAId, { title: offTitles[1], preferredMinutesFromNow: 45 }),
    createKstSameDayFutureClassAdmin(centerAId, { title: offTitles[2], preferredMinutesFromNow: 60 }),
  ]);
  createdClassIds.push(...offClasses.map((c) => c.id));

  for (let i = 0; i < offClasses.length; i++) {
    const cls = offClasses[i];
    await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
    await memberPage.getByRole("button", { name: "예약하기" }).click();
    await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
    await expect(
      memberPage.locator(".class-row", { hasText: offTitles[i] }).getByRole("button", { name: "취소" })
    ).toBeVisible();
  }

  // OFF 단계 예약은 ON 단계의 "2회 제한" 카운트에 섞이지 않도록 전부 취소해둔다.
  // ⚠ deepLink(reservationDeepLink)로 다시 이동하면 handleReserve()가 기존 예약 여부를
  // 확인하지 않고 예약 확인 모달을 다시 자동으로 여는데, 그 모달의 sheet-overlay가
  // .class-row의 "취소" 버튼을 덮어버려 클릭이 막힌다 — 그래서 여기서는 deepLink 대신
  // 일반 캘린더 탐색으로 이동한다(cancel-deadline.spec.ts와 동일한 방식).
  for (let i = 0; i < offClasses.length; i++) {
    const cls = offClasses[i];
    await memberPage.goto("/reservation");
    await selectKstCalendarDay(memberPage, kstDateStr(cls.startTime));
    memberPage.once("dialog", (d) => d.accept());
    await memberPage.locator(".class-row", { hasText: offTitles[i] }).getByRole("button", { name: "취소" }).click();
    await expect(
      memberPage.locator(".class-row", { hasText: offTitles[i] }).getByRole("button", { name: "예약" })
    ).toBeVisible();
  }

  // ② 관리자 화면에서 실제로 ON + 하루 최대 2회로 저장
  await gotoManagerSettings(page);
  await toggleSettingSwitch(page, "일일 예약 횟수 제한", true);
  await setSettingNumber(page, "하루 최대", 2);
  await saveManagerSettings(page);
  const saved = await fetchSettingsAdmin(centerAId);
  expect(saved.dailyBookLimitEnabled).toBe(true);
  expect(saved.dailyBookLimit).toBe(2);

  // ③ 같은 날 서로 다른 시간의 수업 3개로 1·2회 성공, 3회 실패 확인
  const limitClasses = await Promise.all([
    createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 일일한도 1", preferredMinutesFromNow: 90 }),
    createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 일일한도 2", preferredMinutesFromNow: 105 }),
    createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 일일한도 3", preferredMinutesFromNow: 120 }),
  ]);
  createdClassIds.push(...limitClasses.map((c) => c.id));

  await memberPage.goto(reservationDeepLink(limitClasses[0].id, limitClasses[0].startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    memberPage.locator(".class-row", { hasText: "E2E 일일한도 1" }).getByRole("button", { name: "취소" })
  ).toBeVisible();

  await memberPage.goto(reservationDeepLink(limitClasses[1].id, limitClasses[1].startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    memberPage.locator(".class-row", { hasText: "E2E 일일한도 2" }).getByRole("button", { name: "취소" })
  ).toBeVisible();

  await memberPage.goto(reservationDeepLink(limitClasses[2].id, limitClasses[2].startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toBeVisible();
  const limitToastText = await waitForToastText(memberPage);
  expect(limitToastText).toContain("하루 예약 가능 횟수");

  await memberContext.close();
});
