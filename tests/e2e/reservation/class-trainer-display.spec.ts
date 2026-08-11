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
  연결했다.
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let userB: TestUser;
let centerAId: string;
let managerAName: string;
let userAName: string;
let userBName: string;
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

async function setTrainers(classId: string, accountIds: string[]): Promise<void> {
  const admin = getFixtureAdminClient();
  const { error } = await admin.from("class_trainers").insert(accountIds.map((account_id) => ({ class_id: classId, account_id })));
  if (error) throw new Error(`강사 지정(fixture) 실패: ${error.message}`);
}

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  userB = loadTestAccountMeta("user-b");
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  const admin = getFixtureAdminClient();
  const { data: names, error } = await admin
    .from("accounts").select("id, name").in("id", [managerA.accountId, userA.accountId, userB.accountId]);
  if (error || !names) throw new Error(`계정 이름 조회 실패: ${error?.message ?? "no data"}`);
  const byId = Object.fromEntries(names.map((n: any) => [n.id, n.name]));
  managerAName = byId[managerA.accountId];
  userAName = byId[userA.accountId];
  userBName = byId[userB.accountId];
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
});

test.describe("D~F: 관리자 수업 목록의 담당 강사 표시", () => {
  test("D: 강사 1명 — '시간 · 강사명 · 예약 인원' 형태로 표시된다", async ({ page }) => {
    const cls = await createFutureTestClassAdmin(centerAId, { title: `강사표시-관리자-단일-${Date.now()}`, hoursFromNow: 200 });
    createdClassIds.push(cls.id);
    await setTrainers(cls.id, [managerA.accountId]);

    const kstDate = kstDateStr(cls.startTime);
    await gotoManagerClassesDay(page, kstDate);
    const meta = page.locator(".class-row", { hasText: "강사표시-관리자-단일" }).locator(".class-row-meta");
    await expect(meta).toContainText(`· ${managerAName} · 예약`);
    // 삭제 버튼/카드 클릭 동작이 그대로인지도 가볍게 확인(범위: 레이아웃만 바뀌었는지)
    await expect(page.locator(".class-row", { hasText: "강사표시-관리자-단일" }).getByRole("button", { name: "삭제" })).toBeVisible();
  });

  test("E: 강사 복수(3명) — '시간 · 강사명 외 N명 · 예약 인원' 형태로 표시된다", async ({ page }) => {
    const cls = await createFutureTestClassAdmin(centerAId, { title: `강사표시-관리자-복수-${Date.now()}`, hoursFromNow: 201 });
    createdClassIds.push(cls.id);
    await setTrainers(cls.id, [managerA.accountId, userA.accountId, userB.accountId]);

    const kstDate = kstDateStr(cls.startTime);
    await gotoManagerClassesDay(page, kstDate);
    const meta = page.locator(".class-row", { hasText: "강사표시-관리자-복수" }).locator(".class-row-meta");
    await expect(meta).toContainText(`· ${managerAName} 외 2명 · 예약`);
  });

  test("F: 강사 없음 — 기존과 동일하게 '시간 · 예약 인원' 형태를 유지하고 불필요한 구분자가 없다", async ({ page }) => {
    const cls = await createFutureTestClassAdmin(centerAId, { title: `강사표시-관리자-없음-${Date.now()}`, hoursFromNow: 202 });
    createdClassIds.push(cls.id);
    // 강사 지정 없음(기본 상태)

    const kstDate = kstDateStr(cls.startTime);
    await gotoManagerClassesDay(page, kstDate);
    const meta = page.locator(".class-row", { hasText: "강사표시-관리자-없음" }).locator(".class-row-meta");
    const text = (await meta.innerText()).replace(/\s+/g, " ").trim();
    expect(text).toMatch(/^\d{2}:\d{2}~\d{2}:\d{2} · 예약 \d+\/\d+/);
    // 강사가 없으면 시간과 "예약" 사이에 구분자가 정확히 하나만 있어야 한다(강사 자리에
    // 빈 " · "가 추가로 끼어들면 " ·  · 예약"처럼 구분자가 중복된다).
    expect((text.match(/·/g) ?? []).length).toBe(1);
  });
});

// 이 파일의 나머지 테스트는 전부 관리자 세션(MANAGER_AUTH_FILE, 파일 상단 test.use)이라,
// 회원 화면 확인은 class-allowed-products.spec.ts와 동일한 관례대로 browser.newContext()로
// 별도 회원 세션을 새로 열어 검증한다(같은 파일 안에서 storageState를 부분적으로 바꾸는
// test.use 중첩 대신 — 이 저장소의 다른 e2e 스펙 어디에도 없는 패턴이라 굳이 새로 쓰지 않음).
test.describe("A~C: 회원 예약 화면의 담당 강사 표시", () => {
  test("A: 강사 1명 — 센터명과 같은 줄에 '센터명 · 강사명' 형태로, 별도 줄이 아니다", async ({ browser }) => {
    const cls = await createFutureTestClassAdmin(centerAId, { title: `강사표시-회원-단일-${Date.now()}`, hoursFromNow: 204 });
    createdClassIds.push(cls.id);
    await setTrainers(cls.id, [managerA.accountId]);

    const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
    const memberPage = await memberContext.newPage();
    await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
    const row = memberPage.locator(".class-row", { hasText: `강사표시-회원-단일` });
    const place = row.locator(".class-row-place");
    await expect(place).toContainText(`· ${managerAName}`);
    // 담당 강사가 별도 줄(.class-row-instructors)로 더 이상 렌더링되지 않는지 확인.
    await expect(row.locator(".class-row-instructors")).toHaveCount(0);
    await memberContext.close();
  });

  test("B: 강사 복수(3명) — '센터명 · 강사명 외 N명' 형태로 표시된다", async ({ browser }) => {
    const cls = await createFutureTestClassAdmin(centerAId, { title: `강사표시-회원-복수-${Date.now()}`, hoursFromNow: 205 });
    createdClassIds.push(cls.id);
    await setTrainers(cls.id, [managerA.accountId, userA.accountId, userB.accountId]);

    const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
    const memberPage = await memberContext.newPage();
    await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
    const row = memberPage.locator(".class-row", { hasText: `강사표시-회원-복수` });
    const place = row.locator(".class-row-place");
    await expect(place).toContainText(`· ${managerAName} 외 2명`);
    await memberContext.close();
  });

  test("C: 강사 없음 — 센터명만 표시되고 불필요한 구분자가 없다", async ({ browser }) => {
    const cls = await createFutureTestClassAdmin(centerAId, { title: `강사표시-회원-없음-${Date.now()}`, hoursFromNow: 206 });
    createdClassIds.push(cls.id);
    // 강사 지정 없음(기본 상태)

    const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
    const memberPage = await memberContext.newPage();
    await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
    const row = memberPage.locator(".class-row", { hasText: `강사표시-회원-없음` });
    const place = row.locator(".class-row-place");
    const text = (await place.innerText()).trim();
    expect(text).not.toContain("·");
    await memberContext.close();
  });
});
