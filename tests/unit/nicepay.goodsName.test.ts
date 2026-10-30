import { describe, expect, it } from "vitest";
import { eucKrByteLength, toNicepayGoodsName, NICEPAY_GOODS_NAME_MAX_BYTES } from "../../lib/payments/server/nicepay/goodsName";

// 공식 문서: GoodsName 은 최대 40 byte(euc-kr). 이모지·EUC-KR 에 없는 문자가 form 에서 &#NNNN; 로 바뀌어 40 byte 를 넘기거나 깨지는 일을 막는다.
describe("toNicepayGoodsName — EUC-KR 40바이트", () => {
  it("한글·영문·숫자·일반 기호는 그대로(40바이트 이내)", () => {
    expect(toNicepayGoodsName("5회 수업 이용권")).toBe("5회 수업 이용권");
    expect(toNicepayGoodsName("[QA] 8회권 · 30일")).toBe("QA 8회권 · 30일");
  });
  it("항상 EUC-KR 40바이트 이하(한글 20자 초과는 문자 단위로 자름)", () => {
    const long = "가나다라마바사아자차카타파하".repeat(5);
    const r = toNicepayGoodsName(long);
    expect(eucKrByteLength(r)).toBeLessThanOrEqual(NICEPAY_GOODS_NAME_MAX_BYTES);
    expect(r).toBe("가나다라마바사아자차카타파하가나다라마바");   // 20자 = 40바이트
    expect(eucKrByteLength(toNicepayGoodsName("a".repeat(100)))).toBe(40);
  });
  it("이모지·EUC-KR 에 없는 문자는 공백으로 바꾸고 결과는 EUC-KR 로 표현 가능", () => {
    const r = toNicepayGoodsName("🎉 파티 수강권 😀 ✨");
    expect(r).toBe("파티 수강권");
    expect(Number.isFinite(eucKrByteLength(r))).toBe(true);
    expect(toNicepayGoodsName("꽓핅 테스트")).not.toContain("�");
  });
  it("폼·마크업을 깨는 문자(<>\"'&\\)는 제거하고 앞뒤·연속 공백을 정리", () => {
    expect(toNicepayGoodsName(`  <b>"요가" & '필라'\\  `)).toBe("b 요가 필라");
  });
  it("비문자열·빈 값·표현 불가 문자뿐이면 기본 상품명", () => {
    for (const v of [undefined, null, 123, "", "   ", "😀😀"]) expect(toNicepayGoodsName(v)).toBe("모하빗 수강권");
  });
  it("문자를 반으로 쪼개지 않는다: 39바이트 뒤 한글은 통째로 버린다", () => {
    const r = toNicepayGoodsName("a".repeat(39) + "가");
    expect(r).toBe("a".repeat(39));
  });
});
