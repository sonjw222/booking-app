/*
  실기기 QA(2026-09-25) — 태블릿/중간 폭 nav rail 확장 계약.
  - 적용 범위(768–1359px)는 CSS 미디어쿼리와 훅이 같은 문자열을 쓴다(정책 불일치 방지)
  - rail 위에서 시작한 가로 swipe만 처리: 오른쪽=펼침, 왼쪽=접힘, 세로 의도는 취소
  - compact/expanded 상태는 aria-expanded로 노출되고 rail은 overlay(콘텐츠 폭 변수 불변)
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NAV_RAIL_MEDIA, resolveRailSwipe, TRIGGER_PX, SWIPE_INTENT_PX,
} from "../../app/components/useExpandableNavRail";

const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");

describe("rail swipe 판정", () => {
  it("compact에서 오른쪽으로 밀면 expand, 24px 미만 느린 이동은 아무 것도 안 함", () => {
    expect(resolveRailSwipe(TRIGGER_PX, 0, 0.1, false)).toBe("expand");
    expect(resolveRailSwipe(TRIGGER_PX - 6, 0, 0.1, false)).toBeNull();
  });
  it("expanded에서 왼쪽으로 밀면 collapse, 오른쪽으로 밀어도 유지", () => {
    expect(resolveRailSwipe(-TRIGGER_PX, 0, -0.1, true)).toBe("collapse");
    expect(resolveRailSwipe(40, 0, 0.5, true)).toBeNull();
  });
  it("compact에서 왼쪽으로 밀어도 펼쳐지지 않는다(방향 반대)", () => {
    expect(resolveRailSwipe(-60, 0, -0.8, false)).toBeNull();
  });
  it("빠른 flick은 짧아도 인정하되 너무 짧으면(10px 미만) 무시", () => {
    expect(resolveRailSwipe(14, 0, 0.6, false)).toBe("expand");
    expect(resolveRailSwipe(8, 0, 0.9, false)).toBeNull();
  });
  it("세로 의도(스크롤)가 크면 취소 — 가로 이동이 커도 |dx| ≤ |dy|×1.5 이면 무시", () => {
    expect(resolveRailSwipe(30, 30, 0.2, false)).toBeNull();
    expect(resolveRailSwipe(30, 25, 0.2, false)).toBeNull();
  });
  it("7px 미만 떨림은 무시", () => {
    expect(resolveRailSwipe(SWIPE_INTENT_PX - 1, 0, 2, false)).toBeNull();
  });
});

describe("breakpoint / CSS 계약", () => {
  it("훅의 적용 범위 = 768–1359px = CSS의 rail 확장 미디어쿼리", () => {
    expect(NAV_RAIL_MEDIA).toBe("(min-width: 768px) and (max-width: 1359px)");
    expect(css).toContain(`@media ${NAV_RAIL_MEDIA} {\n  .member-desktop-nav[aria-expanded="true"],`);
  });
  it("확장 폭은 기존 데스크톱 rail 값(244px, --workspace-sidebar 1360+와 동일)을 쓴다", () => {
    expect(css).toMatch(/\.workspace-sidebar\[aria-expanded="true"\] \{\s*width: 244px;/);
    expect(css).toContain("--workspace-sidebar: 244px; --workspace-rail: 244px");
  });
  it("1360px 이상은 이 훅의 범위 밖(상시 244px sidebar 유지)", () => {
    expect(NAV_RAIL_MEDIA).toContain("max-width: 1359px");
  });
  it("회원(.member-desktop-nav)과 관리자/플랫폼(.workspace-sidebar) 모두 같은 공용 훅을 쓴다", () => {
    for (const f of ["app/components/BottomNav.tsx", "app/components/ManagerNav.tsx", "app/components/AdminNav.tsx"]) {
      const src = read(f);
      expect(src).toContain("useExpandableNavRail(");
      expect(src).toContain("aria-expanded={expanded}");
    }
  });
  it("라벨은 opacity + 작은 translateX로 rail 폭 전개와 같은 타이밍에 나타난다(즉시 팝인 금지)", () => {
    expect(css).toMatch(/transform: translateX\(-6px\);\s*transition: max-width 220ms/);
  });
  it("rail은 fixed overlay — 확장 시 콘텐츠 폭 변수(--workspace-sidebar)를 바꾸지 않는다", () => {
    const expandedBlock = css.slice(css.indexOf('.member-desktop-nav[aria-expanded="true"],'), css.indexOf('.member-desktop-nav[aria-expanded="true"] .desktop-nav-note'));
    expect(expandedBlock).not.toContain("--workspace-sidebar");
  });
  it("메뉴 항목(a/button)은 rail click 핸들러가 가로채지 않는다 — 항목 탭은 즉시 라우팅", () => {
    const hook = read("app/components/useExpandableNavRail.ts");
    expect(hook).toContain('if (target.closest("a,button")) return;');
  });
});
