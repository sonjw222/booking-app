import { test, expect, type Page } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  cleanupTestClassAdmin,
  kstDateStr,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import { getFixtureAdminClient } from "../../integration/setup";
import { supabase } from "../../../lib/supabaseClient";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  임시 진단(제거 예정) — PR #44 수동 QA 발견: 기존 수업은 정상인데 실제 관리자 UI로
  새로 만든 수업은 회원이 유효한 수강권을 보유해도 "사용 가능한 수강권이 없어요"라고 뜸.

  DB-level 예비진단(tests/integration/_diag_new_class_bug.test.ts)으로 이미 확인한 것:
  admin client로 직접 insert한 새 class는 기존 class와 RPC 결과가 완전히 동일(둘 다 52건) —
  membership_schedule_rules는 centerA 전체 0건, class_allowed_products도 둘 다 0건.
  즉 DB/RPC 레이어 자체는 새 class여도 정상 동작함 — 그렇다면 차이는 반드시
  "실제 관리자 UI 등록 흐름이 direct insert와 다르게 하는 무언가" 또는 "회원 화면
  프론트엔드 상태/fetch"에 있다. 이 테스트가 실제 UI로 그 차이를 찾는다.
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

test("진단: 실제 관리자 UI로 신규 수업(모든 수강권 허용) 생성 → DB 상태 → 회원 실제 재현", async ({ page, browser }) => {
  const uniqueTitle = `DIAG-UI-NEWCLASS-${Date.now()}`;

  // 90일 뒤 미래 날짜(다른 어떤 stale 데이터와도 안 겹치도록) — 오늘 기준 90일 뒤 KST 날짜 계산
  const future = new Date(Date.now() + 90 * 24 * 3600 * 1000);
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(future);

  await page.goto("/manager/classes");
  await expect(page.locator(".cal-title")).toBeVisible();
  // 90일 뒤까지 "다음달" 버튼으로 이동(최대 4개월)
  const [ty, tm] = dateStr.split("-").map(Number);
  for (let i = 0; i < 4; i++) {
    const title = (await page.locator(".cal-title").innerText()).trim();
    const [cy, cm] = title.split(".").map(Number);
    if (cy === ty && cm === tm) break;
    await page.locator(".cal-nav-btn").nth(1).click();
  }

  await page.locator(".fab-btn", { hasText: "수업 등록" }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 등록" })).toBeVisible();

  await page.locator('input[placeholder="수업명"]').fill(uniqueTitle);
  await page.locator('input[type="date"]').fill(dateStr);
  await fillAmPmTime(page, 0, 19, 0); // 시작 19:00
  await fillAmPmTime(page, 1, 20, 0); // 종료 20:00

  // "예약 가능 수강권"은 아무것도 선택하지 않음(Case A: 모든 수강권 허용)
  await expect(page.locator(".perm-guide", { hasText: "모든 수강권" })).toBeVisible();

  await page.getByRole("button", { name: "등록하기", exact: true }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);

  // 방금 만든 class를 DB에서 직접 찾는다(제목으로 식별 — 유니크 prefix라 충돌 없음)
  const admin = getFixtureAdminClient();
  const { data: newClassRow, error: findErr } = await admin
    .from("classes")
    .select("id, title, start_time, end_time, capacity, class_format, class_type_id, status")
    .eq("center_id", centerAId)
    .eq("title", uniqueTitle)
    .single();
  if (findErr || !newClassRow) throw new Error(`방금 만든 class를 못 찾음: ${findErr?.message}`);
  createdClassIds.push(newClassRow.id);
  console.log(`=== UI로 생성된 신규 class: ${JSON.stringify(newClassRow)} ===`);

  const { data: cap, error: capErr } = await supabase
    .from("class_allowed_products").select("*").eq("class_id", newClassRow.id);
  if (capErr) throw new Error(capErr.message);
  console.log(`=== UI로 생성된 신규 class의 class_allowed_products: ${(cap ?? []).length}건 ${JSON.stringify(cap ?? [])} ===`);

  // RPC 직접 호출 — userA 세션으로 전환해서 호출(실제 회원 fetchUsableMembershipsByClass와 동일 조건)
  const { switchToTestUser } = await import("../../integration/setup");
  await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
  const { data: rpcRows, error: rpcErr } = await supabase.rpc("usable_memberships_for_classes", {
    p_class_ids: [newClassRow.id],
    p_profile_id: userA.profileId,
  });
  if (rpcErr) throw new Error(`RPC 호출 실패: ${rpcErr.message}`);
  console.log(`=== UI로 생성된 신규 class에 대한 RPC 직접 호출 결과: ${(rpcRows ?? []).length}건 ${JSON.stringify((rpcRows ?? []).slice(0, 3))} ===`);

  // 실제 회원 브라우저로 재현
  const memberContext = await browser.newContext({ storageState: MEMBER_AUTH_FILE });
  const memberPage = await memberContext.newPage();

  let rpcNetworkInfo: any = null;
  memberPage.on("response", async (res) => {
    if (res.url().includes("usable_memberships_for_classes")) {
      try {
        const body = await res.text();
        rpcNetworkInfo = { status: res.status(), url: res.url(), bodyLength: body.length, bodyPreview: body.slice(0, 500) };
      } catch { /* 무시 */ }
    }
  });

  await memberPage.goto(reservationDeepLink(newClassRow.id, newClassRow.start_time));
  // 신규 class가 90일 뒤라 회원 화면이 month를 여러 번 이동하며 다시 로드해야 auto-open
  // 효과가 target을 찾는다 — 고정 대기 대신 예약확인 모달 자체가 뜨는 것을 기다린다.
  await expect(memberPage.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible({ timeout: 20000 });
  await memberPage.waitForTimeout(1500); // 모달이 뜬 뒤 pass 목록 RPC 응답까지 여유
  const passList = memberPage.locator(".pass-pick-list");
  const noPassMsg = memberPage.locator("text=현재 사용할 수 있는 수강권이 없어요");
  const passListVisible = await passList.isVisible().catch(() => false);
  const noPassVisible = await noPassMsg.isVisible().catch(() => false);
  console.log(`=== 회원 화면 재현 결과: .pass-pick-list visible=${passListVisible}, "수강권 없음" 메시지 visible=${noPassVisible} ===`);
  console.log(`=== 회원 화면에서 관측된 RPC network 응답: ${JSON.stringify(rpcNetworkInfo)} ===`);

  await memberContext.close();
});
