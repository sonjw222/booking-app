/* 회원 브라우저 통합 흐름(격리 PostgREST + 실제 JWT, 로컬 Next dev). 알림·결제 외부 전송 없음.
   1) 홈 → 하단/사이드 탭 '마이' 링크 이동 → 로그아웃 확인창(취소/확인), 마우스·키보드 모두. 2) 예약 화면: 대기 불가 안내(F10), 정상 예약 → DB 차감 → 취소 → 복구. */
import { expect, test } from "@playwright/test";
import { ID, sql, U } from "./support";
import { loginAs } from "./uiLogin";

const CLS = { ok: "d8000000-0000-0000-0000-0000000000a1", full: "d8000000-0000-0000-0000-0000000000a2" };
const MEM = "d8100000-0000-0000-0000-0000000000a1";
const PRODUCT = "e1000000-0000-0000-0000-0000000000e1";

test.afterAll(() => {
  sql(`delete from reservations where class_id::text like 'd8000000-%'`);
  sql(`delete from classes where id::text like 'd8000000-%'`);
  sql(`delete from memberships where id='${MEM}'`);
  sql(`update center_settings set waitlist_weekly_limit=0 where center_id='${ID.centerPub}'`);
});

test("[실제 JWT] 홈 → 링크 이동으로 마이 → 로그아웃: 취소는 닫기만, 확인은 로그아웃(새로고침·직접 이동 우회 없음), 키보드로도 동작", async ({ page }) => {
  await loginAs(page, U.A, "a@test.invalid");
  await page.goto("/");
  await page.getByRole("link", { name: /마이/ }).first().click();
  await page.waitForURL(/\/mypage/);
  const logout = page.locator(".logout-row");
  await expect(logout).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(Math.round((page.viewportSize()?.width ?? 800) * 0.6), 300);   // 사람의 포인터 이동(자동화 도구는 클릭 전까지 포인터를 옮기지 않음)
  await logout.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toHaveCount(1);
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/mypage");
  await logout.focus(); await page.keyboard.press("Enter");                               // 키보드로 다시 열기
  await expect(dialog).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await logout.click();
  await dialog.getByRole("button", { name: "확인" }).click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).not.toMatch(/^\/mypage/);
});

test("[실제 JWT] 예약 화면: 정원 마감 + 대기 횟수 0이면 버튼 대신 '마감 · 대기 불가', 일반 수업은 예약 → 차감 → 취소 → 복구", async ({ page }) => {
  sql(`update center_settings set waitlist_weekly_limit=0 where center_id='${ID.centerPub}'`);
  const start = (h: number) => `(date_trunc('day', now() at time zone 'Asia/Seoul') + interval '2 days' + interval '${h} hours') at time zone 'Asia/Seoul'`;
  sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,status,pass_selection_mode,booking_deadline_min) values ('${CLS.ok}','${ID.centerPub}','[QA] UI 예약 수업',${start(10)},${start(11)},5,'open','all',0),('${CLS.full}','${ID.centerPub}','[QA] UI 마감 수업',${start(12)},${start(13)},1,'open','all',0) on conflict (id) do nothing`);
  sql(`insert into memberships(id,profile_id,center_id,product_id,product_name,total_count,remaining_count,status,pass_type,expires_at) values ('${MEM}','${ID.pA1}','${ID.centerPub}','${PRODUCT}','[QA] 공개 무료권',3,3,'active','count',(current_date + 60)) on conflict (id) do update set remaining_count=3,status='active'`);
  sql(`insert into reservations(class_id,profile_id,membership_id,status) values ('${CLS.full}','${ID.pB1}',null,'confirmed') on conflict do nothing`);
  await loginAs(page, U.A, "a@test.invalid");
  await page.goto(`/reservation?center=${ID.centerPub}`);
  // 이틀 뒤 날짜로 이동: 캘린더에서 날짜 칸 클릭(수업이 있는 날)
  const target = await page.evaluate(() => { const d = new Date(Date.now() + 2 * 86400000); return d.getDate(); });
  await expect(page.locator(".reservation-calendar, .cal-grid, .resv-cal").first()).toBeVisible({ timeout: 30_000 }).catch(() => {});
  const dayCell = page.locator(`button:has-text("${target}")`).filter({ hasNot: page.locator("input") }).first();
  if (await dayCell.count()) await dayCell.click().catch(() => {});
  const okRow = page.locator(".class-row", { hasText: "[QA] UI 예약 수업" });
  await expect(okRow).toBeVisible({ timeout: 30_000 });
  const fullRow = page.locator(".class-row", { hasText: "[QA] UI 마감 수업" });
  await expect(fullRow).toBeVisible();
  await expect(fullRow.locator(".mini-btn-note")).toContainText("대기 불가");               // F10: 서버가 거절할 조건을 미리 안내
  await expect(fullRow.getByRole("button", { name: /대기|예약/ })).toHaveCount(0);
  // 정상 예약
  await okRow.getByRole("button", { name: "예약" }).click();
  const sheet = page.locator(".sheet", { hasText: "예약하시겠어요?" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("수강권 조건만 확인한 상태예요")).toBeVisible();              // F10 안내
  await sheet.getByRole("button", { name: "예약하기" }).click();
  await expect.poll(() => sql(`select remaining_count from memberships where id='${MEM}'`), { timeout: 20_000 }).toBe("2");
  expect(sql(`select status from reservations where class_id='${CLS.ok}' and profile_id='${ID.pA1}'`)).toBe("confirmed");
  // 취소 → 복구
  const cancelBtn = okRow.getByRole("button", { name: "취소" });
  await expect(cancelBtn).toBeVisible({ timeout: 20_000 });
  await cancelBtn.click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible({ timeout: 15_000 });                                  // 취소 전 확인창(비동기로 뜸)
  await confirm.getByRole("button", { name: "확인" }).click();
  await expect.poll(() => sql(`select remaining_count from memberships where id='${MEM}'`), { timeout: 20_000 }).toBe("3");
  expect(sql(`select status from reservations where class_id='${CLS.ok}' and profile_id='${ID.pA1}'`)).toBe("cancelled");
});
