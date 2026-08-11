import { test, expect, type Page } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  kstDateStr,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import { getFixtureAdminClient } from "../../integration/setup";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  담당 강사 표시 UI 수동 QA 발견사항 회귀 테스트(2026-08-12).

  발견된 문제: 회원 예약 화면에서 담당 강사 이름이 센터명과 별도 줄(.class-row-instructors)
  로, 그것도 그 클래스에 전용 스타일이 없어(globals.css에 .class-row-instructors 규칙
  자체가 없었음) 기본 텍스트 크기로 나와 부자연스럽게 강조돼 보였다. 관리자 수업 목록에는
  담당 강사가 아예 표시되지 않았다(ManagedClass에 instructorNames 필드 자체가 없었음).

  수정 범위는 순수 표시(UI)로 한정 — class_trainers/class_trainer_names RPC/RLS는 전혀
  건드리지 않았고, 회원 화면의 조회 로직(lib/reservations.ts)도 그대로 재사용한다.
  관리자 목록(lib/classes.ts fetchClasses())에만 같은 class_trainer_names RPC를 새로
  연결했다. "강사 1명/외 N명" 포맷 문구·임계값 자체는 lib/instructorDisplay.ts로 추출만
  했을 뿐 기존 로직 그대로다(단위 테스트: tests/unit/instructorDisplay.test.ts).

  [강사 지정 방법 — 실제 관리자 UI 사용, admin(service_role) 직접 insert 아님]
  class_trainers는 "매니저 강사 생성" RLS로 보호돼 있고(그 센터 active 스태프만 대상으로
  허용) service_role에는 애초에 이 테이블 GRANT가 없다(실측: "permission denied for
  table class_trainers" — class_allowed_products와 같은 계열의 기존 gap, 이번 QA 수정
  범위 밖이라 그대로 둠). 그래서 이 파일은 실제 관리자 브라우저 세션으로 "담당 강사"
  칩을 직접 클릭해 지정한다(assignTrainerViaUi) — RLS를 우회하지 않고, 이미 정상 동작
  중인 실제 등록 경로를 그대로 사용.

  "강사 복수" 표시 포맷(외 N명)은 서로 다른 활성 스태프 계정이 2명 더 필요한데, 이 순수
  표시 문제 수정 범위에서 새 스태프 계정을 만드는 건 과하다고 판단해 그 케이스는
  tests/unit/instructorDisplay.test.ts에서 순수 함수로 결정적으로 검증한다. 여기서는
  실제 DB 라운드트립이 안전한 "강사 1명"/"강사 없음" 두 상태만 다룬다.
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let centerAId: string;
let managerAName: string;
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

// 실제 관리자 UI(수업 수정 시트의 "담당 강사" 섹션)로 강사 1명을 지정하고 저장한다.
async function assignTrainerViaUi(page: Page, kstDate: string, classTitle: string, trainerName: string): Promise<void> {
  await gotoManagerClassesDay(page, kstDate);
  await page.locator(".class-row", { hasText: classTitle }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 수정" })).toBeVisible();
  const trainerSearch = page.locator('input[placeholder="강사 이름 검색"]');
  if (await trainerSearch.count() > 0) await trainerSearch.fill(trainerName);
  await page.locator(".class-trainers-list .filter-chip", { hasText: trainerName }).click();
  await page.getByRole("button", { name: "수정하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
}

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  const admin = getFixtureAdminClient();
  const { data, error } = await admin.from("accounts").select("name").eq("id", managerA.accountId).maybeSingle();
  if (error || !data) throw new Error(`계정 이름 조회 실패: ${error?.message ?? "no data"}`);
  managerAName = (data as any).name;
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
});

test.describe("D, F: 관리자 수업 목록의 담당 강사 표시", () => {
  test("D: 강사 1명 — '시간 · 강사명 · 예약 인원' 형태로 표시된다", async ({ page }) => {
    const title = `강사표시-관리자-단일-${Date.now()}`;
    const cls = await createFutureTestClassAdmin(centerAId, { title, hoursFromNow: 200 });
    createdClassIds.push(cls.id);
    const kstDate = kstDateStr(cls.startTime);
    await assignTrainerViaUi(page, kstDate, title, managerAName);

    const meta = page.locator(".class-row", { hasText: title }).locator(".class-row-meta");
    await expect(meta).toContainText(`· ${managerAName} · 예약`);
    // 삭제 버튼/카드 클릭 동작이 그대로인지도 가볍게 확인(범위: 레이아웃만 바뀌었는지)
    await expect(page.locator(".class-row", { hasText: title }).getByRole("button", { name: "삭제" })).toBeVisible();
  });

  test("F: 강사 없음 — 기존과 동일하게 '시간 · 예약 인원' 형태를 유지하고 불필요한 구분자가 없다", async ({ page }) => {
    const title = `강사표시-관리자-없음-${Date.now()}`;
    const cls = await createFutureTestClassAdmin(centerAId, { title, hoursFromNow: 202 });
    createdClassIds.push(cls.id);
    // 강사 지정 없음(기본 상태)

    const kstDate = kstDateStr(cls.startTime);
    await gotoManagerClassesDay(page, kstDate);
    const meta = page.locator(".class-row", { hasText: title }).locator(".class-row-meta");
    const text = (await meta.innerText()).replace(/\s+/g, " ").trim();
    expect(text).toMatch(/^\d{2}:\d{2}~\d{2}:\d{2} · 예약 \d+\/\d+/);
    // 강사가 없으면 시간과 "예약" 사이에 구분자가 정확히 하나만 있어야 한다(강사 자리에
    // 빈 " · "가 추가로 끼어들면 " ·  · 예약"처럼 구분자가 중복된다).
    expect((text.match(/·/g) ?? []).length).toBe(1);
  });
});

// 이 describe의 테스트는 관리자 세션(page, 파일 상단 test.use)으로 UI를 통해 강사를 먼저
// 지정한 뒤, class-allowed-products.spec.ts와 동일한 관례대로 browser.newContext()로 별도
// 회원 세션을 새로 열어 회원 화면 표시를 확인한다.
test.describe("A, C: 회원 예약 화면의 담당 강사 표시", () => {
  test("A: 강사 1명 — 센터명과 같은 줄에 '센터명 · 강사명' 형태로, 별도 줄이 아니다", async ({ page, browser }) => {
    const title = `강사표시-회원-단일-${Date.now()}`;
    const cls = await createFutureTestClassAdmin(centerAId, { title, hoursFromNow: 204 });
    createdClassIds.push(cls.id);
    const kstDate = kstDateStr(cls.startTime);
    await assignTrainerViaUi(page, kstDate, title, managerAName);

    const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
    const memberPage = await memberContext.newPage();
    await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
    const row = memberPage.locator(".class-row", { hasText: title });
    const place = row.locator(".class-row-place");
    await expect(place).toContainText(`· ${managerAName}`);
    // 담당 강사가 별도 줄(.class-row-instructors)로 더 이상 렌더링되지 않는지 확인.
    await expect(row.locator(".class-row-instructors")).toHaveCount(0);
    await memberContext.close();
  });

  test("예약 확인 상세에는 목록과 달리 담당 강사 명단이 줄임 없이 보인다(2026-08-12 피드백)", async ({ page, browser }) => {
    const title = `강사표시-회원-상세-${Date.now()}`;
    const cls = await createFutureTestClassAdmin(centerAId, { title, hoursFromNow: 207 });
    createdClassIds.push(cls.id);
    const kstDate = kstDateStr(cls.startTime);
    await assignTrainerViaUi(page, kstDate, title, managerAName);

    const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
    const memberPage = await memberContext.newPage();
    await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
    await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });
    await expect(memberPage.locator(".confirm-class-sub", { hasText: "담당 강사" })).toContainText(managerAName);
    await memberContext.close();
  });

  test("C: 강사 없음 — 센터명만 표시되고 불필요한 구분자가 없다", async ({ browser }) => {
    const title = `강사표시-회원-없음-${Date.now()}`;
    const cls = await createFutureTestClassAdmin(centerAId, { title, hoursFromNow: 206 });
    createdClassIds.push(cls.id);
    // 강사 지정 없음(기본 상태)

    const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
    const memberPage = await memberContext.newPage();
    await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
    const row = memberPage.locator(".class-row", { hasText: title });
    const place = row.locator(".class-row-place");
    const text = (await place.innerText()).trim();
    expect(text).not.toContain("·");
    await memberContext.close();
  });
});
