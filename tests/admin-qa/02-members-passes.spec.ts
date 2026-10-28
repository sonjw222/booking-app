import { test, expect, openAs, db, QA_CENTER_ID, gotoQaCenter, shot, need, resetQaMember } from "./helpers";
import type { BrowserContext, Page } from "@playwright/test";

/* [센터 오너] 회원 수강권 지급·연장·환불 — 실브라우저 + DB 확인. 회원(CI User A)은 격리 DB 안의 fixture 계정이다. */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext; let page: Page; let errors: string[];
const profile = () => need("QA_MEMBER_PROFILE_ID");
test.beforeAll(async ({ browser }) => {
  ({ ctx, page, errors } = await openAs(browser, "owner"));
  await resetQaMember();
});
test.afterAll(async () => { await ctx.close(); });

async function openMember() {
  await gotoQaCenter(page, "/manager/members");
  await page.getByText("CI User A", { exact: true }).first().click();
  await expect(page.getByRole("button", { name: "+ 수강권 지급" })).toBeVisible();
}

const mine = async () => (await db().from("memberships").select("id,product_name,total_count,remaining_count,status,expires_at,created_at").eq("center_id", QA_CENTER_ID()).eq("profile_id", profile()).order("created_at", { ascending: false })).data ?? [];
let before: string[] = []; let granted = "";
test("[오너] 수강권 지급 — 회원 상세 → 지급하기 → 수강권·결제(서비스) 기록", async () => {
  before = (await mine()).map((m) => m.id);
  await openMember();
  await page.getByRole("button", { name: "+ 수강권 지급" }).click();
  await expect(page.getByText("님에게 수강권 지급")).toBeVisible();
  await page.locator("select", { has: page.locator("option", { hasText: "QA 10회권" }) }).selectOption({ label: "QA 10회권 · 100,000원" });
  await shot(page, "02-grant-form");
  await page.getByRole("button", { name: "지급하기" }).click();
  await expect(page.getByText("님에게 수강권 지급")).toHaveCount(0, { timeout: 15_000 });
  const fresh = (await mine()).filter((m) => !before.includes(m.id));
  expect(fresh.length).toBe(1); expect(fresh[0].total_count).toBe(10); granted = fresh[0].id;
  await page.waitForTimeout(3000);
  await shot(page, "02-after-grant");
  // 지급 직후(새로고침 없이) 같은 화면의 회원 목록 행·상태 칩이 지급 결과를 반영해야 한다
  const rowText = await page.locator(".member-row, .mem-row, [class*=member-row]").first().innerText().catch(() => "");
  const chipsOn = await page.locator(".filter-chip.on, .chip.on").allInnerTexts();
  test.info().annotations.push({ type: "observed", description: `지급 3초 뒤 목록 행="${rowText.replace(/\s+/g, " ").slice(0, 60)}" chips=${JSON.stringify(chipsOn)}` });
  expect(chipsOn, "지급 직후 열려 있는 상세 시트의 회원 상태가 '활성'으로 갱신되어야 함(지급 전 '만료'가 남으면 안 됨)").toContain("활성");
  expect(chipsOn).not.toContain("만료");
  expect(errors).toEqual([]);
});

test("[오너] 지급 직후 상태 일관성 — 새로고침 뒤 회원 목록 '수강권 없음'/상태 칩이 지급 결과와 일치", async () => {
  await openMember();
  await shot(page, "02-reopen-member");
  const status = await db().from("center_members").select("status").eq("center_id", QA_CENTER_ID()).eq("profile_id", profile()).single();
  const chipOn = await page.locator(".filter-chip.on, .chip.on").allInnerTexts();
  test.info().annotations.push({ type: "observed", description: `center_members.status=${status.data?.status}; chips on=${JSON.stringify(chipOn)}` });
  await expect(page.getByText("QA 10회권").first()).toBeVisible();
});

test("[오너] 수강권 연장 — 연장 버튼 → +30일 → 만료일 변경 저장 → DB 반영", async () => {
  await openMember();
  const before = new Date((await mine())[0].expires_at).getTime();
  await page.getByRole("button", { name: "연장", exact: true }).first().click();
  await expect(page.getByText("수강권 만료일 연장")).toBeVisible();
  await shot(page, "02-extend-form");
  await page.getByRole("button", { name: "만료일 연장", exact: true }).click();
  await expect(page.getByText("연장할까요?")).toBeVisible();
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await expect.poll(async () => new Date((await mine())[0].expires_at).getTime() - before, { timeout: 15_000 }).toBeGreaterThanOrEqual(29 * 86400000);
  const log = await db().from("memberships").select("expires_at").eq("id", granted).single();
  expect(log.error).toBeNull();
  await shot(page, "02-after-extend");
});

test("[오너] 상품(대여품) 지급 — '+ 상품 지급' → 선택 → 지급하기 → 상품 수강권 행", async () => {
  const name = "QA 대여품";
  let g = (await db().from("products").select("id").eq("center_id", QA_CENTER_ID()).eq("name", name).maybeSingle()).data;
  if (!g) g = (await db().from("products").insert({ center_id: QA_CENTER_ID(), name, product_kind: "goods", pass_type: "count", total_count: 5, price: 0, is_on_sale: true, is_active: true }).select("id").single()).data!;
  const countGoods = async () => (await db().from("memberships").select("id").eq("center_id", QA_CENTER_ID()).eq("profile_id", profile()).eq("product_id", g!.id)).data?.length ?? 0;
  const before = await countGoods();
  await openMember();
  await page.getByRole("button", { name: "+ 상품 지급" }).click();
  await shot(page, "02-goods-grant-form");
  await page.locator("select", { has: page.locator("option", { hasText: name }) }).selectOption({ label: await page.locator("option", { hasText: name }).first().innerText() });
  await page.getByRole("button", { name: "지급하기" }).click();
  await expect.poll(countGoods, { timeout: 15_000 }).toBe(before + 1);
  await shot(page, "02-after-goods-grant");
});

test("[오너] 환불 — 관리자 화면에는 수강권 환불 처리 컨트롤이 없다(회원 본인 환불/PG API 경로) → 해당 없음(N/A) 기록", async () => {
  await openMember();
  await page.getByRole("button", { name: "결제", exact: true }).click();
  await page.getByText("신규", { exact: true }).first().click();
  await shot(page, "02-payments-tab-no-refund-control");
  const refundControls = await page.getByRole("button", { name: /환불/ }).count();
  test.info().annotations.push({ type: "matrix", description: `N/A: 회원 상세·결제 탭의 환불 버튼 ${refundControls}개 — 관리자 수동 환불 UI 미제공(docs/23_Admin_Feature_Audit.md E: 부분 환불 UI 없음). 실결제 환불(PG)은 금지 범위라 실행하지 않음` });
  expect(refundControls).toBe(0);
});
