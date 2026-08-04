import { test, expect } from "../fixtures/managerAuth";
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
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { gotoManagerSettings, saveManagerSettings, toggleSettingSwitch, waitForToastText } from "../fixtures/pageHelpers";

/*
  운영설정 "당일 예약 허용"을 실제 관리자 화면에서 켜고/끄면서 실제 회원 화면에서 그
  효과가 나타나는지 끝까지 검증한다 — 사용자가 요청한 정확한 흐름 그대로:
    ON → 당일 수업 생성 → 회원 예약 → 예약 성공 → 예약 취소 → OFF 저장 → 새로고침 →
    다시 예약 → 예약 실패

  중요: reserve_class() RPC를 직접 호출하는 테스트만으로는 이 기능이 정상이라고 결론
  내릴 수 없다는 것이 실제로 확인됐다 — 실제 회원 화면(app/reservation/page.tsx
  doReserve())은 회원이 사용 가능한 수강권을 하나라도 가지고 있으면(이 스펙처럼
  createTestMembershipAdmin으로 항상 만들어두는 경우 포함) reserve_class()가 아니라
  reserve_with_membership()을 호출한다. 그래서 이 스펙은 실제 브라우저에서 "예약하기"
  버튼을 눌러야만 실제 사용자가 겪는 경로를 검증한 것이 된다
  (fix_reserve_with_membership_operational_settings.sql 참고).

  Node 쪽 픽스처(수업 생성/수강권 지급 등)는 admin(service-role) client로만 만든다 —
  managerA/userA로 Node에서 다시 로그인하면 브라우저가 이미 로그인해둔 그 계정의 세션이
  무효화된다는 것이 실제 CI에서 확인됐다(tests/e2e/fixtures/testData.ts 파일 상단 설명
  참고). "당일 예약 허용" 토글/저장 자체는 반드시 브라우저로 수행한다.
*/

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
    allowSameDayBooking: true, // 시작값 ON — 사용자가 요청한 순서(ON부터) 그대로
  });
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

test("당일예약 ON→예약성공→취소→OFF저장→새로고침→다시예약→예약실패 (실브라우저 end-to-end)", async ({ managerPage: page, browser }) => {
  // ① ON 상태에서 당일 수업 생성
  const cls = await createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 당일예약토글" });
  createdClassIds.push(cls.id);

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();

  // ② 회원 예약 → 예약 성공 (모달이 닫히고 그 수업 행이 "취소" 버튼으로 바뀜)
  await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  const cancelButton = memberPage.locator(".class-row", { hasText: "E2E 당일예약토글" }).getByRole("button", { name: "취소" });
  await expect(cancelButton).toBeVisible();

  // ③ 예약 취소 → 다시 "예약하기" 버튼으로 돌아옴
  memberPage.once("dialog", (d) => d.accept());
  await cancelButton.click();
  const reserveButton = memberPage.locator(".class-row", { hasText: "E2E 당일예약토글" }).getByRole("button", { name: "예약하기" });
  await expect(reserveButton).toBeVisible();

  // ④ 관리자 화면에서 실제로 OFF 저장
  await gotoManagerSettings(page);
  await toggleSettingSwitch(page, "당일 예약 허용", false);
  await saveManagerSettings(page);
  const afterOff = await fetchSettingsAdmin(centerAId);
  expect(afterOff.allowSameDayBooking).toBe(false);

  // ⑤ 회원 화면 새로고침 후 다시 예약 시도 → 실패
  await memberPage.reload();
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toBeVisible();
  const toastText = await waitForToastText(memberPage);
  expect(toastText).toContain("당일 예약은 허용되지 않아요");

  await memberContext.close();
});
