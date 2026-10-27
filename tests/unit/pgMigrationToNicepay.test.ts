// @vitest-environment node
/* PG 전환(Toss → NICEPAY) 안전 계약 — 오프라인 정적/단위 확인. 실제 PG·DB 호출 없음. */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recurringMoid, firstChargeMoid, decideAfterChargeFailure, assertBillingActivated, BillingNotActivatedError, NICEPAY_BILLING_ACTIVATED } from "../../lib/payments/server/nicepay/billing";
import { visiblePayMethodIds } from "../../lib/payMethods";

const read = (f: string) => readFileSync(f, "utf8");
const checkout = read("app/checkout/page.tsx");

describe("신규 결제 경로에서 Toss가 선택되지 않는다 / fail-closed", () => {
  it("checkout은 Toss SDK·Toss Provider를 쓰지 않고, 주문 생성 전에 PG 진입 가능 여부로 중단한다", () => {
    expect(checkout).not.toMatch(/loadTossSdk|TossPaymentProvider|TOSS_SUPPORTED/);
    const gate = checkout.indexOf("isOnlinePgCheckoutAvailable()");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(checkout.indexOf("await createOrder({", gate - 2000 > 0 ? gate : 0));
    expect(checkout.indexOf("const providerName = resolveProviderName()")).toBeGreaterThan(gate);
  });
  it("createOrder의 provider 타입은 mock|nicepay (신규 toss/portone 주문 불가)", () => {
    expect(read("lib/orders.ts")).toContain('provider?: "mock" | "nicepay"');
  });
  it("직접결제 fallback: PG가 꺼져 있으면 항상 direct만 노출", () => {
    expect(visiblePayMethodIds({ pgEnabled: false, allowed: null, all: ["card", "kakao", "toss", "transfer", "direct"] })).toEqual(["direct"]);
    expect(read("lib/payments/PaymentProviderFactory.ts")).toContain('process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED === "true"');
  });
});

describe("과거 Toss 거래의 조회·취소·환불 경로 보존(E)", () => {
  it("서버 라우트·라이프사이클·복귀 확정 경로가 그대로 있다", () => {
    for (const f of ["app/api/payments/confirm/route.ts", "app/api/payments/cancel/route.ts", "app/api/payments/refund/route.ts", "app/api/payments/return/confirm/route.ts", "app/api/payments/return/cancel/route.ts", "app/api/payments/return-token/route.ts", "lib/payments/server/lifecycle.ts", "lib/payments/server/toss.ts", "app/checkout/success/page.tsx"]) expect(existsSync(f), f).toBe(true);
    const l = read("lib/payments/server/lifecycle.ts");
    expect(l).toContain('const needsPgCancel = ctx.provider === "toss" && ctx.amount > 0;');
    expect(l).toContain("refundBegin");
    expect(read("lib/payments/tossPaymentApi.ts")).toContain('fetch("/api/payments/refund"');
  });
  it("Toss 운영 키(TOSS_SECRET_KEY / TOSS_BILLING_SECRET_KEY) 사용 코드는 변경 없이 서버 라우트에 남아 있다", () => {
    expect(read("app/api/payments/refund/route.ts")).toContain("process.env.TOSS_SECRET_KEY");
    expect(read("app/api/billing/charge-due/route.ts")).toContain("process.env.TOSS_BILLING_SECRET_KEY");
  });
});

describe("정기결제(빌링) 비활성 / 기존 구독 보존", () => {
  it("BILLING_ENABLED 기본 꺼짐 정책 유지, NICEPAY 빌링은 코드 잠금", () => {
    expect(read("lib/centerSubscription.ts")).toContain('process.env.NEXT_PUBLIC_BILLING_ENABLED === "true"');
    expect(NICEPAY_BILLING_ACTIVATED).toBe(false);
    expect(() => assertBillingActivated()).toThrow(BillingNotActivatedError);
  });
  it("회차별 유일 Moid / 재시도 정책(7회, 비재시도 즉시 실패)", () => {
    const c = "123e4567-e89b-12d3-a456-426614174000";
    expect(recurringMoid(c, "2026-11-16")).toBe(`sub-recur-${c}-2026-11-16`);
    expect(recurringMoid(c, "2026-11-16")).toBe(recurringMoid(c, "2026-11-16"));
    expect(firstChargeMoid(c, "2026-10-16T03:00:00Z")).toBe(`sub-first-${c}-20261016030000`);
    expect(() => recurringMoid("x", "2026-11-16")).toThrow(); expect(() => recurringMoid(c, "11/16")).toThrow();
    expect(decideAfterChargeFailure({ retryCount: 0, nonRetryable: false })).toEqual({ status: "past_due", retryCount: 1 });
    expect(decideAfterChargeFailure({ retryCount: 5, nonRetryable: false })).toEqual({ status: "past_due", retryCount: 6 });
    expect(decideAfterChargeFailure({ retryCount: 6, nonRetryable: false }).status).toBe("payment_failed");
    expect(decideAfterChargeFailure({ retryCount: 0, nonRetryable: true }).status).toBe("payment_failed");
  });
  it("빌링 모듈에는 카드정보 필드가 없다", () => {
    expect(read("lib/payments/server/nicepay/billing.ts").replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/CardNo|cardNumber|expiry|ExpYear|IDNo|birth|CardPw|password/i);
  });
});
