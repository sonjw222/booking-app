/* F01 화면: 관리자가 지급한 쿠폰이 회원의 '내 쿠폰'에 보이고(실제 JWT·격리 DB), 다른 계정/미지급 쿠폰은 안 보이며, 조회 실패는 '보유한 쿠폰이 없어요'가 아니라 오류로 보인다(실패는 응답 조작이므로 이름에 표시). */
import { expect, test } from "@playwright/test";
import { ID, sql, U } from "./support";
import { loginAs } from "./uiLogin";

const C = { mine: "e9800000-0000-0000-0000-0000000000c1", other: "e9800000-0000-0000-0000-0000000000c2", undelivered: "e9800000-0000-0000-0000-0000000000c3" };
const MC = { mine: "e9810000-0000-0000-0000-0000000000c1", other: "e9810000-0000-0000-0000-0000000000c2" };
const CM = { b: "", a: "" };   // 센터 회원 행은 다른 흐름이 이미 만들었을 수 있어 id 를 조회해 쓴다

test.beforeAll(() => {
  sql(`insert into center_members(center_id,profile_id) values ('${ID.centerPub}','${ID.pB1}'),('${ID.centerPub}','${ID.pA1}') on conflict (center_id, profile_id) do nothing`);
  CM.b = sql(`select id from center_members where center_id='${ID.centerPub}' and profile_id='${ID.pB1}'`); CM.a = sql(`select id from center_members where center_id='${ID.centerPub}' and profile_id='${ID.pA1}'`);
  const mk = (id: string, name: string) => sql(`insert into coupons(id,center_id,name,discount_type,discount_value,applies_to) values ('${id}','${ID.centerPub}','${name}','fixed',5000,'all') on conflict (id) do nothing`);
  mk(C.mine, "[QA] 내 지급 쿠폰"); mk(C.other, "[QA] 다른 회원 쿠폰"); mk(C.undelivered, "[QA] 미지급 쿠폰");
  sql(`insert into member_coupons(id,coupon_id,center_member_id,status) values ('${MC.mine}','${C.mine}','${CM.b}','available'),('${MC.other}','${C.other}','${CM.a}','available') on conflict (id) do nothing`);
});
test.afterAll(() => {
  sql(`delete from member_coupons where id in ('${MC.mine}','${MC.other}')`); sql(`delete from coupons where id in ('${C.mine}','${C.other}','${C.undelivered}')`);
});

test("[실제 JWT] 내 쿠폰: 본인에게 지급된 쿠폰만 보이고 다른 회원·미지급 쿠폰은 보이지 않는다", async ({ page }) => {
  await loginAs(page, U.B, "b@test.invalid");
  await page.goto("/mypage/coupons");
  await expect(page.getByText("[QA] 내 지급 쿠폰")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("[QA] 다른 회원 쿠폰")).toHaveCount(0);
  await expect(page.getByText("[QA] 미지급 쿠폰")).toHaveCount(0);
  await expect(page.getByText("보유한 쿠폰이 없어요")).toHaveCount(0);
});

test("[실제 JWT] 지급받은 쿠폰이 없는 회원은 정상 빈 목록('보유한 쿠폰이 없어요')", async ({ page }) => {
  sql(`update member_coupons set status='available' where id='${MC.other}'`);
  await loginAs(page, U.M, "m@test.invalid");     // 센터 오너 계정의 회원 프로필에는 지급 쿠폰이 없다
  await page.goto("/mypage/coupons");
  await expect(page.getByText("보유한 쿠폰이 없어요")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("쿠폰을 불러오지 못했어요")).toHaveCount(0);
});

test("[응답 조작(mock)] 조회 실패(RPC 500)는 빈 목록이 아니라 오류 + 다시 시도로 표시된다", async ({ page }) => {
  await page.route("**/rpc/my_member_coupons*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) }));
  await loginAs(page, U.B, "b@test.invalid");
  await page.goto("/mypage/coupons");
  await expect(page.getByText("쿠폰을 불러오지 못했어요")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("보유한 쿠폰이 없어요")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible();
});
