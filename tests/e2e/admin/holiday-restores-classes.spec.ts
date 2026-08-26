import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  createFutureTestClassAdmin,
  createClassOnKstDateAdmin,
  cleanupTestClassAdmin,
  kstDateStr,
  type TestUser,
} from "../fixtures/testData";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { selectKstCalendarDay } from "../fixtures/pageHelpers";

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

  ⚠️ ③단계 관련 — CI 1차 검증에서 코드 재확인 후 수정: 회원 화면은 fetchMonthData()
  (lib/reservations.ts)에서 classes를 center_holidays와 대조해 "그 센터+그 날짜가 휴무일이면
  아예 목록에서 제외"한다(.filter(c => !holidaySet.has(`${center_id}:${date}`)), classes.status
  와는 무관한 별도 로직). 즉 휴무일이 "살아있는 동안"은 그 수업 자체가 회원 목록에 안 뜨므로
  클릭해서 "폐강된 수업이에요" 토스트를 받는 상황 자체가 나올 수 없다(실제 CI 실행에서 확인:
  .class-row가 없어 클릭 대기가 타임아웃). 사용자가 재현한 실제 버그는 "삭제 이후"에 발생한다 —
  휴무일이 사라지면 holidaySet 필터는 더 이상 안 걸리지만, add_holiday_safe가 그때 같이 바꿔둔
  classes.status='cancelled'는 (복구 로직이 없으면) 그대로 남아 예약 시도가 계속 막힌다. 그래서
  ③단계는 "휴무일이 있는 동안은 목록에 아예 안 보인다"만 확인하고, 진짜 회귀 검증은 ⑥⑦단계
  (삭제 후 실제로 다시 예약되는지)가 담당한다.
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let originalSettings: Awaited<ReturnType<typeof fetchSettingsAdmin>>;
const createdClassIds: string[] = [];
let holidayDate: string;

// app/manager/holidays/page.tsx의 fmtDate()와 동일한 포맷 — 화면에 실제로 렌더링되는
// 텍스트와 정확히 일치시켜 그 휴무일 행만 찾는다("E2E"처럼 임의 문자열로 매칭하지 않음,
// 이 센터에 다른 휴무일이 이미 있을 수 있으므로).
function fmtDate(d: string): string {
  const dt = new Date(d + "T00:00:00+09:00");
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short" }).format(dt);
}

// 관리자 화면의 "추가" 폼은 fetchMyCenters()가 끝나 centerId가 정해지기 전에도 이미 렌더링돼
// 있다(목록 영역만 loading으로 감싸져 있음) — 그래서 goto 직후 바로 입력/클릭하면 centerId가
// 아직 null인 순간을 때릴 수 있다(실제 CI 실패로 재현됨: "추가" 클릭에도 add_holiday_safe RPC
// 자체가 전혀 발생하지 않음을 네트워크 트레이스로 확인). 목록이 최초로 로딩을 끝낸 뒤(빈 상태든
// 항목이 있든)에만 입력을 시작해 centerId가 확정된 이후임을 보장한다.
async function waitHolidaysReady(p: import("@playwright/test").Page): Promise<void> {
  await p.locator(".daylist-empty, .hol-list").first().waitFor({ state: "visible" });
}

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  originalSettings = await fetchSettingsAdmin(centerAId);
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    dailyBookLimitEnabled: false,
    dailyBookLimit: null,
  });
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  if (originalSettings) await saveSettingsAdmin(centerAId, originalSettings);
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
  // ⚠ 이 센터는 여러 스펙(E2E/통합 테스트)이 공유하는 테스트 센터라, 우연히 같은
  // 날짜(예: hoursFromNow가 24의 배수로 겹침)에 다른 스펙이 예약 있는 수업을 만들어둔
  // 상태일 수 있다(실제로 CI에서 재현: "수업 2개, 예약 1건" 확인창이 떠서 "추가"
  // 클릭만으로는 안 끝나고 막힘). add_holiday_safe()가 의도한 정상 동작(예약자가
  // 있으면 확인 필요)이므로, 그 확인창이 뜨면 "예약 취소하고 휴무일 지정"까지
  // 마저 눌러 끝까지 진행한다 — 이 테스트의 관심사(휴무일 삭제 시 폐강 복구)와는
  // 무관한 경합이라 강제 진행이 맞다.
  const holidayRow = () => page.locator(".hol-row", { hasText: fmtDate(holidayDate) });
  await page.goto("/manager/holidays");
  await waitHolidaysReady(page);
  await page.locator('input[type="date"]').fill(holidayDate);
  await page.getByRole("button", { name: "추가" }).click();
  // ⚠ isVisible()은 즉시 현재 DOM만 확인하고 기다려주지 않는다("추가" 클릭 직후엔 서버
  // 응답이 아직 안 와 확인창이 렌더되기 전이라 항상 false로 새서 이 분기 자체가 절대
  // 실행되지 않았다 — 실제 CI 트레이스로 add_holiday_safe가 force=false로 딱 한 번만
  // 호출된 것을 확인). waitFor()로 실제로 폴링하며 기다린다.
  const forceConfirmBtn = page.getByRole("button", { name: "예약 취소하고 휴무일 지정" });
  const needsConfirm = await forceConfirmBtn
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (needsConfirm) {
    await forceConfirmBtn.click();
  }
  await expect(holidayRow()).toBeVisible();

  // ③ 회원 화면 확인 — 휴무일인 동안은 그 날짜 수업이 목록에서 아예 사라진다
  // (fetchMonthData의 holidaySet 필터, classes.status와는 별개 로직).
  await memberPage.goto("/reservation");
  await selectKstCalendarDay(memberPage, holidayDate);
  await expect(memberPage.locator(".holiday-notice")).toBeVisible();
  await expect(
    memberPage.locator(".class-row", { hasText: "E2E 휴무일복구-기존" })
  ).toHaveCount(0);

  // ④ 관리자 화면에서 방금 만든 휴무일을 실제로 삭제
  await page.goto("/manager/holidays");
  await waitHolidaysReady(page);
  // handleDelete()가 appConfirm() 커스텀 확인창을 띄운다(네이티브 confirm()에서 마이그레이션됨).
  await holidayRow().getByRole("button", { name: "삭제" }).click();
  await page.locator(".confirm-sheet").getByRole("button", { name: "확인" }).click();
  await expect(holidayRow()).toHaveCount(0);

  // ⑤ 휴무일 지정 이후 만든 새 수업("신규 수업")도 같은 날짜에 추가 — 삭제 후 이것도
  // 예약 가능해야 한다(휴무일이 계속 있었다면 이 수업도 폐강 대상이었을 것이므로).
  // ⚠ hoursFromNow처럼 "지금부터 상대"로 다시 계산하면, 여기까지 오는 동안 여러 UI
  // 라운드트립을 거쳐 시간이 흘렀을 수 있어 existingCls/holidayDate와 다른 날짜에 생길
  // 위험이 있다(실제로 CI에서 재현 확인). holidayDate를 그대로 명시해 항상 같은 날짜에
  // 생기도록 한다.
  const newCls = await createClassOnKstDateAdmin(centerAId, {
    title: "E2E 휴무일복구-신규", kstDate: holidayDate, kstTime: "11:00",
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
