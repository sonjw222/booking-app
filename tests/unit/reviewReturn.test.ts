// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeCheckoutReturnPath, readStoredReturnPath, rememberCheckoutReturn, REVIEW_RETURN_STORAGE_KEY } from "../../lib/payments/reviewReturnPath";
import { reviewReturnHtml, RETURN_SCRIPT, returnScriptHash } from "../../lib/payments/server/nicepay/reviewReturnPage";
import { createHash } from "node:crypto";

const C = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222";
const good = `/checkout?center=${C}&product=${P}&count=8&size=M&day=2&time=19:00&reserveClassId=${C}&reserveDate=2026-11-10`;

describe("sanitizeCheckoutReturnPath", () => {
  it("허용된 키·형식은 보존", () => { expect(sanitizeCheckoutReturnPath(good)).toBe(good.replace("%3A", ":") .replace("19:00", "19%3A00")); });
  it.each([
    "https://evil.com/checkout?center=x", "//evil.com/checkout", "/checkout/../admin", "/mypage", "/checkoutx",
    `/checkout?center=${C}&product=${P}&returnToken=abc`, `/checkout?center=${C}&product=${P}&authKey=1`,
    `/checkout?center=${C}&product=${P}&count=<script>`, `/checkout?center=${C}&product=${P}&count=1&count=2`,
    `/checkout?center=${C}`, `/checkout?center=${C}&product=${P}#x`, `/checkout?center=${C}&product=${P}\\evil`,
  ])("거부: %s", (x) => { expect(sanitizeCheckoutReturnPath(x)).toBeNull(); });
  it("문자열 아님/너무 김", () => { expect(sanitizeCheckoutReturnPath(null)).toBeNull(); expect(sanitizeCheckoutReturnPath("/checkout?" + "a".repeat(1000))).toBeNull(); });
});

describe("저장/읽기", () => {
  const store = () => { const m = new Map<string, string>(); return { setItem: (k: string, v: string) => void m.set(k, v), get: (k: string) => m.get(k) ?? null }; };
  it("결제 화면에서만 저장", () => {
    const s = store();
    expect(rememberCheckoutReturn({ pathname: "/mypage", search: "" }, s)).toBe(false);
    expect(rememberCheckoutReturn({ pathname: "/checkout", search: `?center=${C}&product=${P}` }, s, 1000)).toBe(true);
    expect(readStoredReturnPath(s.get(REVIEW_RETURN_STORAGE_KEY), 2000, { product: P, center: C })).toBe(`/checkout?center=${C}&product=${P}`);
  });
  it("만료·다른 상품·깨진 값은 null", () => {
    const raw = JSON.stringify({ p: `/checkout?center=${C}&product=${P}`, at: 1000 });
    expect(readStoredReturnPath(raw, 1000 + 31 * 60 * 1000)).toBeNull();
    expect(readStoredReturnPath(raw, 2000, { product: C })).toBeNull();
    expect(readStoredReturnPath("{bad", 2000)).toBeNull();
    expect(readStoredReturnPath(null, 2000)).toBeNull();
  });
});

function render(outcome: Parameters<typeof reviewReturnHtml>[0], ctx = { center: C, product: P }, stored?: string) {
  document.open(); document.write(reviewReturnHtml(outcome, ctx).replace(/<script>[\s\S]*<\/script>/, "")); document.close();
  localStorage.clear(); if (stored !== undefined) localStorage.setItem(REVIEW_RETURN_STORAGE_KEY, stored);
  new Function(RETURN_SCRIPT)();
  return document.getElementById("back") as HTMLAnchorElement;
}
describe("복귀 화면", () => {
  it("저장 경로 없으면 센터 상세 폴백, 마이페이지 링크 없음", () => {
    const a = render("closed"); expect(a.getAttribute("href")).toBe(`/center/${C}`); expect(a.textContent).toBe("센터 화면으로 돌아가기");
    expect(reviewReturnHtml("closed")).not.toContain("/mypage");
  });
  it("센터 정보도 없으면 홈", () => { expect(render("invalid", {} as never).getAttribute("href")).toBe("/"); });
  it("저장된 직전 결제 화면이 있으면 '결제 화면으로 돌아가기'", () => {
    const a = render("closed", undefined, JSON.stringify({ p: good, at: Date.now() }));
    expect(a.textContent).toBe("결제 화면으로 돌아가기"); expect(a.getAttribute("href")!.startsWith("/checkout?")).toBe(true);
    expect(a.getAttribute("href")).toBe(sanitizeCheckoutReturnPath(good));
  });
  it("조작된/만료/다른 상품 값은 무시하고 폴백 유지", () => {
    for (const v of [JSON.stringify({ p: "https://evil.com", at: Date.now() }), JSON.stringify({ p: good, at: 1 }), JSON.stringify({ p: `/checkout?center=${C}&product=${C}`, at: Date.now() }), "{x"]) {
      const a = render("closed", undefined, v); expect(a.getAttribute("href")).toBe(`/center/${C}`);
    }
  });
  it("취소·인증확인·확인불가 문구 구분, 성공 표현 없음", () => {
    expect(reviewReturnHtml("closed")).toContain("테스트 결제창 종료");
    expect(reviewReturnHtml("verified-not-approved")).toContain("승인 안 함");
    expect(reviewReturnHtml(undefined)).toContain("확인 불가");
    for (const o of ["closed", "verified-not-approved", "invalid"] as const) expect(reviewReturnHtml(o)).not.toMatch(/결제 완료되었|결제가 완료|승인되었/);
  });
  it("UUID 아닌 컨텍스트는 속성/링크에 쓰지 않음", () => {
    const h = reviewReturnHtml("closed", { center: '"><script>x', product: "p" }); expect(h).not.toContain('"><script>x'); expect(h).toContain('href="/"');
  });
  it("CSP 해시가 실제 스크립트와 일치", () => { expect(returnScriptHash()).toBe(createHash("sha256").update(RETURN_SCRIPT).digest("base64")); });
});
