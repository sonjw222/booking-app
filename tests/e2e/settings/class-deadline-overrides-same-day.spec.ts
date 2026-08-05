import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { waitForToastText } from "../fixtures/pageHelpers";

/*
  P0-2: 개별 수업의 예약마감(booking_deadline_min, CLASS-001 override)이 운영설정
  "당일예약 허용"보다 우선해야 한다 — 사용자가 재현한 그대로:
    운영설정 당일예약 허용 OFF, 수업 19:00, 그 수업에만 예약마감 15:00을 지정했다면
    당일 15:00까지는 예약 가능해야 한다.

  코드 감사 결과: reserve_class()/reserve_with_membership() 둘 다 "예약 마감시간 확인"
  블록은 booking_deadline_min을 이미 최우선으로 쓰지만, 바로 다음의 "당일 예약 허용 여부"
  블록은 이 override를 전혀 보지 않고 언제나 center_settings.allow_same_day_booking만
  확인했다 — 그래서 관리자가 그 수업에 명시적으로 예약마감을 지정해도 센터 전체의
  당일예약 토글이 꺼져 있으면 여전히 막혔다. booking_deadline_min이 있는 수업은 당일예약
  허용 검사를 건너뛰도록 수정(fix_class_deadline_overrides_same_day_toggle.sql).

  당일예약 허용 토글 자체가 실제 UI에서 정상 동작하는지는 same-day-booking.spec.ts가 이미
  검증하므로, 여기서는 admin client로 설정 기준선만 빠르게 맞추고 override 상호작용
  자체에 집중한다.
*/

test.use({ storageState: MEMBER_AUTH_FILE });

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
    allowSameDayBooking: false, // 사용자 재현 조건: 당일예약 허용 OFF
    dailyBookLimitEnabled: false,
  });
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

test("당일예약 허용 OFF여도, 수업에 명시된 예약마감 전이면 당일 예약이 가능하다 (실브라우저)", async ({ page }) => {
  // 수업 2시간 뒤 시작, 예약마감을 그보다 짧은 60분 전으로 지정 → 마감이 아직 안 지남(지금+60분).
  const cls = await createFutureTestClassAdmin(centerAId, {
    title: "E2E 마감우선-성공", hoursFromNow: 2, bookingDeadlineMin: 60,
  });
  createdClassIds.push(cls.id);

  await page.goto(reservationDeepLink(cls.id, cls.startTime));
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    page.locator(".class-row", { hasText: "E2E 마감우선-성공" }).getByRole("button", { name: "취소" })
  ).toBeVisible();
});

test("당일예약 허용 OFF에서, 수업에 명시된 예약마감이 지났으면 '마감' 사유로 차단된다(당일예약 사유 아님) (실브라우저)", async ({ page }) => {
  // 수업 20분 뒤 시작, 예약마감 60분 전 지정 → 마감이 이미 지남(지금-40분).
  const cls = await createFutureTestClassAdmin(centerAId, {
    title: "E2E 마감우선-실패", hoursFromNow: 20 / 60, bookingDeadlineMin: 60,
  });
  createdClassIds.push(cls.id);

  await page.goto(reservationDeepLink(cls.id, cls.startTime));
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toBeVisible();
  const toastText = await waitForToastText(page);
  // 당일예약 허용 토글 때문이 아니라 개별 수업 마감 때문에 막혔다는 것을 문구로 확정한다.
  expect(toastText).toContain("예약 마감시간이 지났어요");
  expect(toastText).not.toContain("당일 예약은 허용되지 않아요");
});
