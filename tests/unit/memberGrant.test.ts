import { describe, expect, it } from "vitest";
import { normalizeGrantMethod } from "../../lib/memberGrant";
describe("F11 — 가격과 결제방법 정규화", () => {
  it("0원 상품을 처음 고르면(기본 card) 서비스로 맞춘다", () => {
    expect(normalizeGrantMethod(0, "card")).toBe("service");
    expect(normalizeGrantMethod("0", "cash")).toBe("service");
  });
  it("유료로 바꾸면 서비스에서 card 로, 이미 고른 방법은 유지한다", () => {
    expect(normalizeGrantMethod(1, "service")).toBe("card");
    expect(normalizeGrantMethod("30000", "transfer")).toBe("transfer");
  });
  it("가격이 비었거나 잘못된 값이면 현재 방법을 유지한다(검증은 grantBlockReason)", () => {
    expect(normalizeGrantMethod("", "card")).toBe("card");
    expect(normalizeGrantMethod("abc", "service")).toBe("service");
    expect(normalizeGrantMethod(-1, "card")).toBe("card");
    expect(normalizeGrantMethod(null, "cash")).toBe("cash");
  });
  it("1→0 재입력과 같은 결과를 처음 선택에서도 얻는다(순서 무관)", () => {
    expect(normalizeGrantMethod(0, normalizeGrantMethod(1, "card"))).toBe("service");
  });
});
