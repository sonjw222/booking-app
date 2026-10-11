import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computePopoverPosition } from "../../lib/popoverPosition";

const panel = { width: 310, height: 308 };
const anchor = (top: number, left = 20, h = 48) => ({ top, left, bottom: top + h, right: left + 300 });
const inside = (p: { top: number; left: number; maxHeight?: number }, vp: { width: number; height: number }) => {
  const h = Math.min(panel.height, p.maxHeight ?? panel.height);
  return p.top >= 0 && p.left >= 0 && p.top + h <= vp.height && p.left + panel.width <= vp.width;
};

describe("computePopoverPosition", () => {
  it("공간이 충분하면 앵커 아래에 둔다", () => {
    const vp = { width: 1440, height: 900 };
    const p = computePopoverPosition(anchor(200), panel, vp);
    expect(p.placement).toBe("bottom");
    expect(p.top).toBe(248 + 8);
    expect(p.maxHeight).toBeUndefined();
    expect(inside(p, vp)).toBe(true);
  });

  it("아래 공간이 모자라고 위가 충분하면 위에 둔다", () => {
    const vp = { width: 390, height: 844 };
    const p = computePopoverPosition(anchor(600), panel, vp);
    expect(p.placement).toBe("top");
    expect(p.top + panel.height).toBeLessThanOrEqual(600 - 8);
    expect(inside(p, vp)).toBe(true);
  });

  it("오른쪽 공간이 모자라면 왼쪽으로 밀어 넣는다", () => {
    const vp = { width: 390, height: 844 };
    const p = computePopoverPosition(anchor(100, 200), panel, vp);
    expect(p.left).toBe(390 - 310 - 8);
    expect(inside(p, vp)).toBe(true);
  });

  it("위·아래 모두 모자라지만 뷰포트에는 들어가면 뷰포트 안으로 밀어 넣는다(앵커와 겹침 허용)", () => {
    const vp = { width: 390, height: 420 };
    const p = computePopoverPosition(anchor(180), panel, vp);
    expect(p.placement).toBe("overlay");
    expect(inside(p, vp)).toBe(true);
    expect(p.maxHeight).toBeUndefined();
  });

  it("뷰포트보다 패널이 크면 maxHeight로 내부 스크롤 처리한다", () => {
    const vp = { width: 390, height: 250 };
    const p = computePopoverPosition(anchor(100), panel, vp);
    expect(p.maxHeight).toBe(250 - 16);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + (p.maxHeight ?? 0)).toBeLessThanOrEqual(250);
  });

  it("패널 크기는 바꾸지 않는다(일반 화면에서 maxHeight 없음)", () => {
    for (const vp of [{ width: 375, height: 667 }, { width: 820, height: 1180 }, { width: 1440, height: 900 }]) {
      expect(computePopoverPosition(anchor(150), panel, vp).maxHeight).toBeUndefined();
    }
  });
});

// 구조 계약: 팝오버는 어떤 조상(.sheet, .sheet-overlay의 overflow:hidden 등)에도 잘리지 않도록 body로 포털 + fixed 좌표를 쓴다.
describe("DatePicker overlay contract", () => {
  const src = readFileSync(join(__dirname, "../../app/components/DatePicker.tsx"), "utf-8");
  const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
  const overlay = readFileSync(join(__dirname, "../../app/components/SheetOverlay.tsx"), "utf-8");

  it("항상 document.body로 createPortal 한다(조상 overflow/오버레이에 의존하지 않음)", () => {
    expect(src).toMatch(/createPortal\(/);
    expect(src).toContain("setHost(document.body)");
    expect(src).not.toContain('closest("[data-sheet-overlay]")');
  });

  it("fixed 팝오버 클래스가 있고 absolute 부모 기준 좌표를 쓰지 않는다", () => {
    expect(css).toMatch(/\.app-date-popover\.is-floating\s*\{[^}]*position:\s*fixed/);
    expect(src).toContain("app-date-popover is-floating");
    expect(src).not.toContain("open-up");
  });

  it("레이아웃 뷰포트 기준으로 계산하고 visualViewport로 높이를 줄이지 않는다", () => {
    expect(src).toContain("document.documentElement.clientWidth");
    expect(src).not.toContain("window.visualViewport");
  });

  it("body 포털 팝오버는 SheetOverlay 포커스 트랩에서 예외 처리되고 팝오버 안에서 Tab이 순환한다", () => {
    expect(src).toContain('data-overlay-portal=""');
    expect(overlay).toContain('closest("[data-overlay-portal]")');
    expect(src).toContain("trapTab");
  });

  it("바깥 클릭은 팝오버(포털)와 트리거 영역을 모두 안쪽으로 본다", () => {
    expect(src).toMatch(/popover\.current\?\.contains\(target\)/);
    expect(src).toMatch(/root\.current\?\.contains\(target\)/);
  });

  it("ESC는 capture 단계에서 캘린더만 닫고 상위 시트로 전파하지 않는다", () => {
    expect(src).toMatch(/addEventListener\("keydown", escape, true\)/);
    expect(src).toContain("event.stopPropagation()");
  });

  it("스크롤/리사이즈 때 위치를 다시 계산한다", () => {
    expect(src).toContain('window.addEventListener("resize"');
    expect(src).toMatch(/addEventListener\("scroll", handler, true\)/);
  });

  it("manager-classes-v2 시트 전용 스타일은 body 포털 팝오버에도 변형 클래스로 적용된다", () => {
    expect(src).toContain('closest(".manager-classes-v2 .sheet")');
    expect(css).toContain(".app-date-popover.in-classes-sheet");
    expect(css).not.toContain("[data-sheet-overlay] > .app-date-popover");
  });
});
