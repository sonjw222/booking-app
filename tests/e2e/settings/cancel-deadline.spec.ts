import { test, expect } from "@playwright/test";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createTestMembership,
  createFutureTestClass,
  cleanupTestClass,
  backdateReservationCreatedAt,
  kstTimeHHmm,
  type TestUser,
} from "../fixtures/testData";
import { fetchSettings, saveSettings, type CenterSettings } from "../../../lib/settings";
import { supabase } from "../../../lib/supabaseClient";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  예약 취소 기한(마감) 검증 — 처음에는 개별 수업 override(cancel_deadline_min)로 시도했으나,
  코드 추적 결과 이 컬럼은 사실상 죽어 있다: cancel_reservation()은 항상 운영설정
  calc_deadline('cancel')을 먼저 쓰고, 그게 null일 때만 이 컬럼을 보는데 center_settings가
  있는 한 calc_deadline은 절대 null이 아니다(fix_class_booking_deadline_override_draft_proposed.sql
  자체 주석에도 "cancel_deadline_min은 이번 범위에서 제외"라고 명시돼 있음). 게다가 이
  컬럼은 DB에서 NOT NULL DEFAULT 0이라 null을 넣으면 즉시 insert가 실패한다(첫 CI 실행에서
  실제로 발견됨). 그래서 이 스펙은 실제로 살아 있는 메커니즘인 운영설정
  (groupCancelDaysBefore=0 + groupCancelTime)으로 "지금부터 N분 뒤/전"이라는 절대 취소마감
  시각을 만들어 검증한다 — day 오프셋 0은 "그 수업이 속한 날의 그 시각"이므로, 오늘 안의
  수업이라면 어느 시각에 시작하든 이 절대 시각이 취소마감이 된다.

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
  await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
  const { data, error } = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: userA.profileId });
  if (error) throw new Error("사전 예약 실패: " + error.message);
  await backdateReservationCreatedAt((data as { reservation_id: string }).reservation_id, 11);
}

test.beforeAll(async () => {
  managerA = await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  originalSettings = await fetchSettings(centerAId);
  await saveSettings(centerAId, {
    ...originalSettings,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    allowSameDayBooking: true,
    dailyBookLimitEnabled: false,
    deductOnLateCancel: false, // 꺼져 있어야 마감 후 취소가 "차감 후 허용"이 아니라 진짜 차단됨
  });

  userA = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
  await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  await createTestMembership(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  for (const id of createdClassIds) await cleanupTestClass(id, []);
  await saveSettings(centerAId, originalSettings);
});

test("취소마감이 5분 뒤(아직 안 지남) — 취소 성공 (실브라우저)", async ({ page }) => {
  await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  await saveSettings(centerAId, {
    ...(await fetchSettings(centerAId)),
    groupCancelDaysBefore: 0,
    groupCancelTime: kstTimeHHmm(5), // 지금부터 5분 뒤 — 아직 마감 전
  });

  const cls = await createFutureTestClass(centerAId, { title: "E2E 취소기한-성공", hoursFromNow: 3 });
  createdClassIds.push(cls.id);
  await reserveAsUserAAndBackdate(cls.id);

  await page.goto("/reservation");
  page.once("dialog", (d) => d.accept());
  await page.locator(".class-row", { hasText: "E2E 취소기한-성공" }).getByRole("button", { name: "취소" }).click();
  await expect(page.locator(".toast")).toContainText("예약이 취소됐어요");
});

test("취소마감이 5분 전(이미 지남) — 취소 실패 (실브라우저)", async ({ page }) => {
  await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  await saveSettings(centerAId, {
    ...(await fetchSettings(centerAId)),
    groupCancelDaysBefore: 0,
    groupCancelTime: kstTimeHHmm(-5), // 지금부터 5분 전 — 이미 마감 지남
  });

  const cls = await createFutureTestClass(centerAId, { title: "E2E 취소기한-실패", hoursFromNow: 3 });
  createdClassIds.push(cls.id);
  await reserveAsUserAAndBackdate(cls.id);

  await page.goto("/reservation");
  page.once("dialog", (d) => d.accept());
  await page.locator(".class-row", { hasText: "E2E 취소기한-실패" }).getByRole("button", { name: "취소" }).click();
  await expect(page.locator(".toast")).toContainText("취소 마감시간이 지났어요");
});
