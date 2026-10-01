// @vitest-environment jsdom
/*
  공용 Bottom Sheet drag-to-dismiss(lib/sheetDrag.ts) 동작 테스트 — 순수 함수 + jsdom 기반 컨트롤러.
  실제 레이아웃이 없는 jsdom이라 sheet 높이는 getHeight로 주입한다(높이 400).
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachSheetDrag, backdropAlpha, clampDrag, shouldDismiss, DISMISS_RATIO } from "../../lib/sheetDrag";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function setup(over?: { isTop?: () => boolean; reduced?: boolean }) {
  const overlay = document.createElement("div");
  const sheet = document.createElement("div");
  const handle = document.createElement("div");
  sheet.appendChild(handle);
  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
  const onDismiss = vi.fn();
  const ctrl = attachSheetDrag({
    overlay, sheet, handle, onDismiss, getHeight: () => 400,
    isTop: over?.isTop, reducedMotion: () => !!over?.reduced,
  });
  const ev = (type: string, y: number, id = 1) => {
    const e = new Event(type, { bubbles: true }) as any;
    e.pointerId = id; e.clientY = y; e.pointerType = "touch"; e.button = 0;
    handle.dispatchEvent(e);
  };
  return { overlay, sheet, handle, onDismiss, ctrl, ev };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("순수 함수", () => {
  it("위로 끌면 0 미만으로 가지 않는다", () => {
    expect(clampDrag(-50)).toBe(0);
    expect(clampDrag(30)).toBe(30);
  });
  it("높이의 35% 초과일 때만 닫힘, 높이를 모르면 닫지 않는다", () => {
    expect(DISMISS_RATIO).toBe(0.35);
    expect(shouldDismiss(141, 400)).toBe(true);
    expect(shouldDismiss(140, 400)).toBe(false);
    expect(shouldDismiss(999, 0)).toBe(false);
  });
  it("backdrop은 끌수록 옅어진다", () => {
    expect(backdropAlpha(0, 400)).toBe(0.4);
    expect(backdropAlpha(200, 400)).toBe(0.2);
    expect(backdropAlpha(400, 400)).toBe(0);
  });
});

describe("컨트롤러", () => {
  it("handle을 끄는 동안 sheet가 손가락을 따라간다(transition 없음)", () => {
    const { sheet, ev } = setup();
    ev("pointerdown", 100); ev("pointermove", 160);
    expect(sheet.style.transform).toBe("translateY(60px)");
    expect(sheet.style.transition).toBe("none");
  });

  it("위로 끌어도 translate가 생기지 않는다(0 미만 이동 없음)", () => {
    const { sheet, ev } = setup();
    ev("pointerdown", 100); ev("pointermove", 40);
    expect(sheet.style.transform).toBe("");
  });

  it("임계치 미만으로 놓으면 snap-back, 닫히지 않는다", () => {
    const { sheet, onDismiss, ev, ctrl } = setup();
    ev("pointerdown", 100); ev("pointermove", 180); ev("pointerup", 180);
    expect(sheet.style.transform).toBe("");
    expect(sheet.style.transition).toContain("transform");
    vi.advanceTimersByTime(1000);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(ctrl.phase()).toBe("idle");
  });

  it("임계치 이상이면 즉시 닫히지 않고 화면 아래로 slide-out한 뒤 transitionend에서 onDismiss 1회", () => {
    const { sheet, onDismiss, ev } = setup();
    ev("pointerdown", 100); ev("pointermove", 300); ev("pointerup", 300);
    expect(onDismiss).not.toHaveBeenCalled();            // 아직 unmount 안 함
    expect(sheet.style.transform).toBe("translateY(400px)"); // 화면 아래까지
    const te = new Event("transitionend", { bubbles: true }) as any;
    te.propertyName = "transform";
    sheet.dispatchEvent(te);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);                          // fallback timer가 중복 호출하지 않는다
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("transitionend가 누락돼도 fallback timer로 정확히 1회 닫힌다", () => {
    const { onDismiss, ev } = setup();
    ev("pointerdown", 100); ev("pointermove", 300); ev("pointerup", 300);
    vi.advanceTimersByTime(600);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("slide-out 애니메이션 중에는 새 pointer를 무시한다", () => {
    const { sheet, ev, ctrl } = setup();
    ev("pointerdown", 100); ev("pointermove", 300); ev("pointerup", 300);
    expect(ctrl.phase()).toBe("closing");
    ev("pointerdown", 50, 2); ev("pointermove", 90, 2);
    expect(sheet.style.transform).toBe("translateY(400px)");
  });

  it("두 번째 손가락(다른 pointerId)은 진행 중인 drag에 영향을 주지 않는다", () => {
    const { sheet, ev } = setup();
    ev("pointerdown", 100, 1); ev("pointerdown", 100, 2); ev("pointermove", 500, 2);
    expect(sheet.style.transform).toBe("");
    ev("pointermove", 130, 1);
    expect(sheet.style.transform).toBe("translateY(30px)");
  });

  it("reduced-motion이면 애니메이션 없이 즉시 onDismiss 1회", () => {
    const { onDismiss, ev } = setup({ reduced: true });
    ev("pointerdown", 100); ev("pointermove", 300); ev("pointerup", 300);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("중첩 sheet: 최상위가 아니면 drag가 시작되지 않는다", () => {
    const { sheet, onDismiss, ev } = setup({ isTop: () => false });
    ev("pointerdown", 100); ev("pointermove", 300); ev("pointerup", 300);
    expect(sheet.style.transform).toBe("");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("본문(handle 밖)에서 시작한 제스처는 dismiss되지 않는다", () => {
    const { sheet, onDismiss } = setup();
    const body = document.createElement("div");
    sheet.appendChild(body);
    for (const [t, y] of [["pointerdown", 100], ["pointermove", 380], ["pointerup", 380]] as const) {
      const e = new Event(t, { bubbles: true }) as any; e.pointerId = 1; e.clientY = y; body.dispatchEvent(e);
    }
    vi.advanceTimersByTime(1000);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe("");
  });

  it("부모가 닫기를 거부하면(저장 중 등) sheet가 원위치로 돌아온다", () => {
    const { sheet, ev } = setup();
    ev("pointerdown", 100); ev("pointermove", 300); ev("pointerup", 300);
    vi.advanceTimersByTime(400);   // onDismiss 호출됨, 그러나 sheet는 여전히 DOM에 있음
    vi.advanceTimersByTime(600);
    expect(sheet.style.transform).toBe("");
  });
});

describe("SheetOverlay 계약(소스)", () => {
  const src = readFileSync(join(__dirname, "../../app/components/SheetOverlay.tsx"), "utf-8");
  it("swipeDismiss=false 또는 onClick 없음이면 handle을 심지 않는다", () => {
    expect(src).toContain("const canSwipe = swipeDismiss && !!props.onClick;");
  });
  it("최상위 sheet만, alertdialog가 있으면 반응하지 않는다", () => {
    expect(src).toContain('!document.querySelector(\'[role="alertdialog"]\')');
  });
});
