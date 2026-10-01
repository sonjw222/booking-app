/*
  구매 횟수 선택형(회차별 가격표) pass/goods — 회원 측(2026-10-01): 가격표 계산, 표시 문구, 장바구니 정책, 주문 저장, 판매 가능 수량 UI, 겹침 방지 CSS.
  가격은 UI 미리보기이고 최종 금액/발급 횟수는 서버가 주문 snapshot으로 확정한다(서버 거부 케이스는 SQL 계약/로직으로 확인).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const inserts: { table: string; row: any }[] = [];
const updates: { table: string; row: any }[] = [];
let existingCartRows: any[] = [];
const insertResult: any = { error: null, data: { id: "order-1" } };

function chain(table: string) {
  const c: any = {};
  for (const m of ["select", "eq", "is", "not", "order", "limit", "in", "single"]) c[m] = vi.fn(() => c);
  c.insert = (row: any) => { inserts.push({ table, row }); const r: any = { select: () => ({ single: async () => insertResult }), then: (res: any) => res({ error: insertResult.error }) }; return r; };
  c.update = (row: any) => { updates.push({ table, row }); return { eq: async () => ({ error: null }) }; };
  c.then = (res: any) => res({ data: table === "cart_items" ? existingCartRows : [{ id: "p1", is_primary: true }], error: null });
  return c;
}
vi.mock("../../lib/supabaseClient", () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: (t: string) => chain(t) } }));
vi.mock("../../lib/authAccount", () => ({ getMyAccountId: async () => "acct-1" }));

import {
  availabilityLabel, cartItemAmount, computeBaseAmount, countOptionLabel, countOptions, isCountSelectable, isValidSelectedCount,
  priceSummary, tierPriceFor, type CountSelectableInfo,
} from "../../lib/selectableCount";
import { previewDiscount } from "../../lib/coupons";
import { createOrder } from "../../lib/orders";
import { addToCart } from "../../lib/cart";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// 가격표 A: goods = 1회 6,000 / 6회 34,000(패키지 할인) / 12회 65,000 — unit×count가 아니다.
const shoes: CountSelectableInfo = {
  price: 6000, countSelectable: true,
  countPrices: [{ count: 1, price: 6000 }, { count: 6, price: 34000 }, { count: 12, price: 65000 }],
};
// pass = 1회 80,000 / 4회 300,000 / 12회 640,000
const sched: CountSelectableInfo = {
  price: 80000, countSelectable: true,
  countPrices: [{ count: 1, price: 80000 }, { count: 4, price: 300000 }, { count: 12, price: 640000 }],
};
const fixed: CountSelectableInfo & { totalCount: number } = { price: 24000, countSelectable: false, totalCount: 4 };

describe("[1][2][3] 가격표 계산(미리보기) — 회차별 독립 가격", () => {
  it("goods 6회 → 34,000원(6×6,000=36,000이 아님), 1회 6,000, 12회 65,000", () => {
    expect(computeBaseAmount(shoes, 6)).toBe(34000);
    expect(computeBaseAmount(shoes, 1)).toBe(6000);
    expect(computeBaseAmount(shoes, 12)).toBe(65000);
  });
  it("pass 4회 → 300,000원, 12회 640,000원", () => {
    expect(computeBaseAmount(sched, 4)).toBe(300000);
    expect(computeBaseAmount(sched, 12)).toBe(640000);
  });
  it("[3] 가격표에 없는 회차(0, 2, 5, 13, -1, 소수, null)는 금액 없음 — 유효하지 않음", () => {
    for (const bad of [0, 2, 5, 13, -1, 2.5, null, undefined]) {
      expect(isValidSelectedCount(shoes, bad as any)).toBe(false);
      expect(computeBaseAmount(shoes, bad as any)).toBeNull();
      expect(tierPriceFor(shoes, bad as any)).toBeNull();
    }
  });
  it("[14] 고정 상품은 기존과 동일: 상품가 그대로, 횟수 선택 불가", () => {
    expect(isCountSelectable(fixed)).toBe(false);
    expect(computeBaseAmount(fixed, null)).toBe(24000);
    expect(isValidSelectedCount(fixed, 3)).toBe(false);
    expect(countOptions(fixed)).toEqual([]);
  });
  it("횟수 옵션은 가격표에 등록된 회차만(정렬), 라벨은 '4회 · 300,000원'", () => {
    expect(countOptions({ countPrices: [{ count: 12, price: 1 }, { count: 4, price: 1 }, { count: 1, price: 1 }] })).toEqual([1, 4, 12]);
    expect(countOptionLabel({ count: 4, price: 300000 })).toBe("4회 · 300,000원");
  });
  it("[12] 쿠폰은 선택한 tier 가격 기준: 6회 34,000 - 5,000 = 29,000", () => {
    const base = computeBaseAmount(shoes, 6)!;
    const coupon = { discountType: "fixed", discountValue: 5000, maxDiscountAmount: null } as any;
    expect(Math.max(0, base - previewDiscount(base, coupon))).toBe(29000);
    const pct = { discountType: "percentage", discountValue: 10, maxDiscountAmount: null } as any;
    expect(previewDiscount(base, pct)).toBe(3400);   // 34,000의 10% (36,000 기준이 아님)
  });
});

describe("표시 문구", () => {
  it("선택형: '1~12회 선택 · 6,000원부터' / 고정: 기존 '4회 · 24,000원'", () => {
    expect(priceSummary({ ...shoes, countPrices: [{ count: 1, price: 6000 }, { count: 12, price: 65000 }] })).toBe("1~12회 선택 · 6,000원부터");
    expect(priceSummary(sched)).toBe("1~12회 선택 · 80,000원부터");
    expect(priceSummary(fixed)).toBe("4회 · 24,000원");
    expect(priceSummary({ ...fixed, totalCount: 0, unlimited: true })).toBe("무제한 · 24,000원");
  });
  it("[15] 공개(비로그인) 요약만 있어도 같은 문구: min/max 횟수 + 최저 가격", () => {
    expect(priceSummary({ price: 6000, countSelectable: true, minCount: 1, maxCount: 12, minTierPrice: 6000 })).toBe("1~12회 선택 · 6,000원부터");
  });
  it("공개 /products가 선택형 문구를 쓰고 고정 표시는 기존 그대로", () => {
    const page = stripTs(read("app/products/page.tsx"));
    expect(page).toContain("isCountSelectable(p)");
    expect(page).toContain("priceSummary(p)");
    expect(page).toContain("<>{productMeta(p)} · {won(p.price)}</>");
  });
  it("공개 RPC 매핑(요약)과 로그인 경로(가격표 조회)가 선택형 필드를 전달하고 min/max_purchase_count 컬럼을 select하지 않는다", () => {
    const c = read("lib/center.ts");
    expect(c).toContain("countSelectable: p.purchase_count_selectable ?? false");
    expect(c).toContain("minTierPrice: p.min_tier_price ?? null");
    expect(c).toContain(".from(\"product_count_prices\")");
    expect(c).toContain("CENTER_PRODUCTS_SELECT_FULL");
    const select = c.slice(c.indexOf("const CENTER_PRODUCTS_SELECT_FULL"), c.indexOf("const CENTER_PRODUCTS_SELECT_FULL") + 200);
    expect(select).not.toContain("min_purchase_count");
  });
  it("가격표가 없는 선택형 상품은 구매 목록에서 제외(최저가로 잘못 팔리지 않게)", () => {
    expect(read("lib/center.ts")).toContain(".filter((p: any) => !p.purchase_count_selectable || (tiersByProduct[p.id]?.length ?? 0) > 0)");
  });
});

describe("[O][P] 판매 가능 수량 표시", () => {
  it("'판매 가능 3개' / 0=매진 / null=표시 안 함", () => {
    expect(availabilityLabel(3)).toBe("판매 가능 3개");
    expect(availabilityLabel(0)).toBe("매진");
    expect(availabilityLabel(null)).toBeNull();
  });
  it("센터 구매 sheet/공개 목록에서 제목 옆 '개 남음' pill이 없고 보조 줄(.center-product-avail)로 표시된다", () => {
    for (const f of ["app/center/[id]/page.tsx", "app/products/page.tsx"]) {
      const src = stripTs(read(f));
      expect(src, f).not.toContain("개 남음");
      expect(src, f).not.toMatch(/pass-group-tag/);
      expect(src, f).toContain("center-product-avail");
      expect(src, f).toContain("availabilityLabel");
    }
  });
  it("매진(0)이면 담기/구매 버튼을 숨긴다(기존 매진 UX 유지)", () => {
    const src = read("app/center/[id]/page.tsx");
    expect(src).toContain("const soldOut = p.remaining === 0;");
    expect(src).toContain("{!soldOut && <AppButton variant=\"secondary\"");
  });
});

describe("[Q] 320~430px 겹침 방지 CSS 계약", () => {
  const css = read("app/globals.css");
  const tail = css.slice(css.indexOf("구매 횟수 선택형 상품 / 판매 가능 수량 표시"));
  it("판매 가능 문구는 nowrap 작은 글씨(제목과 같은 줄 pill 아님), 제목은 wrap/anywhere로 줄바꿈", () => {
    expect(tail).toMatch(/\.center-product-avail\s*\{[^}]*white-space:\s*nowrap/);
    expect(tail).toMatch(/\.center-product-avail\s*\{[^}]*font-size:\s*11\.5px/);
    expect(tail).toMatch(/\.center-product-name\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(tail).toMatch(/\.center-product-name\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
  it("선택형 행은 정보/선택/버튼이 각자 100% 줄로 쌓여 서로 겹치지 않고, 버튼 터치 영역(44px)은 기존 규칙 유지", () => {
    expect(tail).toMatch(/\.center-product-row\.is-selectable\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(tail).toMatch(/\.center-product-row\.is-selectable \.center-product-info\s*\{[^}]*flex:\s*1 1 100%/);
    expect(tail).toMatch(/\.center-product-select\s*\{[^}]*flex:\s*1 1 100%/);
    expect(css).toMatch(/\.center-product-actions \.app-button\s*\{[^}]*min-height:\s*44px/);
  });
  it("select는 16px(iOS 자동 확대 방지)", () => {
    expect(tail).toMatch(/\.center-product-select-field select\s*\{[^}]*font-size:\s*16px/);
  });
});

describe("센터 구매 sheet — 선택형은 한 번만, 횟수/사이즈 선택 후 담기·구매", () => {
  const src = read("app/center/[id]/page.tsx");
  it("상품마다 같은 CenterProductRow로 렌더(12줄 반복 없음)하고 횟수 select를 제공한다", () => {
    expect(src).toContain("<CenterProductRow key={p.id}");
    expect(src).toContain("sortedTiers(p)");
    expect(src).toContain("countOptionLabel(t)");
    expect(src).toContain("priceSummary(p)");
  });
  it("사이즈 있는 선택형은 횟수+사이즈 둘 다 필요(사이즈 미선택 시 담기/구매 비활성)", () => {
    expect(src).toContain("const needsSize = selectable && !!p.sizes && p.sizes.length > 0;");
    expect(src).toContain("const blocked = (needsSize && !size) || (selectable && count == null);");
    expect(src).toContain("disabled={blocked}");
  });
  it("구매는 count/size를 checkout URL로 넘기고, 담기는 selectedCount/selectedSize를 함께 저장", () => {
    expect(src).toContain("url += `&count=${sel.count}`");
    expect(src).toContain("selectedSize: sel?.size ?? null, selectedCount: sel?.count ?? null");
  });
});

describe("[G][H] 주문 저장 — selected_count/size가 사라지지 않는다", () => {
  beforeEach(() => { inserts.length = 0; updates.length = 0; existingCartRows = []; insertResult.error = null; });
  it("createOrder가 selected_count/selected_size를 orders에 저장(클라이언트 amount는 서버가 재검증)", async () => {
    await createOrder({ centerId: "c1", productId: "g1", productName: "피겨화 대여", amount: 30000, payMethod: "direct", selectedSize: "240", selectedCount: 5 });
    const row = inserts.find((i) => i.table === "orders")!.row;
    expect(row.selected_count).toBe(5);
    expect(row.selected_size).toBe("240");
    expect(row.amount).toBe(30000);
  });
  it("고정 상품 주문은 selected_count가 null(기존과 동일)", async () => {
    await createOrder({ centerId: "c1", productId: "p1", productName: "수강권", amount: 24000, payMethod: "direct" });
    expect(inserts.find((i) => i.table === "orders")!.row.selected_count).toBeNull();
  });
  it("컬럼 미적용(42703) 환경에서 선택형 주문은 조용히 selected_count를 빼지 않고 명확히 실패한다", async () => {
    insertResult.error = { code: "42703", message: "column selected_count does not exist" };
    await expect(createOrder({ centerId: "c1", productId: "g1", productName: "x", amount: 6000, selectedCount: 1 })).rejects.toThrow("준비 중");
  });
  it("checkout/cart가 selectedCount를 createOrder로 전달하고 금액 = tier 가격 - 센터쿠폰 - 포인트 기준(baseAmount)", () => {
    const checkout = stripTs(read("app/checkout/page.tsx"));
    expect((checkout.match(/selectedCount: countSelectable \? selectedCount : undefined/g) ?? []).length).toBe(2);
    expect(checkout).toContain("const baseAmount = product ? (computeBaseAmount(product, selectedCount) ?? product.price) : 0;");
    expect(checkout).toContain("Math.max(0, baseAmount - memberCouponDiscount)");
    expect(checkout).toContain("previewDiscount(baseAmount, selectedMemberCoupon)");
    expect(checkout).toContain("sp.get(\"count\")");
    expect(checkout).toContain("sortedTiers(product)");
    expect(checkout).toContain("computeBaseAmount(product, selectedCount) == null");   // 가격표에 없는 횟수는 결제 진행 안 함
    const cart = stripTs(read("app/cart/page.tsx"));
    expect(cart).toContain("selectedCount: it.countSelectable ? it.selectedCount : undefined");
  });
});

describe("[장바구니] 한 상품(+사이즈)당 한 선택 row, 다시 담으면 선택 변경", () => {
  beforeEach(() => { inserts.length = 0; updates.length = 0; existingCartRows = []; insertResult.error = null; });
  it("같은 상품+사이즈가 이미 있으면 insert 대신 selected_count/price를 update(합산 안 함)", async () => {
    existingCartRows = [{ id: "ci-1" }];
    await addToCart({ centerId: "c1", productId: "g1", productName: "피겨화 대여", price: 18000, selectedSize: "240", selectedCount: 3 });
    expect(inserts.filter((i) => i.table === "cart_items")).toHaveLength(0);
    expect(updates.find((u) => u.table === "cart_items")!.row).toEqual({ selected_count: 3, price: 18000 });
  });
  it("처음 담으면 product_id/selected_count/selected_size를 모두 보존해 insert", async () => {
    await addToCart({ centerId: "c1", productId: "g1", productName: "피겨화 대여", price: 30000, selectedSize: "240", selectedCount: 5 });
    expect(inserts.find((i) => i.table === "cart_items")!.row).toMatchObject({ product_id: "g1", selected_count: 5, selected_size: "240", price: 30000 });
  });
  it("고정 상품은 기존 방식(selected_count null)으로 row 추가", async () => {
    await addToCart({ centerId: "c1", productId: "p1", productName: "헬멧 대여권", price: 20000 });
    expect(inserts.find((i) => i.table === "cart_items")!.row.selected_count).toBeNull();
  });
  it("[11] 장바구니 count 변경 → 해당 tier 가격(6회 34,000), 그 외는 row 금액", () => {
    const item = { price: 6000, countSelectable: true, countPrices: shoes.countPrices, selectedCount: 1 };
    expect(cartItemAmount(item)).toBe(6000);
    expect(cartItemAmount({ ...item, selectedCount: 6 })).toBe(34000);
    expect(cartItemAmount({ ...item, selectedCount: 12 })).toBe(65000);
    expect(cartItemAmount({ price: 20000, countSelectable: false, countPrices: [], selectedCount: null })).toBe(20000);
  });
  it("장바구니 화면: 선택형 row는 stepper 대신 횟수 select, 사이즈 chip 유지", () => {
    const cart = read("app/cart/page.tsx");
    expect(cart).toContain("selectableItems.map");
    expect(cart).toContain("구매 횟수`}");
    expect(cart).toContain("countOptionLabel(t)");
    expect(cart).toContain("const noSizeGroups");
    expect(cart).toContain("if (it.countSelectable) continue;");
  });
});

describe("구매내역 — 선택 횟수/사이즈 표시", () => {
  it("구매내역 화면이 '5회 구매 신청 · 240'/보유 횟수 문구와 사이즈를 보여준다", () => {
    const page = read("app/purchases/page.tsx");
    expect(page).toContain("회 구매 신청");
    expect(page).toContain("it.selectedSize");
    const orders = read("lib/orders.ts");
    expect(orders).toContain("selectedSize: (m as any).selected_size ?? null");
    expect(orders).toContain("selected_count, selected_size");
  });
});
