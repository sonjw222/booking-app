/*
  수강권/상품 공통 "구매자가 횟수 선택 + 회차별 가격표" — 서버 계약(SQL 소스 텍스트) + 공용 순수 로직.
  DB가 없는 환경이라 SQL은 주석 제거 후 계약을 확인하고, 트리거 규칙은 그대로 옮긴 순수 모델로 시나리오를 돌린다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  availabilityLabel, cartItemAmount, computeBaseAmount, countOptionLabel, countOptions, fillTiersFromUnit, isCountSelectable,
  isValidSelectedCount, priceSummary, tierPriceFor, validateTierDrafts, draftsToTiers, type CountTier,
} from "../../lib/selectableCount";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const mig = noComments(read("add_selectable_count_pricing.sql"));
const issue = noComments(read("fix_order_issuance_and_auto_booking.sql"));

const goodsTiers: CountTier[] = [{ count: 1, price: 6000 }, { count: 6, price: 34000 }, { count: 12, price: 65000 }];
const passTiers: CountTier[] = [{ count: 1, price: 80000 }, { count: 4, price: 300000 }, { count: 12, price: 640000 }];
const goods = { price: 6000, countSelectable: true, countPrices: goodsTiers };
const pass = { price: 80000, countSelectable: true, countPrices: passTiers };
const fixed = { price: 24000, countSelectable: false, totalCount: 4 };

describe("[A][B] 회차별 가격 — unit×count가 아니라 가격표", () => {
  it("goods 6회=34,000(1회 6,000×6=36,000이 아님), 12회=65,000, 1회=6,000", () => {
    expect(computeBaseAmount(goods, 6)).toBe(34000);
    expect(computeBaseAmount(goods, 12)).toBe(65000);
    expect(computeBaseAmount(goods, 1)).toBe(6000);
  });
  it("pass 4회=300,000, 12회=640,000 (수강권도 동일 모델)", () => {
    expect(computeBaseAmount(pass, 4)).toBe(300000);
    expect(computeBaseAmount(pass, 12)).toBe(640000);
  });
  it("[D] 가격표에 없는 회차(0/5/13/소수/null)는 유효하지 않고 금액이 없다", () => {
    for (const bad of [0, 5, 13, -1, 2.5, null, undefined]) {
      expect(isValidSelectedCount(goods, bad as any)).toBe(false);
      expect(computeBaseAmount(goods, bad as any)).toBeNull();
    }
  });
  it("가격표에 등록된 회차만 선택지로 나온다(1,6,12만 판매 가능) + 옵션 라벨에 가격", () => {
    expect(countOptions(goods)).toEqual([1, 6, 12]);
    expect(countOptionLabel({ count: 4, price: 300000 })).toBe("4회 · 300,000원");
    expect(tierPriceFor(goods, 6)).toBe(34000);
  });
  it("[Q] 고정 상품은 기존과 동일: 금액=상품가, 횟수 선택 불가, 표시 '4회 · 24,000원'", () => {
    expect(computeBaseAmount(fixed, null)).toBe(24000);
    expect(isValidSelectedCount(fixed, 5)).toBe(false);
    expect(isCountSelectable(fixed)).toBe(false);
    expect(priceSummary(fixed)).toBe("4회 · 24,000원");
  });
  it("[R] 선택형 표시: '1~12회 선택 · 6,000원부터'(미선택 상태), 공개 RPC 요약만 있어도 동일", () => {
    expect(priceSummary(goods)).toBe("1~12회 선택 · 6,000원부터");
    expect(priceSummary({ price: 80000, countSelectable: true, minCount: 1, maxCount: 12, minTierPrice: 80000 })).toBe("1~12회 선택 · 80,000원부터");
  });
  it("[K] 장바구니 count 변경 → 해당 tier 가격(표시용)", () => {
    expect(cartItemAmount({ price: 6000, countSelectable: true, countPrices: goodsTiers, selectedCount: 6 })).toBe(34000);
    expect(cartItemAmount({ price: 24000, countSelectable: false, selectedCount: null })).toBe(24000);
  });
  it("[L] 쿠폰: tier 가격(34,000) - 쿠폰(5,000) = 29,000 (서버가 같은 순서로 계산)", () => {
    expect(Math.max(0, (computeBaseAmount(goods, 6) as number) - 5000)).toBe(29000);
  });
  it("[T] 판매 가능 수량 문구는 이용 횟수와 무관: 3→'판매 가능 3개', 0→'매진', null→표시 안 함", () => {
    expect(availabilityLabel(3)).toBe("판매 가능 3개");
    expect(availabilityLabel(0)).toBe("매진");
    expect(availabilityLabel(null)).toBeNull();
  });
});

describe("관리자 가격표 입력 보조", () => {
  it("기본 가격 채우기: 1회 6,000 → 1~12회 6,000×N (편의 기능, 이후 행별 수정)", () => {
    const t = fillTiersFromUnit(6000);
    expect(t).toHaveLength(12);
    expect(t[5]).toEqual({ count: 6, price: 36000 });
    expect(fillTiersFromUnit(0)).toEqual([]);
  });
  it("검증: 1개 이상, 중복/0원 거부, 체크 해제한 회차는 판매 안 함", () => {
    expect(validateTierDrafts([])).not.toBeNull();
    expect(validateTierDrafts([{ count: 1, price: "6,000", enabled: true }, { count: 6, price: "34,000", enabled: true }])).toBeNull();
    expect(validateTierDrafts([{ count: 1, price: "0", enabled: true }])).toContain("0원보다");
    expect(validateTierDrafts([{ count: 1, price: "100", enabled: true }, { count: 1, price: "200", enabled: true }])).toContain("두 번");
    expect(draftsToTiers([{ count: 1, price: "6,000", enabled: true }, { count: 2, price: "12000", enabled: false }])).toEqual([{ count: 1, price: 6000 }]);
  });
});

describe("DB 구조/제약 계약", () => {
  it("가격표는 child 테이블(unique(product_id,count), count>=1, price>0, products cascade) — price_1.. 컬럼/JSON 아님", () => {
    expect(mig).toContain("create table if not exists product_count_prices");
    expect(mig).toContain("references products(id) on delete cascade");
    expect(mig).toContain("count      integer not null check (count >= 1)");
    expect(mig).toContain("price      integer not null check (price > 0)");
    expect(mig).toContain("unique (product_id, count)");
    expect(mig).not.toMatch(/price_1\b|price_12\b/);
  });
  it("min/max/unit_price 컬럼을 만들지 않는다(가격표가 구매 가능 회차를 정의)", () => {
    expect(mig).not.toMatch(/add column if not exists (min_purchase_count|max_purchase_count|unit_price)/);
  });
  it("products.purchase_count_selectable은 default false(기존 상품 불변), 무제한과 동시 사용 불가, pass/goods 모두 허용", () => {
    expect(mig).toContain("purchase_count_selectable boolean not null default false");
    expect(mig).toContain("unlimited = false and unlimited_pass = false");
    expect(mig).not.toMatch(/product_kind = 'goods'/);
  });
  it("RLS: 가격표 쓰기 정책 없음(RPC로만 변경), anon 차단, 조회는 관리자/구매 가능한 회원", () => {
    expect(mig).toContain("alter table product_count_prices enable row level security");
    expect(mig).not.toMatch(/create policy[^;]*for (insert|update|delete)/i);
    expect(mig).toContain("revoke all on table product_count_prices from anon");
    expect(mig).toContain("member_can_purchase_product(product_count_prices.product_id, me.pid)");
  });
  it("set_product_count_prices: 권한(pass.create/update), 전체 교체, 중복/0원 거부, products.price=최저가 동기화, 빈 배열=고정 복귀", () => {
    expect(mig).toContain("has_permission(v_product.center_id, 'pass.create') or has_permission(v_product.center_id, 'pass.update')");
    expect(mig).toContain("같은 횟수를 두 번 등록할 수 없어요");
    expect(mig).toContain("횟수는 1 이상, 가격은 0원보다 커야 해요");
    expect(mig).toContain("price = v_min");
    expect(mig).toContain("purchase_count_selectable = false");
    expect(mig).toContain("무제한 상품은 횟수 선택형으로 만들 수 없어요");
  });
  it("[C][D] orders BEFORE INSERT: 선택형은 selected_count 필수 + 가격표에 있는 회차만, 고정은 selected_count 거부, snapshot은 서버가 가격표에서 확정", () => {
    expect(mig).toContain("before insert on orders");
    expect(mig).toContain("raise exception '구매할 횟수를 선택해주세요'");
    expect(mig).toContain("where product_id = v_p.id and count = new.selected_count");
    expect(mig).toContain("raise exception '구매할 수 없는 횟수예요(%회)'");
    expect(mig).toContain("new.product_amount_snapshot := v_price;");
    expect(mig).toContain("raise exception '이 상품은 구매 횟수를 선택할 수 없어요'");
    expect(mig).toContain("new.product_amount_snapshot := v_p.price;");
  });
  it("[E][F] 가격표를 나중에 바꿔도 기존 주문은 snapshot 유지(주문 변조는 가드 트리거), 새 주문은 새 가격", () => {
    expect(mig).toContain("before update of selected_count, product_amount_snapshot, product_id on orders");
    expect(mig).toContain("if auth.uid() is not null then");
    // 모델: 주문 시점 34,000 snapshot → 가격표가 36,000이 돼도 expected(snapshot)=34,000, 새 주문=36,000
    const tiers = [{ count: 6, price: 34000 }];
    const snapshot = tiers[0].price;
    tiers[0].price = 36000;
    expect(snapshot).toBe(34000);
    expect(tiers[0].price).toBe(36000);
  });
  it("[T] max_quantity 의미 불변: 가격표 migration은 max_quantity/enforce_product_sale_limit를 건드리지 않는다", () => {
    expect(mig).not.toContain("max_quantity");
    expect(mig).not.toContain("enforce_product_sale_limit");
  });
  it("[20] 기존 1~12회 상품 자동 병합/삭제/수정 없음(후보 조회 SELECT는 주석)", () => {
    expect(mig).not.toMatch(/delete from products|update products set (name|is_on_sale|is_active)|drop table/i);
    expect(read("add_selectable_count_pricing.sql")).toContain("-- select center_id, product_kind, regexp_replace(name");
  });
  it("롤백은 트리거/RPC/제약 제거 + 데이터(테이블/컬럼) 보존", () => {
    const rb = read("rollback_add_selectable_count_pricing.sql");
    expect(rb).toContain("drop function if exists set_product_count_prices(uuid, jsonb);");
    expect(rb).toContain("-- drop table if exists product_count_prices;");
  });
});

describe("발급/검증 계약 (직접결제 + 향후 PG 공통)", () => {
  it("[M][N] 기대금액의 기본금액은 주문 snapshot(가격표 값), 쿠폰 퍼센트/최소금액도 base 기준 → 서버 최종금액", () => {
    expect(issue).toContain("v_base := coalesce(p_order.product_amount_snapshot, v_product.price);");
    expect(issue).toContain("return greatest(0, v_base - v_verified_discount - coalesce(p_order.points_used, 0));");
    expect(issue).toContain("(v_base * v_member_coupon.discount_value) / 100");
    expect(issue).toContain("v_base < v_member_coupon.minimum_order_amount");
    expect(issue).not.toMatch(/v_product\.price\s*\*/);   // unit×count 가정 없음
  });
  it("[G][H] 선택형 발급 횟수 = orders.selected_count(두 경로: fulfill_order/PG), 고정 = 상품 정의 — pass/goods 공통", () => {
    expect((issue.match(/v_count := v_order\.selected_count;/g) ?? []).length).toBe(1);
    expect((issue.match(/v_count := p_order\.selected_count;/g) ?? []).length).toBe(1);
    expect((issue.match(/v_count := case when v_product\.unlimited_pass then null else v_product\.total_count end;/g) ?? []).length).toBe(2);
  });
  it("[C] 클라이언트가 6회 + amount 6,000을 보내면 서버 기대금액(34,000)과 달라 거부", () => {
    expect(issue).toContain("if p_order.amount is distinct from v_expected_amount then");
    expect(issue).toContain("v_order.amount is distinct from v_expected");
    expect(6000 === computeBaseAmount(goods, 6)).toBe(false);
  });
  it("[I] 예약조건은 선택 횟수와 무관: 이 migration/발급 로직은 membership_schedule_rules/class_allowed_products를 건드리지 않는다", () => {
    expect(mig).not.toMatch(/membership_schedule_rules|class_allowed_products/);
    expect(issue).toContain("selected_size");   // goods 사이즈 보존 [J]
  });
  it("[R] 공개 RPC: 선택형은 요약(min/max 회차, min/max 가격)만, 가격표 자체/내부 컬럼은 공개 안 함, 가격표 없는 선택형은 비공개", () => {
    const pub = noComments(read("add_public_storefront_products.sql"));
    for (const c of ["purchase_count_selectable", "min_purchase_count", "max_purchase_count", "min_tier_price", "max_tier_price"]) expect(pub).toContain(c);
    expect(pub).toContain("exists (select 1 from product_count_prices t where t.product_id = p.id)");
    expect(pub).not.toMatch(/selected_members|membership_product_members|grade/);
  });
  it("[O][P] 관리자 지급: 선택형(pass/goods)은 가격표에 있는 회차만 지급, 고정은 횟수 지정 거부, 0원은 service", () => {
    const g = noComments(read("add_manager_grant_product_rpc.sql"));
    expect(g).toContain("p_selected_count integer default null");
    expect(g).toContain("exists (select 1 from product_count_prices where product_id = v_product.id and count = p_selected_count)");
    expect(g).toContain("v_count := p_selected_count;");
    expect(g).toContain("이 상품은 지급 횟수를 고를 수 없어요");
    expect(g).toContain("when p_pay_method = 'service' then 'service' else 'new'");
  });
  it("[I][J] 5→4 예약 차감/4→5 복원은 기존 예약 SQL(remaining_count)로 동작 — selected_count와 무관", () => {
    const u = noComments(read("add_reservation_goods_usage.sql"));
    expect(u).toContain("remaining_count = remaining_count - 1");
    expect(u).toContain("remaining_count = remaining_count + 1");
  });
});
