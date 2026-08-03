import { test, expect, type Page } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createKstSameDayFutureClassAdmin,
  cleanupTestClassAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { waitForToastText } from "../fixtures/pageHelpers";

/*
  운영설정 "당일 예약 허용"을 실제 관리자 화면에서 끄고/켜서, 실제 회원 화면에서 그 효과가
  나타나는지 끝까지 검증한다(코드 확인이 아니라 브라우저 클릭 기준 — 이 항목은 과거 "코드로는
  맞는데 실브라우저에서 안 된다"는 보고가 있었던 항목이라, 반드시 UI 토글 → 저장 → 회원
  예약 시도까지 전 과정을 브라우저로 확인한다).

  Node 쪽 픽스처(수업 생성/설정 초기값 등)는 전부 admin(service-role) client로만 만든다 —
  managerA/userA로 Node에서 다시 로그인하면 브라우저가 이미 로그인해둔 그 계정의 세션이
  무효화된다는 것이 실제 CI에서 확인됐다(tests/e2e/fixtures/testData.ts 파일 상단 설명
  참고). "당일 예약 허용" 토글/저장 자체는 반드시 브라우저로 수행한다.

  toast(2.5초 자동소멸)를 기다리다 실패하던 문제(원인 C, 이전 리포트)는: 성공 케이스는
  실제 화면 상태(저장 버튼 텍스트, 모달 닫힘, 예약 행의 버튼)로 확인하고, 실패 케이스처럼
  "왜" 실패했는지 정확한 문구가 필요한 곳만 waitForToastText(locator.waitFor 기반)로
  안정적으로 읽는다.
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
    dailyBookLimitEnabled: false,
    allowSameDayBooking: true, // 시작 기준값 — 이 값을 브라우저에서 OFF로 바꾸는 것부터 테스트한다
  });
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

async function toggleSameDayBooking(page: Page, turnOn: boolean) {
  await page.goto("/manager/settings");
  const row = page.locator(".set-row", { hasText: "당일 예약 허용" });
  const toggle = row.locator("button.switch");
  const isOn = (await toggle.getAttribute("class"))?.includes(" on") ?? false;
  if (isOn !== turnOn) {
    await toggle.click();
    await page.locator("button.header-action").click();
    // 저장 성공은 버튼 자체의 상태 전이(저장 중 → 저장됨)로 확인한다 — toast의 2.5초
    // 자동소멸 창을 놓칠 위험이 없다(dirty가 false가 될 때까지 자동 재시도로 대기).
    await expect(page.locator("button.header-action")).toHaveText("저장됨");
  }
}

test("당일예약 OFF → 회원 예약 실패 → ON → 회원 예약 성공 (실브라우저 end-to-end)", async ({ page, browser }) => {
  // ① 관리자: 당일 예약 허용 OFF (실제 토글 클릭 + 저장 버튼 클릭)
  await toggleSameDayBooking(page, false);

  // ② DB 값 변경 확인
  const afterOff = await fetchSettingsAdmin(centerAId);
  expect(afterOff.allowSameDayBooking).toBe(false);

  // ③④⑤ 회원 화면에서 오늘 수업을 예약 시도 → RPC가 거부 → 실패 확인
  const classOff = await createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 당일예약OFF" });
  createdClassIds.push(classOff.id);

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(classOff.id, classOff.startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  // 실패 시 모달이 안 닫히는 것으로 먼저 확인하고, 정확한 사유는 toast로 확정한다.
  await expect(memberPage.locator(".sheet-overlay")).toBeVisible();
  const offToastText = await waitForToastText(memberPage);
  expect(offToastText).toContain("당일 예약은 허용되지 않아요");
  await memberContext.close();

  // ① 관리자: 당일 예약 허용 ON으로 되돌림
  await toggleSameDayBooking(page, true);
  const afterOn = await fetchSettingsAdmin(centerAId);
  expect(afterOn.allowSameDayBooking).toBe(true);

  // ③④⑤ 같은 흐름으로, 이번엔 성공해야 한다 — 모달이 닫히고 그 수업 행이 "취소" 버튼으로
  // 바뀌는 실제 상태 변화로 확인한다(toast 대신).
  const classOn = await createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 당일예약ON" });
  createdClassIds.push(classOn.id);

  const memberContext2 = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage2 = await memberContext2.newPage();
  await memberPage2.goto(reservationDeepLink(classOn.id, classOn.startTime));
  await memberPage2.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage2.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    memberPage2.locator(".class-row", { hasText: "E2E 당일예약ON" }).getByRole("button", { name: "취소" })
  ).toBeVisible();
  await memberContext2.close();
});
