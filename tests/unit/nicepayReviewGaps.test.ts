import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BUSINESS_ADDRESS } from "../../lib/businessAddress";

const root = path.resolve(__dirname, "../..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");

describe("NICEPAY 심사 보완 1 — 홈·공개 상품 하단 사업장 주소(단일 출처 BUSINESS_INFO.address)", () => {
  it("홈과 공개 상품 페이지가 BUSINESS_INFO.address 를 표시하고, 주소 문자열을 하드코딩하지 않는다", () => {
    for (const f of ["app/page.tsx", "app/products/page.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("<BusinessAddressLine />");   // 환경변수 플래그가 켜진 빌드에서만 표시(기본 꺼짐) — app/components/BusinessAddressLine.tsx
      expect(src, `${f}: 주소 하드코딩 금지`).not.toContain(BUSINESS_ADDRESS);
    }
  });
  it("/legal/business 도 같은 값을 쓰고, 주소는 임의 값이 아니라 기존 BUSINESS_INFO 값 그대로다", () => {
    expect(read("app/legal/business/page.tsx")).toContain("{BUSINESS_ADDRESS}");
    expect(BUSINESS_ADDRESS.length).toBeGreaterThan(5);   // 값 자체는 이 테스트에 적지 않는다(사업자등록증 대조는 사용자 확인 사항)
  });
  it("홈 하단 주석에 '자택 주소 → 공개 배포는 사용자 승인 후' 경고가 남아 있다", () => {
    expect(read("app/page.tsx")).toMatch(/자택 주소이므로 공개 배포는 사용자 승인 후에만/);
  });
});

describe("NICEPAY 심사 보완 3 — 이용기간 표시 연결", () => {
  it("회원용 상품 조회는 만료 원본 컬럼을 요청하고(42703 폴백 유지), 공개 목록은 기간 RPC 가 없어도 실패하지 않는다", () => {
    const src = read("lib/center.ts");
    expect(src).toContain("expiry_mode, expiry_days, expiry_date, rolling_month_cutoff_day, rolling_month_allow_early_use");
    expect(src).toMatch(/withPeriod\.error\?\.code === "42703"/);
    expect(src).toContain("fetch_public_storefront_product_periods");
    expect(src).toMatch(/try \{[\s\S]*fetch_public_storefront_product_periods[\s\S]*\} catch/);   // 기간 RPC 실패는 목록을 깨지 않는다
  });
  it("periodSourceFromRow: 원본이 없으면 null(추측 금지), 있으면 그대로 매핑", async () => {
    vi.mock("../../lib/supabaseClient", () => ({ supabase: {} }));
    const { periodSourceFromRow } = await import("../../lib/center");
    expect(periodSourceFromRow({})).toBeNull(); expect(periodSourceFromRow(null)).toBeNull(); expect(periodSourceFromRow({ expiry_mode: null })).toBeNull();
    expect(periodSourceFromRow({ expiry_mode: "days", expiry_days: 30 })).toEqual({ expiryMode: "days", expiryDays: 30, expiryDate: null, rollingMonthCutoffDay: null, rollingMonthAllowEarlyUse: null });
    expect(periodSourceFromRow({ expiry_mode: "rolling_month", rolling_month_cutoff_day: 20, rolling_month_allow_early_use: true })).toMatchObject({ expiryMode: "rolling_month", rollingMonthCutoffDay: 20, rollingMonthAllowEarlyUse: true });
  });
  it("공개 상품·센터 구매 시트·상품 상세·결제 화면이 이용기간 안내를 렌더링한다", () => {
    expect(read("app/products/page.tsx")).toContain("<ServicePeriodNotice source={p.periodSource} variant=\"compact\" />");
    expect(read("app/products/page.tsx")).toContain("<ServicePeriodGenericNote />");
    expect(read("app/center/[id]/page.tsx")).toContain("<ServicePeriodNotice source={descProduct.periodSource} />");
    expect(read("app/center/[id]/page.tsx")).toContain("variant=\"compact\"");
    expect(read("app/checkout/page.tsx")).toContain("<ServicePeriodNotice source={product.periodSource} />");
  });
  it("결제 활성화 정책은 바뀌지 않았다: PG_CHECKOUT_ENABLED 게이트와 심사관 오버라이드 조회 코드가 그대로", () => {
    const checkout = read("app/checkout/page.tsx");
    expect(checkout).toContain("useState(PG_CHECKOUT_ENABLED)");
    expect(checkout).toContain("fetchMyPgCheckoutOverride()");
    expect(read("lib/payments/index.ts")).toMatch(/PG_CHECKOUT_ENABLED/);
  });
});
