import { test, expect, openAs, db, QA_CENTER_ID, gotoQaCenter, kstDate, uniq, shot } from "./helpers";
import type { BrowserContext, Page } from "@playwright/test";

/* [센터 오너] 수업 생성·수정·삭제, 일정 복사 — 실브라우저(Chromium) + DB 사후 확인(서비스 롤은 확인 전용). 로컬 격리 스택에서만 실행. */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext; let page: Page; let errors: string[];
const title = uniq("QA수업"); const edited = `${title}-수정`;
test.beforeAll(async ({ browser }) => {
  await db().from("classes").delete().eq("center_id", QA_CENTER_ID()).ilike("title", "QA수업-%");   // 이전 실행 잔여 정리(QA 센터 한정)
  ({ ctx, page, errors } = await openAs(browser, "owner")); });
test.afterAll(async () => { await ctx.close(); });

const rowOf = (t: string) => page.locator(".class-row", { hasText: t });

test("[오너] 수업 생성 — 등록 폼 → 목록 반영 + DB 행", async () => {
  await gotoQaCenter(page, "/manager/classes");
  await page.locator(".workspace-create-class:visible, .fab-btn:visible").filter({ hasText: "수업 등록" }).first().click();
  await expect(page.locator(".sheet-title", { hasText: "수업 등록" })).toBeVisible();
  await page.locator('input[placeholder="수업명"]').fill(title);
  await page.locator('input[type="date"]').fill(kstDate(2));
  await shot(page, "01-class-create-form");
  await page.getByRole("button", { name: "등록하기", exact: true }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  const { data } = await db().from("classes").select("id,title,center_id").eq("title", title);
  expect(data?.length).toBe(1); expect(data![0].center_id).toBe(QA_CENTER_ID());
  expect(errors).toEqual([]);
});

test("[오너] 수업 수정 — 제목 변경 저장 → DB 반영", async () => {
  await gotoQaCenter(page, "/manager/classes");
  const cls = (await db().from("classes").select("start_time").eq("title", title).single()).data!;
  await page.locator(".cal-cell", { hasText: new RegExp(`^${Number(kstDate(2).slice(8))}$`) }).first().click();
  await rowOf(title).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 수정" })).toBeVisible();
  await page.locator('input[placeholder="수업명"]').fill(edited);
  await shot(page, "01-class-edit-form");
  await page.getByRole("button", { name: /^(저장|수정하기|저장하기)$/ }).first().click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  expect(cls.start_time).toBeTruthy();
  await expect.poll(async () => (await db().from("classes").select("id").eq("title", edited)).data?.length).toBe(1);
});

test("[오너] 일정 복사 — 이번 달 수업을 다음 달로 복사 실행 → 복사본 DB 행", async () => {
  await gotoQaCenter(page, "/manager/classes");
  const before = (await db().from("classes").select("id", { count: "exact", head: true }).eq("center_id", QA_CENTER_ID()).ilike("title", `${title}%`)).count ?? 0;
  await page.getByRole("button", { name: "일정 복사", exact: true }).first().click();
  await expect(page.getByText("스케줄 복사")).toBeVisible();
  await shot(page, "01-schedule-copy-form");
  await page.getByRole("button", { name: "미리보기" }).click();
  await expect(page.getByRole("button", { name: "복사하기" })).toBeEnabled({ timeout: 15_000 });
  await shot(page, "01-schedule-copy-preview");
  await page.getByRole("button", { name: "복사하기" }).click();
  await expect(page.getByText("선택한 수업을 복사할까요?")).toBeVisible();
  await shot(page, "01-schedule-copy-confirm");
  await page.getByRole("button", { name: "계속하기" }).click();
  await expect(page.getByText("스케줄 복사")).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(async () => (await db().from("classes").select("id", { count: "exact", head: true }).eq("center_id", QA_CENTER_ID()).ilike("title", `${title}%`)).count ?? 0, { timeout: 15_000 }).toBeGreaterThan(before);
});

test("[오너] 수업 삭제 — 행의 삭제 → 확인 → DB 에서 사라짐", async () => {
  await gotoQaCenter(page, "/manager/classes");
  await page.locator(".cal-cell", { hasText: new RegExp(`^${Number(kstDate(2).slice(8))}$`) }).first().click();
  await expect(rowOf(edited)).toBeVisible();
  const victim = (await db().from("classes").select("id,start_time").eq("title", edited).eq("center_id", QA_CENTER_ID()).order("start_time")).data![0];
  await rowOf(edited).getByRole("button", { name: "삭제", exact: true }).click();
  await shot(page, "01-class-delete-confirm");
  await expect(page.locator(".sheet-title", { hasText: "수업 삭제" })).toBeVisible();
  await page.getByRole("button", { name: "삭제", exact: true }).last().click();
  await expect.poll(async () => (await db().from("classes").select("id").eq("id", victim.id)).data?.length ?? -1, { timeout: 15_000 }).toBe(0);
  await shot(page, "01-class-after-delete");
});
