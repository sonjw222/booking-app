import { test, expect, type Page } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  reservationDeepLink,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  getOrCreateTestPassProductNamed,
  createTestGoodsMembershipAdmin,
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
    3) class_allowed_products를 UI 재진입으로 확인하도록 고친 뒤에도 그 재진입 클릭
       자체가 60초 타임아웃으로 실패했다("waiting for locator('.class-row')..."). 원인은
       form.date(수업 등록 폼의 날짜 입력, 직접 타이핑으로 채움)와 화면의 selectedDay
       (달력에서 어떤 날짜의 .class-row 목록을 보여줄지 결정하는 별개의 state)가 서로
       다른 값이라, 월만 이동하고 날짜 칸은 안 눌렀더니 저장한 class가 있는 날짜가
       화면에 아예 안 보였던 것 — class-allowed-products.spec.ts의 gotoManagerClassesDay가
       왜 날짜 칸까지 클릭하는지 이제야 정확히 이해함. gotoFutureDay로 이름을 바꾸고
       날짜 칸 클릭을 추가.
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;
let buyProductId: string;
const BUY_PRODUCT_NAME = "TEST4 신규구매전용패스";
const GOODS_PRODUCT_NAME = "E2E 테스트 대여품 상품"; // getOrCreateTestGoodsProduct의 고정 이름
const createdClassIds: string[] = [];

// TEST4가 실제로 구매를 완료하면 membership뿐 아니라 그 구매의 payments 행도 함께
// 생긴다(checkout → createOrder → confirmPayment) — payments.membership_id가 FK라
// membership만 지우면 FK violation으로 조용히 실패한다(실측 확인: 첫 실행은 성공했지만
// 그 memberships delete가 FK로 막혀 있었고, 다음 실행이 beforeAll에서 똑같이 실패해
// "이미 보유한 상품"이 돼버려 TEST4의 전제 자체가 깨졌다 — 실제 앱 버그 아니라 이
// cleanup 헬퍼 자체의 FK 순서 누락이었음). payments → memberships 순서로 지운다.
async function cleanupBuyProductMemberships(profileId: string, productId: string): Promise<void> {
  const admin = getFixtureAdminClient();
  const { data: mems, error: findErr } = await admin
    .from("memberships").select("id").eq("profile_id", profileId).eq("product_id", productId);
  if (findErr) throw new Error(`TEST4 membership 조회 실패: ${findErr.message}`);
  const memIds = (mems ?? []).map((m) => m.id);
  if (memIds.length === 0) return;
  const { error: payErr } = await admin.from("payments").delete().in("membership_id", memIds);
  if (payErr) throw new Error(`TEST4 payments 정리 실패: ${payErr.message}`);
  const { error: memErr } = await admin.from("memberships").delete().in("id", memIds);
  if (memErr) throw new Error(`TEST4 memberships 정리 실패: ${memErr.message}`);
}

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  if (originalSettings) await saveSettingsAdmin(centerAId, originalSettings);
  // 다음 실행에서도 "아직 안 가진 상품"이라는 전제가 성립하도록 매번 정리한다(P2-20에서
  // 겪은 것과 같은 종류의 테스트 데이터 누적을 여기서 반복하지 않기 위함).
  if (buyProductId) await cleanupBuyProductMemberships(userA.profileId, buyProductId);
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

  // TEST4 전용 — userA가 아직 안 가진 상품이어야 "구매 전 사용 가능한 수강권 없음"이
  // 성립한다. 이전 실행이 afterAll을 못 돌렸을 경우를 대비해 시작 시점에도 자기치유
  // 정리를 한 번 더 한다(product 자체는 get-or-create라 재사용, membership+payments만 정리).
  const buyProduct = await getOrCreateTestPassProductNamed(centerAId, BUY_PRODUCT_NAME);
  buyProductId = buyProduct.id;
  await cleanupBuyProductMemberships(userA.profileId, buyProductId);

  // TEST5 전용 — goods가 pass 목록에 절대 안 보이는지 검증하려면 실제로 goods를 보유해야
  // "안 보임"이 의미 있는 확인이 된다(get-or-create + self-healing, 기존 패턴 재사용).
  await createTestGoodsMembershipAdmin(centerAId, userA.profileId, { remainingCount: 5 });
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

// 월 이동 후 반드시 날짜 칸까지 클릭한다 — form.date(수업 등록 폼의 날짜 입력)와 화면의
// selectedDay(달력에서 어떤 날짜의 .class-row 목록을 보여줄지)는 서로 다른 state라, 날짜
// 칸을 직접 클릭해 selectedDay를 맞춰둬야 저장 후 그 날짜의 .class-row가 보인다(실측
// 확인 — 처음엔 이 클릭을 빠뜨려서 저장한 class를 재진입 확인하려는 클릭이 60초
// 타임아웃으로 실패했다: selectedDay가 다른 날짜를 가리켜 .class-row 자체가 없었음).
async function gotoFutureDay(page: Page, dateStr: string) {
  const [ty, tm, td] = dateStr.split("-").map(Number);
  await page.goto("/manager/classes");
  await expect(page.locator(".cal-title")).toBeVisible();
  for (let i = 0; i < 6; i++) {
    const title = (await page.locator(".cal-title").innerText()).trim();
    const [cy, cm] = title.split(".").map(Number);
    if (cy === ty && cm === tm) break;
    await page.locator(".cal-nav-btn").nth(1).click();
  }
  await page.locator(".cal-cell", { hasText: new RegExp(`^${td}$`) }).click();
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

  await gotoFutureDay(page, dateStr);
  await page.locator(".fab-btn", { hasText: "수업 등록" }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 등록" })).toBeVisible();

  await page.locator('input[placeholder="수업명"]').fill(uniqueTitle);
  await page.locator('input[type="date"]').fill(dateStr);
  await fillAmPmTime(page, 0, 19, 0);
  await fillAmPmTime(page, 1, 20, 0);
  await expect(page.locator(".perm-guide", { hasText: "모든 수강권" })).toBeVisible();

  await page.getByRole("button", { name: "등록하기", exact: true }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0, { timeout: 30_000 });

  const newClass = await findClassByTitle(uniqueTitle);
  createdClassIds.push(newClass.id);

  // class_allowed_products 저장 상태는 admin(service_role) client가 이 테이블 GRANT가
  // 없어 못 읽고, 인증 안 된 Node supabase 싱글턴은 RLS로 항상 빈 배열만 보이며,
  // Node에서 managerA/userA로 다시 로그인하면 브라우저(storageState)의 같은 계정 세션이
  // 즉시 무효화된다(testData.ts 파일 상단 주석에 이미 문서화된 실측 결과) — 그래서
  // class-allowed-products.spec.ts와 동일하게 UI 재진입으로 확인한다.
  await page.locator(".class-row", { hasText: uniqueTitle }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 수정" })).toBeVisible();
  // [수강권 허용 정책 변경] 'all'은 이제 "모든 chip이 체크된 상태"로 표현된다(0개 체크가
  // 아님 — 0개는 저장 자체가 막히는 상태). 등록 시 어떤 chip도 건드리지 않았으므로 여전히
  // 전체 체크 상태여야 한다.
  const allChipsT1 = page.locator(".class-allowed-products-list .filter-chip");
  const totalChipsT1 = await allChipsT1.count();
  await expect(page.locator(".class-allowed-products-list .filter-chip.on")).toHaveCount(totalChipsT1);
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

  await gotoFutureDay(page, dateStr);
  await page.locator(".fab-btn", { hasText: "수업 등록" }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 등록" })).toBeVisible();

  await page.locator('input[placeholder="수업명"]').fill(uniqueTitle);
  await page.locator('input[type="date"]').fill(dateStr);
  await fillAmPmTime(page, 0, 19, 0);
  await fillAmPmTime(page, 1, 20, 0);

  // 기본값 'all'(전체 체크)에서 시작하므로 먼저 전체 해제한 뒤 특정 pass 하나만 고른다.
  await page.getByRole("button", { name: "전체 해제" }).click();
  await page.locator('input[placeholder="수강권 이름 검색"]').fill("E2E 테스트 수강권 상품");
  const chip = page.locator(".filter-chip", { hasText: "E2E 테스트 수강권 상품" });
  await expect(chip).toHaveCount(1); // 검색 결과가 정확히 1개인지(모호한 매칭 배제)
  await chip.click();
  await expect(chip).toHaveClass(/on/); // 클릭이 실제로 이 chip을 on 상태로 토글했는지
  await expect(page.locator(".perm-guide", { hasText: "1개" })).toBeVisible();

  await page.getByRole("button", { name: "등록하기", exact: true }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0, { timeout: 30_000 });

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

test("TEST4: 신규 수업 → 사용 가능 수강권 없음 → 그 자리에서 구매 → 새로고침 포함 즉시 사용 가능 → 예약 성공 (실브라우저)", async ({ page, browser }) => {
  const uniqueTitle = `NEWCLASS-BUY-${Date.now()}`;
  const dateStr = futureKstDateStr(92);

  await gotoFutureDay(page, dateStr);
  await page.locator(".fab-btn", { hasText: "수업 등록" }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 등록" })).toBeVisible();

  await page.locator('input[placeholder="수업명"]').fill(uniqueTitle);
  await page.locator('input[type="date"]').fill(dateStr);
  await fillAmPmTime(page, 0, 19, 0);
  await fillAmPmTime(page, 1, 20, 0);

  // userA가 아직 안 가진 전용 상품 하나만 허용 — "구매 전 사용 가능한 수강권 없음"이
  // 우연이 아니라 구조적으로 보장되게 한다. 기본값 'all'(전체 체크)에서 시작하므로
  // 먼저 전체 해제한다.
  await page.getByRole("button", { name: "전체 해제" }).click();
  await page.locator('input[placeholder="수강권 이름 검색"]').fill(BUY_PRODUCT_NAME);
  const chip = page.locator(".filter-chip", { hasText: BUY_PRODUCT_NAME });
  await expect(chip).toHaveCount(1);
  await chip.click();
  await expect(chip).toHaveClass(/on/);

  await page.getByRole("button", { name: "등록하기", exact: true }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0, { timeout: 30_000 });

  const newClass = await findClassByTitle(uniqueTitle);
  createdClassIds.push(newClass.id);

  // class_allowed_products 확인(TEST1/TEST2와 동일한 UI 재진입 패턴 — 파일 상단 주석 참고)
  await page.locator(".class-row", { hasText: uniqueTitle }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 수정" })).toBeVisible();
  const chipsOn = page.locator(".class-allowed-products-list .filter-chip.on");
  await expect(chipsOn).toHaveCount(1);
  await expect(chipsOn).toHaveText(BUY_PRODUCT_NAME);
  await page.locator(".sheet-overlay").click({ position: { x: 10, y: 10 } });

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();

  // ① 구매 전: 사용 가능한 수강권 없음 + 구매 가능한 목록에 이 전용 상품만(goods는 절대 아님) 표시
  await memberPage.goto(reservationDeepLink(newClass.id, newClass.start_time));
  await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });
  await expect(memberPage.locator("text=현재 사용할 수 있는 수강권이 없어요")).toBeVisible();
  const purchasableList = memberPage.locator(".purchasable-pass-list");
  await expect(purchasableList).toBeVisible({ timeout: 10000 });
  await expect(purchasableList).toContainText(BUY_PRODUCT_NAME);
  await expect(purchasableList).not.toContainText(GOODS_PRODUCT_NAME); // TEST5의 "구매 추천도 pass만" 관점 겸용

  // ② "수강권 구매하기" → 센터 상세의 구매 시트(자동 오픈) → 이 상품 "구매" 클릭
  const buyBtn = memberPage.locator(".no-pass-buy-btn");
  await expect(buyBtn).toBeVisible();
  await buyBtn.click();
  await expect(memberPage.locator(".sheet-title", { hasText: "수강권 · 상품 구매" })).toBeVisible({ timeout: 15000 });
  const productRow = memberPage.locator(".center-product-row", { hasText: BUY_PRODUCT_NAME });
  await expect(productRow).toBeVisible();
  await productRow.locator(".center-product-buy").click();

  // ③ 결제 화면 → 실제 테스트 결제(Mock, 이 앱의 유일한 결제 경로) 진행
  await expect(memberPage.locator(".checkout-pay-btn")).toBeVisible({ timeout: 15000 });
  await memberPage.locator(".checkout-pay-btn").click();
  await expect(memberPage.locator("text=테스트 결제가 완료됐어요")).toBeVisible({ timeout: 20000 });
  const backToReserveLink = memberPage.locator("a", { hasText: "지금 바로 예약 이어가기" });
  await expect(backToReserveLink).toBeVisible();

  // 실패할 경우에만 진단 정보를 남기기 위해 미리 응답을 캡처해둔다(성공 경로에서는 출력 안 함)
  let lastUsableResponse: { status: number; body: string } | null = null;
  memberPage.on("response", async (res) => {
    if (res.url().includes("usable_memberships_for_classes")) {
      try { lastUsableResponse = { status: res.status(), body: await res.text() }; } catch { /* 무시 */ }
    }
  });

  // ④ <a href> — 풀 페이지 네비게이션이라 "새로고침 포함" 요구사항을 그대로 만족한다
  //    (checkout/page.tsx도 1.8초 후 window.location.href로 동일하게 자동 이동하지만,
  //    테스트 결정성을 위해 버튼을 직접 클릭해 즉시 진행한다).
  await backToReserveLink.click();

  // ⑤ 같은 신규 수업 예약창이 다시 열리고, 방금 산 pass가 즉시 사용 가능해야 함
  try {
    await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });
    const passListAfter = memberPage.locator(".pass-pick-list");
    await expect(passListAfter).toBeVisible({ timeout: 15000 });
    await expect(passListAfter).toContainText(BUY_PRODUCT_NAME);
  } catch (e) {
    // 요청받은 대로: 실패 순간의 membership row와 RPC 응답을 전부 남긴다
    const admin = getFixtureAdminClient();
    const { data: mem, error: memErr } = await admin
      .from("memberships")
      .select("id, product_id, center_id, profile_id, status, remaining_count, expires_at")
      .eq("profile_id", userA.profileId).eq("product_id", buyProductId)
      .order("created_at", { ascending: false }).limit(1);
    console.log(`=== TEST4 실패 — 방금 구매한 membership row(admin client): ${JSON.stringify(mem)} error=${memErr?.message} ===`);
    console.log(`=== TEST4 실패 — 재오픈 후 usable_memberships_for_classes 마지막 네트워크 응답: ${JSON.stringify(lastUsableResponse)} ===`);
    throw e;
  }

  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0, { timeout: 20000 });
  await expect(
    memberPage.locator(".class-row", { hasText: uniqueTitle }).getByRole("button", { name: "취소" })
  ).toBeVisible();

  await memberContext.close();
});

test("TEST5: 신규 수업(모든 수강권 허용)에서도 goods는 사용 가능한 수강권 목록에 절대 안 보임 (실브라우저)", async ({ page, browser }) => {
  const uniqueTitle = `NEWCLASS-GOODSCHK-${Date.now()}`;
  const dateStr = futureKstDateStr(93);

  await gotoFutureDay(page, dateStr);
  await page.locator(".fab-btn", { hasText: "수업 등록" }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 등록" })).toBeVisible();

  await page.locator('input[placeholder="수업명"]').fill(uniqueTitle);
  await page.locator('input[type="date"]').fill(dateStr);
  await fillAmPmTime(page, 0, 19, 0);
  await fillAmPmTime(page, 1, 20, 0);
  // 예약 가능 수강권은 아무것도 선택하지 않음(모든 수강권 허용)
  await expect(page.locator(".perm-guide", { hasText: "모든 수강권" })).toBeVisible();

  await page.getByRole("button", { name: "등록하기", exact: true }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0, { timeout: 30_000 });

  const newClass = await findClassByTitle(uniqueTitle);
  createdClassIds.push(newClass.id);

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(newClass.id, newClass.start_time));
  await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });

  // userA는 beforeAll에서 goods 1개(remainingCount:5)를 실제로 보유한 상태 — "안 보임"이
  // 우연이 아니라 실제 필터링 결과임을 의미 있게 검증한다("모든 수강권 허용"이라 goods를
  // 제외한 실제 pass들이 usable로 나와야 정상).
  const passList = memberPage.locator(".pass-pick-list");
  await expect(passList).toBeVisible();
  await expect(passList).not.toContainText(GOODS_PRODUCT_NAME);

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
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0, { timeout: 30_000 });
  await memberContext.close();
});
