import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(__dirname, "../..", f), "utf-8");

describe("구매 sheet 역할 분리 — 스타일 계약(.is-sheet 범위, 토큰만)", () => {
  const css = read("app/globals.css");
  const block = css.slice(css.indexOf("시트 상품 카드(2026-11-09)"));
  it("모든 규칙이 .center-products .center-product-row.is-sheet 아래로 범위가 한정된다(다른 화면 영향 없음)", () => {
    const selectors = block.split("\n").filter((l) => /^\.[\w-]/.test(l)).map((l) => l.split("{")[0].trim());
    expect(selectors.length).toBeGreaterThan(5);
    for (const s of selectors) expect(s).toMatch(/^\.center-products \.center-product-row\.is-sheet/);
  });
  it("버튼은 항상 전체 폭 grid·최소 44px, 긴 이름은 줄바꿈, 색은 토큰만", () => {
    expect(block).toMatch(/\.center-product-actions \.app-button\s*\{[^}]*min-height:\s*44px/);
    expect(block).toMatch(/\.center-product-name\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(/);
  });
  it("행 마크업에는 select·합계가 없고 조회 전용 링크는 '결제 화면 확인 (구매 불가)'", () => {
    const page = read("app/center/[id]/page.tsx");
    const row = page.slice(page.indexOf("function CenterProductRow"));
    expect(row).not.toMatch(/<select|center-product-total/);
    expect(row).toContain("결제 화면 확인 (구매 불가)");
  });
});
