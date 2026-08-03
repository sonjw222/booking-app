import { test, expect } from "@playwright/test";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createTestMembership,
  createFutureTestClassWithDeadlines,
  cleanupTestClass,
  backdateReservationCreatedAt,
  type TestUser,
} from "../fixtures/testData";
import { fetchSettings, saveSettings, type CenterSettings } from "../../../lib/settings";
import { supabase } from "../../../lib/supabaseClient";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  예약 취소 기한(마감) 검증 — 개별 수업 override(cancel_deadline_min, CLASS-001)로 "수업 시작
  2시간 전"을 표현하고, 실제로 그 전/후에 취소 시도가 갈리는지 브라우저로 검증한다.

  예약 자체는(취소 대상을 만들기 위한 선행 조건일 뿐 이 테스트의 검증 대상이 아니므로) Node
  쪽에서 RPC로 직접 만들고, cancel_reservation()의 "예약 후 10분 그레이스" 예외에 걸리지
  않도록 created_at을 충분히 과거로 되돌린다(tests/integration/reservation-cancel-grace-period.test.ts와
  동일하게 검증된 기법). "취소" 버튼 클릭과 그 결과 확인만 브라우저로 수행한다.
*/

test.use({ storageState: MEMBER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];

async function reserveAsUserAAndBackdate(classId: string): Promise<void> {
  await switchToTestUser(process.env.TEST_USER_A_EMAIL!, process.env.TEST_USER_A_PASSWORD!);
  const { data, error } = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: userA.profileId });
  if (error) throw new Error("사전 예약 실패: " + error.message);
  await backdateReservationCreatedAt((data as { reservation_id: string }).reservation_id, 11);
}

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
    deductOnLateCancel: false, // 꺼져 있어야 마감 후 취소가 "차감 후 허용"이 아니라 진짜 차단됨
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

test("취소마감 2시간 전 — 3시간 뒤 수업은 취소 성공 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassWithDeadlines(centerAId, {
    title: "E2E 취소기한-성공", hoursFromNow: 3, cancelDeadlineMin: 120,
  });
  createdClassIds.push(cls.id);
  await reserveAsUserAAndBackdate(cls.id);

  await page.goto("/reservation");
  page.once("dialog", (d) => d.accept());
  await page.locator(".class-row", { hasText: "E2E 취소기한-성공" }).getByRole("button", { name: "취소" }).click();
  await expect(page.locator(".toast")).toContainText("예약이 취소됐어요");
});

test("취소마감 2시간 전 — 1시간 뒤 수업은 취소 실패 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassWithDeadlines(centerAId, {
    title: "E2E 취소기한-실패", hoursFromNow: 1, cancelDeadlineMin: 120,
  });
  createdClassIds.push(cls.id);
  await reserveAsUserAAndBackdate(cls.id);

  await page.goto("/reservation");
  page.once("dialog", (d) => d.accept());
  await page.locator(".class-row", { hasText: "E2E 취소기한-실패" }).getByRole("button", { name: "취소" }).click();
  await expect(page.locator(".toast")).toContainText("취소 마감시간이 지났어요");
});
