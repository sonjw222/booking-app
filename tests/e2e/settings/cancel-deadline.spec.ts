import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  insertConfirmedReservationAdmin,
  kstTimeHHmm,
  kstDateStr,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { selectKstCalendarDay, waitForToastText } from "../fixtures/pageHelpers";

/*
  예약 취소 기한(마감) 검증 — 처음에는 개별 수업 override(cancel_deadline_min)로 시도했으나,
  코드 추적 결과 이 컬럼은 사실상 죽어 있다: cancel_reservation()은 항상 운영설정
  calc_deadline('cancel')을 먼저 쓰고, 그게 null일 때만 이 컬럼을 보는데 center_settings가
  있는 한 calc_deadline은 절대 null이 아니다(fix_class_booking_deadline_override_draft_proposed.sql
  자체 주석에도 "cancel_deadline_min은 이번 범위에서 제외"라고 명시돼 있음). 게다가 이
  컬럼은 DB에서 NOT NULL DEFAULT 0이라 null을 넣으면 즉시 insert가 실패한다(첫 CI 실행에서
  실제로 발견됨). 그래서 이 스펙은 실제로 살아 있는 메커니즘인 운영설정
  (groupCancelDaysBefore=0 + groupCancelTime)으로 "지금부터 N분 뒤/전"이라는 절대 취소마감
  시각을 만들어 검증한다.

  예약 자체는 Node 쪽에서 admin client로 직접 "확정 예약" 행을 만들고, created_at을
  처음부터 과거로 지정해 cancel_reservation()의 "예약 후 10분 그레이스" 예외를 애초에
  피한다.

  /reservation의 "오늘" 기본 선택은 브라우저 로컬(이 CI 러너는 UTC) 타임존을 쓰는데
  실제로는 KST 자정~오전 9시 사이에 실행되면 하루 어긋난다(실측 확인, 원인 A — 운영
  코드는 이번에 고치지 않음). 그래서 페이지 기본 선택에 기대지 않고, 캘린더를 실제
  사용자처럼 클릭해 수업의 KST 날짜로 명시적으로 이동한다.
*/

test.use({ storageState: MEMBER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let membershipId: string;
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
    dailyBookLimitEnabled: false,
    deductOnLateCancel: false, // 꺼져 있어야 마감 후 취소가 "차감 후 허용"이 아니라 진짜 차단됨
  });
  const membership = await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
  membershipId = membership.id;
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

test("취소마감이 5분 뒤(아직 안 지남) — 취소 성공 (실브라우저)", async ({ page }) => {
  await saveSettingsAdmin(centerAId, {
    ...(await fetchSettingsAdmin(centerAId)),
    groupCancelDaysBefore: 0,
    groupCancelTime: kstTimeHHmm(5), // 지금부터 5분 뒤 — 아직 마감 전
  });

  const cls = await createFutureTestClassAdmin(centerAId, { title: "E2E 취소기한-성공", hoursFromNow: 3 });
  createdClassIds.push(cls.id);
  await insertConfirmedReservationAdmin(cls.id, userA.profileId, {
    membershipId,
    createdAtIso: new Date(Date.now() - 11 * 60_000).toISOString(), // 10분 그레이스를 피하도록 11분 전으로 생성
  });

  await page.goto("/reservation");
  await selectKstCalendarDay(page, kstDateStr(cls.startTime));
  page.once("dialog", (d) => d.accept());
  const cancelButton = page.locator(".class-row", { hasText: "E2E 취소기한-성공" }).getByRole("button", { name: "취소" });
  await cancelButton.click();
  // toast 대신, 취소 성공 시 그 행의 "취소" 버튼이 사라지는(다시 예약 가능 상태로 바뀌는)
  // 실제 상태 변화로 확인한다.
  await expect(cancelButton).toHaveCount(0);
});

test("취소마감이 5분 전(이미 지남) — 취소 실패 (실브라우저)", async ({ page }) => {
  await saveSettingsAdmin(centerAId, {
    ...(await fetchSettingsAdmin(centerAId)),
    groupCancelDaysBefore: 0,
    groupCancelTime: kstTimeHHmm(-5), // 지금부터 5분 전 — 이미 마감 지남
  });

  const cls = await createFutureTestClassAdmin(centerAId, { title: "E2E 취소기한-실패", hoursFromNow: 3 });
  createdClassIds.push(cls.id);
  await insertConfirmedReservationAdmin(cls.id, userA.profileId, {
    membershipId,
    createdAtIso: new Date(Date.now() - 11 * 60_000).toISOString(),
  });

  await page.goto("/reservation");
  await selectKstCalendarDay(page, kstDateStr(cls.startTime));
  page.once("dialog", (d) => d.accept());
  const cancelButton = page.locator(".class-row", { hasText: "E2E 취소기한-실패" }).getByRole("button", { name: "취소" });
  await cancelButton.click();
  // 실패 시 cancel_reservation()이 예외를 던져 상태가 바뀌지 않으므로 "취소" 버튼이
  // 그대로 남아있고, 정확한 사유는 waitForToastText(locator.waitFor 기반)로 확정한다.
  const toastText = await waitForToastText(page);
  expect(toastText).toContain("취소 마감시간이 지났어요");
  await expect(cancelButton).toBeVisible();
});
