import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 2026-08-31 로그인 복귀 기능의 회귀 방지: 비로그인 방문자가 결제하기를 누르면 "로그인이 필요해요" + "로그인 하러 가기"(현재 URL을 next로 보존)가 보여야 한다.
// 비로그인이면 fetchCenterProductsForPurchase가 공개(publicFallback) 모델을 돌려주고, handlePay의 publicFallback 가드가 그 문구에 도달하기 전에
// "로그인 정보를 확인하지 못했어요"로 가로채던 것이 원인이었다.
const page = readFileSync("app/checkout/page.tsx", "utf8");
const fn = page.slice(page.indexOf("async function handlePay()"));
const guard = fn.slice(fn.indexOf("if (product.publicFallback)"), fn.indexOf("if (scheduleState.blocked)"));

describe("checkout — 비로그인 방문자", () => {
  it("publicFallback 가드는 세션이 없으면 '로그인이 필요해요'(로그인 링크가 붙는 상태), 세션이 있는데도 공개 모델이면 기존 확인 실패 문구를 유지한다", () => {
    expect(guard).toContain("supabase.auth.getSession()");
    expect(guard).toContain('sessionData.session ? "로그인 정보를 확인하지 못했어요. 다시 로그인한 뒤 시도해주세요." : "로그인이 필요해요"');
    expect(guard).toMatch(/setError\([^;]*\);\s*return;\s*\}/);   // 결제 진행(주문 생성)으로 넘어가지 않는다
  });
  it("가드는 여전히 스케줄 판정/주문 생성보다 먼저다(결제 차단 유지)", () => {
    expect(fn.indexOf("product.publicFallback")).toBeLessThan(fn.indexOf("scheduleState.blocked"));
    expect(fn.indexOf("product.publicFallback")).toBeLessThan(fn.indexOf("createOrder("));
  });
  it("'로그인이 필요해요'일 때만 로그인 하러 가기 링크를 렌더하고, 링크는 현재 checkout URL을 next로 보존하는 기존 함수를 쓴다", () => {
    expect(page).toContain('error === "로그인이 필요해요" && (');
    expect(page).toContain('<a className="error-toast-action" href={loginHrefWithReturnToHere()}>로그인 하러 가기</a>');
    expect(readFileSync("lib/postLoginReturn.ts", "utf8")).toContain("`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`");
  });
});
