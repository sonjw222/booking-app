import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("NICEPAY 정기구독 상품 확인 경로", () => {
  const catalog = read("app/center-subscription/page.tsx");
  const home = read("app/page.tsx");

  it("심사 계정 홈에서 구독 상품 확인 페이지로 이동할 수 있다", () => {
    expect(home).toContain('isNicepayReviewer && centers.length > 0');
    expect(home).toContain('href="/center-subscription"');
    expect(home).toContain("센터 운영자용 월 구독 상품 확인");
  });

  it("공개 가능한 활성 상품만 공개 조회하며 QA·비활성 플랜은 제외한다", () => {
    expect(catalog).toContain('from("subscription_plans")');
    expect(catalog).toContain('.eq("is_active", true)');
    expect(catalog).toContain("p.monthly_price > 0");
    expect(catalog).toContain('process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY');
    expect(catalog).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("카드 등록·자동청구·주문 생성 없이 상품·정책만 안내한다", () => {
    expect(catalog).toContain("정기결제 카드 등록 준비 중");
    expect(catalog).toContain('href="/legal/refund"');
    expect(catalog).toContain('href="/legal/terms"');
    expect(catalog).toContain("disabled");
    expect(catalog).not.toMatch(/\.(insert|update|delete|rpc)\s*\(/);
    expect(catalog).not.toMatch(/(requestCenterBillingAuth|confirmCenterBilling|chargeDue|nicepaySign|goPay)\s*\(/);
  });
});
