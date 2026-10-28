import { test, expect, openAs, db, QA_CENTER_ID, gotoQaCenter, shot, need, uniq, restAs, denied, sessionToken } from "./helpers";
import type { BrowserContext, Page } from "@playwright/test";

/* [제한 직원 — QA 조회 전용 역할] 메뉴 노출·읽기 전용 화면·서버 거부 일치. 이 역할은 회원/후기/상품/주문/공지/직원 "조회"와 다른 직원 그룹 수업 조회만 가진다.
   UI 가 막혀 있어도 URL/REST 로 우회할 수 있는지(서버 거부)를 브라우저 세션 토큰으로 직접 확인한다. */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext; let page: Page;
test.beforeAll(async ({ browser }) => { ({ ctx, page } = await openAs(browser, "limited")); await gotoQaCenter(page, "/manager"); });
test.afterAll(async () => { await ctx.close(); });
const REVIEW_TEXT = "QA제한직원후기";

test("[제한직원] 메뉴 노출 — 사이드 메뉴에 권한 없는 쓰기성 메뉴가 없다(매출·알림톡·쿠폰·운영설정 등)", async () => {
  await shot(page, "06-limited-home");
  const items = await page.locator("nav a, aside a, .workspace-nav a, [class*=sidebar] a").allInnerTexts();
  const names = items.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  test.info().annotations.push({ type: "observed", description: `제한직원 메뉴: ${JSON.stringify(names)}` });
  expect(names.length).toBeGreaterThan(0);
  for (const hidden of ["매출·결제", "쿠폰", "알림톡", "운영 설정", "플랫폼 구독", "정산계좌"]) expect(names.join("|"), `${hidden} 메뉴는 권한이 없어 숨겨져야 함`).not.toContain(hidden);
});

test("[제한직원] 주문 화면 — 조회만 가능, '확정 · 발급'/'취소' 컨트롤 없음 + 서버가 발급 RPC 도 거부", async () => {
  const mine = await db().from("orders").insert({ center_id: QA_CENTER_ID(), profile_id: need("QA_MEMBER_PROFILE_ID"), product_id: need("QA_PRODUCT_ID"), product_name: "QA 10회권", amount: 100000, pay_method: "direct", payment_provider: "mock", status: "pending" }).select("id").single();
  expect(mine.error).toBeNull();
  await gotoQaCenter(page, "/manager/orders");
  await expect(page.getByText(/확인 대기 \([1-9]\d*\)/)).toBeVisible();
  await shot(page, "06-limited-orders");
  await expect(page.getByRole("button", { name: "확정 · 발급" })).toHaveCount(0);
  const pending = [{ id: mine.data!.id as string }];
  const r = await restAs(page).patch(`orders?id=eq.${pending[0].id}`, { status: "cancelled" });
  expect(denied(r), `주문 직접 취소가 서버에서 거부되어야 함: ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`).toBe(true);
  expect((await db().from("orders").select("status").eq("id", pending[0].id).single()).data?.status).toBe("pending");
});

test("[제한직원] 수업 등록 — UI 버튼은 보이지만 저장은 서버가 거부(DB 행 없음)", async () => {
  const title = uniq("QA제한수업");
  await gotoQaCenter(page, "/manager/classes");
  await page.locator(".workspace-create-class:visible, .fab-btn:visible").filter({ hasText: "수업 등록" }).first().click();
  await page.locator('input[placeholder="수업명"]').fill(title);
  await page.locator('input[type="date"]').fill(new Date(Date.now() + 3 * 86400000 + 9 * 3600000).toISOString().slice(0, 10));
  await page.getByRole("button", { name: "등록하기", exact: true }).click();
  await page.waitForTimeout(2500);
  await shot(page, "06-limited-class-create-attempt");
  expect((await db().from("classes").select("id").eq("title", title)).data?.length ?? 0).toBe(0);
  const direct = await restAs(page).post("classes", { center_id: QA_CENTER_ID(), title: `${title}-rest`, start_time: new Date(Date.now() + 86400000).toISOString(), end_time: new Date(Date.now() + 90000000).toISOString(), capacity: 5 });
  expect(denied(direct), `수업 REST 생성 거부: ${direct.status}`).toBe(true);
  expect((await db().from("classes").select("id").ilike("title", `${title}%`)).data?.length ?? 0).toBe(0);
});

test("[제한직원] 공지·쿠폰 — 쓰기 컨트롤 없음 + 서버 거부", async () => {
  await gotoQaCenter(page, "/manager/announcements");
  await expect(page.getByRole("button", { name: "+ 새 공지" })).toHaveCount(0);
  await shot(page, "06-limited-announcements");
  const t = uniq("QA제한공지");
  const n = await restAs(page).post("center_announcements", { center_id: QA_CENTER_ID(), title: t, content: "x" });
  expect(denied(n), `공지 REST 생성 거부: ${n.status}`).toBe(true);
  const c = await restAs(page).post("coupons", { center_id: QA_CENTER_ID(), name: t, discount_type: "amount", discount_value: 1000 });
  expect(denied(c), `쿠폰 REST 생성 거부: ${c.status}`).toBe(true);
  expect((await db().from("center_announcements").select("id").eq("title", t)).data?.length ?? 0).toBe(0);
});

test("[제한직원] 후기 — 답변·삭제 컨트롤 없음 + 서버가 답변 UPDATE 거부", async () => {
  await db().from("center_reviews").delete().eq("center_id", QA_CENTER_ID()).eq("profile_id", need("QA_MEMBER_PROFILE_ID"));
  const rv = await db().from("center_reviews").insert({ center_id: QA_CENTER_ID(), profile_id: need("QA_MEMBER_PROFILE_ID"), rating: 4, content: REVIEW_TEXT }).select("id").single();
  await gotoQaCenter(page, "/manager/reviews");
  await expect(page.getByText(REVIEW_TEXT)).toBeVisible();
  await shot(page, "06-limited-reviews");
  const replyBtn = await page.getByRole("button", { name: /답변 (달기|수정)/ }).count();
  const delBtn = await page.getByRole("button", { name: "삭제", exact: true }).count();
  test.info().annotations.push({ type: "observed", description: `답변 버튼 ${replyBtn}개, 삭제 버튼 ${delBtn}개(권한: facility.review.view 만)` });
  const r = await restAs(page).patch(`center_reviews?id=eq.${rv.data!.id}`, { reply: "무단 답변", replied_at: new Date().toISOString() });
  expect(denied(r), `후기 답변 REST 거부: ${r.status}`).toBe(true);
  expect((await db().from("center_reviews").select("reply").eq("id", rv.data!.id).single()).data?.reply).toBeNull();
  expect(replyBtn, "후기 답변 권한이 없으면 답변 버튼이 없어야 함").toBe(0);
});

test("[제한직원] 직원·권한 — 역할 변경/권한 편집 컨트롤 없음 + 서버가 역할 지정·권한 부여 거부", async () => {
  const target = need("QA_TARGET_ACCOUNT_ID"); const limitedRole = (await db().from("center_roles").select("id").eq("center_id", QA_CENTER_ID()).eq("name", "QA 조회 전용").single()).data!.id;
  await gotoQaCenter(page, "/manager/staff");
  await page.getByText("QA 변경대상직원", { exact: true }).first().click();
  await shot(page, "06-limited-staff-detail");
  const roleBtns = await page.getByRole("button", { name: "QA 조회 전용", exact: true }).count();
  test.info().annotations.push({ type: "observed", description: `직원 상세의 역할 변경 버튼 ${roleBtns}개` });
  const r1 = await restAs(page).patch(`manager_centers?account_id=eq.${target}&center_id=eq.${QA_CENTER_ID()}`, { role_id: limitedRole });
  expect(denied(r1), `역할 지정 REST 거부: ${r1.status}`).toBe(true);
  const r2 = await restAs(page).post("role_permissions", { role_id: limitedRole, permission_key: "facility.staff.delete" });
  expect(denied(r2), `권한 부여 REST 거부(권한 상승 방지): ${r2.status}`).toBe(true);
  expect((await db().from("role_permissions").select("id").eq("role_id", limitedRole).eq("permission_key", "facility.staff.delete")).data?.length ?? 0).toBe(0);
  expect(roleBtns, "권한 없는 직원에게 역할 변경 버튼이 보이면 안 됨").toBe(0);
});

test("[제한직원] 알림톡 — 발송 권한(message.alimtalk.view)이 없으면 화면·회원 목록 진입점·서버(send-alimtalk) 모두 거부", async () => {
  await gotoQaCenter(page, "/manager/alimtalk/send");
  await shot(page, "06-limited-alimtalk-send");
  await expect(page.getByText(/알림톡 보내기 화면을 볼 권한이 없어요/)).toBeVisible();   // 화면도 같은 권한으로 막힌다
  await gotoQaCenter(page, "/manager/members");
  await expect(page.getByRole("button", { name: "알림톡 발송" })).toHaveCount(0);   // 회원 목록의 알림톡 진입점도 숨김
  const token = await sessionToken(page);
  const res = await page.request.fetch(`${need("NEXT_PUBLIC_SUPABASE_URL")}/functions/v1/send-alimtalk`, { method: "POST", headers: { apikey: need("NEXT_PUBLIC_SUPABASE_ANON_KEY"), Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, data: JSON.stringify({ to: "01099999999", content: "QA 권한 확인(발송 금지 — 외부 자격증명 없음)", channel: "alimtalk", centerId: QA_CENTER_ID() }) });
  const body = (await res.text()).slice(0, 200);
  test.info().annotations.push({ type: "matrix", description: `제한직원(알림톡 권한 없음)의 send-alimtalk 직접 호출 → HTTP ${res.status()} ${body}` });
  expect([401, 403], `권한 없는 직원의 알림톡 발송 요청은 403 이어야 함(현재 ${res.status()}: ${body})`).toContain(res.status());
});
