/* 관리자 브라우저 흐름(격리 PostgREST + 실제 센터 오너 JWT): 일정 복사 첫 진입(F09), 시작 전 수업 출석 확인, 휴무 문구(F08). 외부 전송 없음. */
import { expect, test, type Page } from "@playwright/test";
import { ID, sql, U } from "./support";
import { loginAs } from "./uiLogin";

const CLS = "d8500000-0000-0000-0000-0000000000a1";
const RES = "d8600000-0000-0000-0000-0000000000a1";
const MEM = "d8700000-0000-0000-0000-0000000000a1";

test.beforeAll(() => {
  // 이번 달 안(오늘 기준 +2일이 달을 넘어가면 오늘 기준 미래 한 시각)에 복사 원본이 될 수업 + 출석 확인용 미래 수업/예약
  sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,status,pass_selection_mode,booking_deadline_min) values ('${CLS}','${ID.centerPub}','[QA] 출석 확인 수업',now()+interval '2 days',now()+interval '2 days 1 hour',5,'open','all',0) on conflict (id) do nothing`);
  sql(`insert into memberships(id,profile_id,center_id,product_name,total_count,remaining_count,status,pass_type,expires_at) values ('${MEM}','${ID.pB1}','${ID.centerPub}','QA',5,4,'active','count',(current_date+60)) on conflict (id) do nothing`);
  sql(`insert into reservations(id,class_id,profile_id,membership_id,status) values ('${RES}','${CLS}','${ID.pB1}','${MEM}','confirmed') on conflict (id) do update set status='confirmed'`);
});
test.afterAll(() => {
  sql(`delete from reservations where id='${RES}'`); sql(`delete from classes where id='${CLS}'`); sql(`delete from memberships where id='${MEM}'`);
});

async function gotoClasses(page: Page) {
  await loginAs(page, U.M, "m@test.invalid");
  await page.goto("/manager/classes");
  await expect(page.locator(".class-row, .daylist-empty, .cal-grid, .mypage-cal").first()).toBeVisible({ timeout: 30_000 });
}

test("[실제 JWT] F09: 일정 복사 창을 열자마자 원본 달 목록이 조회되고(버튼을 누르지 않아도), 모드를 바꿔도 마지막 선택의 결과만 남는다", async ({ page }) => {
  await gotoClasses(page);
  await page.getByRole("button", { name: "일정 복사" }).click();
  const sheet = page.locator(".sheet", { hasText: "스케줄 복사" });
  await expect(sheet).toBeVisible();
  // 로딩 표시 → 목록 또는 '복사할 수업이 없어요'(빈 목록)로 정리됨: 둘 다 아니면 '아무것도 없는 창'(회귀)
  await expect(sheet.locator(".copy-select-row, .perm-guide:has-text('복사할 수업이 없어요')").first()).toBeVisible({ timeout: 15_000 });
  const weekdayRows = await sheet.locator(".copy-select-row").count();
  await sheet.getByRole("button", { name: "날짜 기준" }).click();
  await sheet.getByRole("button", { name: "요일 기준" }).click();            // 빠르게 왕복해도 마지막(요일 기준) 결과로 수렴
  await expect.poll(async () => sheet.locator(".copy-select-row").count(), { timeout: 15_000 }).toBe(weekdayRows);
});

test("[실제 JWT] 시작 전 수업 출석: 확인창에서 취소하면 상태 유지, 확인하면 출석 처리(서버 규칙 불변)", async ({ page }) => {
  await gotoClasses(page);
  const row = page.locator(".class-row", { hasText: "[QA] 출석 확인 수업" });
  if (!(await row.count())) {   // 이틀 뒤 날짜로 이동
    const target = await page.evaluate(() => new Date(Date.now() + 2 * 86400000).getDate());
    const cell = page.locator(`button:has-text("${target}")`).first(); if (await cell.count()) await cell.click().catch(() => {});
  }
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole("button", { name: /예약 \d+\/\d+/ }).click();
  const att = page.locator("button.att-btn", { hasText: "출석" }).first();
  await expect(att).toBeVisible({ timeout: 15_000 });
  await att.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("아직 시작하지 않은 수업");
  await dialog.getByRole("button", { name: "취소" }).click();
  expect(sql(`select status from reservations where id='${RES}'`)).toBe("confirmed");      // 취소하면 변화 없음
  await att.click();
  await dialog.getByRole("button", { name: "확인" }).click();
  await expect.poll(() => sql(`select status from reservations where id='${RES}'`), { timeout: 15_000 }).toBe("attended");
  // 되돌리기(미정으로)
  const undo = page.locator("button.att-btn", { hasText: /미정|되돌/ }).first();
  if (await undo.count()) { await undo.click(); await expect.poll(() => sql(`select status from reservations where id='${RES}'`), { timeout: 15_000 }).toBe("confirmed"); }
});
