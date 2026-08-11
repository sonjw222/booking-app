import { test, expect, type Page } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  deleteExistingClassesByTitle,
  kstDateStr,
  getOrCreateTestPassProduct,
  createTestMembershipAdmin,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import { getFixtureAdminClient } from "../../integration/setup";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  P3(출석/체크인 배치): 관리자 예약자 명단(app/manager/classes/page.tsx)의 출결 처리 실브라우저
  검증. 기존 구조 감사 결과 이 UI는 이미 구현돼 있었다(새로 만들지 않음) — 이번에 실제로 고친
  것만 검증: (1) "결석" 버튼이 실제로는 출결 표시를 취소(confirmed로 되돌림)하는 동작이라
  진짜 결석(노쇼) 처리와 라벨이 반대였던 버그(라벨을 "되돌리기"/"결석(노쇼)"로 수정),
  (2) 대기(waitlisted) 예약은 출석/결석 버튼 자체가 안 보여야 한다(서버 가드와 짝 —
  fix_attendance_consolidate_and_guard_draft_proposed.sql 미적용 시 서버 RPC는 여전히 예전
  동작이지만, 이 UI단 버튼 숨김은 SQL과 무관하게 이미 적용된 코드라 항상 검증 가능).
*/

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

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
const createdClassIds: string[] = [];
// 테스트 도중 만든 임시 프로필(대기 시나리오 등)은 여기 추적해 afterAll에서 반드시 지운다 —
// 테스트 본문 끝에서만 지우면 그 전에 assertion이 실패해 던지는 순간 정리가 스킵되고, 공유
// 계정(userA)에 남은 여분의 profiles 행이 switchToTestUser()(.eq("is_primary", true)로
// 좁히기 전에는 .maybeSingle()에서 "multiple rows"로 다른 모든 테스트/E2E setup을 깨뜨렸다
// (실제로 재현됨 — 이 파일의 대기 테스트가 원인). is_primary 필터로 근본 원인은 고쳤지만,
// 이 스펙 자체도 afterAll로 확실히 정리하도록 함께 강화한다.
const createdProfileIds: string[] = [];

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });

  // self-healing 정리(2026-08 공유 센터 오염 진단 후 도입) — afterAll이 createdProfileIds를
  // 지우긴 하지만, CI가 이 spec 도중 취소되면(GitHub Actions concurrency.cancel-in-progress,
  // 또는 사람이 새 실행을 다시 트리거) afterAll 자체가 실행되지 않는다. 실측 진단에서
  // "P3 출결-대기용"(is_primary=false) 프로필이 16건 넘게 고아 상태로 쌓여 있는 것을
  // 확인했다 — 매 실행 시작 시점에 이전에 남은 것들을 먼저 정리한다(reservations →
  // memberships → profiles 순, FK 안전 순서).
  {
    const admin = getFixtureAdminClient();
    const { data: staleProfiles } = await admin
      .from("profiles").select("id").eq("account_id", userA.accountId).eq("is_primary", false).eq("name", "P3 출결-대기용");
    const staleIds = (staleProfiles ?? []).map((p) => p.id);
    if (staleIds.length > 0) {
      await admin.from("reservations").delete().in("profile_id", staleIds);
      await admin.from("memberships").delete().in("profile_id", staleIds);
      await admin.from("profiles").delete().in("id", staleIds);
    }
  }
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  if (createdProfileIds.length > 0) {
    const admin = getFixtureAdminClient();
    await admin.from("profiles").delete().in("id", createdProfileIds);
  }
});

test("관리자: 예약자 출석 → 결석(노쇼) → 되돌리기, 취소된 예약은 변경 불가 (그룹 수업, 실브라우저)", async ({ page, browser }) => {
  const cls = await createFutureTestClassAdmin(centerAId, { title: "P3 출결-그룹", hoursFromNow: 40 });
  createdClassIds.push(cls.id);
  const kstDate = kstDateStr(cls.startTime);

  // 회원이 실제로 예약(confirmed)한 상태를 만든다.
  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await memberContext.close();

  await gotoManagerClassesDay(page, kstDate);
  await page.locator(".class-row", { hasText: "P3 출결-그룹" }).locator(".res-count-link").click();
  await expect(page.locator(".sheet-title", { hasText: "예약자" })).toBeVisible();

  const rosterItem = page.locator(".roster-item").first();
  await expect(rosterItem).toBeVisible();
  await expect(rosterItem.locator(".hist-status")).toHaveText("확정");

  // 출석 처리
  await rosterItem.getByRole("button", { name: "출석" }).click();
  await expect(rosterItem.locator(".hist-status")).toHaveText("출석");

  // 결석(노쇼) 처리 — 라벨이 실제 동작(no_show)과 일치하는지 확인(이번에 고친 버그).
  await rosterItem.getByRole("button", { name: "결석(노쇼)" }).click();
  await expect(rosterItem.locator(".hist-status")).toHaveText("노쇼");

  // 되돌리기(confirmed로 리셋)
  await rosterItem.getByRole("button", { name: "되돌리기" }).click();
  await expect(rosterItem.locator(".hist-status")).toHaveText("확정");

  // 예약취소 → handleAttendance()가 네이티브 confirm()을 띄운다(Playwright는 기본적으로
  // 자동 취소하므로 명시적으로 accept해야 실제로 진행됨).
  page.once("dialog", (d) => d.accept());
  await rosterItem.getByRole("button", { name: "예약취소" }).click();
  await expect(rosterItem.locator(".hist-status")).toHaveText("취소");
  await expect(rosterItem.locator(".att-locked")).toContainText("변경 불가");
  await expect(rosterItem.getByRole("button", { name: "출석" })).toHaveCount(0);
});

test("관리자: 대기(waitlisted) 예약은 출석/결석 버튼이 보이지 않는다 (그룹 수업, 실브라우저)", async ({ page, browser }) => {
  const cls = await createFutureTestClassAdmin(centerAId, { title: "P3 출결-대기", hoursFromNow: 41, capacity: 1 });
  createdClassIds.push(cls.id);
  const kstDate = kstDateStr(cls.startTime);
  const admin = getFixtureAdminClient();

  // userA가 먼저 예약해 정원(1명)을 채운다.
  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(cls.id, cls.startTime));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await memberContext.close();

  // 대기로 등록될 두 번째 예약은 admin insert로 직접 만든다(별도 회원 브라우저 로그인 없이).
  // ⚠ reserve_class()는 auth.uid() 기반으로 본인 프로필인지 검증해 service-role 클라이언트로는
  // 호출할 수 없다(로그인 세션이 없어 "로그인이 필요하거나 프로필을 찾을 수 없어요"로 거부됨) —
  // 그래서 waitlisted 행을 직접 insert한다(모든 NOT NULL 컬럼에 기본값이 있어 안전, schema.sql 확인).
  const { data: waitProfile } = await admin
    .from("profiles").insert({ account_id: userA.accountId, name: "P3 출결-대기용", is_primary: false }).select("id").single();
  createdProfileIds.push(waitProfile!.id); // afterAll에서 확실히 정리 — 아래 assertion이 실패해도 남지 않게
  const { data: waitMembership } = await admin
    .from("memberships").insert({
      profile_id: waitProfile!.id, center_id: centerAId, product_id: (await getOrCreateTestPassProduct(centerAId)).id,
      product_name: "P3 출결 대기용 수강권", pass_type: "count", total_count: 5, remaining_count: 5,
      expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10), status: "active",
    }).select("id").single();
  await admin.from("reservations").insert({
    class_id: cls.id, profile_id: waitProfile!.id, membership_id: waitMembership!.id,
    status: "waitlisted", waitlist_order: 1,
  });

  await gotoManagerClassesDay(page, kstDate);
  await page.locator(".class-row", { hasText: "P3 출결-대기" }).locator(".res-count-link").click();
  await expect(page.locator(".sheet-title", { hasText: "예약자" })).toBeVisible();

  const waitItem = page.locator(".roster-item", { hasText: "대기" });
  await expect(waitItem).toBeVisible();
  await expect(waitItem.getByRole("button", { name: "출석" })).toHaveCount(0);
  await expect(waitItem.getByRole("button", { name: "결석(노쇼)" })).toHaveCount(0);
  await expect(waitItem.getByRole("button", { name: "예약취소" })).toBeVisible();
});

test("관리자: 프라이빗 수업에서도 출석/결석 처리가 동일하게 동작한다 (실브라우저)", async ({ page, browser }) => {
  const admin = getFixtureAdminClient();
  // CI가 실행 도중 concurrency로 취소되면(다음 push가 cancel-in-progress로 이전 실행을
  // 죽임) afterAll이 못 돌아 이 제목의 수업(+ 걸려 있던 예약)이 그대로 남는다(실제로
  // 재현됨: 회원 화면에 같은 제목 행이 2개가 돼 .res-count-link가 Playwright strict mode
  // violation로 실패). createFutureTestClassAdmin과 동일한 관례로 생성 전 정리한다.
  await deleteExistingClassesByTitle(centerAId, "P3 출결-프라이빗");
  const start = new Date(Date.now() + 42 * 3600 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const { data: privateCls, error } = await admin
    .from("classes")
    .insert({ center_id: centerAId, title: "P3 출결-프라이빗", start_time: start.toISOString(), end_time: end.toISOString(), capacity: 1, class_format: "private" })
    .select("id, start_time")
    .single();
  if (error || !privateCls) throw new Error(`프라이빗 테스트 수업 생성 실패: ${error?.message ?? "no data"}`);
  createdClassIds.push(privateCls.id);
  const kstDate = kstDateStr(privateCls.start_time);

  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(reservationDeepLink(privateCls.id, privateCls.start_time));
  await memberPage.getByRole("button", { name: "예약하기" }).click();
  await expect(memberPage.locator(".sheet-overlay")).toHaveCount(0);
  await memberContext.close();

  await gotoManagerClassesDay(page, kstDate);
  await page.locator(".class-row", { hasText: "P3 출결-프라이빗" }).locator(".res-count-link").click();
  await expect(page.locator(".sheet-title", { hasText: "예약자" })).toBeVisible();

  const rosterItem = page.locator(".roster-item").first();
  await rosterItem.getByRole("button", { name: "출석" }).click();
  await expect(rosterItem.locator(".hist-status")).toHaveText("출석");
});
