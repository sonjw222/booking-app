// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachSheetDrag } from "../../lib/sheetDrag";
import { installBackBridge, runBack } from "../../lib/backPolicy";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function mkSheet(opts: { contentDrag: boolean; edgeBlock?: boolean; scrollTop?: number; scrollable?: boolean; reduced?: boolean }) {
  document.body.innerHTML = `<div id="ov" data-sheet-overlay ${opts.edgeBlock ? "data-edge-swipe-block" : ""}><div id="sheet" class="sheet"><div class="sheet-drag-handle" id="h"></div><div id="body"><p id="p">내용</p><input id="in" /></div></div></div>`;
  const overlay = document.getElementById("ov")!, sheet = document.getElementById("sheet")!, handle = document.getElementById("h")!;
  Object.defineProperty(sheet, "scrollHeight", { value: opts.scrollable ? 2000 : 300, configurable: true }); Object.defineProperty(sheet, "clientHeight", { value: 500, configurable: true });
  sheet.scrollTop = opts.scrollTop ?? 0;
  sheet.style.overflowY = opts.scrollable ? "auto" : "visible";
  const onDismiss = vi.fn();
  const ctrl = attachSheetDrag({ overlay, sheet, handle, onDismiss, contentDrag: opts.contentDrag, getHeight: () => 500, reducedMotion: () => opts.reduced ?? true });
  return { overlay, sheet, onDismiss, ctrl };
}
let tid = 0;
function touch(type: string, target: Element, y: number, x = 100) {
  if (type === "touchstart") tid++;
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: unknown[]; changedTouches: unknown[] };
  const pt = { clientX: x, clientY: y, identifier: tid };
  Object.defineProperty(e, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [pt] });
  Object.defineProperty(e, "changedTouches", { value: [pt] });
  target.dispatchEvent(e); return e;
}
const swipe = (target: Element, y0: number, y1: number, x0 = 100, x1 = 100, end = true, frameMs = 60) => {
  touch("touchstart", target, y0, x0);
  const moves = [1, 2, 3, 4, 5].map((i) => { vi.advanceTimersByTime(frameMs); return touch("touchmove", target, y0 + ((y1 - y0) * i) / 5, x0 + ((x1 - x0) * i) / 5); });
  if (end) { vi.advanceTimersByTime(frameMs); touch("touchend", target, y1, x1); } return moves;
};
beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ""; });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

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
  it("빠른 아래 플릭(짧은 거리·고속)은 닫고, 같은 거리의 느린 드래그는 원위치", () => {
    const fast = mkSheet({ contentDrag: true }); swipe(document.getElementById("p")!, 100, 160, 100, 100, true, 4); expect(fast.onDismiss).toHaveBeenCalledTimes(1);   // 60px, 5×4ms → 약 3px/ms
    const slow = mkSheet({ contentDrag: true }); swipe(document.getElementById("p")!, 100, 160, 100, 100, true, 40); expect(slow.onDismiss).not.toHaveBeenCalled(); expect(slow.sheet.style.transform).toBe("");
    const tiny = mkSheet({ contentDrag: true }); swipe(document.getElementById("p")!, 100, 110, 100, 100, true, 2); expect(tiny.onDismiss).not.toHaveBeenCalled();   // 최소 거리 미달 플릭은 무시
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

describe("안정성 — 손가락/요소 소실·취소·재진입", () => {
  it("드래그 중 터치한 요소가 DOM 에서 제거돼도(리렌더) touchend 를 window 로 받아 정리된다 — 시트가 중간에 멈추지 않는다", () => {
    const { sheet, onDismiss } = mkSheet({ contentDrag: true }); const p = document.getElementById("p")!;
    touch("touchstart", p, 100); vi.advanceTimersByTime(120); touch("touchmove", p, 140); vi.advanceTimersByTime(120); touch("touchmove", p, 200);
    const host = p.parentElement!; host.removeChild(p);                       // 터치 대상 제거(React 리렌더 모사)
    vi.advanceTimersByTime(120); const win = new Event("touchmove", { bubbles: true, cancelable: true }); Object.defineProperty(win, "touches", { value: [{ clientX: 100, clientY: 230, identifier: tid }] }); window.dispatchEvent(win);
    const end = new Event("touchend", { bubbles: true, cancelable: true }); Object.defineProperty(end, "touches", { value: [] }); Object.defineProperty(end, "changedTouches", { value: [{ clientX: 100, clientY: 230, identifier: tid }] }); window.dispatchEvent(end);
    vi.advanceTimersByTime(1000); expect(sheet.style.transform).toBe(""); expect(onDismiss).not.toHaveBeenCalled();   // 130px(26%) → 원위치, 상태 idle
  });
  it("touchend 를 끝내 못 받으면(손가락 소실) 다음 터치 시작/가림/타임아웃에서 원위치로 복구", () => {
    const a = mkSheet({ contentDrag: true }); const p = document.getElementById("p")!;
    touch("touchstart", p, 100); vi.advanceTimersByTime(60); touch("touchmove", p, 130); vi.advanceTimersByTime(60); touch("touchmove", p, 170); expect(a.sheet.style.transform).toContain("translateY"); expect(a.ctrl.phase()).toBe("dragging");
    vi.advanceTimersByTime(3200); expect(a.ctrl.phase()).not.toBe("dragging"); vi.advanceTimersByTime(600); expect(a.sheet.style.transform).toBe("");   // 정지 타임아웃 → snap-back
    const b = mkSheet({ contentDrag: true }); const q = document.getElementById("p")!;
    touch("touchstart", q, 100); vi.advanceTimersByTime(60); touch("touchmove", q, 130); vi.advanceTimersByTime(60); touch("touchmove", q, 170); touch("touchstart", q, 300); vi.advanceTimersByTime(600);   // 새 터치가 끝을 못 받은 이전 드래그를 복구
    expect(b.sheet.style.transform).toBe("");
    const c = mkSheet({ contentDrag: true }); const r = document.getElementById("p")!;
    touch("touchstart", r, 100); vi.advanceTimersByTime(60); touch("touchmove", r, 130); vi.advanceTimersByTime(60); touch("touchmove", r, 170); Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); vi.advanceTimersByTime(600);
    expect(c.sheet.style.transform).toBe(""); Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  it("snap-back 도중 다시 잡으면 현재 위치에서 이어서 따라간다(점프 없음) — 빠른 연속 드래그", () => {
    const { sheet, ctrl } = mkSheet({ contentDrag: true, reduced: false }); const p = document.getElementById("p")!;
    swipe(p, 100, 190, 100, 100, true, 60);                                      // 느리게 내렸다 놓음 → snap-back 시작
    expect(ctrl.phase()).toBe("settling"); sheet.style.transform = "translateY(40px)";   // 전환 도중 위치(jsdom 은 transition 을 계산하지 않으므로 인라인 값으로 대체)
    touch("touchstart", p, 100); vi.advanceTimersByTime(60); touch("touchmove", p, 120); vi.advanceTimersByTime(60); touch("touchmove", p, 150);
    expect(ctrl.phase()).toBe("dragging"); expect(sheet.style.transform).toMatch(/translateY\((\d+(\.\d+)?)px\)/);
    const y = Number(/translateY\(([\d.]+)px\)/.exec(sheet.style.transform)![1]); expect(y).toBeGreaterThanOrEqual(40);   // 0 으로 튀지 않고 40px 에서 이어서
  });
  it("드래그 중에는 본문 overflow 를 잠가 네이티브 스크롤·바운스와 동시에 일어나지 않고, 끝나면 복원", () => {
    const { sheet } = mkSheet({ contentDrag: true, scrollable: true }); const p = document.getElementById("p")!;
    swipe(p, 100, 160, 100, 100, false); expect(sheet.style.overflowY).toBe("hidden"); touch("touchend", p, 160); vi.advanceTimersByTime(1000); expect(sheet.style.overflowY).toBe("auto");
  });
  it("열고 닫기 20회 반복해도 window 리스너가 누적되지 않는다(destroy 로 정리)", () => {
    const add = vi.spyOn(window, "addEventListener"), rem = vi.spyOn(window, "removeEventListener");
    for (let i = 0; i < 20; i++) { const { ctrl } = mkSheet({ contentDrag: true }); swipe(document.getElementById("p")!, 100, 130, 100, 100, true, 60); ctrl.destroy(); }
    const net = (name: string) => add.mock.calls.filter((c) => c[0] === name).length - rem.mock.calls.filter((c) => c[0] === name).length;
    for (const n of ["touchmove", "touchend", "touchcancel", "blur", "pagehide"]) expect(net(n)).toBeLessThanOrEqual(0);   // 추가한 만큼(이상) 제거 — 누적 없음
    add.mockRestore(); rem.mockRestore();
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
    expect(users.sort()).toEqual(["app/center/[id]/page.tsx", "app/components/SheetOverlay.tsx", "app/globals.css", "lib/nativeBounce.ts", "lib/sheetDrag.ts"]);   // globals.css·nativeBounce 는 주석에서만 언급
  });
  it("네이티브 변경 없음: iOS 는 이미 문자열 판정이면 아무것도 하지 않는다(EdgeBackPolicy)", () => {
    const sw = readFileSync("ios/App/App/NavigationPolicyPlugin.swift", "utf8"); expect(sw).toContain("if bridgeResult != nil { return .none }");
  });
});
