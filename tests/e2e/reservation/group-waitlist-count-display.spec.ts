import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createKstSameDayFutureClassAdmin,
  insertConfirmedReservationAdmin,
  cleanupTestClassAdmin,
  cleanupTodaysReservationsForProfile,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  kstDateStr,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { selectKstCalendarDay } from "../fixtures/pageHelpers";

/*
  운영설정 "회원에게 대기 인원 표시"(show_group_waitlist_count) 회귀 테스트.

  배경(TODO.md P2-17, 2026-08-27 재확인): 이 문서는 "표시 대상 UI 자체가 없어 미구현"이라고
  적혀 있었지만, 실제 코드(app/reservation/page.tsx의 `.class-count` "대기 {N}",
  lib/reservations.ts의 showWaitlistCount/waitlisted 배선)를 확인한 결과 이미 완전히
  구현·연결돼 있었다(문서 갱신 누락, 언제 구현됐는지는 이 조사만으로 불명). 회귀를 막기 위한
  자동 검증이 그동안 하나도 없었으므로 이번에 추가한다.
*/

test.use({ storageState: MEMBER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let userB: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  userB = loadTestAccountMeta("user-b");
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  originalSettings = await fetchSettingsAdmin(centerAId);
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 20 });
  await cleanupTodaysReservationsForProfile(centerAId, userA.profileId);
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

test("대기 인원 표시 설정 ON/OFF에 따라 .class-count의 '대기 N'이 나타나고 사라진다 (실브라우저)", async ({ page }) => {
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    allowSameDayBooking: true,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    dailyBookLimitEnabled: false,
    waitlistWeeklyLimit: 999,
    showGroupWaitlistCount: true,
  });

  const title = `E2E 대기인원표시 ${Date.now()}`;
  const cls = await createKstSameDayFutureClassAdmin(centerAId, { title, preferredMinutesFromNow: 30, capacity: 1 });
  createdClassIds.push(cls.id);
  // 정원(1명)을 userB로 직접 채워, userA가 예약하면 곧바로 대기로 등록되게 한다.
  await insertConfirmedReservationAdmin(cls.id, userB.profileId);

  await page.goto("/reservation");
  await selectKstCalendarDay(page, kstDateStr(cls.startTime));

  const row = page.locator(".class-row", { hasText: title });
  await row.getByRole("button", { name: "대기" }).click();
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  await expect(row.getByText("대기중")).toBeVisible();

  // 설정 ON: 대기 인원(1명)이 표시돼야 한다
  await page.reload();
  await selectKstCalendarDay(page, kstDateStr(cls.startTime));
  await expect(page.locator(".class-row", { hasText: title }).locator(".class-count", { hasText: "대기" })).toHaveText("대기 1");

  // 설정 OFF: 인원수 표시가 사라져야 한다("대기중" 배지는 내 예약 상태 표시라 별개 — 계속 남아있어야 정상)
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    allowSameDayBooking: true,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    dailyBookLimitEnabled: false,
    waitlistWeeklyLimit: 999,
    showGroupWaitlistCount: false,
  });
  await page.reload();
  await selectKstCalendarDay(page, kstDateStr(cls.startTime));
  const rowAfter = page.locator(".class-row", { hasText: title });
  await expect(rowAfter.locator(".class-count", { hasText: "대기" })).toHaveCount(0);
  await expect(rowAfter.getByText("대기중")).toBeVisible();
});
