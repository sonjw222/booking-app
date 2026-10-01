/*
  관리자 수업 캘린더(2026-10-02): 선택 날짜의 외곽 직사각형 포커스 outline 제거 + 키보드 포커스는 날짜 원형으로 이동.
  원인은 전역 button:focus-visible outline이 날짜 셀 버튼 전체에 적용된 것이다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
const page = readFileSync(join(__dirname, "../../app/manager/classes/page.tsx"), "utf-8");

describe("관리자 캘린더 선택 날짜 — 원형만, 외곽 네모 없음", () => {
  it("셀 전체의 포커스 outline이 꺼져 있다(:focus, :focus-visible) — manager 캘린더에만 한정", () => {
    expect(css).toMatch(/\.manager-classes-v2 \.cal-cell:focus,\s*\.manager-classes-v2 \.cal-cell:focus-visible \{ outline: none; \}/);
  });
  it("접근성 유지: 키보드 포커스는 날짜 원형(.daynum-wrap)에 링으로 표시(직사각형 아님)", () => {
    expect(css).toMatch(/\.manager-classes-v2 \.cal-cell:focus-visible \.daynum-wrap \{[^}]*box-shadow:[^}]*0 0 0 3px/);
    expect(css).not.toMatch(/\.manager-classes-v2 \.cal-cell[^{]*\{[^}]*outline: [1-9]/);
  });
  it("선택 날짜의 기존 원형 링·색은 그대로(border/box-shadow 큰 사각형 없음)", () => {
    expect(css).toContain(".manager-classes-v2 .cal-cell.selected .daynum-wrap{background:transparent!important;box-shadow:inset 0 0 0 1.5px var(--accent)!important}");
    expect(css).toContain("border:0!important;border-radius:0!important;background:transparent!important}");   // 셀 border/radius 없음
    expect(css).toContain(".manager-classes-v2 .cal-cell.selected:not(.sun):not(.sat) .cal-daynum{color:var(--accent)!important}");
  });
  it("레이아웃/오늘·토일 색/수업 점 규칙은 그대로, 마크업도 변경 없음", () => {
    expect(css).toContain(".cal-cell.sun .cal-daynum { color: var(--danger); }");
    expect(css).toContain(".cal-cell.sat .cal-daynum { color: var(--info); }");
    expect(css).toContain(".manager-classes-v2 .cal-dots{height:6px;");
    expect(page).toContain('<span className="daynum-wrap"><span className="cal-daynum">{day}</span></span>');
    expect(page).toContain('aria-pressed={day === selectedDay}');
  });
});
