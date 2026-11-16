// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachSheetDrag } from "../../lib/sheetDrag";
import { installBackBridge, runBack } from "../../lib/backPolicy";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function mkSheet(opts: { contentDrag: boolean; edgeBlock?: boolean; scrollTop?: number; scrollable?: boolean }) {
  document.body.innerHTML = `<div id="ov" data-sheet-overlay ${opts.edgeBlock ? "data-edge-swipe-block" : ""}><div id="sheet" class="sheet"><div class="sheet-drag-handle" id="h"></div><div id="body"><p id="p">내용</p><input id="in" /></div></div></div>`;
  const overlay = document.getElementById("ov")!, sheet = document.getElementById("sheet")!, handle = document.getElementById("h")!;
  Object.defineProperty(sheet, "scrollHeight", { value: opts.scrollable ? 2000 : 300, configurable: true }); Object.defineProperty(sheet, "clientHeight", { value: 500, configurable: true });
  sheet.scrollTop = opts.scrollTop ?? 0;
  sheet.style.overflowY = opts.scrollable ? "auto" : "visible";
  const onDismiss = vi.fn();
  const ctrl = attachSheetDrag({ overlay, sheet, handle, onDismiss, contentDrag: opts.contentDrag, getHeight: () => 500, reducedMotion: () => true });
  return { overlay, sheet, onDismiss, ctrl };
}
let tid = 0;
function touch(type: string, target: Element, y: number, x = 100) {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: unknown[]; timeStamp: number };
  const pts = type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y, identifier: ++tid }];
  Object.defineProperty(e, "touches", { value: pts }); target.dispatchEvent(e); return e;
}
const swipe = (target: Element, y0: number, y1: number, x0 = 100, x1 = 100, end = true) => {
  touch("touchstart", target, y0, x0); const moves = [1, 2, 3, 4, 5].map((i) => touch("touchmove", target, y0 + ((y1 - y0) * i) / 5, x0 + ((x1 - x0) * i) / 5));
  if (end) touch("touchend", target, y1, x1); return moves;
};
beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => { document.body.innerHTML = ""; });

describe("본문 터치 드래그(contentDrag, opt-in)", () => {
  it("opt-in 이 아니면(기본) 본문 터치는 아무 영향이 없다 — 다른 시트 동작 불변", () => {
    const { sheet, onDismiss } = mkSheet({ contentDrag: false });
    const moves = swipe(document.getElementById("p")!, 100, 480); expect(sheet.style.transform).toBe(""); expect(moves.every((m) => !m.defaultPrevented)).toBe(true); expect(onDismiss).not.toHaveBeenCalled();
  });
  it("맨 위에서 아래로 끌면 시트가 따라 내려가고(preventDefault), 기준(35%) 이상이면 닫는다", () => {
    const { sheet, onDismiss } = mkSheet({ contentDrag: true });
    const p = document.getElementById("p")!;
    const moves = swipe(p, 100, 100 + 100, 100, 100, false); expect(sheet.style.transform).toContain("translateY(80px)"); expect(moves.every((m) => m.defaultPrevented)).toBe(true);
    touch("touchend", p, 200); expect(onDismiss).not.toHaveBeenCalled();   // 80/500 = 16% < 35% → 원위치(reducedMotion: 즉시 정리)
    expect(sheet.style.transform).toBe("");
    swipe(p, 100, 100 + 300); expect(onDismiss).toHaveBeenCalledTimes(1);
  });
  it("본문 스크롤이 맨 위가 아니면 일반 스크롤 우선(드래그 전환 없음)", () => {
    const { sheet, onDismiss } = mkSheet({ contentDrag: true, scrollable: true, scrollTop: 120 });
    const moves = swipe(document.getElementById("p")!, 100, 400); expect(sheet.style.transform).toBe(""); expect(onDismiss).not.toHaveBeenCalled(); expect(moves.every((m) => !m.defaultPrevented)).toBe(true);
  });
  it("스크롤 가능한 본문이 맨 위(scrollTop 0)면 아래 드래그가 시트 드래그로 전환", () => {
    const { onDismiss } = mkSheet({ contentDrag: true, scrollable: true, scrollTop: 0 });
    swipe(document.getElementById("p")!, 100, 450); expect(onDismiss).toHaveBeenCalledTimes(1);
  });
  it("손가락을 위로 밀면(스크롤 방향) 시트는 움직이지 않는다 — 끝단이 아니면 preventDefault 도 안 함", () => {
    const { sheet } = mkSheet({ contentDrag: true, scrollable: true, scrollTop: 0 });
    const moves = swipe(document.getElementById("p")!, 400, 100); expect(sheet.style.transform).toBe(""); expect(moves.every((m) => !m.defaultPrevented)).toBe(true);
  });
  it("스크롤 끝단 초과(맨 아래에서 위로)·내용이 짧은 시트에서 위로 밀기는 preventDefault(문서 rubber-band 차단)", () => {
    const a = mkSheet({ contentDrag: true, scrollable: true }); a.sheet.scrollTop = 2000 - 500;   // 맨 아래
    expect(swipe(document.getElementById("p")!, 400, 100).every((m) => m.defaultPrevented)).toBe(true);
    const b = mkSheet({ contentDrag: true, scrollable: false });
    expect(swipe(document.getElementById("p")!, 400, 100).every((m) => m.defaultPrevented)).toBe(true);
  });
  it("시트 밖(딤 영역) 터치 이동은 항상 preventDefault", () => {
    const { overlay, sheet } = mkSheet({ contentDrag: true }); const moves = swipe(overlay, 5, 300);
    expect(moves.every((m) => m.defaultPrevented)).toBe(true); expect(sheet.style.transform).toBe("");
  });
  it("가로 스와이프·입력 요소·여러 손가락은 드래그로 전환하지 않는다", () => {
    const { sheet, onDismiss } = mkSheet({ contentDrag: true });
    swipe(document.getElementById("p")!, 100, 110, 20, 300); expect(sheet.style.transform).toBe("");
    swipe(document.getElementById("in")!, 100, 480); expect(sheet.style.transform).toBe(""); expect(onDismiss).not.toHaveBeenCalled();
  });
  it("touchcancel 이면 닫지 않고 원위치", () => {
    const { sheet, onDismiss } = mkSheet({ contentDrag: true }); const p = document.getElementById("p")!;
    swipe(p, 100, 480, 100, 100, false); touch("touchcancel", p, 480); expect(onDismiss).not.toHaveBeenCalled(); expect(sheet.style.transform).toBe("");
  });
  it("destroy 후 리스너가 제거된다", () => {
    const { sheet, ctrl } = mkSheet({ contentDrag: true }); ctrl.destroy(); swipe(document.getElementById("p")!, 100, 300); expect(sheet.style.transform).toBe("");
  });
});

describe("가장자리 스와이프 입구(edge)·시스템 back 구분", () => {
  const router = { back: vi.fn(), push: vi.fn(), replace: vi.fn() };
  const overlay = (edgeBlock: boolean) => { document.body.innerHTML = `<div data-sheet-overlay ${edgeBlock ? "data-edge-swipe-block" : ""}></div>`; };
  it("edge-swipe 차단 시트가 맨 위: edge 입구는 아무것도 안 하고, 시스템 back 은 기존대로 시트를 닫는다", () => {
    overlay(true); const el = document.querySelector<HTMLElement>("[data-sheet-overlay]")!; const click = vi.spyOn(el, "click");
    expect(runBack(router, "/center/x", { edgeSwipe: true })).toBe("blocked-by-overlay"); expect(click).not.toHaveBeenCalled(); expect(router.back).not.toHaveBeenCalled();
    expect(runBack(router, "/center/x")).toBe("close-overlay"); expect(click).toHaveBeenCalledTimes(1);
  });
  it("다른 시트(차단 표시 없음)는 edge 입구에서도 기존처럼 닫힌다 — 범위 제한", () => {
    overlay(false); const el = document.querySelector<HTMLElement>("[data-sheet-overlay]")!; const click = vi.spyOn(el, "click");
    expect(runBack(router, "/center/x", { edgeSwipe: true })).toBe("close-overlay"); expect(click).toHaveBeenCalled();
  });
  it("시트가 닫히면(오버레이 없음) edge 입구는 일반 back 정책", () => {
    document.body.innerHTML = ""; const d = runBack(router, "/center/x", { edgeSwipe: true }); expect(["history-back", "fallback", "none"]).toContain(d);
  });
  it("installBackBridge: iOS 네이티브면 __mwhabitBack 이 edge 판정, 아니면(Android·웹) 기존 판정; __mwhabitBackEdge 는 항상 edge", () => {
    overlay(true);
    const off = installBackBridge(router, () => "/center/x", { iosNative: true }); expect(window.__mwhabitBack!()).toBe("blocked-by-overlay"); expect(window.__mwhabitBackEdge!()).toBe("blocked-by-overlay"); off(); expect(window.__mwhabitBack).toBeUndefined();
    overlay(true); const off2 = installBackBridge(router, () => "/center/x", {}); expect(window.__mwhabitBack!()).toBe("close-overlay"); expect(window.__mwhabitBackEdge!()).toBe("blocked-by-overlay"); off2();
  });
});

describe("소스 계약", () => {
  it("수강권 안내창(센터 구매 시트)만 contentDrag 를 켠다", () => {
    const center = readFileSync("app/center/[id]/page.tsx", "utf8"); expect(center).toMatch(/<SheetOverlay className="sheet-overlay" onClick=\{\(\) => setBuySheet\(false\)\} contentDrag>/);
    const users = ["app", "lib"].flatMap((d) => execFileSync("grep", ["-rl", "contentDrag", d], { encoding: "utf8" }).split("\n").filter(Boolean));
    expect(users.sort()).toEqual(["app/center/[id]/page.tsx", "app/components/SheetOverlay.tsx", "lib/sheetDrag.ts"]);
  });
  it("네이티브 변경 없음: iOS 는 이미 문자열 판정이면 아무것도 하지 않는다(EdgeBackPolicy)", () => {
    const sw = readFileSync("ios/App/App/NavigationPolicyPlugin.swift", "utf8"); expect(sw).toContain("if bridgeResult != nil { return .none }");
  });
});
