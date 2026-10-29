import { describe, expect, it } from "vitest";
import { methodsForProvider, visiblePayMethodIds, NICEPAY_ONLINE_METHOD_IDS } from "../../lib/payMethods";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("NICEPAY v3 — 결제수단은 카드만 온라인 노출(카카오페이·토스페이·계좌이체 미노출), 직접결제 유지", () => {
  const ALL = ["card", "kakao", "toss", "transfer", "direct"];
  it("nicepay 이면 card·direct 만, 그 밖의 provider 는 목록 불변", () => {
    expect(methodsForProvider(ALL, "nicepay")).toEqual(["card", "direct"]);
    expect(methodsForProvider(ALL, "mock")).toEqual(ALL); expect(methodsForProvider(ALL, "disabled")).toEqual(ALL);
    expect(NICEPAY_ONLINE_METHOD_IDS).toEqual(["card"]);
  });
  it("PG 비활성(일반 회원)이면 어떤 경우에도 direct 만, 심사관(pgEnabled)이면 card+direct", () => {
    expect(visiblePayMethodIds({ pgEnabled: false, allowed: null, all: methodsForProvider(ALL, "nicepay") })).toEqual(["direct"]);
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: null, all: methodsForProvider(ALL, "nicepay") })).toEqual(["card", "direct"]);
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: ["kakao", "toss"], all: methodsForProvider(ALL, "nicepay") })).toEqual(["direct"]);   // 센터 설정이 PG 수단만 허용해도 NICEPAY 에서 못 쓰는 수단이면 direct 로 안전 대체
  });
  it("체크아웃·장바구니가 이 필터를 실제로 쓰고, 복귀 토큰 게이트가 NICEPAY 주문에 토스 규칙을 쓰지 않는다", () => {
    const r = (f: string) => readFileSync(path.resolve(__dirname, "../..", f), "utf8");
    expect(r("app/checkout/page.tsx")).toMatch(/methodsForProvider\(PAY_METHODS\.map\(\(m\) => m\.id\), resolveProviderName\(\)\)/);
    expect(r("app/cart/page.tsx")).toContain("methodsForProvider(");
    const deps = r("lib/payments/server/deps.ts"); const g0 = deps.indexOf("async gateAllows"); const gate = deps.slice(g0, deps.indexOf("tossConfirm:", g0));
    expect(gate.indexOf('payment_provider === "nicepay"')).toBeGreaterThan(-1); expect(gate.indexOf("nicepayGate(admin)")).toBeLessThan(gate.lastIndexOf("pg_checkout_override"));
  });
});
