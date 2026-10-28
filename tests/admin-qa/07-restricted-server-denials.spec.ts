import { test, expect, openAs, db, QA_CENTER_ID, gotoQaCenter, need, uniq, restAs, denied } from "./helpers";
import type { BrowserContext, Page } from "@playwright/test";

/* [제한 직원] UI 를 우회한 쓰기 시도 표 — 모두 서버(RLS/RPC)가 거부해야 하고, 서비스 롤로 확인한 DB 값은 그대로여야 한다. 읽기 허용 항목은 대조군으로 성공해야 한다. */
let ctx: BrowserContext; let page: Page;
test.beforeAll(async ({ browser }) => { ({ ctx, page } = await openAs(browser, "limited")); await gotoQaCenter(page, "/manager/members"); });
test.afterAll(async () => { await ctx.close(); });
const C = () => QA_CENTER_ID();

test("[제한직원] 대조군 — 허용된 조회(회원·상품·주문·후기·직원)는 성공", async () => {
  const api = restAs(page);
  for (const t of ["center_members?select=id&limit=1", "products?select=id&limit=1", "orders?select=id&limit=1", "center_reviews?select=id&limit=1", "manager_centers?select=id&limit=1"]) {
    const r = await api.get(`${t}${t.includes("center_id") ? "" : `&center_id=eq.${C()}`}`);
    expect(r.status, t).toBe(200);
  }
});

let memberCount = 0; let victimMembership = ""; let victimExpiry = "";
test.beforeAll(async () => {
  const ms = (await db().from("memberships").select("id,expires_at").eq("center_id", C()).eq("profile_id", need("QA_MEMBER_PROFILE_ID"))).data ?? [];
  if (!ms.length) { const r = await db().from("memberships").insert({ center_id: C(), profile_id: need("QA_MEMBER_PROFILE_ID"), product_id: need("QA_PRODUCT_ID"), product_name: "QA 10회권", pass_type: "count", total_count: 10, remaining_count: 10 }).select("id,expires_at").single(); ms.push(r.data!); }
  memberCount = ms.length; victimMembership = ms[0].id; victimExpiry = ms[0].expires_at;
});
const attempts: Array<{ name: string; run: (a: ReturnType<typeof restAs>) => Promise<{ status: number; json: unknown }>; verify?: () => Promise<boolean> }> = [
  { name: "운영 설정 변경(facility.operation 없음)", run: (a) => a.patch(`center_settings?center_id=eq.${C()}`, { group_book_days_before: 99 }), verify: async () => (await db().from("center_settings").select("group_book_days_before").eq("center_id", C()).maybeSingle()).data?.group_book_days_before !== 99 },
  { name: "센터 정보 변경(facility.info 없음)", run: (a) => a.patch(`centers?id=eq.${C()}`, { name: "무단 변경" }), verify: async () => (await db().from("centers").select("name").eq("id", C()).single()).data?.name === "관리자QA센터" },
  { name: "룸 추가(facility.room.manage 없음)", run: (a) => a.post("rooms", { center_id: C(), name: uniq("무단룸") }) },
  { name: "회원 등록(customer.member.create 없음)", run: (a) => a.post("center_members", { center_id: C(), profile_id: need("QA_MEMBER_PROFILE_ID") }) },
  { name: "결제 등록(pass.payment.create 없음)", run: (a) => a.post("payments", { center_id: C(), profile_id: need("QA_MEMBER_PROFILE_ID"), total_amount: 1000, card_amount: 1000, sale_type: "new", status: "paid" }) },
  { name: "수강권 상품 수정(pass.update 없음)", run: (a) => a.patch(`products?id=eq.${need("QA_PRODUCT_ID")}`, { price: 1 }), verify: async () => (await db().from("products").select("price").eq("id", need("QA_PRODUCT_ID")).single()).data?.price === 100000 },
  { name: "상품 판매 정지(pass.sale_toggle 없음)", run: (a) => a.patch(`products?id=eq.${need("QA_PRODUCT_ID")}`, { is_on_sale: false }), verify: async () => (await db().from("products").select("is_on_sale").eq("id", need("QA_PRODUCT_ID")).single()).data?.is_on_sale === true },
  { name: "수강권 지급 RPC(customer.member.issue_pass 없음)", run: (a) => a.rpc("manager_grant_product", { p_center_id: C(), p_profile_id: need("QA_MEMBER_PROFILE_ID"), p_product_id: need("QA_PRODUCT_ID"), p_price: 100000, p_pay_method: "card" }), verify: async () => ((await db().from("memberships").select("id").eq("center_id", C()).eq("profile_id", need("QA_MEMBER_PROFILE_ID"))).data?.length ?? 0) === memberCount },
  { name: "수강권 만료일 연장 RPC(pass_expiry.update 없음)", run: (a) => a.rpc("manager_extend_membership_expiry", { p_membership_id: victimMembership, p_mode: "days", p_days: 30 }), verify: async () => (await db().from("memberships").select("expires_at").eq("id", victimMembership).single()).data?.expires_at === victimExpiry },
];
for (const at of attempts) {
  test(`[제한직원] 서버 거부 — ${at.name}`, async () => {
    const before = at.verify ? await at.verify() : true; expect(before).toBe(true);
    const r = await at.run(restAs(page));
    test.info().annotations.push({ type: "observed", description: `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 140)}` });
    expect(r.status, "함수/테이블이 없어서(404) 거부된 것처럼 보이면 안 됨 — 시험 자체가 무효").not.toBe(404);
    expect(denied(r), `거부되어야 함: ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`).toBe(true);
    if (at.verify) expect(await at.verify(), "DB 값이 변하지 않아야 함").toBe(true);
  });
}
test("[제한직원] 정리 확인 — 무단 시도로 생긴 행이 없다", async () => {
  expect((await db().from("rooms").select("id").eq("center_id", C()).ilike("name", "무단룸%")).data?.length ?? 0).toBe(0);
  expect((await db().from("payments").select("id").eq("center_id", C()).eq("total_amount", 1000)).data?.length ?? 0).toBe(0);
});
