/*
  실기기 QA(2026-09-25) — 다크 모드/스켈레톤/테마/캘린더 선택/iOS long-press CSS 회귀 방지.
  (실제 렌더 검증은 브라우저/실기기, 여기서는 회귀하기 쉬운 선언만 고정한다.)
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isThemeOptionSelected } from "../../app/settings/theme/page";

const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");

describe("다크 모드 표면", () => {
  it("센터 상세 탭 배경이 라이트 하드코딩(rgba(251,251,250))이 아니라 --bg 토큰", () => {
    const line = css.split("\n").find((l) => l.startsWith(".center-detail-v2 .center-tabs {"))!;
    expect(line).toContain("var(--bg)");
    expect(line).not.toContain("251,251,250");
  });
  it("공용 뒤로가기 버튼(button.side)은 배경/테두리 리셋 — 기본 버튼 면(흰색)이 보이지 않는다", () => {
    expect(css).toMatch(/button\.side \{ background: transparent; border: 0;/);
  });
  it("검색 버튼은 --ink 채움(다크에서 흰색) 대신 입력창과 같은 surface 계열", () => {
    const line = css.split("\n").find((l) => l.startsWith(".discovery-page-v2 .search-go {"))!;
    expect(line).toContain("background: var(--surface)");
    expect(line).not.toContain("background: var(--ink)");
  });
});

describe("로딩 스켈레톤", () => {
  it("app/loading.tsx는 중앙정렬 flex 컨테이너(system-state-v2)가 아니라 전용 래퍼를 쓴다", () => {
    const src = read("app/loading.tsx");
    expect(src).toContain("route-loading");
    expect(src).not.toMatch(/<main className="system-state-v2"><Loading/);
  });
  it(".loading-wrap은 부모 정렬과 무관하게 전체 폭을 차지하고 usable viewport 높이를 기준으로 한다", () => {
    expect(css).toContain("display: block; width: 100%; align-self: stretch; box-sizing: border-box;");
    expect(css).toMatch(/min-height: max\(360px, calc\(100dvh - var\(--safe-top, 0px\) - 72px - var\(--floating-nav-clearance\)\)\);/);
  });
});

describe("테마 선택 카드", () => {
  it("카드는 실제 테마 색이 아닌 중립 surface 토큰, 선택은 accent 테두리", () => {
    const line = css.split("\n").find((l) => l.startsWith(".theme-option {"))!;
    expect(line).toContain("var(--card-bg)");
    expect(css).toMatch(/\.theme-option\.on \{ border-color: var\(--accent\); \}/);
  });
  it("페이지가 카드에 인라인 배경/글자색을 주지 않는다", () => {
    const src = read("app/settings/theme/page.tsx");
    expect(src).not.toMatch(/style=\{\{ background: t\.bg, borderColor/);
    expect(src).not.toContain("color: t.ink");
  });
  it("선택 상태는 저장된 테마 id와 정확히 일치할 때만(시스템 다크에서 '다크 모드'가 선택돼 보이면 안 됨)", () => {
    expect(isThemeOptionSelected("system", "system")).toBe(true);
    expect(isThemeOptionSelected("system", "charcoal")).toBe(false);
    expect(isThemeOptionSelected("burgundy", "burgundy")).toBe(true);
    expect(isThemeOptionSelected("charcoal", "burgundy")).toBe(false);
  });
});

describe("캘린더 선택 날짜", () => {
  it("채움(accent/brand-soft) 없이 outline(ring) 중심", () => {
    expect(css).toMatch(/\.cal-cell\.selected \{ background: transparent; \}/);
    expect(css).toContain(".cal-cell.selected .daynum-wrap { box-shadow: inset 0 0 0 1.5px var(--accent); }");
    expect(css).not.toMatch(/\.cal-cell\.selected \{ background: var\(--accent\)/);
    expect(css).not.toMatch(/\.member-reservation \.cal-cell\.selected \.daynum-wrap \{ background: var\(--brand-soft\)/);
    expect(css).not.toMatch(/\.manager-classes-v2 \.cal-cell\.selected \.daynum-wrap\{background:var\(--brand-soft\)/);
  });
  it("주말 날짜는 선택돼도 본래 색(danger/info)을 유지하고, 수업 있는 날 점은 숨기지 않는다", () => {
    expect(css).toContain(".cal-cell.selected:not(.sun):not(.sat) .cal-daynum");
    expect(css).not.toContain(".member-reservation .cal-cell.selected .cal-dot { opacity: 0; }");
    expect(css).not.toContain(".manager-classes-v2 .cal-cell.selected .cal-dots{opacity:0}");
  });
});

describe("iOS long-press 링크 미리보기", () => {
  it("링크/버튼/role 요소에만 -webkit-touch-callout: none, user-select는 건드리지 않는다", () => {
    const start = css.lastIndexOf("a[href],\nbutton,");
    const blk = css.slice(start, css.indexOf("-webkit-touch-callout: default; }", start));
    expect(blk).toContain("-webkit-touch-callout: none");
    expect(blk).toContain("a[href]");
    expect(blk).not.toContain("user-select");
  });
});
