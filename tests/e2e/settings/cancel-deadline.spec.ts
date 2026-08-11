import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createKstSameDayFutureClassAdmin,
  cleanupTestClassAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  insertConfirmedReservationAdmin,
  ALWAYS_PAST_TODAY_TIME,
  ALWAYS_FUTURE_TODAY_TIME,
  kstDateStr,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { gotoManagerSettings, saveManagerSettings, selectKstCalendarDay, setDaysBeforeTime, waitForToastText } from "../fixtures/pageHelpers";

/*
  예약 취소 가능 기한 — 실제 관리자 화면에서 "그룹 수업 취소" 기한을 저장하고, 회원
  화면에서 그 효과를 검증한다(사용자가 요청한 정확한 숫자: 취소기한 2시간, 3시간
  전=취소 성공, 1시간 전=취소 실패).

  groupCancelDaysBefore=0 + groupCancelTime=(지금부터 2시간 뒤의 KST 시각)으로 저장하면
  "오늘 날짜의 그 시각까지만 취소 가능"이 된다. 수업 자체는 "지금부터 3시간 뒤"(취소
  기한 전) 또는 "지금부터 1시간 뒤"(취소 기한 지남)로 만든다.

  예약 자체는 Node 쪽에서 admin client로 직접 "확정 예약" 행을 만들고, created_at을
  처음부터 과거로 지정해 cancel_reservation()의 "예약 후 10분 그레이스" 예외를 애초에
  피한다 — 이 스펙의 검증 대상은 예약 생성이 아니라 취소 기한이므로.

  /reservation의 "오늘" 기본 선택은 브라우저 로컬(이 CI 러너는 UTC) 타임존을 쓰는데
  실제로는 KST 자정~오전 9시 사이에 실행되면 하루 어긋난다(실측 확인, 원인 A — 운영
  코드는 이번에 고치지 않음). 그래서 deepLink로 직접 그 수업을 열어 화면 기본 선택에
  기대지 않는다.
*/

test.use({ storageState: MANAGER_AUTH_FILE });

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

test("취소기한 2시간 — 3시간 뒤 수업은 1시간 전이라 취소 성공 (실브라우저 end-to-end)", async ({ page, browser }) => {
  // 관리자 화면에서 실제로 "그룹 수업 취소" = 0일 전, 지금부터 2시간 뒤 시각으로 저장
  await gotoManagerSettings(page);
  await setDaysBeforeTime(page, "그룹 수업 취소", 0, ALWAYS_FUTURE_TODAY_TIME);
  await saveManagerSettings(page);
  const saved = await fetchSettingsAdmin(centerAId);
  expect(saved.groupCancelDaysBefore).toBe(0);

  const cls = await createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 취소기한-성공", preferredMinutesFromNow: 180 });
  createdClassIds.push(cls.id);
  await insertConfirmedReservationAdmin(cls.id, userA.profileId, {
    membershipId,
    createdAtIso: new Date(Date.now() - 11 * 60_000).toISOString(), // 10분 그레이스를 피하도록 11분 전으로 생성
  });

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto("/reservation");
  await selectKstCalendarDay(memberPage, kstDateStr(cls.startTime));
  memberPage.once("dialog", (d) => d.accept());
  const cancelButton = memberPage.locator(".class-row", { hasText: "E2E 취소기한-성공" }).getByRole("button", { name: "취소" });
  await cancelButton.click();
  // toast 대신, 취소 성공 시 그 행의 "취소" 버튼이 사라지는(다시 예약 가능 상태로 바뀌는)
  // 실제 상태 변화로 확인한다.
  await expect(cancelButton).toHaveCount(0);
  await memberContext.close();
});

test("취소기한 2시간 — 1시간 뒤 수업은 이미 지나서 취소 실패 (실브라우저 end-to-end)", async ({ page, browser }) => {
  // ⚠ groupCancelDaysBefore=0일 때 마감은 "그 날짜 안에서 고정된 절대 시각"이지 각
  // 수업 시작시각 기준 상대값이 아니다(calc_deadline() — v_deadline_date = 수업의
  // KST 날짜 - days). 그래서 "이미 지남"을 표현하려면 지금보다 과거 시각을 써야 한다
  // (위 성공 테스트처럼 미래 시각을 쓰면 수업이 몇 시간 뒤든 항상 마감 전이라 성공한다 —
  // 실제로 이 버그로 테스트가 실패하는 게 CI에서 확인됨).
  await gotoManagerSettings(page);
  await setDaysBeforeTime(page, "그룹 수업 취소", 0, ALWAYS_PAST_TODAY_TIME);
  await saveManagerSettings(page);

  const cls = await createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 취소기한-실패", preferredMinutesFromNow: 60 });
  createdClassIds.push(cls.id);
  await insertConfirmedReservationAdmin(cls.id, userA.profileId, {
    membershipId,
    createdAtIso: new Date(Date.now() - 11 * 60_000).toISOString(),
  });

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto("/reservation");
  await selectKstCalendarDay(memberPage, kstDateStr(cls.startTime));
  memberPage.once("dialog", (d) => d.accept());
  const cancelButton = memberPage.locator(".class-row", { hasText: "E2E 취소기한-실패" }).getByRole("button", { name: "취소" });
  await cancelButton.click();
  // 실패 시 cancel_reservation()이 예외를 던져 상태가 바뀌지 않으므로 "취소" 버튼이
  // 그대로 남아있고, 정확한 사유는 waitForToastText(locator.waitFor 기반)로 확정한다.
  const toastText = await waitForToastText(memberPage);
  expect(toastText).toContain("취소 마감시간이 지났어요");
  await expect(cancelButton).toBeVisible();
  await memberContext.close();
});
