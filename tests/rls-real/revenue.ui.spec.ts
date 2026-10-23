/* F16 표시: 센터 오너 JWT + 격리 DB 의 실제 매출 함수(나머지 보정 적용)로 두 모드의 구분 라벨과 합계를 확인한다. 1000원 기간제를 3번 이용 → 합계 1,000원(334+333+333). */
import { expect, test } from "@playwright/test";
import { ID, sql, U } from "./support";
import { loginAs } from "./uiLogin";

const P = "e9700000-0000-0000-0000-0000000000f1", MS = "e9700000-0000-0000-0000-0000000000f2";
test.beforeAll(() => {
  sql(`insert into products(id,center_id,name,price,product_kind,total_count,unlimited_pass,is_active,is_on_sale) values ('${P}','${ID.centerPub}','[QA] 매출 기간제',1000,'pass',null,true,true,true) on conflict (id) do nothing`);
  sql(`insert into memberships(id,profile_id,center_id,product_id,product_name,pass_type,total_count,remaining_count,status,expires_at) values ('${MS}','${ID.pB1}','${ID.centerPub}','${P}','[QA] 매출 기간제','period',null,null,'active',(current_date + 60)) on conflict (id) do nothing`);
  const m0 = "date_trunc('month', now() at time zone 'Asia/Seoul')";
  sql(`insert into payments(id,profile_id,center_id,membership_id,sale_type,total_amount,status,paid_at) values ('e9700000-0000-0000-0000-0000000000f3','${ID.pB1}','${ID.centerPub}','${MS}','new',1000,'paid',(${m0} + interval '1 hour') at time zone 'Asia/Seoul') on conflict (id) do nothing`);
  for (const d of [1, 2, 3]) {
    sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,status,pass_selection_mode,booking_deadline_min) values ('e9700000-0000-0000-0000-0000000000a${d}','${ID.centerPub}','[QA] 매출 수업 ${d}',(${m0} + interval '${d} days 10 hours') at time zone 'Asia/Seoul',(${m0} + interval '${d} days 11 hours') at time zone 'Asia/Seoul',5,'open','all',0) on conflict (id) do nothing`);
    sql(`insert into reservations(id,class_id,profile_id,membership_id,status) values ('e9700000-0000-0000-0000-0000000000b${d}','e9700000-0000-0000-0000-0000000000a${d}','${ID.pB1}','${MS}','attended') on conflict (id) do nothing`);
  }
});
test.afterAll(() => {
  sql(`delete from reservations where id::text like 'e9700000-%'`); sql(`delete from classes where id::text like 'e9700000-%'`);
  sql(`delete from payments where id::text like 'e9700000-%'`); sql(`delete from memberships where id='${MS}'`); sql(`delete from products where id='${P}'`);
  sql(`update center_settings set unlimited_pass_revenue_mode='usage_split' where center_id='${ID.centerPub}'`);
});

test("[실제 JWT] 이용 횟수로 분배(usage_split): '정기권(이용 횟수로 분배)' 줄에 1,000원·'구매일 전액' 표기 없음, 설명이 실제 방식과 일치", async ({ page }) => {
  sql(`update center_settings set unlimited_pass_revenue_mode='usage_split' where center_id='${ID.centerPub}'`);
  await loginAs(page, U.M, "m@test.invalid");
  await page.goto("/manager/class-revenue");
  await expect(page.locator(".sales-big-value")).toContainText("1,000", { timeout: 30_000 });
  await expect(page.getByText("이용한 수업 횟수로 나눠")).toBeVisible();
  await expect(page.getByText("정기권(구매일 전액")).toHaveCount(0);
  await expect(page.locator(".sales-bd-item", { hasText: "정기권(이용 횟수로 분배)" })).toContainText("1,000");   // 서버 periodPassRevenue = 이용 분배분
  await expect(page.locator(".sales-bd-item", { hasText: "수업(횟수제)" })).toContainText("0원");
});

test("[실제 JWT] 구매일에 전액(purchase_date_full): '정기권(구매일 전액)' 줄에 1,000원, 수업 줄은 0원", async ({ page }) => {
  sql(`update center_settings set unlimited_pass_revenue_mode='purchase_date_full' where center_id='${ID.centerPub}'`);
  await loginAs(page, U.M, "m@test.invalid");
  await page.goto("/manager/class-revenue");
  await expect(page.locator(".sales-bd-item", { hasText: "정기권(구매일 전액)" })).toContainText("1,000", { timeout: 30_000 });
  await expect(page.getByText("결제한 날 하루에 전액")).toBeVisible();
  await expect(page.locator(".sales-bd-item", { hasText: "수업(횟수제)" })).toContainText("0원");
});
