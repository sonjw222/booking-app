/*
  app/center/[id]/page.tsx ("센터 상세" — 회원용) — iPhone 14 Pro 실기기 QA(2026-10-01):
  뒤로가기 버튼과 센터 프로필 이미지(placeholder 배지)가 시각적으로 겹치는 문제.
  근본 원인: .center-detail-head가 absolute라 정상 흐름에서 높이를 차지하지 않는데,
  .center-hero-badge는 이를 고정값 margin-top: 90px로만 밀어내고 있었다 — 이 값이
  헤더의 실제 렌더 높이(safe-area-inset-top 포함)와 무관해, Dynamic Island 기기
  (iPhone 14 Pro, safe-area-inset-top ≈ 59px)에서 헤더 실제 높이(~101px)가 90px를
  넘어서며 겹쳤다. 렌더링 도구 없이(이 프로젝트 기존 관례) 소스 텍스트로 검증한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(__dirname, "../../app/center/[id]/page.tsx"), "utf-8");
const cssRaw = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");

describe("센터 상세 화면 구조 — back button / hero(사진 또는 placeholder 배지) / 탭", () => {
  it("뒤로가기 버튼(.side)과 .center-hero가 둘 다 존재한다", () => {
    expect(page).toContain('<a className="side" aria-label="뒤로가기" href={backHref}>‹</a>');
    expect(page).toContain('<div className="center-hero">');
  });

  it("사진 있음/없음(placeholder 배지) 둘 다 같은 .center-hero 안에서 렌더된다(같은 header spacing 규칙 적용 대상)", () => {
    const heroBlock = page.slice(page.indexOf('<div className="center-hero">'), page.indexOf('{/* 섹션 탭 */}'));
    expect(heroBlock).toContain("ZoomableImage className=\"center-hero-photo\"");
    expect(heroBlock).toContain('<div className="center-hero-badge">{center.name.slice(0, 1)}</div>');
  });

  it("센터 상세 화면은 center-detail-v2 스코프를 쓴다(이 화면 전용 CSS만 수정 — 공용 .back-header/.center-hero 기본 규칙은 그대로)", () => {
    expect(page).toContain('className="app-shell center-detail-v2"');
  });
});

describe("근본 원인 수정 — badge spacing이 헤더의 실제 렌더 높이에서 계산된다(고정 매직넘버 아님)", () => {
  const scope = css.slice(css.indexOf(".center-detail-v2 {"), css.indexOf(".center-detail-v2 .center-tabs {"));

  it("헤더 실제 높이를 하나의 CSS 변수(--center-detail-head-h)로 정의한다 — 여러 곳에 흩어진 매직넘버 대신 단일 규칙", () => {
    expect(scope).toMatch(/--center-detail-head-h:\s*calc\(max\(18px,\s*var\(--safe-top\)\)\s*\+\s*30px\s*\+\s*12px\)/);
  });

  it("badge의 margin-top이 이 변수를 그대로 참조한다(고정 90px가 아님)", () => {
    expect(scope).toMatch(/\.center-hero-badge\s*\{\s*margin:\s*calc\(var\(--center-detail-head-h\)\s*\+\s*16px\)/);
    expect(scope).not.toMatch(/\.center-hero-badge\s*\{\s*margin:\s*90px/);
  });

  it("safe-area(--safe-top, env(safe-area-inset-top))를 계속 반영한다 — 하드코딩된 고정 px로 되돌아가지 않음", () => {
    expect(scope).toContain("var(--safe-top)");
  });

  it("뒤로가기 버튼 위치(헤더의 position/top/padding-top)는 이번 수정으로 바뀌지 않았다 — 버튼을 밀어 올리는 방식이 아니라 그 아래 hero를 내리는 방식", () => {
    expect(scope).toContain("position: absolute; top: 0; left: 0; right: 0; z-index: 20;");
    expect(scope).toContain("padding-top: max(18px,var(--safe-top));");
  });

  it("사진(.center-hero-photo) 크기는 그대로다(이미지를 축소해서 문제를 회피하지 않음 — 310px 유지)", () => {
    expect(scope).toContain("height: 310px");
  });

  it("터치 영역(.back-header .side)은 최소 44x44가 이미 보장돼 있다(기존 규칙, 회귀 없음)", () => {
    expect(css).toContain(".back-header .side { min-width: 44px; min-height: 44px; }");
  });
});

describe("오른쪽 상단 메뉴/액션 버튼 — 이 화면은 별도 액션 없이 빈 spacer만 있다(감사 결과, 새로 추가하지 않음)", () => {
  it("center-detail-head의 두 번째 .side는 액션 없는 빈 spacer다", () => {
    const headerBlock = page.slice(page.indexOf('className="back-header center-detail-head"'), page.indexOf('className="back-header center-detail-head"') + 300);
    expect(headerBlock).toContain('<div className="side" />');
    expect(headerBlock).not.toMatch(/onClick/);
  });
});

describe("하단 UI 회귀 없음 — 탭/구매·예약 바는 그대로", () => {
  it("center-tabs와 center-bottom-bar 관련 코드는 이번 변경 범위 밖(구조 변경 없음)", () => {
    expect(page).toContain('<div className="center-tabs">');
  });
});
