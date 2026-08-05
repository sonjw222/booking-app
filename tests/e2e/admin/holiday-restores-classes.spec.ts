import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  kstDateStr,
  type TestUser,
} from "../fixtures/testData";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { selectKstCalendarDay, waitForToastText } from "../fixtures/pageHelpers";

/*
  P0-1: 휴무일을 지정하면 add_holiday_safe()가 그날 수업들을 classes.status='cancelled'로
  바꾸는데(이력 보존을 위한 재설계, 이번 세션에 확인됨), 휴무일을 삭제할 때는 그 상태를
  되돌리는 코드가 어디에도 없었다 — 그래서 휴무일을 지워도 수업은 계속 "폐강된 수업이에요"로
  막혀 있었다(캐시/RPC 문제가 아니라 애초에 복구 로직이 없었던 것, 코드 감사로 확인).

  fix_holiday_delete_restores_classes.sql의 remove_holiday_safe()로 수정 — 휴무일 삭제와
  동시에 그 센터/날짜의 cancelled 수업을 open으로 되돌린다.

  이 흐름은 사용자가 요청한 그대로 검증한다:
    휴무일 생성 → 회원 화면 확인(예약 차단) → 휴무일 삭제 → 새로고침 →
    기존 수업 예약 가능 → 새 수업 예약 가능
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
const createdClassIds: string[] = [];
let holidayDate: string;

// app/manager/holidays/page.tsx의 fmtDate()와 동일한 포맷 — 화면에 실제로 렌더링되는
// 텍스트와 정확히 일치시켜 그 휴무일 행만 찾는다("E2E"처럼 임의 문자열로 매칭하지 않음,
// 이 센터에 다른 휴무일이 이미 있을 수 있으므로).
function fmtDate(d: string): string {
  const dt = new Date(d + "T00:00:00+09:00");
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short" }).format(dt);
}

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
});

test("휴무일 생성→회원화면 예약차단 확인→삭제→새로고침→기존/신규 수업 예약 가능 (실브라우저 end-to-end)", async ({ page, browser }) => {
  // ① 며칠 뒤(당일예약 설정과 무관하도록) 날짜에 수업 하나를 미리 만들어둔다("기존 수업").
  const existingCls = await createFutureTestClassAdmin(centerAId, {
    title: "E2E 휴무일복구-기존", hoursFromNow: 5 * 24,
  });
  createdClassIds.push(existingCls.id);
  holidayDate = kstDateStr(existingCls.startTime);

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();

  // ② 관리자 화면에서 실제로 그 날짜를 휴무일로 지정
  const holidayRow = () => page.locator(".hol-row", { hasText: fmtDate(holidayDate) });
  await page.goto("/manager/holidays");
  await page.locator('input[type="date"]').fill(holidayDate);
  await page.getByRole("button", { name: "추가" }).click();
  await expect(holidayRow()).toBeVisible();

  // ③ 회원 화면 확인 — 그 날짜 수업 예약 시도가 "폐강된 수업이에요"로 차단돼야 한다.
  await memberPage.goto("/reservation");
  await selectKstCalendarDay(memberPage, holidayDate);
  await memberPage.locator(".class-row", { hasText: "E2E 휴무일복구-기존" }).getByRole("button", { name: "예약" }).click();
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  const blockedToast = await waitForToastText(memberPage);
  expect(blockedToast).toContain("폐강된 수업이에요");

  // ④ 관리자 화면에서 방금 만든 휴무일을 실제로 삭제
  await page.goto("/manager/holidays");
  page.once("dialog", (d) => d.accept());
  await holidayRow().getByRole("button", { name: "삭제" }).click();
  await expect(holidayRow()).toHaveCount(0);

  // ⑤ 휴무일 지정 이후 만든 새 수업("신규 수업")도 같은 날짜에 추가 — 삭제 후 이것도
  // 예약 가능해야 한다(휴무일이 계속 있었다면 이 수업도 폐강 대상이었을 것이므로).
  const newCls = await createFutureTestClassAdmin(centerAId, {
    title: "E2E 휴무일복구-신규", hoursFromNow: 5 * 24 + 1,
  });
  createdClassIds.push(newCls.id);

  // ⑥ 회원 화면 새로고침 후 기존 수업이 다시 예약 가능한지 확인
  await memberPage.reload();
  await selectKstCalendarDay(memberPage, holidayDate);
  await memberPage.locator(".class-row", { hasText: "E2E 휴무일복구-기존" }).getByRole("button", { name: "예약" }).click();
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    memberPage.locator(".class-row", { hasText: "E2E 휴무일복구-기존" }).getByRole("button", { name: "취소" })
  ).toBeVisible();

  // ⑦ 새 수업도 예약 가능한지 확인
  await memberPage.locator(".class-row", { hasText: "E2E 휴무일복구-신규" }).getByRole("button", { name: "예약" }).click();
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    memberPage.locator(".class-row", { hasText: "E2E 휴무일복구-신규" }).getByRole("button", { name: "취소" })
  ).toBeVisible();

  await memberContext.close();
});
