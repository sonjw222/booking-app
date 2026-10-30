// @vitest-environment node
/* Mock 결제 운영 오작동 방지 — 오프라인. 실제 PG·DB 호출 없음. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPaymentProvider, resolveProviderName, isMockPaymentAllowed, isOnlinePgCheckoutAvailable } from "../../lib/payments/PaymentProviderFactory";
import { MockPaymentProvider } from "../../lib/payments/MockPaymentProvider";
import { DisabledPaymentProvider } from "../../lib/payments/DisabledPaymentProvider";
import { NicepayPaymentProvider } from "../../lib/payments/NicepayPaymentProvider";

afterEach(() => { vi.unstubAllEnvs(); });
const env = (nodeEnv: string, provider?: string, allowMock?: string) => {
  vi.stubEnv("NODE_ENV", nodeEnv);
  if (provider === undefined) vi.stubEnv("NEXT_PUBLIC_PAYMENT_PROVIDER", ""); else vi.stubEnv("NEXT_PUBLIC_PAYMENT_PROVIDER", provider);
  vi.stubEnv("NEXT_PUBLIC_ALLOW_MOCK_PAYMENT", allowMock ?? "");
};

describe("운영 빌드에서 Mock은 명시 허용 없이는 절대 선택되지 않는다", () => {
  for (const v of [undefined, "", "mock", "unknown-pg", "MOCK", "Toss", "toss", "portone"]) {
    it(`production + PROVIDER=${JSON.stringify(v)} → disabled (Mock 아님)`, async () => {
      env("production", v);
      expect(isMockPaymentAllowed()).toBe(false);
      expect(resolveProviderName()).toBe("disabled");
      const p = getPaymentProvider();
      expect(p).toBeInstanceOf(DisabledPaymentProvider);
      expect(p).not.toBeInstanceOf(MockPaymentProvider);
      await expect(p.createPayment({ orderId: "o", amount: 1000 })).rejects.toThrow(/준비 중/);
      await expect(p.confirmPayment("k", "o", 1000)).rejects.toThrow();
      expect(isOnlinePgCheckoutAvailable()).toBe(false);
    });
  }
  it("production + NEXT_PUBLIC_ALLOW_MOCK_PAYMENT=true + mock → mock (Preview QA용 명시 허용)", () => {
    env("production", "mock", "true"); expect(resolveProviderName()).toBe("mock"); expect(getPaymentProvider()).toBeInstanceOf(MockPaymentProvider);
  });
  it("허용 값은 정확히 'true'만 (1/yes/True 거부)", () => {
    for (const a of ["1", "yes", "True", "TRUE", " true"]) { env("production", "mock", a); expect(resolveProviderName()).toBe("disabled"); }
  });
  it("ALLOW_MOCK을 켜도 toss/portone(은퇴 PG)은 mock이 되지 않는다", () => {
    for (const v of ["toss", "portone"]) { env("production", v, "true"); expect(resolveProviderName()).toBe("disabled"); }
  });
});

describe("nicepay는 어떤 환경에서도 mock으로 폴백하지 않는다", () => {
  for (const [n, a] of [["production", ""], ["production", "true"], ["development", ""], ["test", ""]] as const) {
    it(`NODE_ENV=${n} allowMock=${JSON.stringify(a)} → nicepay 전용 어댑터(서버/DB 게이트는 별도)`, () => {
      env(n, "nicepay", a);
      expect(resolveProviderName()).toBe("nicepay");
      const p = getPaymentProvider();
      expect(p).toBeInstanceOf(NicepayPaymentProvider); expect(p).not.toBeInstanceOf(MockPaymentProvider);
      expect(isOnlinePgCheckoutAvailable()).toBe(true); // 코드 준비만. 서버 설정/DB 게이트가 실제 승인 여부를 결정
    });
  }
});

describe("개발/테스트 환경의 기존 동작 유지", () => {
  for (const n of ["development", "test"]) {
    it(`${n}: 값 없음/mock/알 수 없는 값 → mock`, () => {
      for (const v of [undefined, "mock", "unknown-provider"]) { env(n, v); expect(getPaymentProvider()).toBeInstanceOf(MockPaymentProvider); }
    });
  }
});

describe("정적 계약 — 운영에서 Mock으로 paid/수강권이 만들어지는 앱 경로 없음", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? (n === "node_modules" ? [] : walk(p)) : /\.(ts|tsx)$/.test(p) ? [p] : []; });
  const src = [...walk("app"), ...walk("lib")];
  it("confirm_test_payment RPC 래퍼는 MockPaymentProvider 외에서 쓰이지 않는다(= Factory 잠금을 우회하는 호출 경로 없음)", () => {
    const users = src.filter((f) => /confirmTestPaymentRpc|["']confirm_test_payment["']/.test(readFileSync(f, "utf8")) && !f.endsWith("mockPaymentApi.ts")).map((f) => f.replace(/\\/g, "/"));
    expect(users).toEqual(["lib/payments/MockPaymentProvider.ts"]);
  });
  it("MockPaymentProvider는 Factory에서만 생성된다", () => {
    const users = src.filter((f) => /new MockPaymentProvider\(/.test(readFileSync(f, "utf8"))).map((f) => f.replace(/\\/g, "/"));
    expect(users).toEqual(["lib/payments/PaymentProviderFactory.ts"]);
  });
  it("checkout은 disabled/비활성 nicepay를 주문(createOrder) 생성 전에 막고, 직접결제 분기는 그보다 앞에서 PG와 무관하게 처리된다", () => {
    const c = readFileSync("app/checkout/page.tsx", "utf8");
    const direct = c.indexOf('effectivePayMethod === "direct"'); const gate = c.indexOf('gateName === "disabled"'); const create = c.indexOf("await createOrder({", gate);
    expect(direct).toBeGreaterThan(-1); expect(gate).toBeGreaterThan(direct); expect(create).toBeGreaterThan(gate);
    expect(c).toMatch(/provider: providerName === "nicepay" \? "nicepay" : "mock"/);
  });
  it("checkout/cart는 'toss'/'portone' provider로 주문을 만들지 않는다", () => {
    for (const f of ["app/checkout/page.tsx", "app/cart/page.tsx"]) expect(readFileSync(f, "utf8")).not.toMatch(/provider:\s*["'](toss|portone)["']/);
  });
  it("DB 계약(저장소 SQL): confirm_test_payment는 payment_provider='mock' + 내부 QA 센터(is_internal)에서만 확정한다", () => {
    const sql = readFileSync("fix_pg_payment_lifecycle.sql", "utf8");
    expect(sql).toContain("v_order.payment_provider is distinct from 'mock'");
    expect(sql).toMatch(/from centers where id = v_order\.center_id and coalesce\(is_internal, false\)/);
  });
});
