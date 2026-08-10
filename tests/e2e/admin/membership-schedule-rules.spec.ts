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
function kstDowFromIso(iso: string): number {
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.getUTCDay();
}
function kstTimeStrFromIso(iso: string): string {
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`;
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
  const dow = kstDowFromIso(cls.startTime);
  const timeStr = kstTimeStrFromIso(cls.startTime);

  await clearScheduleRulesForProduct(restrictedPass.id);
  await setScheduleRuleForProduct(restrictedPass.id, { dayOfWeek: dow, startTime: timeStr, classTitle: uniqueTitle });

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

// C + D + F: 규칙과 안 맞는 수업 + class_allowed_products로 이 pass를 명시적으로 허용해도
// (F: AND 조건) 여전히 사용 불가(C) + 관리자 UI가 재진입 시 경고를 보여줌(D).
test("C+D+F: schedule rule과 안 맞으면 class_allowed_products로 허용해도 사용 불가 + 관리자 경고 표시 (실브라우저)", async ({ page, browser }) => {
  const matchTitle = `P1-15 수업 ${Date.now()}`; // 규칙이 가리키는 "진짜" 수업명(다른 것)
  const uniqueTitle = `P1-15-MISMATCH-${Date.now()}`; // 실제로 만들 수업명(다름 → 불일치)
  const cls = await createFutureTestClassAdmin(centerAId, { title: uniqueTitle, hoursFromNow: 151 });
  createdClassIds.push(cls.id);
  const dow = kstDowFromIso(cls.startTime);
  const timeStr = kstTimeStrFromIso(cls.startTime);
  const mismatchedDow = (dow + 1) % 7; // 요일 자체를 다르게 만들어 확실히 불일치시킴

  await clearScheduleRulesForProduct(restrictedPass.id);
  await setScheduleRuleForProduct(restrictedPass.id, { dayOfWeek: mismatchedDow, startTime: timeStr, classTitle: matchTitle });

  // F: class_allowed_products로 이 pass를 명시적으로 "허용"해둔다(상품 제한은 통과하지만
  // schedule_rules는 여전히 막아야 함 — AND 조건 검증).
  const admin = getFixtureAdminClient();
  const { error: capErr } = await admin.from("class_allowed_products").insert({ class_id: cls.id, product_id: restrictedPass.id });
  if (capErr) throw new Error(`class_allowed_products 설정 실패: ${capErr.message}`);

  // D: 관리자가 이 수업을 재진입하면 경고가 보여야 한다.
  const kstDate = kstDateStrFromIso(cls.startTime);
  await gotoManagerClassesDay(page, kstDate);
  await page.locator(".class-row", { hasText: uniqueTitle }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 수정" })).toBeVisible();
  const warning = page.locator(".schedule-rule-warning");
  await expect(warning).toBeVisible({ timeout: 10000 });
  await expect(warning).toContainText(RESTRICTED_PASS_NAME);
  await page.locator(".sheet-overlay").click({ position: { x: 10, y: 10 } });

  // C: 회원 화면에서는 이 pass가 사용 불가로 뜬다(class_allowed_products가 허용해도).
  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
  await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });
  await expect(memberPage.locator("text=현재 사용할 수 있는 수강권이 없어요")).toBeVisible();
  await expect(memberPage.locator(".pass-pick-list")).toHaveCount(0);
  await memberContext.close();
});

// E: 이 mismatch 상황에서 방금 새로 발급된(구매와 동일한 경로로 생성된) membership도
// 기존 pass와 동일하게 schedule rule 제한을 그대로 적용받는다 — "새로 산 pass라서 예외"는
// 없다는 것을 확인.
test("E: 방금 새로 발급된 membership도 같은 상품이면 동일한 schedule rule 제한을 받는다 (실브라우저)", async ({ page, browser }) => {
  const matchTitle = `P1-15 수업 ${Date.now()}`;
  const uniqueTitle = `P1-15-NEWMEM-${Date.now()}`;
  const cls = await createFutureTestClassAdmin(centerAId, { title: uniqueTitle, hoursFromNow: 152 });
  createdClassIds.push(cls.id);
  const dow = kstDowFromIso(cls.startTime);
  const timeStr = kstTimeStrFromIso(cls.startTime);
  const mismatchedDow = (dow + 1) % 7;

  await clearScheduleRulesForProduct(restrictedPass.id);
  await setScheduleRuleForProduct(restrictedPass.id, { dayOfWeek: mismatchedDow, startTime: timeStr, classTitle: matchTitle });

  // "방금 구매"를 흉내내기 위해 이 프로필의 기존 membership을 지우고 새로 하나 발급한다
  // (실제 checkout/confirmPayment 경로와 동일하게 memberships 행이 새로 생기는 것만
  // 재현하면 충분 — 이 테스트의 초점은 결제 플로우가 아니라 신규 membership도 같은
  // product_id면 같은 규칙을 받는지이며, 그 결제 플로우 자체는 new-class-creation.spec.ts의
  // TEST4가 이미 전체 검증함).
  const admin = getFixtureAdminClient();
  await admin.from("memberships").delete().eq("profile_id", userA.profileId).eq("product_id", restrictedPass.id);
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
  await expect(memberPage.locator("text=현재 사용할 수 있는 수강권이 없어요")).toBeVisible();
  await memberContext.close();

  // 원상복구: 이후 다른 테스트/재실행에 영향 없도록 정상 membership으로 되돌림
  await createTestMembershipForProduct(centerAId, userA.profileId, restrictedPass, { remainingCount: 10 });
});
