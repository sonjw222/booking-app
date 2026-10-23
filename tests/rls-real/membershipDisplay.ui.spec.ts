/* F15·F17 + 소진 표시 + 구매 내역: 실제 JWT·격리 DB 자료로 마이/구매 내역 화면의 상태·횟수 표시를 확인한다. */
import { expect, test } from "@playwright/test";
import { ID, sql, U } from "./support";
import { loginAs } from "./uiLogin";

const P = { unl: "e9300000-0000-0000-0000-0000000000f1", cnt: "e9300000-0000-0000-0000-0000000000f2" };
const M = { unl: "e9400000-0000-0000-0000-0000000000f1", ok: "e9400000-0000-0000-0000-0000000000f2", out: "e9400000-0000-0000-0000-0000000000f3", old: "e9400000-0000-0000-0000-0000000000f4" };

test.beforeAll(() => {
  sql(`insert into products(id,center_id,name,price,product_kind,total_count,unlimited_pass,is_active,is_on_sale) values ('${P.unl}','${ID.centerPub}','[QA] 무제한 정기권',90000,'pass',null,true,true,true),('${P.cnt}','${ID.centerPub}','[QA] 횟수권',50000,'pass',10,false,true,true) on conflict (id) do nothing`);
  const ins = (id: string, prod: string, name: string, total: string, rem: string, exp: string, pt: string) =>
    sql(`insert into memberships(id,profile_id,center_id,product_id,product_name,total_count,remaining_count,status,pass_type,expires_at) values ('${id}','${ID.pA1}','${ID.centerPub}','${prod}','${name}',${total},${rem},'active','${pt}',${exp}) on conflict (id) do update set remaining_count=${rem}, expires_at=${exp}, status='active'`);
  ins(M.unl, P.unl, "[QA] 무제한 정기권", "null", "null", "(current_date + 30)", "period");
  ins(M.ok, P.cnt, "[QA] 횟수권 정상", "10", "7", "(current_date + 30)", "count");
  ins(M.out, P.cnt, "[QA] 횟수권 소진", "10", "0", "(current_date + 30)", "count");
  // 소진(0회)이라도 앞으로 들을 예약이 남아 있으면 마이에서 계속 보여야 한다(lib/mypage 규칙) — 미래 예약 1건을 둔다.
  sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,status,pass_selection_mode,booking_deadline_min) values ('e9500000-0000-0000-0000-0000000000f1','${ID.centerPub}','[QA] 소진 카드용 수업',now()+interval '5 days',now()+interval '5 days 1 hour',5,'open','all',0) on conflict (id) do nothing`);
  sql(`insert into reservations(id,class_id,profile_id,membership_id,status) values ('e9600000-0000-0000-0000-0000000000f1','e9500000-0000-0000-0000-0000000000f1','${ID.pA1}','${M.out}','confirmed') on conflict (id) do nothing`);
  ins(M.old, P.cnt, "[QA] 횟수권 만료", "10", "4", "(current_date - 1)", "count");   // 저장 상태는 active 인데 만료일이 지남
});
test.afterAll(() => {
  sql(`delete from reservations where id='e9600000-0000-0000-0000-0000000000f1'`); sql(`delete from classes where id='e9500000-0000-0000-0000-0000000000f1'`);
  sql(`delete from memberships where id in ('${Object.values(M).join("','")}')`);
  sql(`delete from products where id in ('${P.unl}','${P.cnt}')`);
});

test("[실제 JWT] 마이: 무제한은 '무제한', 정상 횟수는 7회 / 10회 남음, 소진은 '모두 사용했어요'(기간 남음), NaN·null 문구 없음", async ({ page }) => {
  await loginAs(page, U.A, "a@test.invalid");
  await page.goto("/mypage");
  const card = (n: string) => page.locator(".membership-card", { hasText: n });
  await expect(page.locator(".membership-card").first()).toBeVisible({ timeout: 30_000 });
  const more = page.getByText("전체보기 ›").first();                                     // 수강권이 많으면 일부만 보이고 '전체보기'로 펼친다
  if (await more.count()) await more.click();
  await expect(card("[QA] 무제한 정기권")).toBeVisible();
  await expect(card("[QA] 무제한 정기권").locator(".count")).toHaveText("무제한");
  await expect(card("[QA] 횟수권 정상").locator(".count")).toContainText("7회");
  await expect(card("[QA] 횟수권 정상").locator(".count")).toContainText("10회 남음");
  await expect(card("[QA] 횟수권 소진").locator(".expire")).toContainText("모두 사용했어요");
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/NaN|null회|undefined/);
});

test("[실제 JWT] 구매 내역: 만료일이 지난 수강권은 '만료', 소진은 '소진', 정상은 '이용중', 무제한은 횟수 대신 '무제한'", async ({ page }) => {
  await loginAs(page, U.A, "a@test.invalid");
  await page.goto("/purchases");
  const item = (n: string) => page.locator(".purchase-item", { hasText: n });
  await expect(item("[QA] 횟수권 정상")).toBeVisible({ timeout: 30_000 });
  await expect(item("[QA] 횟수권 정상").locator(".purchase-status")).toHaveText("이용중");
  await expect(item("[QA] 횟수권 만료").locator(".purchase-status")).toHaveText("만료");
  await expect(item("[QA] 횟수권 소진").locator(".purchase-status")).toHaveText("소진");
  await expect(item("[QA] 무제한 정기권")).toContainText("무제한");
  await expect(item("[QA] 무제한 정기권").locator(".purchase-status")).toHaveText("이용중");
});
