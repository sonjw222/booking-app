/*
  릴리스 폴리시 배치 6차(2026-09-15, item 12) — 검색 화면 back/search 버튼 UI 회귀 방지.
  - 뒤로가기 버튼(BackButton, className="side")은 이미 44×44 터치 타겟 +
    display:grid/place-items:center로 광학 중앙정렬돼 있었다(회귀 확인용 고정).
  - 검색 CTA(.search-go)는 입력창(.search-input, 50px)과 높이가 안 맞았다(44px) —
    50px로 통일. disabled 상태 스타일이 아예 없었던 것도 추가.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cssSource = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
const pageSource = readFileSync(join(__dirname, "../../app/search/page.tsx"), "utf-8");

describe("검색 화면 back/search 버튼 UI", () => {
  it("찾기 탭에 제목과 검색 입력 레이블이 있다", () => {
    expect(pageSource).toContain("<h1>찾기</h1>");
    expect(pageSource).toContain('htmlFor="discovery-search"');
  });

  it("검색 CTA(.search-go)와 입력창(.search-input)의 높이가 동일하다(세로 중앙정렬 어긋남 방지)", () => {
    const inputHeight = cssSource.match(/\.discovery-page-v2 \.search-input \{[^}]*height:\s*(\d+)px/)?.[1];
    const goHeight = cssSource.match(/\.discovery-page-v2 \.search-go \{[^}]*height:\s*(\d+)px/)?.[1];
    expect(inputHeight).toBeDefined();
    expect(goHeight).toBeDefined();
    expect(goHeight).toBe(inputHeight);
  });

  it("검색 CTA에 disabled 상태 스타일이 있다", () => {
    expect(cssSource).toContain(".discovery-page-v2 .search-go:disabled");
  });

  it("검색 입력창은 iOS 자동 확대 방지를 위해 16px 이상 폰트를 쓴다", () => {
    const fontSize = cssSource.match(/\.discovery-page-v2 \.search-input \{[^}]*font-size:\s*(\d+(?:\.\d+)?)px/)?.[1];
    expect(fontSize).toBeDefined();
    expect(Number(fontSize)).toBeGreaterThanOrEqual(16);
  });

  it("검색 CTA는 disabled 상태를 실제로 busy 플래그와 연결해 렌더링한다", () => {
    expect(pageSource).toMatch(/<AppButton className="search-go"[^>]*disabled=\{busy \|\| kw\.trim\(\)\.length < 2\}/);
  });
});
