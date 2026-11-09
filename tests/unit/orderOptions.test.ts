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
