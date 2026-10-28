import { test, expect, openAs, db, QA_CENTER_ID, gotoQaCenter, shot, need, resetQaMember } from "./helpers";
import type { BrowserContext, Page } from "@playwright/test";

/* [센터 오너] 주문 발급(확정)·취소 — 직접결제(direct) 대기 주문 2건을 fixture 로 만들고 UI 로 처리한다(실결제·PG 호출 없음). */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext; let page: Page; let errors: string[]; let issueId = ""; let cancelId = "";
const newOrder = async () => {
  const { data, error } = await db().from("orders").insert({ center_id: QA_CENTER_ID(), profile_id: need("QA_MEMBER_PROFILE_ID"), product_id: need("QA_PRODUCT_ID"), product_name: "QA 10회권", amount: 100000, pay_method: "direct", payment_provider: "mock", status: "pending" }).select("id").single();
  if (error) throw new Error(error.message); return data.id as string;
};
test.beforeAll(async ({ browser }) => { ({ ctx, page, errors } = await openAs(browser, "owner")); await resetQaMember(); issueId = await newOrder(); cancelId = await newOrder(); });
test.afterAll(async () => { await ctx.close(); });

test("[오너] 주문 발급 — '확정 · 발급' → 계속하기 → 주문 처리 완료 + 수강권·매출 반영", async () => {
  await gotoQaCenter(page, "/manager/orders");
  await expect(page.getByText("확인 대기 (2)")).toBeVisible();
  await shot(page, "03-orders-pending");
  await page.getByRole("button", { name: "확정 · 발급" }).first().click();
  await expect(page.getByText("발급하고 매출에 반영할까요?")).toBeVisible();
  await shot(page, "03-order-issue-confirm");
  await page.getByRole("button", { name: "계속하기", exact: true }).click();
  await expect(page.getByText("확인 대기 (1)")).toBeVisible({ timeout: 20_000 });
  const rows = (await db().from("orders").select("id,status,verified").in("id", [issueId, cancelId])).data ?? [];
  const done = rows.filter((r) => r.status !== "pending"); expect(done.length).toBe(1); test.info().annotations.push({ type: "observed", description: `발급된 주문 status=${done[0].status} verified=${done[0].verified}` });
  const m = (await db().from("memberships").select("id").eq("center_id", QA_CENTER_ID()).eq("profile_id", need("QA_MEMBER_PROFILE_ID"))).data ?? [];
  expect(m.length).toBe(1);
  await shot(page, "03-order-after-issue");
  expect(errors).toEqual([]);
});

test("[오너] 주문 취소 — 남은 대기 주문 '취소' → 확인 → 주문 cancelled, 수강권 미발급", async () => {
  await gotoQaCenter(page, "/manager/orders");
  const pending = (await db().from("orders").select("id").in("id", [issueId, cancelId]).eq("status", "pending")).data ?? [];
  expect(pending.length).toBe(1);
  await page.getByRole("button", { name: "취소", exact: true }).first().click();
  await shot(page, "03-order-cancel-confirm");
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await expect.poll(async () => (await db().from("orders").select("status").eq("id", pending[0].id).single()).data?.status, { timeout: 20_000 }).toBe("cancelled");
  const m = (await db().from("memberships").select("id").eq("center_id", QA_CENTER_ID()).eq("profile_id", need("QA_MEMBER_PROFILE_ID"))).data ?? [];
  expect(m.length).toBe(1);   // 취소로 수강권이 추가 발급되지 않음
  await shot(page, "03-order-after-cancel");
});
