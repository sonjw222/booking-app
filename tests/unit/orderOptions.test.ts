import { describe, expect, it } from "vitest";
import { firstOrderOptionIssue, orderOptionIssue, type OrderOptionInput } from "../../lib/orderOptions";
import { readFileSync } from "node:fs";

const tiers = [{ count: 1, price: 6000 }, { count: 6, price: 34000 }];
const base: OrderOptionInput = { productName: "요가 매트", sizes: ["S", "M"], selectedSize: "M", countSelectable: false, selectedCount: null };

describe("사이즈", () => {
  it("정의된 사이즈면 통과", () => expect(orderOptionIssue(base)).toBeNull());
  it("필수인데 미선택", () => expect(orderOptionIssue({ ...base, selectedSize: null })?.kind).toBe("size-required"));
  it("상품 옵션에서 사라진 옛 사이즈 거부", () => expect(orderOptionIssue({ ...base, selectedSize: "XL" })?.kind).toBe("size-invalid"));
  it("사이즈 없는 상품에 사이즈가 실려 있으면 거부", () => expect(orderOptionIssue({ ...base, sizes: null, selectedSize: "M" })?.kind).toBe("size-unexpected"));
  it("사이즈 없는 상품·미선택은 통과", () => expect(orderOptionIssue({ ...base, sizes: [], selectedSize: null })).toBeNull());
});
describe("횟수", () => {
  const sel: OrderOptionInput = { ...base, sizes: null, selectedSize: null, countSelectable: true, countPrices: tiers, selectedCount: 6 };
  it("가격표에 있는 횟수 통과", () => expect(orderOptionIssue(sel)).toBeNull());
  it("미선택/가격표에 없는 횟수 거부", () => {
    expect(orderOptionIssue({ ...sel, selectedCount: null })?.kind).toBe("count-required");
    expect(orderOptionIssue({ ...sel, selectedCount: 4 })?.kind).toBe("count-invalid");
    expect(orderOptionIssue({ ...sel, countPrices: [] })?.kind).toBe("count-invalid");
  });
  it("고정 상품에 횟수가 실려 있으면 거부", () => expect(orderOptionIssue({ ...sel, countSelectable: false })?.kind).toBe("count-unexpected"));
  it("사이즈+횟수 모두 필요한 상품: 둘 다 맞아야 통과", () => {
    const both = { ...sel, sizes: ["240", "245"], selectedSize: "245" };
    expect(orderOptionIssue(both)).toBeNull();
    expect(orderOptionIssue({ ...both, selectedSize: null })?.kind).toBe("size-required");
  });
  it("목록은 첫 문제를 돌려준다", () => expect(firstOrderOptionIssue([base, { ...base, productName: "B", selectedSize: null }, sel])?.message).toContain("'B'"));
});
describe("연결(소스 계약)", () => {
  const cart = readFileSync("app/cart/page.tsx", "utf8"), chk = readFileSync("app/checkout/page.tsx", "utf8");
  it("장바구니 일괄 주문과 결제 화면 모두 주문 생성 전에 같은 검증을 한다", () => {
    expect(cart.indexOf("firstOrderOptionIssue(items)")).toBeGreaterThan(0);
    expect(cart.indexOf("firstOrderOptionIssue(items)")).toBeLessThan(cart.indexOf("await createOrder("));
    expect(chk.indexOf("orderOptionIssue({")).toBeGreaterThan(0);
    expect(chk.indexOf("orderOptionIssue({")).toBeLessThan(chk.indexOf("await createOrder("));
  });
  it("결제 화면은 URL 의 size 를 상품 사이즈 목록에 있을 때만 채택한다", () => {
    expect(chk).toContain("found.sizes.includes(wantSize)");
  });
});

import { checkoutSearchWithSelection } from "../../lib/orderOptions";
import { sanitizeCheckoutReturnPath } from "../../lib/payments/reviewReturnPath";
describe("결제 화면 선택값 → 주소 반영(결제창 복귀용)", () => {
  const C = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222";
  it("횟수·사이즈를 넣고 다른 쿼리는 보존, 복귀 경로 검증을 통과", () => {
    const s = checkoutSearchWithSelection(`?center=${C}&product=${P}&reserveDate=2026-11-10`, { count: 8, size: "M" });
    expect(s).toContain("count=8"); expect(s).toContain("size=M"); expect(s).toContain("reserveDate=2026-11-10");
    expect(sanitizeCheckoutReturnPath("/checkout" + s)).toBe("/checkout" + s);
  });
  it("선택이 없으면 키를 지운다 / 바꾸면 갱신", () => {
    expect(checkoutSearchWithSelection(`?center=${C}&product=${P}&count=4&size=S`, { count: null, size: null })).toBe(`?center=${C}&product=${P}`);
    expect(checkoutSearchWithSelection(`?center=${C}&product=${P}&count=4`, { count: 6, size: undefined })).toContain("count=6");
  });
  it("같은 선택이면 문자열이 변하지 않아 replaceState 가 반복되지 않는다", () => {
    const once = checkoutSearchWithSelection(`?center=${C}&product=${P}`, { count: 8, size: "M" });
    expect(checkoutSearchWithSelection(once, { count: 8, size: "M" })).toBe(once);
  });
});
