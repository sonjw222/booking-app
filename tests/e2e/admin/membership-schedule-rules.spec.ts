import { test, expect, type Page } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  getOrCreateTestPassProductNamed,
  createTestMembershipForProduct,
  clearScheduleRulesForProduct,
  setScheduleRuleForProduct,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import { getFixtureAdminClient } from "../../integration/setup";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  P1-15: membership_schedule_rules(수강권 자체의 요일/시간/수업명 예약조건)와 신규 수업
  생성 화면의 "모든 수강권 허용"/"특정 수강권 지정" 사이의 상호작용 회귀 테스트.

  배경(실제 수동 QA로 100% 재현, 2026-08-10): 관리자가 새 수업을 "모든 수강권 허용"으로
  만들어도, 회원이 가진 pass 상품 자체에 membership_schedule_rules가 걸려 있고 그 조건이
  새 수업의 요일/시간/제목과 안 맞으면 그 pass는 예약에 쓸 수 없다 — "모든 수강권 허용"은
  class_allowed_products(어떤 *상품*을 쓸 수 있는지) 제한만 해제할 뿐, membership_schedule_rules
  (그 상품을 *어느 수업*에 쓸 수 있는지)는 완전히 별개의 조건으로 계속 적용된다
  (usable_memberships_for_classes RPC, fix_usable_memberships_product_kind.sql). RPC 로직
  자체는 설계대로 정확히 동작하는 것이라 바꾸지 않았고, 대신 관리자가 이 상호작용을 미리
  알 수 있도록 수업 등록/수정 화면에 경고를 추가했다(app/manager/classes/page.tsx,
  lib/passes.ts의 findScheduleExcludedProducts — 순수 함수 단위 테스트는
  tests/unit/passes.scheduleRuleWarning.test.ts 참고).

  TEST A(규칙 없는 pass + 모든 수강권 허용 → 사용 가능)는 이미 new-class-creation.spec.ts의
  TEST1이 커버하고 있어(그 스펙의 pass 상품엔 schedule_rules가 없음) 여기서 중복 생성하지
  않는다.

  [P1 신규 정책, 2026-08-11 추가] 관리자가 수업에서 "특정 수강권"을 직접 지정하면, 그
  product에 한해 membership_schedule_rules를 무시하고 사용할 수 있다(fix_membership_
  schedule_rule_override_draft_proposed.sql). 이 override의 RPC/DB 레벨 매트릭스(A~J)는
  tests/integration/schedule-rule-override.test.ts가 훨씬 격리된 환경에서 엄밀히 검증한다 —
  이 E2E 파일은 실제 관리자 등록 → 실제 회원 예약이라는 end-to-end 경로와, 관리자 UI가 두
  모드("모든 수강권 허용" vs "특정 수강권 지정")의 차이를 실제로 명확히 안내하는지(K)만
  검증한다. 아래 "D+F(override)" 테스트는 원래 옛 정책(AND 조건, 특정 지정해도
  schedule_rules 불일치면 차단)을 검증했으나, 새 정책에서는 정확히 반대(특정 지정 시
  override로 사용 가능)가 기대 동작이라 이번에 맞춰 갱신했다 — "모든 수강권 허용 +
  mismatch → 여전히 차단" 자체(옛 C의 진짜 취지)는 schedule-rule-override.test.ts의 통합
  테스트 C가 격리된 환경에서 이미 엄밀히 검증하므로 이 파일에서 다시 만들지 않는다(다른
  무제한 테스트 pass들이 실제 계정에 많아 "모든 수강권 허용" 모드에서 순수 격리가 어려움 —
  아래 헬퍼 주석 참고).
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let restrictedPass: { id: string; name: string };
const RESTRICTED_PASS_NAME = "P1-15 스케줄제한 테스트 수강권";
const createdClassIds: string[] = [];

async function gotoManagerClassesDay(page: Page, kstDate: string): Promise<void> {
  const [y, m, d] = kstDate.split("-").map(Number);
  await page.goto("/manager/classes");
  await expect(page.locator(".cal-title")).toBeVisible();
  for (let i = 0; i < 14; i++) {
    const title = (await page.locator(".cal-title").innerText()).trim();
    const [ty, tm] = title.split(".").map(Number);
    if (ty === y && tm === m) break;
    await page.locator(".cal-nav-btn").nth(1).click();
  }
  await page.locator(".cal-cell", { hasText: new RegExp(`^${d}$`) }).click();
}

function kstDateStrFromIso(iso: string): string {
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, "0")}-${String(kst.getUTCDate()).padStart(2, "0")}`;
}
// ⚠ [사고 기록 2] 초까지 맞춰도(위 kstTimeStrFromIso 주석 참고) 여전히 안 맞았다 —
// createFutureTestClassAdmin()의 start_time은 Date.now() 기반이라 밀리초도 0이 아닌데,
// membership_schedule_rules.start_time(time 컬럼)은 기본 정밀도가 마이크로초까지라 "정확히
// 같은 초"를 넣어도 소수점 이하 밀리초가 달라 여전히 안 맞았다(CI에서 재현 확인, retry도
// 동일하게 실패해 결정적임을 재확인). class의 start_time 자체를 깨끗한 분 단위로 UPDATE해
// 규칙이 비교할 값 자체를 밀리초 없는 값으로 만든다 — 이러면 규칙 쪽 정밀도와 무관하게
// 항상 정확히 일치한다.
async function normalizeClassStartTimeToCleanMinute(classId: string, startTimeIso: string): Promise<string> {
  const d = new Date(startTimeIso);
  d.setUTCSeconds(0, 0);
  const cleanIso = d.toISOString();
  const admin = getFixtureAdminClient();
  const { error } = await admin.from("classes").update({ start_time: cleanIso }).eq("id", classId);
  if (error) throw new Error(`class start_time 정규화 실패: ${error.message}`);
  return cleanIso;
}

function kstDowFromIso(iso: string): number {
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.getUTCDay();
}
// ⚠ [사고 기록] createFutureTestClassAdmin()의 start_time은 Date.now() + hoursFromNow에서
// 그대로 나온 값이라 초 단위가 0이 아니다(테스트 실행 시각의 잔여 초를 그대로 물려받음).
// RPC가 실제로 비교하는 (start_time at time zone 'Asia/Seoul')::time은 그 초까지 그대로
// 포함하므로, 여기서 "HH:MM"만 만들어 membership_schedule_rules.start_time에 넣으면
// Postgres가 초를 :00으로 채워 넣어 실제 class의 초와 어긋나 규칙이 절대 매치되지 않았다
// (CI에서 3개 테스트 전부 결정적으로 실패해 실측 확인 — 실제 앱 코드의 AmPmTimeInput은
// 항상 :00초라 이 문제가 없음, 순수히 이 테스트 fixture의 문제). 초까지 정확히 맞춘다.
function kstTimeStrFromIso(iso: string): string {
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}:${String(kst.getUTCSeconds()).padStart(2, "0")}`;
}

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  restrictedPass = await getOrCreateTestPassProductNamed(centerAId, RESTRICTED_PASS_NAME);
  await clearScheduleRulesForProduct(restrictedPass.id);
  await createTestMembershipForProduct(centerAId, userA.profileId, restrictedPass, { remainingCount: 10 });
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await clearScheduleRulesForProduct(restrictedPass.id);
});

// B: 규칙과 수업(요일/시간/제목)이 정확히 일치 → 기존 pass가 사용 가능하고 예약 성공.
test("B: schedule rule과 일치하는 수업에서는 그 조건의 pass가 사용 가능하다 (모든 수강권 허용, 실브라우저)", async ({ page, browser }) => {
  const uniqueTitle = `P1-15-MATCH-${Date.now()}`;
  const cls = await createFutureTestClassAdmin(centerAId, { title: uniqueTitle, hoursFromNow: 150 });
  createdClassIds.push(cls.id);
  const cleanStart = await normalizeClassStartTimeToCleanMinute(cls.id, cls.startTime);
  const dow = kstDowFromIso(cleanStart);
  const timeStr = kstTimeStrFromIso(cleanStart);

  await clearScheduleRulesForProduct(restrictedPass.id);
  await setScheduleRuleForProduct(restrictedPass.id, { dayOfWeek: dow, startTime: timeStr, classTitle: uniqueTitle });

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(cls.id, cleanStart));
  await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });
  const passList = memberPage.locator(".pass-pick-list");
  await expect(passList).toBeVisible({ timeout: 15000 });
  await expect(passList).toContainText(RESTRICTED_PASS_NAME);

  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0, { timeout: 20000 });
  await memberContext.close();
});

// class_allowed_products는 service_role SQL GRANT가 없어(이미 문서화된 별도 gap,
// class-allowed-products.spec.ts와 동일 계열) admin client로 직접 insert할 수 없다
// (CI에서 실제 재현됨: "permission denied for table class_allowed_products"). 이 파일의
// C+D+F/E 테스트는 class-allowed-products.spec.ts와 동일하게 관리자 실제 세션(RLS 통과)의
// UI로 "특정 pass 지정"을 설정한다 — 이건 F(class_allowed_products+schedule_rules AND 조건)
// 검증에도 필요하고, 동시에 userA가 이미 보유한 수많은(제한 없는) 다른 테스트 pass들이
// "모든 수강권 허용" 수업에서 항상 usable로 섞여 "사용 가능한 수강권 없음" 자체를 검증할
// 수 없게 만드는 문제도 함께 해결한다(class_allowed_products로 이 pass 하나로만 좁혀야
// 다른 pass들이 전부 제외되어 이 케이스를 깨끗하게 isolate할 수 있음).
async function restrictClassToRestrictedPassViaUi(page: Page, uniqueTitle: string): Promise<void> {
  await page.locator(".class-row", { hasText: uniqueTitle }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 수정" })).toBeVisible();
  // [수강권 허용 정책 변경] 기본값 'all'(전체 체크)에서 시작하므로 먼저 전체 해제한 뒤
  // 목표 pass 하나만 고른다 — 그러지 않으면 이미 체크된 chip을 클릭해 꺼버리게 된다.
  await page.getByRole("button", { name: "전체 해제" }).click();
  await page.locator('input[placeholder="수강권 이름 검색"]').fill(RESTRICTED_PASS_NAME);
  const chip = page.locator(".filter-chip", { hasText: RESTRICTED_PASS_NAME });
  await expect(chip).toHaveCount(1);
  await chip.click();
  await expect(chip).toHaveClass(/on/);
}

// D + F(override) + K: 규칙과 안 맞는 수업이라도 class_allowed_products로 이 pass를
// 명시적으로 지정하면(F가 다른 product로 새지 않는지는 통합 테스트가 검증) 이제
// override로 사용 가능(D/E) + 관리자 UI가 "모든 수강권 허용"일 때의 경고(danger)와
// "특정 수강권 지정"일 때의 override 안내(info)를 서로 다르게 보여줌(K).
test("D+F(override)+K: 특정 수강권 직접 지정 시 schedule rule 불일치해도 사용 가능 + 관리자 UI 안내가 모드별로 다름 (실브라우저)", async ({ page, browser }) => {
  const matchTitle = `P1-15 수업 ${Date.now()}`; // 규칙이 가리키는 "진짜" 수업명(다른 것)
  const uniqueTitle = `P1-15-OVERRIDE-${Date.now()}`; // 실제로 만들 수업명(다름 → 불일치)
  const cls = await createFutureTestClassAdmin(centerAId, { title: uniqueTitle, hoursFromNow: 151 });
  createdClassIds.push(cls.id);
  const dow = kstDowFromIso(cls.startTime);
  const timeStr = kstTimeStrFromIso(cls.startTime);
  const mismatchedDow = (dow + 1) % 7; // 요일 자체를 다르게 만들어 확실히 불일치시킴

  await clearScheduleRulesForProduct(restrictedPass.id);
  await setScheduleRuleForProduct(restrictedPass.id, { dayOfWeek: mismatchedDow, startTime: timeStr, classTitle: matchTitle });

  const kstDate = kstDateStrFromIso(cls.startTime);
  await gotoManagerClassesDay(page, kstDate);

  // K(1단계): 아직 "특정 지정"을 안 한 상태(=모든 수강권 허용)에서는 danger 경고가 보여야
  // 한다 — schedule rule이 그대로 적용되는 모드이므로.
  await page.locator(".class-row", { hasText: uniqueTitle }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 수정" })).toBeVisible();
  await expect(page.locator(".schedule-rule-warning")).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".schedule-rule-override-note")).toHaveCount(0);
  await page.locator(".sheet-overlay").click({ position: { x: 10, y: 10 } });

  // F: "특정 pass 지정"으로 이 pass를 명시적으로 지정한다.
  await restrictClassToRestrictedPassViaUi(page, uniqueTitle);

  // K(2단계): "특정 지정" 후에는 danger 경고 대신 override 안내(info)로 바뀌어야 한다 —
  // 관리자가 두 모드의 차이를 헷갈리지 않도록.
  await expect(page.locator(".schedule-rule-warning")).toHaveCount(0);
  const overrideNote = page.locator(".schedule-rule-override-note");
  await expect(overrideNote).toBeVisible({ timeout: 10000 });
  await expect(overrideNote).toContainText(RESTRICTED_PASS_NAME);

  await page.getByRole("button", { name: "수정하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);

  // K(재확인): 재진입해도 override 안내가 그대로 보인다(danger 경고 아님).
  await page.locator(".class-row", { hasText: uniqueTitle }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 수정" })).toBeVisible();
  await expect(page.locator(".schedule-rule-override-note")).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".schedule-rule-warning")).toHaveCount(0);
  await page.locator(".sheet-overlay").click({ position: { x: 10, y: 10 } });

  // D: 회원 화면에서는 이 pass가 이제 사용 가능하다(schedule rule 불일치와 무관, override).
  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
  await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });
  const passList = memberPage.locator(".pass-pick-list");
  await expect(passList).toBeVisible({ timeout: 15000 });
  await expect(passList).toContainText(RESTRICTED_PASS_NAME);
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0, { timeout: 20000 });
  await memberContext.close();
});

// J: 이 mismatch 상황에서 방금 새로 발급된(구매와 동일한 경로로 생성된) membership도
// class_allowed_products로 명시 지정된 상품이면 기존 pass와 동일하게 override를 받는다 —
// "새로 산 pass라서 예외"는 없다는 것을 확인(새 정책에서는 사용 가능이 기대 동작).
// class_allowed_products로 이 pass 하나만 허용해 다른(제한 없는) 보유 pass들이 "usable"에
// 섞여 이 검증을 무의미하게 만들지 않도록 isolate한다.
test("J: 방금 새로 발급된 membership도 같은 상품이 직접 지정돼 있으면 동일한 override를 받는다 (실브라우저)", async ({ page, browser }) => {
  const matchTitle = `P1-15 수업 ${Date.now()}`;
  const uniqueTitle = `P1-15-NEWMEM-${Date.now()}`;
  const cls = await createFutureTestClassAdmin(centerAId, { title: uniqueTitle, hoursFromNow: 152 });
  createdClassIds.push(cls.id);
  const dow = kstDowFromIso(cls.startTime);
  const timeStr = kstTimeStrFromIso(cls.startTime);
  const mismatchedDow = (dow + 1) % 7;

  await clearScheduleRulesForProduct(restrictedPass.id);
  await setScheduleRuleForProduct(restrictedPass.id, { dayOfWeek: mismatchedDow, startTime: timeStr, classTitle: matchTitle });

  const kstDate = kstDateStrFromIso(cls.startTime);
  await gotoManagerClassesDay(page, kstDate);
  await restrictClassToRestrictedPassViaUi(page, uniqueTitle);
  await page.getByRole("button", { name: "수정하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);

  // "방금 구매"를 흉내내기 위해 이 프로필의 기존 membership을 지우고 새로 하나 발급한다
  // (실제 checkout/confirmPayment 경로와 동일하게 memberships 행이 새로 생기는 것만
  // 재현하면 충분 — 이 테스트의 초점은 결제 플로우가 아니라 신규 membership도 같은
  // product_id면 같은 override를 받는지이며, 그 결제 플로우 자체는 new-class-creation.spec.ts의
  // TEST4가 이미 전체 검증함). 이전 테스트(D+F+K)가 이 membership으로 예약을 만들었을 수
  // 있어, membership을 지우기 전에 그 예약부터 먼저 지워야 FK 위반이 나지 않는다.
  const admin = getFixtureAdminClient();
  const { data: oldMems } = await admin
    .from("memberships").select("id")
    .eq("profile_id", userA.profileId).eq("product_id", restrictedPass.id);
  const oldMemIds = (oldMems ?? []).map((m: any) => m.id as string);
  if (oldMemIds.length > 0) {
    await admin.from("reservations").delete().in("membership_id", oldMemIds);
    await admin.from("memberships").delete().in("id", oldMemIds);
  }
  const { error: newMemErr } = await admin.from("memberships").insert({
    profile_id: userA.profileId, center_id: centerAId, product_id: restrictedPass.id,
    product_name: restrictedPass.name, pass_type: "count", total_count: 5, remaining_count: 5,
    expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10), status: "active",
  });
  if (newMemErr) throw new Error(`신규 membership 생성 실패: ${newMemErr.message}`);

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
  await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });
  const passList = memberPage.locator(".pass-pick-list");
  await expect(passList).toBeVisible({ timeout: 15000 });
  await expect(passList).toContainText(RESTRICTED_PASS_NAME);
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0, { timeout: 20000 });
  await memberContext.close();

  // 원상복구: 이후 다른 테스트/재실행에 영향 없도록 정상(제한 없는) membership으로 되돌림
  await createTestMembershipForProduct(centerAId, userA.profileId, restrictedPass, { remainingCount: 10 });
});
