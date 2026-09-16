/*
  릴리스 폴리시 배치 6차(2026-09-15, item 11) — 관리자 "더보기" 화면 마지막 메뉴와 하단
  nav 사이 공백 과다 회귀 방지. 근본 원인은 여러 차례의 "final" 시도가 서로를 지우지
  않고 쌓여 padding-bottom(app/globals.css)과 별도 스페이서 엘리먼트
  (.manager-menu-end-spacer, app/manager/page.tsx)가 동시에 적용돼 여백이 이중으로
  쌓인 것 — 스페이서를 완전히 제거하고 padding-bottom 하나만 유일한 기준으로 남겼다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cssSource = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
const pageSource = readFileSync(join(__dirname, "../../app/manager/page.tsx"), "utf-8");

describe("관리자 더보기 화면 하단 여백 — 이중 스페이서 제거 회귀 방지", () => {
  it("manager-menu-end-spacer 엘리먼트가 JSX에서 완전히 제거됐다", () => {
    expect(pageSource).not.toContain("manager-menu-end-spacer");
  });

  it("manager-menu-end-spacer CSS 규칙(selector 자체)이 완전히 제거됐다(설명 주석 속 언급은 허용)", () => {
    expect(cssSource).not.toContain(".manager-menu-end-spacer {");
    expect(cssSource).not.toContain(".manager-menu-end-spacer{");
  });

  it(".manager-home-v2에 걸리는 padding-bottom 선언이 정확히 하나(공용 !important 블록)만 남아있다(예전 92px/28px/170px 등 중복 버전 제거)", () => {
    // .manager-home-v2 자체 selector에 padding-bottom을 직접 주는 규칙(28px/92px/170px 버전들)은
    // 이제 없어야 하고, 여러 selector를 묶은 공용 !important 블록 하나(104px)만 남아야 한다.
    expect(cssSource).not.toMatch(/\.manager-home-v2\s*\{[^}]*padding-bottom/);
    expect(cssSource).not.toMatch(/\.manager-home-v2\{[^}]*padding-bottom/);
    const sharedBlockMatches = cssSource.match(/\.manager-home-v2,\n\s*\.manager-members-v2,\n\s*\.manager-classes-v2\s*\{\s*padding-bottom: calc\(var\(--floating-nav-clearance\) \+ 104px\) !important;/g) ?? [];
    expect(sharedBlockMatches.length).toBe(1);
  });

  it("남은 유일한 padding-bottom 규칙은 --floating-nav-clearance(nav 실제 높이+safe-bottom)를 기준으로 한다", () => {
    const idx = cssSource.indexOf("padding-bottom: calc(var(--floating-nav-clearance) + 104px) !important;");
    expect(idx).toBeGreaterThan(-1);
  });
});
