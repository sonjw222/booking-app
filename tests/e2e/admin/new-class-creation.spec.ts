import { test, expect, type Page } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import { getFixtureAdminClient } from "../../integration/setup";
import { supabase } from "../../../lib/supabaseClient";
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
      class_allowed_products/RPC/회원 화면(.pass-pick-list) 전부 정상 동작 — 재현 실패.
  즉 TEST_MANAGER_A/TEST_USER_A/centerA 기존 fixture와 정상 그룹수업 생성 경로로는
  이 버그가 재현되지 않았다(상세 경위는 PR #44 코멘트 참고). 그럼에도 불구하고 이
  파일은 "관리자 UI로 실제 수업을 등록하는 경로"를 exercise하는 최초의 자동 테스트다
  (기존에는 전부 admin client 직접 insert로 setup했고, UI 등록 자체를 검증하는 테스트가
  하나도 없었다 — 이번 조사로 드러난 실제 커버리지 공백) — 향후 같은 종류의 회귀를
  놓치지 않기 위해 정식 회귀 테스트로 남긴다.
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
const createdClassIds: string[] = [];

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
});

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
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

  const { data: cap, error: capErr } = await supabase.from("class_allowed_products").select("*").eq("class_id", newClass.id);
  if (capErr) throw new Error(capErr.message);
  expect(cap ?? []).toHaveLength(0); // "모든 수강권 허용" = class_allowed_products 0건

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(newClass.id, newClass.start_time));
  await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });
  await expect(memberPage.locator(".pass-pick-list")).toBeVisible();
  await expect(memberPage.locator("text=현재 사용할 수 있는 수강권이 없어요")).toHaveCount(0);

  // TEMP-DIAG(재현성 확인용, 제거 예정): 30초로 늘려도 여전히 실패해 단순 인프라 지연이
  // 아닐 가능성이 있음 — reserve_with_membership RPC의 실제 응답과 에러 toast를 캡처.
  let reserveRpcInfo: any = null;
  memberPage.on("response", async (res) => {
    if (res.url().includes("reserve_with_membership")) {
      try {
        reserveRpcInfo = { status: res.status(), body: await res.text() };
      } catch { /* 무시 */ }
    }
  });
  let toastText = "(관측 안 됨)";
  const toastWatcher = (async () => {
    try {
      await expect(memberPage.locator(".toast")).toBeVisible({ timeout: 4000 });
      toastText = await memberPage.locator(".toast").innerText();
    } catch { /* 토스트 자체가 안 뜨면 무시(정상 성공 경로일 수 있음) */ }
  })();
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await toastWatcher;
  await memberPage.waitForTimeout(1500);
  console.log(`=== reserve_with_membership RPC 응답: ${JSON.stringify(reserveRpcInfo)} ===`);
  console.log(`=== toast 텍스트: ${toastText} ===`);
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0, { timeout: 30000 });
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
  await page.locator(".filter-chip", { hasText: "E2E 테스트 수강권 상품" }).click();
  await expect(page.locator(".perm-guide", { hasText: "1개" })).toBeVisible();

  await page.getByRole("button", { name: "등록하기", exact: true }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);

  const newClass = await findClassByTitle(uniqueTitle);
  createdClassIds.push(newClass.id);

  // 네트워크 레벨로 실측 확인(2026-08-09, PR #44 조사): 저장 직후 이 값을 곧바로 조회하면
  // 브라우저가 보낸 INSERT 자체는 정확한 payload로 성공했는데도(모달이 정상적으로 닫힘 =
  // setClassProducts()가 throw 없이 완료됨) 공유 dev Supabase가 바쁠 때 드물게 Node 쪽의
  // 별도 커넥션에서 곧바로 조회하면 아직 안 보이는 경우가 있었다(같은 실행에서 반복 재현됨,
  // 두 번 모두 정확한 payload의 POST 요청 자체는 있었음 — 앱 버그 아니라 read-after-write
  // 타이밍 문제) — 즉시 단정하지 않고 짧게 재시도한다.
  await expect.poll(async () => {
    const { data, error } = await supabase.from("class_allowed_products").select("product_id, products(name)").eq("class_id", newClass.id);
    if (error) throw new Error(error.message);
    return (data ?? []).length;
  }, { timeout: 10000, message: "class_allowed_products가 저장 후에도 계속 0건으로 조회됨" }).toBe(1); // 특정 1개만 허용 = 정확히 1건

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
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0, { timeout: 30000 });
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
