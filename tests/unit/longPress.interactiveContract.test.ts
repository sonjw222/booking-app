/*
  2026-09-26 — iOS 길게 누르기: 탭하는 UI의 텍스트 선택/callout/드래그 방지 계약.
  입력창/본문은 영향 없어야 하고, 앱 전체 user-select: none은 금지.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
const start = css.lastIndexOf("a[href],\nbutton,", css.indexOf(".list-row {\n  -webkit-touch-callout: none"));
const inputRestore = css.indexOf("input, textarea, select, [contenteditable=\"\"]", start);
const controlBlock = css.slice(start, inputRestore);
const restoreBlock = css.slice(inputRestore, css.indexOf("}", inputRestore) + 1);

describe("interactive control CSS", () => {
  it("링크/버튼/탭/네비게이션 항목에 callout·user-select(webkit 포함) none", () => {
    for (const sel of ["a[href]", "button", '[role="button"]', '[role="tab"]', ".bottom-nav", ".desktop-nav-item", ".workspace-sidebar", ".member-desktop-nav", ".filter-chip", ".center-tab", ".list-row"]) {
      expect(controlBlock).toContain(sel);
    }
    expect(controlBlock).toContain("-webkit-touch-callout: none");
    expect(controlBlock).toContain("-webkit-user-select: none");
    expect(controlBlock).toMatch(/\buser-select: none/);
  });
  it("앱 전체(*, html, body, #root)에 user-select: none을 걸지 않는다", () => {
    expect(css).not.toMatch(/(^|\n)\s*(\*|html|body|main|p|div|span)\s*(,[^{]*)?\{[^}]*user-select:\s*none/);
  });
  it("input/textarea/select/contenteditable은 text 선택과 callout을 명시적으로 복원", () => {
    expect(restoreBlock).toContain("-webkit-user-select: text");
    expect(restoreBlock).toContain("user-select: text");
    expect(restoreBlock).toContain("-webkit-touch-callout: default");
    for (const sel of ["input", "textarea", "select", "contenteditable"]) expect(restoreBlock).toContain(sel);
  });
  it("touch-action: manipulation만 사용(pan 제스처를 막는 none/pinch-zoom 제한 없음)", () => {
    expect(controlBlock).toContain("touch-action: manipulation");
    expect(controlBlock).not.toMatch(/touch-action:\s*none/);
  });
  it("SwipeRow(pan-y)와 rail(pan-y) 설정은 그대로 — 가로 제스처 회귀 없음", () => {
    expect(css).toMatch(/\.swipe-row-content \{[^}]*touch-action: pan-y/);
    expect(css).toMatch(/\.member-desktop-nav, \.workspace-sidebar \{ touch-action: pan-y/);
  });
  it("pressed 모션: scale 속성(transform과 별개) 미세값 + reduced-motion 해제, 과한 spring 없음", () => {
    expect(css).toContain("scale: .985");
    expect(css).toMatch(/transition: scale 110ms cubic-bezier\(\.2,\.75,\.2,1\)/);
    expect(css.slice(css.indexOf("scale: .985"))).toMatch(/prefers-reduced-motion: reduce\)[\s\S]{0,200}\{ scale: 1; \}/);
    expect(css).not.toMatch(/scale: \.9[0-7]/);
  });
  it("pressed 스타일은 :where()로 특이도 0 — 기존 컴포넌트의 transition/pressed 스타일을 덮어쓰지 않는다", () => {
    expect(css).toContain(":where(a[href], button, [role=\"button\"], [role=\"tab\"]) { transition: scale");
  });
});

describe("InteractiveGuard(contextmenu/dragstart)", () => {
  class FakeEl {
    constructor(private flags: { interactive?: boolean; editable?: boolean }) {}
    closest(sel: string) {
      if (sel.includes("input, textarea")) return this.flags.editable ? this : null;
      return this.flags.interactive ? this : null;
    }
  }
  afterEach(() => vi.unstubAllGlobals());

  it("탭하는 UI는 true, 입력창/편집 영역/일반 본문은 false", async () => {
    vi.stubGlobal("Element", FakeEl);
    const { isInteractiveTarget } = await import("../../app/components/InteractiveGuard");
    expect(isInteractiveTarget(new FakeEl({ interactive: true }))).toBe(true);
    expect(isInteractiveTarget(new FakeEl({ interactive: true, editable: true }))).toBe(false);
    expect(isInteractiveTarget(new FakeEl({}))).toBe(false);
    expect(isInteractiveTarget(null)).toBe(false);
  });
  it("네이티브에서만 붙고 document 전체 드래그/메뉴를 막지 않는다(대상 판별 후에만 preventDefault)", () => {
    const src = readFileSync(join(__dirname, "../../app/components/InteractiveGuard.tsx"), "utf-8");
    expect(src).toContain("if (!Capacitor.isNativePlatform()) return;");
    expect(src).toContain("if (isInteractiveTarget(e.target)) e.preventDefault();");
    expect(src).not.toMatch(/addEventListener\("(drop|dragover|selectstart)"/);
    // pointerdown에서 실행/이동시키지 않는다 — action은 release(click) 1회
    expect(src).not.toMatch(/addEventListener\("pointer/);
  });
  it("root layout에 마운트되어 있다", () => {
    const layout = readFileSync(join(__dirname, "../../app/layout.tsx"), "utf-8");
    expect(layout).toContain("<InteractiveGuard />");
  });
});
