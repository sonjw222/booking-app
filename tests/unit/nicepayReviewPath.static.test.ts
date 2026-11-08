import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const read = (f: string) => readFileSync(join(__dirname, "../..", f), "utf-8");

/* 실제 센터(조회 전용 허용) → 결제 화면 → 카드 결제창 확인(승인 없음) 경로의 구조 계약. */
describe("심사 경로 구조 계약", () => {
  it("조회 전용 센터의 상품 행은 담기·구매 대신 결제 화면(결제창 확인) 링크만 갖는다", () => {
    const src = read("app/center/[id]/page.tsx");
    expect(src).toMatch(/viewOnly && checkoutHref && !soldOut/); expect(src).toContain("결제 화면 · 카드 결제창 확인");
    expect(src).toMatch(/\{!viewOnly && <div className="center-product-actions">/);   // 구매 버튼 블록은 조회 전용에서 렌더되지 않는다
    expect(src.match(/checkoutHref=\{`\/checkout\?center=\$\{centerId\}&product=\$\{p\.id\}`\}/g)?.length).toBe(2);
  });
  it("결제 화면은 조회 전용·심사 카드 잠금 모두에서 실제 결제 버튼을 비활성하고 handlePay 도 막는다", () => {
    const src = read("app/checkout/page.tsx");
    expect(src).toMatch(/disabled=\{busy \|\| pgUnresolved \|\| reviewCardLock \|\|[\s\S]*\|\| viewOnly\}/); expect(src).toContain("if (!product || viewOnly) return;");
    expect(src).toContain("<NicepayReviewWindow key={productId}");
  });
  it("허용 센터가 있으면 탐색은 허용 센터만, 인증창 대상 판정은 허용 행·승인 센터·판매 중 미만료 상품을 요구한다", () => {
    expect(read("lib/nicepayReviewScope.ts")).toContain("const filter = `id.in.(${scope.extraCenterIds.join(\",\")})`;");
    const rt = read("lib/payments/server/nicepay/reviewWindowRuntime.ts");
    for (const must of ["nicepay_review_center_grants", "real.is_nicepay_review !== false", "real.is_internal !== false", 'real.status !== "approved"', "product.expiry_date < KST_TODAY()", "is_on_sale !== true"]) expect(rt).toContain(must);
  });
  it("인증창 경로(review-window)는 승인·주문·이용권 쓰기 포트를 가져오지 않는다", () => {
    const rt = read("lib/payments/server/nicepay/reviewWindowRuntime.ts");
    expect(rt).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(|net\.approve|nicepay_claim_order/);
  });
});
