import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createFutureTestClassAdmin,
  createKstSameDayFutureClassAdmin,
  cleanupTestClassAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  reservationDeepLink,
  ALWAYS_PAST_TODAY_TIME,
  ALWAYS_FUTURE_TODAY_TIME,
  kstDateStr,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { gotoManagerSettings, saveManagerSettings, selectKstCalendarDay, setDaysBeforeTime, waitForToastText } from "../fixtures/pageHelpers";

/*
  예약 가능 기한(마감) 검증 — "N시간 전" 정밀도는 운영설정의 요일 단위(N일 전 HH:MM)로는
  표현할 수 없고, 수업별 개별 예약마감 override(booking_deadline_min, 분 단위, CLASS-001)로만
  표현 가능하다는 것을 코드로 확인했다(lib/classes.ts/reserve_class()). 이 override 값
  자체는 수업 등록 폼(관리자 화면)에 이미 있는 필드이지만, 이 스펙에서는 fixture 생성을
  Node 쪽에서 admin client로 직접 지정하고(같은 값을 관리자 화면에서 넣어도 결과는 동일 —
  DB 컬럼이 같다), "그 값대로 회원 화면에서 실제로 예약 가능/불가가 갈리는지"를 브라우저로
  검증하는 데 집중한다. Node 쪽이 managerA/userA로 다시 로그인하지 않는 이유는
  tests/e2e/fixtures/testData.ts 파일 상단 설명 참고(브라우저 세션 무효화 방지).

  시나리오: 예약마감 = 수업 시작 2시간 전(booking_deadline_min=120)
    - 수업이 3시간 뒤 시작 → 지금은 마감(1시간 뒤) 이전이므로 예약 성공
    - 수업이 1시간 뒤 시작 → 마감(이미 1시간 전에 지남) 이후이므로 예약 실패
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
  // 운영설정 자체는 넉넉하게 열어둬 개별 수업 override만 결과에 영향을 주게 한다.
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    allowSameDayBooking: true,
    dailyBookLimitEnabled: false,
  });
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

test("예약마감 2시간 전 — 3시간 뒤 수업은 예약 성공 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassAdmin(centerAId, {
    title: "E2E 예약가능기한-성공", hoursFromNow: 3, bookingDeadlineMin: 120,
  });
  createdClassIds.push(cls.id);

  await page.goto(reservationDeepLink(cls.id, cls.startTime));
  await page.getByRole("button", { name: "예약하기" }).click();
  // toast(2.5초 자동소멸)를 기다리는 대신, 실제 상태 변화로 성공을 확인한다: 예약이
  // 성공하면 모달이 닫히고(doReserve의 setConfirmClass(null)) 그 수업 행이 "취소"
  // 버튼으로 바뀐다(다시 데이터를 불러온 뒤 mine=true가 됨).
  await expect(page.locator(".sheet-overlay")).toHaveCount(0, { timeout: 30_000 });
  await expect(
    page.locator(".class-row", { hasText: "E2E 예약가능기한-성공" }).getByRole("button", { name: "취소" })
  ).toBeVisible();
});

test("예약마감 2시간 전 — 1시간 뒤 수업은 예약 실패 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassAdmin(centerAId, {
    title: "E2E 예약가능기한-실패", hoursFromNow: 1, bookingDeadlineMin: 120,
  });
  createdClassIds.push(cls.id);

  await page.goto(reservationDeepLink(cls.id, cls.startTime));
  await page.getByRole("button", { name: "예약하기" }).click();
  // 실패 시 doReserve()의 catch 경로는 모달을 닫지 않으므로("실패했으니 다시 시도할 수
  // 있게") 모달이 계속 떠 있는지로 먼저 확인하고, 정확히 "왜" 실패했는지는 toast 문구로
  // 확정한다 — 2.5초 자동소멸을 피하기 위해 waitForToastText(locator.waitFor 기반)로
  // "나타나는 순간" 텍스트를 읽는다(임의 sleep이나 뒤늦은 폴링 없음).
  await expect(page.locator(".sheet-overlay")).toBeVisible();
  const toastText = await waitForToastText(page);
  expect(toastText).toContain("예약 마감시간이 지났어요");
});

test("운영설정 예약마감 30분(관리자 화면 저장) — 40분 전 성공, 20분 전 실패 (실브라우저 end-to-end)", async ({ page, browser }) => {
  // 개별 수업 override(위 두 테스트)와 별개로, 운영설정 자체(그룹 수업 예약 - N일 전
  // HH:MM)를 실제 관리자 화면에서 저장했을 때도 동일하게 동작하는지 확인한다.
  //
  // ⚠ groupBookDaysBefore=0일 때 마감은 "그 날짜 안에서 고정된 절대 시각"이지 각 수업
  // 시작시각 기준 상대값이 아니다(calc_deadline()). 그래서 "성공"/"실패" 두 경우를
  // 하나의 마감 시각으로는 표현할 수 없고, 마감을 미래(아직 안 지남)로 저장해 성공
  // 케이스를 확인한 뒤, 과거(이미 지남)로 다시 저장해 실패 케이스를 확인해야 한다.
  const mgrContext = await browser.newContext({ storageState: MANAGER_AUTH_FILE });
  const mgrPage = await mgrContext.newPage();

  await gotoManagerSettings(mgrPage);
  await setDaysBeforeTime(mgrPage, "그룹 수업 예약", 0, ALWAYS_FUTURE_TODAY_TIME);
  await saveManagerSettings(mgrPage);
  const savedOpen = await fetchSettingsAdmin(centerAId);
  expect(savedOpen.groupBookDaysBefore).toBe(0);

  const okCls = await createKstSameDayFutureClassAdmin(centerAId, {
    title: "E2E 운영마감-40분전", preferredMinutesFromNow: 40,
  });
  createdClassIds.push(okCls.id);
  await page.goto(reservationDeepLink(okCls.id, okCls.startTime));
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0, { timeout: 30_000 });
  await expect(
    page.locator(".class-row", { hasText: "E2E 운영마감-40분전" }).getByRole("button", { name: "취소" })
  ).toBeVisible();

  // 이제 마감을 과거로 다시 저장 — 이 순간부터 이 센터의 모든 그룹 수업은 예약 마감이다.
  await setDaysBeforeTime(mgrPage, "그룹 수업 예약", 0, ALWAYS_PAST_TODAY_TIME);
  await saveManagerSettings(mgrPage);
  const savedClosed = await fetchSettingsAdmin(centerAId);
  expect(savedClosed.groupBookDaysBefore).toBe(0);
  await mgrContext.close();

  const failCls = await createKstSameDayFutureClassAdmin(centerAId, {
    title: "E2E 운영마감-20분전", preferredMinutesFromNow: 20,
  });
  createdClassIds.push(failCls.id);
  // ⚠ 같은 테스트 안에서 두 번째로 reservationDeepLink를 쓰면(위 okCls에 이어) openClassId
  // 자동오픈 useEffect가 방금 만든 수업을 못 찾아 모달이 안 열리는 현상이 실측 확인됐다
  // (원인 특정 전, booking-open-deadline.spec.ts와 동일한 일반 캘린더 탐색으로 우회 —
  // 이 방식은 같은 달에 클러터가 많아도 안정적으로 동작함이 이미 확인됨).
  await page.goto("/reservation");
  await selectKstCalendarDay(page, kstDateStr(failCls.startTime));
  await page.locator(".class-row", { hasText: "E2E 운영마감-20분전" }).getByRole("button", { name: "예약" }).click();
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toBeVisible();
  const toastText2 = await waitForToastText(page);
  expect(toastText2).toContain("예약 마감시간이 지났어요");
});
