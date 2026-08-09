import { test, expect, type Page } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  reservationDeepLink,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { getFixtureAdminClient } from "../../integration/setup";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  신규 수업 생성(관리자 UI) → 회원 예약 흐름 회귀 테스트.

  배경(PR #44 수동 QA, 2026-08-10): "기존 수업은 정상인데 관리자 UI로 새로 만든 수업은
  회원이 유효한 수강권을 보유해도 '사용 가능한 수강권이 없어요'라고 뜬다"는 버그가
  보고됨. 조사 결과(read-only 진단 → admin client 직접 insert 비교 → 실제 Playwright
  브라우저로 관리자 UI 등록 재현 → RPC 직접 호출 → 회원 실제 브라우저 재현, 전부 CI로
  실측):
    - membership_schedule_rules는 centerA 전체 0건(과거 이 정확한 증상을 냈던 자동-규칙
      추가 버그의 잔여 데이터 가설은 실제 데이터로 반박됨).
    - admin client로 직접 insert한 새 class와 기존 class는 RPC 결과가 완전히 동일.
    - 실제 관리자 UI로 새 class를 만들어도(모든 수강권 허용/특정 pass 1개 허용 둘 다)
      class_allowed_products/RPC/회원 화면(.pass-pick-list)까지는 전부 정상 동작 — 여기까지는
      재현 실패.
  즉 TEST_MANAGER_A/TEST_USER_A/centerA 기존 fixture와 정상 그룹수업 생성 경로로는 PR #44가
  보고한 증상(.pass-pick-list 자체가 안 뜸)이 재현되지 않았다(상세 경위는 PR #44 코멘트 참고).

  이 파일은 "관리자 UI로 실제 수업을 등록하는 경로"를 exercise하는 최초의 자동 테스트라서
  (기존엔 전부 admin client 직접 insert로 setup, UI 등록 자체를 검증하는 테스트가 하나도
  없었음 — 이번 조사로 드러난 실제 커버리지 공백) 처음엔 "실제 예약 성공까지" 확인하는
  마지막 단계를 넣었는데, 그 단계에서 테스트 자체의 결함 두 개를 새로 발견해 전부 코드
  변경 없이 테스트를 고쳤다(둘 다 실측 근거 있음, 추측 아님 — 앱 버그는 하나도 없었음):
    1) class_allowed_products 저장 상태를 Node 쪽에서 직접 SELECT로 확인하려 했는데
       계속 빈 배열만 나왔다 — 처음엔 "read-after-write 타이밍 문제"로 추정해
       expect.poll로 재시도했지만 15초를 줘도 여전히 실패해 더 파봄. 네트워크 캡처로
       브라우저의 INSERT 자체는 매번 정확한 payload로 성공했음(모달이 정상 닫힘)을
       재확인한 뒤 진짜 원인을 찾음: 이 테스트가 쓰는 Node 쪽 supabase 싱글턴은 어느
       계정으로도 로그인한 적이 없어(anon), class_allowed_products의 SELECT RLS
       정책("auth.uid() is not null")에 항상 막혀 빈 배열만 보였다 — 타이밍과 무관한
       영구적인 인증 문제였다. admin(service_role) client는 이 테이블에 대한 SQL GRANT가
       없어 그마저도 안 되고, Node에서 managerA/userA로 로그인하면(switchToTestUser)
       브라우저(storageState)의 같은 계정 세션이 즉시 무효화된다는 게 이미 문서화돼
       있어(tests/e2e/fixtures/testData.ts 파일 상단 주석, 실측 확인된 내용) 그 방법도
       못 쓴다. 그래서 class-allowed-products.spec.ts와 동일하게 UI 재진입(수정 시트를
       다시 열어 어떤 chip이 .on 상태인지 확인)으로 검증하도록 바꿨다 — Node에서 이
       값을 안전하게 직접 읽을 방법이 아예 없다.
    2) 예약 확정 클릭이 "아직 예약이 열리지 않았어요"로 실패했다 — RPC 응답을 캡처해
       확인. 원인은 테스트가 임의로 고른 90/91일 뒤 날짜가 "예약 오픈 기한"
       (groupOpenDaysBefore, 기본값 60일)을 초과했기 때문(booking-open-deadline.spec.ts가
       검증하는 바로 그 기능이 설계대로 정확히 동작한 것 — 앱 버그 아님. 처음엔
       groupBookDaysBefore를 잘못 건드렸다가 — 이건 "오픈"이 아니라 다른 마감 설정 —
       calc_deadline()의 실제 kind 분기(fix_calc_deadline_open_kind_draft_proposed.sql)를
       다시 읽고 정정함). beforeAll에서 groupOpenDaysBefore를 이 파일의 최대 날짜보다
       넉넉히 크게 저장하고 afterAll에서 원복하도록 수정(다른 테스트 파일들의 기존
       관례와 동일한 패턴).
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  if (originalSettings) await saveSettingsAdmin(centerAId, originalSettings);
});

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  // 이 파일의 수업들은 90일 이상 뒤 미래 날짜를 쓴다(다른 테스트가 남긴 근미래 데이터와
  // 안 겹치도록) — 예약 오픈 기한 제한이 남아있으면 그 자체가 "아직 예약 불가"로
  // 막히므로, 이 테스트 동안만 명시적으로 제한을 풀어둔다(다른 파일들과 동일한 관례).
  originalSettings = await fetchSettingsAdmin(centerAId);
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    groupOpenDaysBefore: 120,
    groupOpenTime: "00:00",
    dailyBookLimitEnabled: false,
  });
});

async function fillAmPmTime(page: Page, rowIndex: number, hour24: number, minute: number) {
  const row = page.locator(".ampm-time-row").nth(rowIndex);
  const period = hour24 < 12 ? "AM" : "PM";
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  await row.locator("select").nth(0).selectOption(period);
  await row.locator("select").nth(1).selectOption(String(hour12));
  await row.locator("select").nth(2).selectOption(String(minute));
}

async function gotoFutureMonth(page: Page, dateStr: string) {
  const [ty, tm] = dateStr.split("-").map(Number);
  await page.goto("/manager/classes");
  await expect(page.locator(".cal-title")).toBeVisible();
  for (let i = 0; i < 6; i++) {
    const title = (await page.locator(".cal-title").innerText()).trim();
    const [cy, cm] = title.split(".").map(Number);
    if (cy === ty && cm === tm) break;
    await page.locator(".cal-nav-btn").nth(1).click();
  }
}

function futureKstDateStr(daysFromNow: number): string {
  const future = new Date(Date.now() + daysFromNow * 24 * 3600 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(future);
}

async function findClassByTitle(title: string) {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin
    .from("classes")
    .select("id, title, start_time, end_time")
    .eq("center_id", centerAId)
    .eq("title", title)
    .single();
  if (error || !data) throw new Error(`방금 만든 class를 못 찾음: ${error?.message}`);
  return data;
}

test("TEST1: 관리자 UI로 신규 수업(모든 수강권 허용) 생성 → 회원 기존 pass 표시 → 예약 성공 (실브라우저)", async ({ page, browser }) => {
  const uniqueTitle = `NEWCLASS-ALL-${Date.now()}`;
  const dateStr = futureKstDateStr(90);

  await gotoFutureMonth(page, dateStr);
  await page.locator(".fab-btn", { hasText: "수업 등록" }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 등록" })).toBeVisible();

  await page.locator('input[placeholder="수업명"]').fill(uniqueTitle);
  await page.locator('input[type="date"]').fill(dateStr);
  await fillAmPmTime(page, 0, 19, 0);
  await fillAmPmTime(page, 1, 20, 0);
  await expect(page.locator(".perm-guide", { hasText: "모든 수강권" })).toBeVisible();

  await page.getByRole("button", { name: "등록하기", exact: true }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);

  const newClass = await findClassByTitle(uniqueTitle);
  createdClassIds.push(newClass.id);

  // class_allowed_products 저장 상태는 admin(service_role) client가 이 테이블 GRANT가
  // 없어 못 읽고, 인증 안 된 Node supabase 싱글턴은 RLS로 항상 빈 배열만 보이며,
  // Node에서 managerA/userA로 다시 로그인하면 브라우저(storageState)의 같은 계정 세션이
  // 즉시 무효화된다(testData.ts 파일 상단 주석에 이미 문서화된 실측 결과) — 그래서
  // class-allowed-products.spec.ts와 동일하게 UI 재진입으로 확인한다.
  await page.locator(".class-row", { hasText: uniqueTitle }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 수정" })).toBeVisible();
  await expect(page.locator(".class-allowed-products-list .filter-chip.on")).toHaveCount(0);
  await page.locator(".sheet-overlay").click({ position: { x: 10, y: 10 } });

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(newClass.id, newClass.start_time));
  await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });
  await expect(memberPage.locator(".pass-pick-list")).toBeVisible();
  await expect(memberPage.locator("text=현재 사용할 수 있는 수강권이 없어요")).toHaveCount(0);

  await memberPage.getByRole("button", { name: "예약하기" }).click();
  // 예약 확정 RPC 왕복이 공유 dev Supabase가 바쁠 때 기본 10초보다 오래 걸릴 수 있음
  // (daily-book-limit.spec.ts에서 이미 실측 확인된 것과 동일 계열의 인프라 지연) — 여유를 둔다.
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0, { timeout: 20000 });
  await expect(
    memberPage.locator(".class-row", { hasText: uniqueTitle }).getByRole("button", { name: "취소" })
  ).toBeVisible();

  await memberContext.close();
});

test("TEST2: 관리자 UI로 신규 수업(특정 pass 1개만 허용) 생성 → 해당 pass만 표시 → 예약 성공 (실브라우저)", async ({ page, browser }) => {
  const uniqueTitle = `NEWCLASS-SPECIFIC-${Date.now()}`;
  const dateStr = futureKstDateStr(91);

  await gotoFutureMonth(page, dateStr);
  await page.locator(".fab-btn", { hasText: "수업 등록" }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 등록" })).toBeVisible();

  await page.locator('input[placeholder="수업명"]').fill(uniqueTitle);
  await page.locator('input[type="date"]').fill(dateStr);
  await fillAmPmTime(page, 0, 19, 0);
  await fillAmPmTime(page, 1, 20, 0);

  await page.locator('input[placeholder="수강권 이름 검색"]').fill("E2E 테스트 수강권 상품");
  const chip = page.locator(".filter-chip", { hasText: "E2E 테스트 수강권 상품" });
  await expect(chip).toHaveCount(1); // 검색 결과가 정확히 1개인지(모호한 매칭 배제)
  await chip.click();
  await expect(chip).toHaveClass(/on/); // 클릭이 실제로 이 chip을 on 상태로 토글했는지
  await expect(page.locator(".perm-guide", { hasText: "1개" })).toBeVisible();

  await page.getByRole("button", { name: "등록하기", exact: true }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);

  const newClass = await findClassByTitle(uniqueTitle);
  createdClassIds.push(newClass.id);

  // class_allowed_products 저장 상태는 UI 재진입으로 확인한다(TEST1과 동일한 이유 —
  // Node에서 이 값을 직접 조회할 안전한 방법이 없음, 파일 상단 주석 참고).
  await page.locator(".class-row", { hasText: uniqueTitle }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 수정" })).toBeVisible();
  const chipsOn = page.locator(".class-allowed-products-list .filter-chip.on");
  await expect(chipsOn).toHaveCount(1);
  await expect(chipsOn).toHaveText("E2E 테스트 수강권 상품");
  await page.locator(".sheet-overlay").click({ position: { x: 10, y: 10 } });

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(newClass.id, newClass.start_time));
  await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });
  const passList = memberPage.locator(".pass-pick-list");
  await expect(passList).toBeVisible();
  await expect(passList).toContainText("E2E 테스트 수강권");
  // TEST3: 미허용 pass(예: 통합테스트 수강권(P3))는 목록에 나오면 안 됨
  await expect(passList).not.toContainText("통합테스트 수강권(P3)");

  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0, { timeout: 20000 });
  await expect(
    memberPage.locator(".class-row", { hasText: uniqueTitle }).getByRole("button", { name: "취소" })
  ).toBeVisible();

  await memberContext.close();
});

test("TEST6(대조군): 기존 방식(admin client 직접 insert)으로 만든 수업도 계속 정상 예약 가능 (실브라우저)", async ({ browser }) => {
  const cls = await createFutureTestClassAdmin(centerAId, { title: `NEWCLASS-CONTROL-${Date.now()}`, hoursFromNow: 32 });
  createdClassIds.push(cls.id);

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
  await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });
  await expect(memberPage.locator(".pass-pick-list")).toBeVisible();
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await memberContext.close();
});
