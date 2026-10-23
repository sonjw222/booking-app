/* F01·F05 — 지급 쿠폰 회원 조회 + 자격 판정. 격리 PostgreSQL(저장소 마이그레이션) + 실제 회원/관리자 JWT. */
import { describe, expect, it, vi } from "vitest";
vi.mock("../../lib/supabaseClient", () => ({ supabase: {} }));   // 순수 함수(evaluateCoupon/rowToMemberCoupon)만 사용
import { clientFor, ID, sql, U } from "./support";
import { evaluateCoupon, rowToMemberCoupon } from "../../lib/coupons";

const manager = () => clientFor(U.M);
const memberB = () => clientFor(U.B);
const memberA = () => clientFor(U.A);
const HOUR = 3600_000;
let lastServerError = "";
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
let cmB = "";

async function makeCoupon(name: string, o: Record<string, unknown> = {}, productIds: string[] = []) {
  const r = await manager().from("coupons").insert({ center_id: ID.centerPub, name, discount_type: "fixed", discount_value: 5000, applies_to: productIds.length ? "selected" : "all", ...o }).select("id").single();
  expect(r.error, `쿠폰 생성 ${name}`).toBeNull();
  const id = (r.data as { id: string }).id;
  if (productIds.length) expect((await manager().from("coupon_products").insert(productIds.map((p) => ({ coupon_id: id, product_id: p })))).error).toBeNull();
  return id;
}
async function issueToB(couponId: string) {
  const r = await manager().rpc("issue_coupon_to_members", { p_coupon_id: couponId, p_center_member_ids: [cmB] });
  expect(r.error, "지급").toBeNull();
  return sql(`select id from member_coupons where coupon_id='${couponId}' and center_member_id='${cmB}' order by created_at desc limit 1`);
}
const myRows = async (c = memberB()) => { const r = await c.rpc("my_member_coupons"); return { error: r.error, rows: ((r.data ?? []) as Parameters<typeof rowToMemberCoupon>[0][]).map(rowToMemberCoupon) }; };
/** 서버 판정: 이 쿠폰으로 상품 e2(50,000원) 주문 금액 검증이 통과하는가(격리 DB에서 서버 함수 직접 호출). */
function serverAccepts(memberCouponId: string): boolean {
  const oid = sql(`insert into orders(center_id, profile_id, product_id, product_name, amount, member_coupon_id) values ('${ID.centerPub}','${ID.pB1}','${ID.prodOther}','[QA] 다른 수강권',50000,'${memberCouponId}') returning id`).split("\n")[0];
  try { sql(`select _order_expected_amount(o) from orders o where id='${oid}'`); return true; } catch (e) { lastServerError = String((e as Error).message).split("\n").find((l) => l.startsWith("ERROR")) ?? String(e).slice(0, 120); return false; } finally { sql(`delete from orders where id='${oid}'`); }
}

describe("F01 — 지급 쿠폰이 회원에게 보인다(권한 확대 없이)", () => {
  it("준비: B를 센터 회원으로 등록(관리자 권한)", async () => {
    await manager().from("center_members").insert({ center_id: ID.centerPub, profile_id: ID.pB1, app_linked: true });
    cmB = sql(`select id from center_members where center_id='${ID.centerPub}' and profile_id='${ID.pB1}'`);
    expect(cmB).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("수정 전 재현: member_coupons 에 coupons 를 임베드하면 회원에게는 정의가 null — 앱이 행을 걸러 '없는 것'처럼 보였다", async () => {
    const id = await makeCoupon("[QA] F01 지급 쿠폰", { discount_value: 3000 });
    await issueToB(id);
    const old = await memberB().from("member_coupons").select("id, status, coupons(id, name)");
    expect(old.error).toBeNull();
    const mine = (old.data as { coupons: unknown }[]).filter(Boolean);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.coupons === null)).toBe(true);                                      // 임베드 = null → 예전 fetchMyCoupons 는 전부 버림
  });

  it("수정 후: 내 쿠폰 조회 함수는 지급된 쿠폰의 정의를 돌려주고 정상 빈 목록과 오류가 구분된다", async () => {
    const { error, rows } = await myRows();
    expect(error).toBeNull();
    expect(rows.find((r) => r.couponName === "[QA] F01 지급 쿠폰")).toMatchObject({ status: "available", discountValue: 3000, centerId: ID.centerPub });
    expect(Number.isFinite(rows.length)).toBe(true);
    expect((await clientFor(null).rpc("my_member_coupons")).error).not.toBeNull();                 // 비로그인은 오류(빈 목록과 구분)
  });

  it("타인·미지급·타 센터 자료는 새지 않는다 / coupons·coupon_products 는 여전히 회원에게 닫혀 있다", async () => {
    const definedOnly = await makeCoupon("[QA] F01 미지급 정의");
    const a = await myRows(memberA());
    expect(a.error).toBeNull();
    expect(a.rows.map((r) => r.couponName)).not.toContain("[QA] F01 지급 쿠폰");                    // A 는 B 의 쿠폰을 볼 수 없다
    const b = await myRows();
    expect(b.rows.map((r) => r.couponName)).not.toContain("[QA] F01 미지급 정의");                  // 지급되지 않은 쿠폰 정의는 안 보인다
    expect(b.rows.every((r) => r.centerId === ID.centerPub)).toBe(true);
    expect((await memberB().from("coupons").select("id").eq("id", definedOnly)).data).toEqual([]);   // 정책 확대 없음
    expect((await memberB().from("coupon_products").select("id")).data).toEqual([]);
  });
});

describe("F05 — 쿠폰 자격: 화면 판정(evaluateCoupon) = 서버 판정(_order_expected_amount)", () => {
  const ctx = (extra: Partial<Parameters<typeof evaluateCoupon>[1]> = {}) => ({ productId: ID.prodOther, price: 50000, centerId: ID.centerPub, ...extra });
  async function scenario(label: string, mk: () => Promise<string>, after?: (mcId: string) => void) {
    const couponId = await mk();
    const mcId = await issueToB(couponId);
    after?.(mcId);
    const row = (await myRows()).rows.find((r) => r.id === mcId)!;
    expect(row, label).toBeTruthy();
    return { ui: evaluateCoupon(row, ctx()), server: serverAccepts(mcId), row };
  }

  it("사용 가능(전체 적용 / 적용 상품 지정)", async () => {
    const all = await scenario("all", () => makeCoupon("[QA] F05 전체"));
    expect(all.ui.ok).toBe(true); expect(all.server, lastServerError).toBe(true);
    const sel = await scenario("selected-ok", () => makeCoupon("[QA] F05 지정 포함", {}, [ID.prodOther]));
    expect(sel.ui.ok).toBe(true); expect(sel.server).toBe(true);
  });
  it("시작 전 / 만료 후 / 유효기간 안", async () => {
    const early = await scenario("not_started", () => makeCoupon("[QA] F05 시작전", { valid_from: iso(48 * HOUR) }));
    expect(early.ui).toEqual({ ok: false, reason: "not_started" }); expect(early.server).toBe(false);
    const late = await scenario("expired", () => makeCoupon("[QA] F05 만료", { valid_from: iso(-72 * HOUR), valid_until: iso(-1 * HOUR) }));
    expect(late.ui).toEqual({ ok: false, reason: "expired" }); expect(late.server).toBe(false);
    const inside = await scenario("window", () => makeCoupon("[QA] F05 기간내", { valid_from: iso(-HOUR), valid_until: iso(24 * HOUR) }));
    expect(inside.ui.ok).toBe(true); expect(inside.server).toBe(true);
  });
  it("최소 결제금액 / 적용 상품 불일치", async () => {
    const min = await scenario("min_amount", () => makeCoupon("[QA] F05 최소금액", { minimum_order_amount: 60000 }));
    expect(min.ui).toEqual({ ok: false, reason: "min_amount" }); expect(min.server).toBe(false);
    const other = await scenario("other_product", () => makeCoupon("[QA] F05 다른상품", {}, [ID.prodFree]));
    expect(other.ui).toEqual({ ok: false, reason: "other_product" }); expect(other.server).toBe(false);
  });
  it("사용됨 / 회수됨", async () => {
    const used = await scenario("used", () => makeCoupon("[QA] F05 사용됨"), (id) => sql(`update member_coupons set status='used', used_at=now() where id='${id}'`));
    expect(used.ui).toEqual({ ok: false, reason: "not_available" }); expect(used.server).toBe(false);
    const revoked = await scenario("revoked", () => makeCoupon("[QA] F05 회수됨"), (id) => sql(`update member_coupons set status='revoked' where id='${id}'`));
    expect(revoked.ui).toEqual({ ok: false, reason: "not_available" }); expect(revoked.server).toBe(false);
  });
  it("다른 센터에서는 쓸 수 없다(화면 판정)", async () => {
    const row = (await myRows()).rows.find((r) => r.couponName === "[QA] F05 전체")!;
    expect(evaluateCoupon(row, ctx({ centerId: ID.centerPriv }))).toEqual({ ok: false, reason: "other_center" });
  });
});
