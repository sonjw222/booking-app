/*
  실기기 QA(2026-09-29) — "내 센터 등록하기" 첫 화면 상단이 iPhone 상태바/Dynamic Island에
  가려지던 문제. 원인: 이 화면만 .back-header(공용 safe-top 계약) 없이 .section-title을
  화면 맨 위 요소로 바로 쓰는데, .section-title 자체 규칙은 고정 padding-top이라 safe-area를
  반영하지 않았다. 다른 화면(admin/manager)의 .section-title은 이미 safe-top을 반영한
  ManagerChrome/AdminChrome 아래에 있어 그대로 둬야 한다 — 이 화면 전용 클래스로만 고친다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
const page = readFileSync(join(__dirname, "../../app/mypage/register-center/page.tsx"), "utf-8");

describe("register-center 화면 safe-area", () => {
  it("고정 px 하드코딩(style={{ paddingTop: 20 }} 등) 대신 전용 클래스를 쓴다", () => {
    expect(page).not.toMatch(/style=\{\{\s*paddingTop:\s*20\s*\}\}/);
    expect(page).not.toMatch(/style=\{\{\s*marginTop:\s*60\s*\}\}/);
    expect(page).toContain('className="section-title register-center-head"');
    expect(page).toContain("register-center-done-notice");
  });

  it("전용 클래스가 실제 safe-area 토큰(--safe-top)을 max()로 반영한다(하드코딩 값으로 덮지 않음)", () => {
    expect(css).toMatch(/\.register-center-head \{ padding-top: max\(20px, var\(--safe-top\)\); \}/);
    expect(css).toMatch(/\.register-center-done-notice \{ margin-top: max\(60px, calc\(var\(--safe-top\) \+ 40px\)\); \}/);
  });

  it("공용 .section-title 기본 규칙 자체는 바꾸지 않는다(admin/manager 화면 회귀 방지)", () => {
    expect(css).toMatch(/\.section-title \{ display: flex; align-items: center; gap: 6px; padding: 20px 20px 4px;/);
  });

  it("--safe-top이 0인 Android/웹에서는 기존과 동일한 20px/60px 최소값을 유지한다(max() 하한)", () => {
    // max(20px, 0) = 20px, max(60px, 0+40px) = 60px — 회귀 없음을 문서화(런타임 CSS 계산은
    // jsdom에서 검증할 수 없어 규칙 자체의 하한값을 고정한다).
    expect(css).toContain("max(20px, var(--safe-top))");
    expect(css).toContain("max(60px, calc(var(--safe-top) + 40px))");
  });
});
