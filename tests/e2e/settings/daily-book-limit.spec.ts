import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createKstSameDayFutureClassAdmin,
  cleanupTestClassAdmin,
  cleanupTodaysReservationsForProfile,
  fetchSettingsAdmin,
  saveSettingsAdmin,
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
  // 이 센터를 공유하는 다른(과거) 테스트 실행이 남긴 leftover 확정 예약이 있으면 "오늘"
  // 카운트가 이미 오염된 채로 시작한다(실측 확인: 새 예약 0건인데도 첫 시도부터 한도
  // 초과) — 검증 전에 이 프로필의 오늘 예약을 전부 지워 항상 0에서 시작하게 한다.
  await cleanupTodaysReservationsForProfile(centerAId, userA.profileId);
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

  // ⚠ 같은 날짜의 여러 수업을 매번 새로 goto()/reservationDeepLink로 이동하면(이전 버전)
  // 전체 페이지를 6번 이상 새로 불러오게 되는데, 실제 CI에서 이 중 한 번이 "불러오는
  // 중..."에서 멈춘 채 끝내 완료되지 않는 경우가 실측 확인됐다. 같은 날짜 안에서는 한
  // 번만 이동한 뒤 각 수업 행을 직접 클릭하는 방식으로 바꿔 전체 페이지 새로고침 횟수를
  // 최소화한다(행 클릭 성공 후의 데이터 갱신은 load()의 클라이언트 쪽 재조회로 충분).
  await memberPage.goto("/reservation");
  await selectKstCalendarDay(memberPage, kstDateStr(offClasses[0].startTime));
  for (let i = 0; i < offClasses.length; i++) {
    await memberPage.locator(".class-row", { hasText: offTitles[i] }).getByRole("button", { name: "예약" }).click();
    await memberPage.getByRole("button", { name: "예약하기" }).click();
    await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
    await expect(
      memberPage.locator(".class-row", { hasText: offTitles[i] }).getByRole("button", { name: "취소" })
    ).toBeVisible();
  }

  // OFF 단계 예약은 ON 단계의 "2회 제한" 카운트에 섞이지 않도록 전부 취소해둔다.
  // 위와 같은 이유로 이미 로드된 페이지를 그대로 재사용한다(새로 goto하지 않음).
  for (let i = 0; i < offClasses.length; i++) {
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

  // 위 OFF 단계와 같은 이유로, 같은 날짜 안에서는 한 번만 이동한 뒤 행을 직접 클릭한다.
  await memberPage.goto("/reservation");
  await selectKstCalendarDay(memberPage, kstDateStr(limitClasses[0].startTime));

  await memberPage.locator(".class-row", { hasText: "E2E 일일한도 1" }).getByRole("button", { name: "예약" }).click();
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    memberPage.locator(".class-row", { hasText: "E2E 일일한도 1" }).getByRole("button", { name: "취소" })
  ).toBeVisible();

  await memberPage.locator(".class-row", { hasText: "E2E 일일한도 2" }).getByRole("button", { name: "예약" }).click();
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    memberPage.locator(".class-row", { hasText: "E2E 일일한도 2" }).getByRole("button", { name: "취소" })
  ).toBeVisible();

  await memberPage.locator(".class-row", { hasText: "E2E 일일한도 3" }).getByRole("button", { name: "예약" }).click();
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toBeVisible();
  const limitToastText = await waitForToastText(memberPage);
  expect(limitToastText).toContain("하루 예약 가능 횟수");

  await memberContext.close();
});
