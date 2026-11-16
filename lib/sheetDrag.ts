/*
  공용 Bottom Sheet drag-to-dismiss (2026-10-01) — app/components/SheetOverlay.tsx가 사용한다.

  예전에는 app/manager/classes/page.tsx(커밋 23fcb9d)에만 로컬 상태/핸들러로 있었고, 임계치를 넘으면
  곧바로 unmount되어 "손을 놓은 뒤 화면 아래까지 마저 내려가는" 모션이 없었다. 이 모듈이 그 동작을
  공용 구현으로 승격한다.

  정책
  - drag handle에서 시작한 제스처만 dismiss로 인정한다(본문 스크롤과 충돌 없음).
  - 아래로만 반응(위로 끌어도 0에서 멈춤), 손가락을 실시간으로 따라간다(드래그 중 transition 없음).
  - 놓을 때 sheet 높이의 35% 넘게 내렸으면 → 현재 위치에서 화면 아래까지 slide-out →
    transitionend(또는 fallback timer) 뒤에 onDismiss를 "정확히 1회" 호출. 미만이면 원위치로 snap-back.
  - 애니메이션 중에는 새 pointer를 무시한다. prefers-reduced-motion이면 애니메이션 없이 즉시 처리.
  - 닫기가 거부되면(저장 중 등으로 부모가 unmount하지 않음) 잠시 뒤 원위치로 되돌린다.
*/

export const DISMISS_RATIO = 0.35;
export const SLIDE_OUT_MS = 220;
export const SNAP_BACK_MS = 200;
const FALLBACK_PAD_MS = 120;
const BLOCKED_CHECK_MS = 160;
const BACKDROP_ALPHA = 0.4; // .sheet-overlay 배경(rgba(0,0,0,.4))과 동일

/** 위로 끌어도 0 미만으로 가지 않는다. */
export function clampDrag(dy: number): number {
  return dy > 0 ? dy : 0;
}

/** 놓았을 때 닫을지 — 거리 기준(실수 방지), 높이를 알 수 없으면(0) 닫지 않는다. */
export function shouldDismiss(dragY: number, height: number): boolean {
  return height > 0 && dragY > height * DISMISS_RATIO;
}

/** 요소가 세로로 실제 스크롤 가능한 컨테이너인지. */
export function isVerticalScroller(el: HTMLElement): boolean {
  const oy = typeof getComputedStyle === "function" ? getComputedStyle(el).overflowY : "";
  return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
}

/** 끌린 만큼 backdrop을 옅게(0~1 비율 → 알파). */
export function backdropAlpha(dragY: number, height: number): number {
  if (height <= 0) return BACKDROP_ALPHA;
  const ratio = Math.min(1, Math.max(0, dragY / height));
  return Number((BACKDROP_ALPHA * (1 - ratio)).toFixed(3));
}

export type SheetDragOptions = {
  overlay: HTMLElement;
  sheet: HTMLElement;
  handle: HTMLElement;
  /** 실제 닫기 실행(= 배경 탭/취소 버튼과 같은 경로). 정확히 1회 호출된다. */
  onDismiss: () => void;
  /** 최상위 sheet인지(중첩 sheet에서는 맨 위만 반응). */
  isTop?: () => boolean;
  reducedMotion?: () => boolean;
  /** 테스트/특수 환경용 높이 측정 주입. */
  getHeight?: () => number;
  /**
   * 본문에서 시작한 아래 방향 터치 드래그도 시트 닫기로 인정(2026-11-16, 수강권 안내창 등 opt-in — 기본 false라 다른 시트는 변경 없음).
   * 본문이 맨 위(scrollTop 0)일 때만 드래그로 전환하고, 그 밖에는 본문 스크롤이 우선한다. 시트가 열린 동안 배경(WebView 문서)이 같이 당겨지는
   * rubber-band(흰 빈 영역)를 막기 위해 시트 밖 터치·스크롤 끝단 터치의 touchmove 는 preventDefault 한다.
   */
  contentDrag?: boolean;
};

export type SheetDragController = { destroy: () => void; phase: () => "idle" | "dragging" | "closing" | "settling" };

export function attachSheetDrag(opts: SheetDragOptions): SheetDragController {
  const { overlay, sheet, handle } = opts;
  const isTop = opts.isTop ?? (() => true);
  const reduced = opts.reducedMotion ?? (() =>
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const heightOf = opts.getHeight ?? (() => sheet.getBoundingClientRect().height);

  let phase: "idle" | "dragging" | "closing" | "settling" = "idle";
  let pointerId: number | null = null;
  let startY = 0;
  let dragY = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let finished = false;

  const later = (fn: () => void, ms: number) => { timers.push(setTimeout(fn, ms)); };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

  function setOffset(y: number, transition: string | null) {
    sheet.style.transition = transition ?? "none";
    sheet.style.transform = y > 0 ? `translateY(${y}px)` : "";
    overlay.style.transition = transition ? `background-color ${SLIDE_OUT_MS}ms ease-out` : "none";
    overlay.style.backgroundColor = y > 0 ? `rgba(0,0,0,${backdropAlpha(y, heightOf())})` : "";
  }

  function clearInline() {
    sheet.style.transition = "";
    sheet.style.transform = "";
    overlay.style.transition = "";
    overlay.style.backgroundColor = "";
  }

  function snapBack() {
    phase = "settling";
    clearTimers();
    if (reduced()) { clearInline(); phase = "idle"; return; }
    setOffset(0, `transform ${SNAP_BACK_MS}ms cubic-bezier(.2,.8,.2,1)`);
    overlay.style.backgroundColor = "";
    const done = () => { clearInline(); phase = "idle"; };
    later(done, SNAP_BACK_MS + FALLBACK_PAD_MS);
  }

  function finishDismiss() {
    if (finished) return;            // transitionend와 fallback timer 중 먼저 온 것만 처리
    finished = true;
    clearTimers();
    opts.onDismiss();
    // 부모가 닫기를 거부했으면(저장 중 등) sheet가 화면 밖에 남지 않도록 원위치로 되돌린다.
    later(() => {
      if (sheet.isConnected && overlay.isConnected) { finished = false; snapBack(); }
    }, BLOCKED_CHECK_MS);
  }

  function onPointerDown(e: PointerEvent) {
    if (phase !== "idle" || pointerId !== null) return;       // 애니메이션/다른 pointer 진행 중
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!isTop()) return;
    pointerId = e.pointerId;
    startY = e.clientY;
    dragY = 0;
    phase = "dragging";
    try { handle.setPointerCapture?.(e.pointerId); } catch { /* 무시 */ }
  }

  function onPointerMove(e: PointerEvent) {
    if (phase !== "dragging" || e.pointerId !== pointerId) return;
    dragY = clampDrag(e.clientY - startY);
    setOffset(dragY, null);
  }

  function finishDrag(canceled: boolean) {
    const height = heightOf();
    if (!canceled && shouldDismiss(dragY, height)) {
      phase = "closing";
      finished = false;
      if (reduced()) { finishDismiss(); return; }
      setOffset(height, `transform ${SLIDE_OUT_MS}ms cubic-bezier(.4,0,1,1)`);
      overlay.style.backgroundColor = "rgba(0,0,0,0)";
      later(finishDismiss, SLIDE_OUT_MS + FALLBACK_PAD_MS);   // transitionend 누락 대비
    } else if (dragY > 0) {
      snapBack();
    } else {
      phase = "idle";
    }
  }

  function release(e: PointerEvent, canceled: boolean) {
    if (phase !== "dragging" || e.pointerId !== pointerId) return;
    pointerId = null;
    try { handle.releasePointerCapture?.(e.pointerId); } catch { /* 무시 */ }
    finishDrag(canceled);
  }

  const onUp = (e: PointerEvent) => release(e, false);
  const onCancel = (e: PointerEvent) => release(e, true);
  const onTransitionEnd = (e: TransitionEvent) => {
    if (phase === "closing" && e.target === sheet && e.propertyName === "transform") finishDismiss();
  };


  // ── 본문(content) 터치 드래그 — opt-in ──
  type TouchMode = null | "pending" | "drag" | "scroll" | "horizontal";
  let tMode: TouchMode = null;
  let tY0 = 0, tX0 = 0, tScroller: HTMLElement | null = null;
  const NO_DRAG = "input, textarea, select, [contenteditable='true'], [data-no-sheet-drag], .sheet-drag-handle";

  function nearestScroller(target: EventTarget | null): HTMLElement | null {
    for (let el = target instanceof HTMLElement ? target : null; el && el !== overlay; el = el.parentElement) { if (isVerticalScroller(el)) return el; if (el === sheet) break; }
    return isVerticalScroller(sheet) ? sheet : null;
  }
  function onTouchStart(e: TouchEvent) {
    tMode = null;
    if (phase !== "idle" || pointerId !== null || e.touches.length !== 1 || !isTop()) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest(NO_DRAG)) return;                        // 입력 요소·핸들(핸들은 포인터 경로)·명시 제외
    tMode = "pending"; tY0 = e.touches[0].clientY; tX0 = e.touches[0].clientX; tScroller = sheet.contains(t) ? nearestScroller(t) : null;
  }
  function onTouchMove(e: TouchEvent) {
    if (e.touches.length !== 1 || !isTop()) return;
    const inSheet = e.target instanceof Node && sheet.contains(e.target);
    if (!inSheet) { if (e.cancelable) e.preventDefault(); return; }   // 시트 밖(딤 영역) 터치: 배경 문서가 당겨지지 않게
    if (tMode === null) return;
    const dy = e.touches[0].clientY - tY0, dx = e.touches[0].clientX - tX0;
    if (tMode === "pending") {
      if (Math.abs(dy) < 3 && Math.abs(dx) < 3) return;
      if (Math.abs(dx) > Math.abs(dy)) { tMode = "horizontal"; return; }   // 가로 스크롤·캐러셀은 건드리지 않는다
      if (dy > 0 && (!tScroller || tScroller.scrollTop <= 0)) { tMode = "drag"; phase = "dragging"; tY0 = e.touches[0].clientY; dragY = 0; }
      else tMode = "scroll";
    }
    if (tMode === "drag") { if (e.cancelable) e.preventDefault(); dragY = clampDrag(e.touches[0].clientY - tY0); setOffset(dragY, null); return; }
    if (tMode === "scroll") {
      // 본문이 스크롤 끝단에서 더 밀리면 WebView 문서까지 튕긴다(흰 빈 영역) — 끝단 초과 입력은 막는다.
      const sc = tScroller;
      const atBottom = !sc || sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1, atTop = !!sc && sc.scrollTop <= 0;
      if (((dy < 0 && atBottom) || (dy > 0 && atTop)) && e.cancelable) e.preventDefault();
    }
  }
  function onTouchEnd(e: TouchEvent) {
    const was = tMode; tMode = null;
    if (was !== "drag" || phase !== "dragging") return;
    if (e.cancelable) e.preventDefault();
    finishDrag(e.type === "touchcancel");
  }
  if (opts.contentDrag) {
    sheet.addEventListener("touchstart", onTouchStart, { passive: true });
    overlay.addEventListener("touchmove", onTouchMove, { passive: false });
    overlay.addEventListener("touchend", onTouchEnd, { passive: false });
    overlay.addEventListener("touchcancel", onTouchEnd, { passive: false });
  }

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onCancel);
  sheet.addEventListener("transitionend", onTransitionEnd);

  return {
    phase: () => phase,
    destroy() {
      clearTimers();
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      sheet.removeEventListener("transitionend", onTransitionEnd);
      if (opts.contentDrag) { sheet.removeEventListener("touchstart", onTouchStart); overlay.removeEventListener("touchmove", onTouchMove); overlay.removeEventListener("touchend", onTouchEnd); overlay.removeEventListener("touchcancel", onTouchEnd); }
      if (sheet.isConnected) clearInline();
    },
  };
}
