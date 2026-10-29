// @vitest-environment node
/* /products 비결제 안내: 환불·사업자 정보 링크가 있고, 특정 PG명·사업장 주소·가짜 결제창 문구가 없다(정적 확인). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("app/products/page.tsx", "utf8");
describe("/products 구매 전 안내", () => {
  it("환불·취소 정책과 사업자 정보로 연결된다", () => {
    expect(page).toContain('data-testid="products-purchase-guide"');
    expect(page).toMatch(/href="\/legal\/refund"[\s\S]{0,200}환불·취소 정책/);
    expect(page).toMatch(/href="\/legal\/business"[\s\S]{0,200}사업자 정보/);
  });
  it("PG사명 단정·결제창 흉내가 없고, 사업장 소재지는 단일 출처(BUSINESS_INFO.address)로만 노출한다(2026-10-27 NICEPAY 심사 요청 — 공개 배포는 사용자 승인 후)", () => {
    const ui = page.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(ui).not.toMatch(/NICEPAY|나이스|토스|Toss/i);
    expect(ui).toContain("<BusinessAddressLine />");   // 주소 문자열을 하드코딩하지 않고 lib/businessInfo.ts 단일 출처만 쓴다
    expect(ui).not.toMatch(/경기도|성남시|중앙공원로/);
    expect(ui).not.toMatch(/카드번호|유효기간|CVC|비밀번호/);
  });
});
