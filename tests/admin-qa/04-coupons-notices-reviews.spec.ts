import { test, expect, openAs, db, QA_CENTER_ID, gotoQaCenter, shot, need, uniq } from "./helpers";
import type { BrowserContext, Page } from "@playwright/test";

/* [센터 오너] 쿠폰 생성·지급, 공지 작성·수정, 후기 답변 — 실브라우저 + DB 확인. 알림은 앱 내 알림 행으로만 남고 외부 발송은 없다(격리 스택에는 외부 자격증명이 없음). */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext; let page: Page; let errors: string[];
test.beforeAll(async ({ browser }) => { ({ ctx, page, errors } = await openAs(browser, "owner")); });
test.afterAll(async () => { await ctx.close(); });
const couponName = uniq("QA쿠폰"); const noticeTitle = uniq("QA공지");

test("[오너] 쿠폰 생성 — 정액 5,000원 → 쿠폰 생성 → 목록 + DB", async () => {
  await gotoQaCenter(page, "/manager/coupons");
  await page.getByRole("button", { name: "+ 쿠폰" }).click();
  await page.locator('input[placeholder="예: VIP 특별 3만원 할인"]').fill(couponName);
  await page.locator('input[placeholder="예: 30000"]').fill("5000");
  await shot(page, "04-coupon-form");
  await page.getByRole("button", { name: "쿠폰 생성" }).click();
  await expect(page.getByText(couponName)).toBeVisible({ timeout: 15_000 });
  const { data } = await db().from("coupons").select("id,name,center_id").eq("name", couponName);
  expect(data?.length).toBe(1); expect(data![0].center_id).toBe(QA_CENTER_ID());
  await shot(page, "04-coupon-created");
});

test("[오너] 쿠폰 지급 — 쿠폰 카드에서 회원 선택 → 지급 → member_coupons 행", async () => {
  await gotoQaCenter(page, "/manager/coupons");
  await page.getByText(couponName).first().click();
  await shot(page, "04-coupon-open");
  const grant = page.getByRole("button", { name: /지급/ }).first();
  await expect(grant).toBeVisible();
  await grant.click();
  await page.locator('input[placeholder="이름 또는 전화번호 검색"]').fill("CI User A");
  await page.getByText("CI User A").last().click();
  await expect(page.getByText("선택 1명")).toBeVisible();
  await shot(page, "04-coupon-grant-selected");
  await page.getByRole("button", { name: "쿠폰 지급", exact: true }).click();
  const cid = (await db().from("coupons").select("id").eq("name", couponName).single()).data!.id;
  await expect.poll(async () => (await db().from("member_coupons").select("id").eq("coupon_id", cid)).data?.length, { timeout: 15_000 }).toBe(1);
  await shot(page, "04-coupon-granted");
});

test("[오너] 공지 작성 — 제목·내용 → 등록하고 알림 보내기 → 목록 + DB", async () => {
  await gotoQaCenter(page, "/manager/announcements");
  await page.getByRole("button", { name: "+ 새 공지" }).click();
  await page.locator('input[placeholder="공지 제목"]').fill(noticeTitle);
  await page.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type("QA 공지 본문입니다.");
  await shot(page, "04-notice-form");
  await page.getByRole("button", { name: "등록하고 알림 보내기" }).click();
  await expect(page.getByText(noticeTitle)).toBeVisible({ timeout: 15_000 });
  const { data } = await db().from("center_announcements").select("id,title,center_id").eq("title", noticeTitle);
  expect(data?.length).toBe(1);
  await shot(page, "04-notice-created");
  expect(errors).toEqual([]);
});

test("[오너] 공지 수정 — 제목 변경 저장 → DB 반영", async () => {
  await gotoQaCenter(page, "/manager/announcements");
  await page.getByText(noticeTitle, { exact: true }).locator("xpath=ancestor::div[.//button[normalize-space()='수정']][1]").getByRole("button", { name: "수정", exact: true }).click();
  await shot(page, "04-notice-edit-form");
  await page.locator('input[placeholder="공지 제목"]').fill(`${noticeTitle}-수정`);
  await page.getByRole("button", { name: "수정", exact: true }).last().click();
  await expect.poll(async () => (await db().from("center_announcements").select("id").eq("title", `${noticeTitle}-수정`)).data?.length, { timeout: 15_000 }).toBe(1);
});

test("[오너] 후기 답변 — 후기 행 답변 입력 → 저장 → reply/replied_at", async () => {
  const text = uniq("QA후기");
  await db().from("center_reviews").delete().eq("center_id", QA_CENTER_ID()).eq("profile_id", need("QA_MEMBER_PROFILE_ID"));   // 센터·회원당 후기 1건 제약 — 이전 실행 fixture 정리
  const r = await db().from("center_reviews").insert({ center_id: QA_CENTER_ID(), profile_id: need("QA_MEMBER_PROFILE_ID"), rating: 5, content: text }).select("id").single();
  expect(r.error).toBeNull();
  await gotoQaCenter(page, "/manager/reviews");
  await expect(page.getByText(text)).toBeVisible();
  await shot(page, "04-review-list");
  const reviewId = r.data!.id;
  await page.getByRole("button", { name: "답변 달기", exact: true }).first().click();
  const box = page.locator('.sheet [contenteditable="true"]').first(); await expect(box).toBeVisible();
  await box.click(); await page.keyboard.type("QA 답변입니다. 감사합니다.");
  await shot(page, "04-review-reply-form");
  await page.getByRole("button", { name: "저장", exact: true }).last().click();
  await expect.poll(async () => (await db().from("center_reviews").select("reply,replied_at").eq("id", reviewId).single()).data?.reply ?? "", { timeout: 15_000 }).toContain("QA 답변입니다. 감사합니다.");
  expect((await db().from("center_reviews").select("replied_at").eq("id", reviewId).single()).data?.replied_at).toBeTruthy();
  await shot(page, "04-review-replied");
});
