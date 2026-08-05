/*
  운영설정 2차 정리(Track 4) — "미수금 자동입력"을 실제로 구현하면서 뽑아낸 계산식 검증.
  이전에는 저장만 되고 어디서도 읽히지 않는 죽은 설정이었다.
*/
import { describe, expect, it } from "vitest";
import { computeAutoUnpaid } from "../../lib/sales";

describe("computeAutoUnpaid", () => {
  it("입력된 결제수단 합계가 상품가보다 적으면 차액을 반환한다", () => {
    expect(computeAutoUnpaid(100000, 60000)).toBe(40000);
  });
  it("입력된 결제수단 합계가 상품가와 같으면 0을 반환한다", () => {
    expect(computeAutoUnpaid(100000, 100000)).toBe(0);
  });
  it("입력된 결제수단 합계가 상품가를 초과해도 음수가 아니라 0을 반환한다", () => {
    expect(computeAutoUnpaid(100000, 150000)).toBe(0);
  });
  it("아직 아무 결제수단도 입력하지 않았으면 상품가 전액을 반환한다", () => {
    expect(computeAutoUnpaid(50000, 0)).toBe(50000);
  });
});
