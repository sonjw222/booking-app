/*
  실기기 QA(2026-09-29) — 출시 전략으로 숨겨뒀던 온라인 결제(Toss) 옵션을 다시 노출하는 방법
  확인. 코드 변경이 아니라 환경변수(NEXT_PUBLIC_PG_CHECKOUT_ENABLED) 하나로 제어된다는 것과,
  그 스위치가 실제로 checkout 화면에 연결돼 있다는 것을 고정한다 — 카드사(현대카드 등) 노출
  여부는 Toss 결제창(PG)이 직접 제어하므로 앱에 카드사 선택 UI를 새로 만들지 않는다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const factory = readFileSync(join(__dirname, "../../lib/payments/PaymentProviderFactory.ts"), "utf-8");
const checkout = readFileSync(join(__dirname, "../../app/checkout/page.tsx"), "utf-8");

describe("PG_CHECKOUT_ENABLED — 환경변수 하나로 켜고 끄는 구조", () => {
  it("코드에 하드코딩되지 않고 NEXT_PUBLIC_PG_CHECKOUT_ENABLED 환경변수로만 결정된다", () => {
    expect(factory).toContain('process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED === "true"');
  });

  it("checkout 화면의 결제수단 목록이 이 플래그로 필터링된다(꺼져 있으면 direct만)", () => {
    expect(checkout).toContain(".filter((m) => pgCheckoutEnabled || m.id === \"direct\")");
  });

  it("심사관 전용 override(accounts.pg_checkout_override)는 전역 플래그와 무관하게 계속 동작한다(변경하지 않음)", () => {
    expect(checkout).toContain("fetchMyPgCheckoutOverride");
    expect(checkout).toContain("setPgCheckoutEnabled(true)");
  });

  it("앱에 카드사(현대카드 등) 선택 UI를 새로 만들지 않는다 — PAY_METHODS는 결제수단(카드/카카오페이/토스페이/계좌이체/직접결제)만 나열한다", () => {
    const methodsBlock = checkout.slice(checkout.indexOf("const PAY_METHODS"), checkout.indexOf("const TOSS_SUPPORTED_METHODS"));
    expect(methodsBlock).not.toMatch(/현대카드|삼성카드|신한카드|카드사/);
  });

  it("카드 결제 선택 시에만 자연스러운 준비중 안내가 있다(카드사를 특정하지 않음)", () => {
    const idx = checkout.indexOf('payMethod === "card" && resolveProviderName() === "toss"');
    expect(idx).toBeGreaterThan(-1);
    const block = checkout.slice(idx, idx + 500);
    expect(block).not.toMatch(/현대카드/);
    expect(block).toContain("준비 중일 수 있어요");
  });
});
