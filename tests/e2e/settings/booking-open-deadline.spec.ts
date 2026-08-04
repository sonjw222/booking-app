import { test, expect } from "../fixtures/managerAuth";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  kstDateStr,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { gotoManagerSettings, saveManagerSettings, selectKstCalendarDay, setDaysBeforeTime, waitForToastText } from "../fixtures/pageHelpers";

/*
  운영설정 "예약 가능 기한 (오픈 시점)" — 실제 관리자 화면에서 그룹 수업 오픈 기한을
  저장하고, 회원 화면에서 그 효과를 검증한다.

  ⚠ 코드로 정확히 추적한 실제 동작(reservation_functions.sql calc_deadline() +
  reserve_class()의 open 체크)은 "N일 전부터 예약이 열린다"이다 — 즉 오픈 기한을
  넘지 않은(더 먼 미래의) 수업은 아직 열리지 않아 예약이 "불가"이고, 오픈 기한 이내로
  들어온(더 가까운) 수업이라야 예약이 "가능"하다. 그래서 openDaysBefore=7일 때:
    - 8일 뒤 수업 → 아직 오픈 전 → 예약 불가
    - 6일 뒤 수업 → 오픈 기한 안쪽 → 예약 가능
  (사용자가 준 예시의 성공/실패와 반대 순서인데, 코드를 직접 확인한 결과이므로 추측이
  아니라 실측대로 검증한다 — 최종 보고에서 이 부분을 별도로 확인 요청한다.)
*/

test.use({ storageState: MEMBER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];

test.beforeAll(async ({ managerPage }) => {
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
  });
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });

  // 관리자 화면에서 실제로 "예약 가능 기한(오픈 시점) - 그룹 수업" = 7일 전 00:00으로 저장
  // (managerPage는 워커 스코프 fixture — 이 워커 전체에서 단 하나뿐인 관리자 context를 재사용)
  await gotoManagerSettings(managerPage);
  await setDaysBeforeTime(managerPage, "그룹 수업", 7, "00:00");
  await saveManagerSettings(managerPage);

  const saved = await fetchSettingsAdmin(centerAId);
  expect(saved.groupOpenDaysBefore).toBe(7);
  expect(saved.groupOpenTime).toBe("00:00");
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

test("예약 오픈 7일 전 — 8일 뒤 수업은 아직 오픈 전(예약 불가) (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassAdmin(centerAId, { title: "E2E 예약오픈-불가", hoursFromNow: 8 * 24 });
  createdClassIds.push(cls.id);

  await page.goto("/reservation");
  await selectKstCalendarDay(page, kstDateStr(cls.startTime));
  // 목록의 버튼 텍스트는 "예약"(모달을 여는 버튼)이고, 모달 안의 실제 제출 버튼만
  // "예약하기"다(app/reservation/page.tsx) — 두 단계로 클릭한다.
  await page.locator(".class-row", { hasText: "E2E 예약오픈-불가" }).getByRole("button", { name: "예약" }).click();
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toBeVisible();
  const toastText = await waitForToastText(page);
  expect(toastText).toContain("아직 예약이 열리지 않았어요");
});

test("예약 오픈 7일 전 — 6일 뒤 수업은 오픈 기한 안쪽(예약 가능) (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassAdmin(centerAId, { title: "E2E 예약오픈-가능", hoursFromNow: 6 * 24 });
  createdClassIds.push(cls.id);

  await page.goto("/reservation");
  await selectKstCalendarDay(page, kstDateStr(cls.startTime));
  await page.locator(".class-row", { hasText: "E2E 예약오픈-가능" }).getByRole("button", { name: "예약" }).click();
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    page.locator(".class-row", { hasText: "E2E 예약오픈-가능" }).getByRole("button", { name: "취소" })
  ).toBeVisible();
});
