import { test, expect, type Page } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  kstDateStr,
  getOrCreateTestPassProductNamed,
  getOrCreateTestGoodsProduct,
  createTestMembershipForProduct,
  clearScheduleRulesForProduct,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import { getFixtureAdminClient } from "../../integration/setup";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  P3: 수업별 사용 가능 수강권(class_allowed_products) 관리 UI.

  기존 구조 감사 결과(이미 구현돼 있던 것 — 이번에 새로 만들지 않음): 관리자 수업 등록/수정
  화면(app/manager/classes/page.tsx)에 "예약 가능 수강권" 다중 선택 칩이 이미 있고, 등록·
  수정·반복등록(setClassProductsBulk)·스케줄 복사(insertCopiedClasses)까지 전부
  lib/classes.ts의 setClassProducts로 class_allowed_products를 정상적으로 채운다. 회원
  화면(usable_memberships_for_classes)도 이미 이 값을 정확히 반영한다. 이번에 실제로
  빠져 있던 것만 추가: (1) 검색 UI, (2) reserve_with_membership()의 서버 강제(별도
  통합테스트), (3) "구매 가능한 수강권" 추천에 goods가 섞이던 버그(코드 수정, 이 스펙의
  goods 검증으로 함께 확인).
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let passA: { id: string; name: string };
let passB: { id: string; name: string };
let passC: { id: string; name: string };
// D/E/F는 "전체 허용" 테스트 전용 — A/B/C는 다른 테스트에서 이미 특정 수업에 명시적으로
// 지정돼(class_allowed_products) membership_schedule_rules가 그 수업 조건으로 좁혀진
// 상태라(의도된 동작 — 특정 수강권만 허용하면 그 수강권은 그 수업에서만 쓰이도록
// 자동 기록됨), "전체 허용" 수업에서 여전히 보여야 하는지 검증하기엔 부적합하다.
let passD: { id: string; name: string };
let passE: { id: string; name: string };
let passF: { id: string; name: string };
let goods: { id: string };
let originalSettings: Awaited<ReturnType<typeof fetchSettingsAdmin>>;
const createdClassIds: string[] = [];
const foreignCenterCleanup: { centerId: string; productId: string } = { centerId: "", productId: "" };

async function gotoManagerClassesDay(page: Page, kstDate: string): Promise<void> {
  const [y, m, d] = kstDate.split("-").map(Number);
  await page.goto("/manager/classes");
  await expect(page.locator(".cal-title")).toBeVisible();
  for (let i = 0; i < 14; i++) {
    const title = (await page.locator(".cal-title").innerText()).trim(); // "YYYY.MM"
    const [ty, tm] = title.split(".").map(Number);
    if (ty === y && tm === m) break;
    await page.locator(".cal-nav-btn").nth(1).click(); // '›' 다음달
  }
  await page.locator(".cal-cell", { hasText: new RegExp(`^${d}$`) }).click();
}

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
    dailyBookLimit: null,
  });

  passA = await getOrCreateTestPassProductNamed(centerAId, "P3 패스A");
  passB = await getOrCreateTestPassProductNamed(centerAId, "P3 패스B");
  passC = await getOrCreateTestPassProductNamed(centerAId, "P3 패스C");
  passD = await getOrCreateTestPassProductNamed(centerAId, "P3 패스D");
  passE = await getOrCreateTestPassProductNamed(centerAId, "P3 패스E");
  passF = await getOrCreateTestPassProductNamed(centerAId, "P3 패스F");
  goods = await getOrCreateTestGoodsProduct(centerAId);

  await createTestMembershipForProduct(centerAId, userA.profileId, passA, { remainingCount: 10 });
  await createTestMembershipForProduct(centerAId, userA.profileId, passB, { remainingCount: 10 });
  await createTestMembershipForProduct(centerAId, userA.profileId, passC, { remainingCount: 10 });
  await createTestMembershipForProduct(centerAId, userA.profileId, passD, { remainingCount: 10 });
  await createTestMembershipForProduct(centerAId, userA.profileId, passE, { remainingCount: 10 });
  await createTestMembershipForProduct(centerAId, userA.profileId, passF, { remainingCount: 10 });

  // 타 센터 혼입 검증용 — 어떤 매니저 로그인도 필요 없이 순수 admin insert로 격리된
  // "다른 센터 + 그 센터의 pass 상품"을 만든다(단순히 admin UI의 상품 목록이 절대
  // 이걸 보여주면 안 된다는 것만 확인하면 되므로).
  const admin = getFixtureAdminClient();

  // [중요] app/manager/classes/page.tsx가 예전엔 class_allowed_products 저장 시 부수효과로
  // membership_schedule_rules에도 자동으로 규칙을 추가/삭제했다(autoAddRulesForClass/
  // removeRulesForClass) — membership_schedule_rules는 사실 완전히 독립된 관리자 화면
  // (/manager/membership-rules, lib/passes.ts)에서 직접 관리하는 별도 기능인데, 이 부수효과가
  // 두 기능의 의미를 섞으면서 "모든 수강권 허용으로 저장해도 예전에 자동 추가된 규칙이 안
  // 지워져 그 수강권만 계속 안 보이는" 버그를 반복적으로 냈다(P3 감사 중 재현·확인). 이제
  // class_allowed_products 저장은 membership_schedule_rules를 절대 건드리지 않도록 고쳤지만,
  // 고치기 전 여러 번의 재실행으로 이미 만들어진 잔여 규칙이 이 파일의 pass 상품들에 남아
  // 있을 수 있어 실행마다 한 번 정리한다(코드가 더 이상 이 테이블에 쓰지 않으므로 앞으로는
  // 다시 쌓이지 않는다).
  for (const p of [passA, passB, passC, passD, passE, passF]) {
    if (p) await clearScheduleRulesForProduct(p.id);
  }

  // [2026-08-14 수정] 매번 무조건 insert하던 걸 이름 기준 get-or-create로 전환 —
  // passA~F와 동일 관례(getOrCreateTestPassProductNamed). E2E가 중간에 죽으면
  // afterAll이 못 돌아 이 fixture가 실행마다 새로 쌓였다(이미 이 이름으로 leaked된
  // 행이 있어도 확인 없이 또 만듦). 이제 이미 있으면 재사용, 없을 때만 생성한다.
  const { data: existingForeignCenter } = await admin
    .from("centers").select("id").eq("name", "P3 타센터-격리테스트").maybeSingle();
  if (existingForeignCenter) {
    foreignCenterCleanup.centerId = (existingForeignCenter as any).id;
  } else {
    const { data: foreignCenter, error: fcErr } = await admin
      .from("centers").insert({ name: "P3 타센터-격리테스트", status: "approved" }).select("id").single();
    if (fcErr || !foreignCenter) throw new Error(`타 센터 생성 실패: ${fcErr?.message ?? "no data"}`);
    foreignCenterCleanup.centerId = foreignCenter.id;
  }
  const { data: existingForeignProduct } = await admin
    .from("products").select("id").eq("center_id", foreignCenterCleanup.centerId).eq("name", "P3 타센터전용패스").maybeSingle();
  if (existingForeignProduct) {
    foreignCenterCleanup.productId = (existingForeignProduct as any).id;
  } else {
    const { data: foreignProduct, error: fpErr } = await admin
      .from("products")
      .insert({ center_id: foreignCenterCleanup.centerId, name: "P3 타센터전용패스", product_kind: "pass", pass_type: "count", total_count: 999, is_on_sale: true, is_active: true })
      .select("id").single();
    if (fpErr || !foreignProduct) throw new Error(`타 센터 상품 생성 실패: ${fpErr?.message ?? "no data"}`);
    foreignCenterCleanup.productId = foreignProduct.id;
  }
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  if (originalSettings) await saveSettingsAdmin(centerAId, originalSettings);
  // foreignCenterCleanup(centerId/productId)은 이제 get-or-create로 재사용되는 공유
  // fixture다 — 더 이상 여기서 삭제하지 않는다(삭제→재생성 churn 제거).
});

test("관리자: 검색으로 특정 pass 1개만 선택 → 저장 → 재진입 시 선택값 유지 → 회원 화면엔 그 pass만 표시 (실브라우저)", async ({ page, browser }) => {
  const cls = await createFutureTestClassAdmin(centerAId, { title: "P3 그룹수업-특정1개", hoursFromNow: 30 });
  createdClassIds.push(cls.id);
  const kstDate = kstDateStr(cls.startTime);

  await gotoManagerClassesDay(page, kstDate);
  await page.locator(".class-row", { hasText: "P3 그룹수업-특정1개" }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 수정" })).toBeVisible();

  // [수강권 허용 정책 변경] 새/미지정 수업은 기본값 'all'이라 열자마자 모든 수강권이 이미
  // 체크돼 있다 — "특정 1개만" 만들려면 먼저 전체 해제부터 해야 한다.
  await page.getByRole("button", { name: "전체 해제" }).click();
  await expect(page.locator(".class-allowed-products-list .filter-chip.on")).toHaveCount(0);
  await page.locator('input[placeholder="수강권 이름 검색"]').fill("패스B");
  await expect(page.locator(".filter-chip", { hasText: "P3 패스A" })).toHaveCount(0);
  await page.locator(".filter-chip", { hasText: "P3 패스B" }).click();
  await page.getByRole("button", { name: "수정하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);

  // 재진입 시 선택값이 그대로 로드되는지 확인
  // ⚠ .filter-chip.on은 이 폼 안에서 그룹/프라이빗 토글·룸 선택에도 재사용되는 클래스라
  // 반드시 예약 가능 수강권 목록(.class-allowed-products-list)으로 범위를 좁혀야 한다.
  await page.locator(".class-row", { hasText: "P3 그룹수업-특정1개" }).click();
  const passChipsOn1 = page.locator(".class-allowed-products-list .filter-chip.on");
  await expect(passChipsOn1).toHaveCount(1);
  await expect(passChipsOn1).toHaveText("P3 패스B");
  await page.locator(".sheet-overlay").click({ position: { x: 10, y: 10 } });

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
  const passList = memberPage.locator(".pass-pick-list");
  // [CI 반복 실패 조사, 2026-09-01] 이 스펙(특히 뒤쪽 두 테스트, 관리자 쪽에서 클릭·저장을
  // 더 많이 거친 뒤에 여기 도달)이 GitHub Actions에서만 간헐적으로 ".pass-pick-list"가
  // 기본 10초 타임아웃 안에 안 뜬다는 걸 여러 PR에 걸쳐 반복 확인함 — 이 센터(managerA
  // 소유 공유 fixture)에 그동안 쌓인 products(100+)/memberships(70+) 자체가 로컬보다 느린
  // CI 환경에서 usable_memberships_for_classes 배치 조회를 눈에 띄게 늦출 만큼 크다고
  // 판단(실제 raw 데이터 오염·중복은 admin으로 직접 조회해 확인했지만 없었음 — 순수하게
  // 데이터 볼륨발 지연). 근본적으로 fixture를 정리하는 대신(다른 병렬 스펙들이 이미 이
  // 데이터에 의존하고 있어 위험도가 더 큼) 타임아웃만 넉넉하게 늘려 실제로 늦게라도
  // 뜨는 경우를 실패로 잘못 처리하지 않게 한다.
  await expect(passList).toBeVisible({ timeout: 25_000 });
  await expect(passList).toContainText("P3 패스B");
  await expect(passList).not.toContainText("P3 패스A");
  await expect(passList).not.toContainText("P3 패스C");
  await memberContext.close();
});

test("관리자: 특정 pass 여러 개 허용 → 지정된 것만 표시, 나머지는 제외 (실브라우저)", async ({ page, browser }) => {
  const cls = await createFutureTestClassAdmin(centerAId, { title: "P3 그룹수업-특정2개", hoursFromNow: 31 });
  createdClassIds.push(cls.id);
  const kstDate = kstDateStr(cls.startTime);

  await gotoManagerClassesDay(page, kstDate);
  await page.locator(".class-row", { hasText: "P3 그룹수업-특정2개" }).click();
  // 기본값 'all'(전체 체크)에서 시작하므로 먼저 전체 해제한 뒤 A/C만 고른다.
  // [B-6: 수강권 목록 접기] 검색 안 하면 미선택 항목이 20개 넘을 때 접히므로(공유
  // 테스트 센터에 그동안 쌓인 pass 상품이 이미 20개를 훌쩍 넘음), 검색으로 좁혀서 클릭한다.
  await page.getByRole("button", { name: "전체 해제" }).click();
  await page.locator('input[placeholder="수강권 이름 검색"]').fill("패스A");
  await page.locator(".filter-chip", { hasText: "P3 패스A" }).click();
  await page.locator('input[placeholder="수강권 이름 검색"]').fill("패스C");
  await page.locator(".filter-chip", { hasText: "P3 패스C" }).click();
  await page.getByRole("button", { name: "수정하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
  const passList = memberPage.locator(".pass-pick-list");
  await expect(passList).toBeVisible({ timeout: 25_000 });
  await expect(passList).toContainText("P3 패스A");
  await expect(passList).toContainText("P3 패스C");
  await expect(passList).not.toContainText("P3 패스B");
  await memberContext.close();
});

test("관리자: 전체 선택(전체 허용으로 전환) → 회원 화면에 보유한 모든 pass 표시, goods는 절대 표시 안 됨 (실브라우저)", async ({ page, browser }) => {
  const cls = await createFutureTestClassAdmin(centerAId, { title: "P3 그룹수업-전체허용", hoursFromNow: 32 });
  createdClassIds.push(cls.id);
  const kstDate = kstDateStr(cls.startTime);

  // 먼저 특정 1개로 지정했다가("전체→특정" 전환 확인) 다시 전체 선택으로 되돌린다
  // ("특정→전체" 전환 확인, [수강권 허용 정책 변경] 이후에는 "전체 선택" 버튼으로만 표현됨).
  // 패스D/E/F는 이 테스트 전용(다른 테스트의 class_allowed_products 지정과 섞이지 않도록
  // 격리) — class_allowed_products 저장은 membership_schedule_rules를 전혀 건드리지 않으므로
  // (아래 회귀 검증 참고) 어떤 pass를 쓰든 동작은 같지만, 테스트 간 독립성을 위해 유지한다.
  await gotoManagerClassesDay(page, kstDate);
  await page.locator(".class-row", { hasText: "P3 그룹수업-전체허용" }).click();
  // 기본값 'all'(전체 체크)에서 시작하므로, 먼저 전체 해제한 뒤 패스D만 고른다.
  // [B-6: 수강권 목록 접기] 검색으로 좁혀서 클릭 — 미선택 항목은 20개 넘으면 접힘.
  await page.getByRole("button", { name: "전체 해제" }).click();
  await page.locator('input[placeholder="수강권 이름 검색"]').fill("패스D");
  await page.locator(".filter-chip", { hasText: "P3 패스D" }).click();
  await page.getByRole("button", { name: "수정하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);

  await page.locator(".class-row", { hasText: "P3 그룹수업-전체허용" }).click();
  const passChipsOn2 = page.locator(".class-allowed-products-list .filter-chip.on");
  await expect(passChipsOn2).toHaveCount(1);
  await page.getByRole("button", { name: "전체 선택(모든 수강권 허용)" }).click();
  // [B-6: 수강권 목록 접기] 전체선택 상태에서 나머지 목록은 접혀서 개별 chip 개수로
  // "전체 체크됨"을 확인할 수 없다(그게 이 접기 기능의 목적) — 대신 UI가 실제로 보여주는
  // "모든 수강권으로 예약 가능해요(전체 선택)" 안내 문구로 같은 상태를 확인한다.
  await expect(page.locator(".perm-guide", { hasText: "모든 수강권으로 예약 가능해요" })).toBeVisible();
  await page.getByRole("button", { name: "수정하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);

  // 회귀 검증(P3 감사 중 실제로 발견한 버그): class_allowed_products 저장(선택이든 전체
  // 선택이든)은 membership_schedule_rules를 절대 건드리면 안 된다 — 이 둘은 완전히 독립된
  // 기능이다(membership_schedule_rules는 /manager/membership-rules에서만 직접 관리). 과거엔
  // 여기서 부수효과로 규칙을 자동 추가/삭제해 "전체 허용으로 바꿔도 이전 규칙이 안 지워져
  // 그 수강권만 계속 안 보이는" 버그를 냈다. 이 테스트가 방금 passD를 선택했다 다시 전체
  // 선택으로 되돌렸으니, passD에는 어떤 schedule_rules 행도 생기지 않았어야 한다.
  const admin = getFixtureAdminClient();
  const { data: leakedRules } = await admin
    .from("membership_schedule_rules")
    .select("id")
    .eq("product_id", passD.id);
  expect(leakedRules ?? []).toHaveLength(0);

  // 저장이 실제로 DB에 반영됐는지(낙관적 로컬 상태가 아니라) 재진입해서 다시 확인한다.
  // ('all' 모드는 UI에서 모든 chip이 체크된 상태로 표현됨 — 0개 체크가 아님. [B-6] 재진입 시
  // 목록은 다시 접힌 상태로 열리므로 위와 동일하게 안내 문구로 확인한다.)
  await page.locator(".class-row", { hasText: "P3 그룹수업-전체허용" }).click();
  await expect(page.locator(".perm-guide", { hasText: "모든 수강권으로 예약 가능해요" })).toBeVisible();
  await page.locator(".sheet-overlay").click({ position: { x: 10, y: 10 } });

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
  const passList = memberPage.locator(".pass-pick-list");
  await expect(passList).toBeVisible({ timeout: 25_000 });
  await expect(passList).toContainText("P3 패스D");
  await expect(passList).toContainText("P3 패스E");
  await expect(passList).toContainText("P3 패스F");
  await expect(passList).not.toContainText("E2E 테스트 대여품"); // goods
  await memberContext.close();
});

test("프라이빗 수업에서도 예약 가능 수강권 선택이 동일하게 동작한다 (실브라우저)", async ({ page, browser }) => {
  const admin = getFixtureAdminClient();
  const start = new Date(Date.now() + 33 * 3600 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const { data: privateCls, error } = await admin
    .from("classes")
    .insert({ center_id: centerAId, title: "P3 프라이빗수업-특정1개", start_time: start.toISOString(), end_time: end.toISOString(), capacity: 1, class_format: "private" })
    .select("id, start_time")
    .single();
  if (error || !privateCls) throw new Error(`프라이빗 테스트 수업 생성 실패: ${error?.message ?? "no data"}`);
  createdClassIds.push(privateCls.id);
  const kstDate = kstDateStr(privateCls.start_time);

  await gotoManagerClassesDay(page, kstDate);
  await page.locator(".class-row", { hasText: "P3 프라이빗수업-특정1개" }).click();
  await expect(page.locator(".filter-chip", { hasText: "프라이빗(1:1)" })).toHaveClass(/on/);
  // 프라이빗 수업에서도 예약 가능 수강권 섹션이 그대로 있고 pass만 나온다(goods 없음).
  await expect(page.locator(".daylist-empty", { hasText: "등록된 수강권이 없어요" })).toHaveCount(0);
  await expect(page.getByText("예약 가능 수강권")).toBeVisible();
  // 기본값 'all'(전체 체크)에서 시작하므로 먼저 전체 해제한 뒤 패스A만 고른다.
  await page.getByRole("button", { name: "전체 해제" }).click();
  await page.locator('input[placeholder="수강권 이름 검색"]').fill("패스A");
  await page.locator(".filter-chip", { hasText: "P3 패스A" }).click();
  await page.getByRole("button", { name: "수정하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(privateCls.id, privateCls.start_time));
  const passList = memberPage.locator(".pass-pick-list");
  await expect(passList).toBeVisible({ timeout: 25_000 });
  await expect(passList).toContainText("P3 패스A");
  // 실제 예약도 정상 성립하는지(프라이빗 정원/동시예약 정책과 충돌 없는지)까지 확인.
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    memberPage.locator(".class-row", { hasText: "P3 프라이빗수업-특정1개" }).getByRole("button", { name: "취소" })
  ).toBeVisible();
  await memberContext.close();
});

test("타 센터 pass는 관리자 선택 목록/검색 결과에 절대 섞이지 않는다 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassAdmin(centerAId, { title: "P3 그룹수업-타센터검증", hoursFromNow: 34 });
  createdClassIds.push(cls.id);
  const kstDate = kstDateStr(cls.startTime);

  await gotoManagerClassesDay(page, kstDate);
  await page.locator(".class-row", { hasText: "P3 그룹수업-타센터검증" }).click();
  // [B-6: 수강권 목록 접기] 새/미지정 수업은 기본값 'all'로 열려 검색 안 하면 목록이
  // 접혀 있다 — 검색으로 좁혀서 "P3 패스A"가 실제로 존재/노출되는지 확인한다.
  await page.locator('input[placeholder="수강권 이름 검색"]').fill("패스A");
  await expect(page.locator(".filter-chip", { hasText: "P3 패스A" })).toBeVisible();
  await page.locator('input[placeholder="수강권 이름 검색"]').fill("타센터");
  await expect(page.locator(".filter-chip", { hasText: "P3 타센터전용패스" })).toHaveCount(0);
  await expect(page.locator(".daylist-empty", { hasText: "일치하는 수강권이 없어요" })).toBeVisible();
});
