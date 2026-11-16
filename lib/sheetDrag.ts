/*
  공용 Bottom Sheet drag-to-dismiss (2026-10-01) — app/components/SheetOverlay.tsx가 사용한다.

  예전에는 app/manager/classes/page.tsx(커밋 23fcb9d)에만 로컬 상태/핸들러로 있었고, 임계치를 넘으면
  곧바로 unmount되어 "손을 놓은 뒤 화면 아래까지 마저 내려가는" 모션이 없었다. 이 모듈이 그 동작을
  공용 구현으로 승격한다.

  정책
  - drag handle에서 시작한 제스처만 dismiss로 인정한다(본문 스크롤과 충돌 없음).
  - 아래로만 반응(위로 끌어도 0에서 멈춤), 손가락을 실시간으로 따라간다(드래그 중 transition 없음).
  - 놓을 때 sheet 높이의 35% 넘게 내렸거나, 아래 방향으로 빠르게 쓸어내렸으면(플릭: 속도 FLICK_VELOCITY 이상 + 최소 거리) → 현재 위치에서 화면 아래까지 slide-out →
    transitionend(또는 fallback timer) 뒤에 onDismiss를 "정확히 1회" 호출. 짧고 느리면 원위치로 snap-back.
    (2026-11-16 실기기 QA 후: 예전 "속도 기준 없음" 정책을 플릭 닫기 요구로 변경 — 거리 기준은 그대로라 느린 드래그의 민감도는 늘지 않는다.)
  - 애니메이션 중에는 새 pointer를 무시한다. prefers-reduced-motion이면 애니메이션 없이 즉시 처리.
  - 닫기가 거부되면(저장 중 등으로 부모가 unmount하지 않음) 잠시 뒤 원위치로 되돌린다.
*/

export const DISMISS_RATIO = 0.35;
export const SLIDE_OUT_MS = 220;
export const SNAP_BACK_MS = 260;
export const FLICK_VELOCITY = 0.5;      // px/ms(=500px/s, iOS 시트 플릭 닫기와 비슷한 수준) — 아래 방향 속도가 이 이상이면 거리가 짧아도 닫는다
export const FLICK_MIN_DISTANCE = 32;   // px — 우발 터치 방지(이보다 짧으면 플릭이어도 닫지 않음)
export const EASE_OUT = "cubic-bezier(.32,.72,0,1)";   // iOS 시트와 비슷한 감속 곡선
const STALE_DRAG_MS = 2500;             // 드래그 중 이 시간 동안 터치 이벤트가 전혀 없으면 손가락을 놓친 것으로 보고 복구
const FALLBACK_PAD_MS = 120;
const BLOCKED_CHECK_MS = 160;
const BACKDROP_ALPHA = 0.4; // .sheet-overlay 배경(rgba(0,0,0,.4))과 동일

/** 위로 끌어도 0 미만으로 가지 않는다. */
export function clampDrag(dy: number): number {
  return dy > 0 ? dy : 0;
}

/** 놓았을 때 닫을지 — 거리 기준(실수 방지) 또는 아래 방향 플릭(velocity, px/ms). 높이를 알 수 없으면(0) 닫지 않는다. */
export function shouldDismiss(dragY: number, height: number, velocity = 0): boolean {
  if (height <= 0) return false;
  if (dragY > height * DISMISS_RATIO) return true;
  return velocity >= FLICK_VELOCITY && dragY >= FLICK_MIN_DISTANCE;
}

/** 최근 샘플(최대 ~100ms)로 계산한 세로 속도(px/ms, 아래가 +). 샘플이 부족하거나 시간차가 0이면 0. */
export function velocityOf(samples: { y: number; t: number }[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) { if (last.t - samples[i].t > 100) break; first = samples[i]; }
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

/** slide-out 시간: 남은 거리 / 속도(최소 속도 보장), 140ms~SLIDE_OUT_MS. */
export function closeDuration(remaining: number, velocity: number): number {
  const v = Math.max(velocity, 1.2);
  return Math.round(Math.min(SLIDE_OUT_MS, Math.max(140, remaining / v)));
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
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  // 실기기 진단용(기본 꺼짐): localStorage.mwhabit_sheet_debug="1" 이면 window.__sheetDragLog 에 단계별 기록을 남긴다.
  const debug = (() => { try { return localStorage.getItem("mwhabit_sheet_debug") === "1"; } catch { return false; } })();
  const log = (m: string) => { if (!debug) return; const w = window as unknown as { __sheetDragLog?: string[] }; (w.__sheetDragLog ??= []).push(`${Math.round(now())} ${m}`); if (w.__sheetDragLog.length > 200) w.__sheetDragLog.shift(); };

  let phase: "idle" | "dragging" | "closing" | "settling" = "idle";
  let pointerId: number | null = null;
  let startY = 0;       // 손가락 시작 y
  let base = 0;         // 드래그 시작 시 시트가 이미 내려가 있던 양(snap-back 도중 다시 잡은 경우)
  let dragY = 0;
  let cachedH = 0;      // 드래그 시작 시 한 번만 측정(매 move 마다 getBoundingClientRect 로 레이아웃을 강제하지 않는다)
  let samples: { y: number; t: number }[] = [];
  let lastEventAt = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let staleTimer: ReturnType<typeof setInterval> | null = null;
  let finished = false;
  let savedOverflowY: string | null = null;

  const later = (fn: () => void, ms: number) => { timers.push(setTimeout(fn, ms)); };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const stopStale = () => { if (staleTimer) { clearInterval(staleTimer); staleTimer = null; } };

  function setOffset(y: number, transition: string | null, ms = SLIDE_OUT_MS) {
    sheet.style.transition = transition ?? "none";
    sheet.style.transform = y > 0 ? `translateY(${y}px)` : "";
    overlay.style.transition = transition ? `background-color ${ms}ms ease-out` : "none";
    overlay.style.backgroundColor = y > 0 ? `rgba(0,0,0,${backdropAlpha(y, cachedH || heightOf())})` : "";
  }

  function lockScroll() { if (savedOverflowY === null) { savedOverflowY = sheet.style.overflowY; sheet.style.overflowY = "hidden"; } }   // 드래그 중 본문 네이티브 스크롤/바운스가 같이 일어나지 않게
  function unlockScroll() { if (savedOverflowY !== null) { sheet.style.overflowY = savedOverflowY; savedOverflowY = null; } }

  function clearInline() {
    sheet.style.transition = "";
    sheet.style.transform = "";
    sheet.style.willChange = "";
    overlay.style.transition = "";
    overlay.style.backgroundColor = "";
    unlockScroll();
  }

  /** 현재 화면에 보이는 시트 y 오프셋(전환 중이어도 실제 값) — snap-back 도중 다시 잡을 때 점프하지 않기 위해. */
  function currentOffset(): number {
    try {
      const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(sheet).transform || "");
      if (m) return Math.max(0, Number(m[1].split(",")[5]) || 0);
    } catch { /* 무시 */ }
    const t = /translateY\((-?[\d.]+)px\)/.exec(sheet.style.transform);
    return t ? Math.max(0, Number(t[1])) : 0;
  }

  function snapBack() {
    phase = "settling";
    clearTimers();
    stopStale();
    log("snapBack");
    if (reduced()) { clearInline(); phase = "idle"; return; }
    setOffset(0, `transform ${SNAP_BACK_MS}ms ${EASE_OUT}`, SNAP_BACK_MS);
    overlay.style.backgroundColor = "";
    const done = () => { clearInline(); phase = "idle"; log("idle"); };
    later(done, SNAP_BACK_MS + FALLBACK_PAD_MS);
  }

  function finishDismiss() {
    if (finished) return;            // transitionend와 fallback timer 중 먼저 온 것만 처리
    finished = true;
    clearTimers();
    log("dismiss");
    opts.onDismiss();
    // 부모가 닫기를 거부했으면(저장 중 등) sheet가 화면 밖에 남지 않도록 원위치로 되돌린다.
    later(() => {
      if (sheet.isConnected && overlay.isConnected) { finished = false; snapBack(); }
    }, BLOCKED_CHECK_MS);
  }

  /** 드래그 시작(포인터·터치 공용). snap-back 도중이면 그 위치에서 이어서 잡는다. 시작할 수 없으면 false. */
  function begin(y: number): boolean {
    if (phase === "closing" || phase === "dragging") return false;
    let from = 0;
    if (phase === "settling") { from = currentOffset(); clearTimers(); log(`grab@${from}`); }
    cachedH = heightOf();
    startY = y; base = from; dragY = from;
    samples = [{ y, t: now() }]; lastEventAt = now();
    phase = "dragging"; finished = false;
    sheet.style.willChange = "transform";
    if (from > 0) setOffset(from, null);
    stopStale();
    staleTimer = setInterval(() => { if (phase === "dragging" && now() - lastEventAt > STALE_DRAG_MS) { log("stale → recover"); recover(); } }, 500);
    log("begin");
    return true;
  }

  function move(y: number) {
    dragY = clampDrag(base + (y - startY));
    lastEventAt = now();
    samples.push({ y, t: lastEventAt }); if (samples.length > 8) samples.shift();
    setOffset(dragY, null);
  }

  function finishDrag(canceled: boolean) {
    stopStale();
    const height = cachedH || heightOf();
    const v = velocityOf(samples);
    log(`end canceled=${canceled} dragY=${Math.round(dragY)} v=${v.toFixed(2)}`);
    if (!canceled && shouldDismiss(dragY, height, v)) {
      phase = "closing";
      finished = false;
      if (reduced()) { finishDismiss(); return; }
      const dur = closeDuration(height - dragY, v);
      setOffset(height, `transform ${dur}ms ${EASE_OUT}`, dur);
      overlay.style.backgroundColor = "rgba(0,0,0,0)";
      later(finishDismiss, dur + FALLBACK_PAD_MS);   // transitionend 누락 대비
    } else if (dragY > 0) {
      snapBack();
    } else {
      clearInline();
      phase = "idle";
    }
  }

  /** 손가락을 놓쳤거나(touchend 누락) 페이지가 가려지는 등 비정상 상황: 시트가 중간 위치에 남지 않도록 원위치로 복구. */
  function recover() {
    removeWindowTouch(); tMode = null; tId = null;
    if (pointerId !== null) { try { handle.releasePointerCapture?.(pointerId); } catch { /* 무시 */ } pointerId = null; }
    if (phase === "dragging") finishDrag(true);
  }

  // ── 핸들(포인터) 드래그 ──
  function onPointerDown(e: PointerEvent) {
    if ((phase !== "idle" && phase !== "settling") || pointerId !== null) return;       // 닫는 중/다른 pointer 진행 중
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!isTop()) return;
    if (!begin(e.clientY)) return;
    pointerId = e.pointerId;
    try { handle.setPointerCapture?.(e.pointerId); } catch { /* 무시 */ }
  }

  function onPointerMove(e: PointerEvent) {
    if (phase !== "dragging" || e.pointerId !== pointerId) return;
    move(e.clientY);
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
  // 이벤트는 touchstart 이후 **window** 에서 받는다: iOS 는 touchmove/touchend 를 "처음 터치한 요소"로 보내는데, 그 요소가 드래그 중 리렌더로 DOM 에서 제거되면
  // 시트(overlay)로 버블링되지 않아 touchend 를 영영 못 받고 시트가 중간에 멈춘다(간헐적 "내려가서 안 닫힘"의 유력 원인). window 리스너는 이를 피한다.
  type TouchMode = null | "pending" | "drag" | "scroll" | "horizontal";
  let tMode: TouchMode = null;
  let tId: number | null = null;
  let tY0 = 0, tX0 = 0, tScroller: HTMLElement | null = null;
  const NO_DRAG = "input, textarea, select, [contenteditable='true'], [data-no-sheet-drag], .sheet-drag-handle";

  const touchOf = (list: TouchList): Touch | null => { for (let i = 0; i < list.length; i++) if (list[i].identifier === tId) return list[i]; return null; };
  function nearestScroller(target: EventTarget | null): HTMLElement | null {
    for (let el = target instanceof HTMLElement ? target : null; el && el !== overlay; el = el.parentElement) { if (isVerticalScroller(el)) return el; if (el === sheet) break; }
    return isVerticalScroller(sheet) ? sheet : null;
  }
  function addWindowTouch() {
    window.addEventListener("touchmove", onWinTouchMove, { passive: false });
    window.addEventListener("touchend", onWinTouchEnd, { passive: false });
    window.addEventListener("touchcancel", onWinTouchEnd, { passive: false });
  }
  function removeWindowTouch() {
    window.removeEventListener("touchmove", onWinTouchMove);
    window.removeEventListener("touchend", onWinTouchEnd);
    window.removeEventListener("touchcancel", onWinTouchEnd);
  }
  function onTouchStart(e: TouchEvent) {
    if (phase === "dragging" && tMode === "drag") recover();                 // 이전 터치의 끝을 못 받았다면 먼저 복구
    tMode = null;
    if ((phase !== "idle" && phase !== "settling") || pointerId !== null || e.touches.length !== 1 || !isTop()) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest(NO_DRAG)) return;                        // 입력 요소·핸들(핸들은 포인터 경로)·명시 제외
    tMode = "pending"; tId = e.touches[0].identifier; tY0 = e.touches[0].clientY; tX0 = e.touches[0].clientX; tScroller = sheet.contains(t) ? nearestScroller(t) : null;
    addWindowTouch();
  }
  function onWinTouchMove(e: TouchEvent) {
    if (tMode === null || !isTop()) return;
    const t = touchOf(e.touches); if (!t) return;
    const dy = t.clientY - tY0, dx = t.clientX - tX0;
    if (tMode === "pending") {
      if (Math.abs(dy) < 3 && Math.abs(dx) < 3) return;
      if (Math.abs(dx) > Math.abs(dy)) { tMode = "horizontal"; return; }   // 가로 스크롤·캐러셀은 건드리지 않는다
      if (dy > 0 && (!tScroller || tScroller.scrollTop <= 0)) {
        if (begin(t.clientY)) { tMode = "drag"; lockScroll(); } else { tMode = "scroll"; }
      } else tMode = "scroll";
    }
    if (tMode === "drag") {
      if (e.cancelable) e.preventDefault(); else log("touchmove not cancelable");   // 이미 네이티브 스크롤이 시작된 뒤면 취소 불가 — overflow 잠금으로 보완
      move(t.clientY); return;
    }
    if (tMode === "scroll") {
      // 본문이 스크롤 끝단에서 더 밀리면 WebView 문서까지 튕긴다(흰 빈 영역) — 끝단 초과 입력은 막는다.
      const sc = tScroller;
      const atBottom = !sc || sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1, atTop = !!sc && sc.scrollTop <= 0;
      if (((dy < 0 && atBottom) || (dy > 0 && atTop)) && e.cancelable) e.preventDefault();
    }
  }
  function onWinTouchEnd(e: TouchEvent) {
    if (tId === null) { removeWindowTouch(); return; }
    let mine = false; for (let i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === tId) mine = true;
    if (!mine && e.touches.length > 0) return;                  // 다른 손가락이 떨어진 것
    const was = tMode; tMode = null; tId = null; removeWindowTouch();
    if (was !== "drag" || phase !== "dragging") return;
    if (e.cancelable) e.preventDefault();
    finishDrag(e.type === "touchcancel");
  }
  // 시트 밖(딤 영역)에서 시작한 터치: 배경 문서가 당겨지지 않게 touchmove 를 막는다.
  function onOverlayTouchMove(e: TouchEvent) {
    if (!isTop()) return;
    if (e.target instanceof Node && sheet.contains(e.target)) return;
    if (e.cancelable) e.preventDefault();
  }
  const onAbort = () => recover();
  const onVisibility = () => { if (document.visibilityState === "hidden") recover(); };

  if (opts.contentDrag) {
    sheet.addEventListener("touchstart", onTouchStart, { passive: true });
    overlay.addEventListener("touchmove", onOverlayTouchMove, { passive: false });
    window.addEventListener("blur", onAbort);
    window.addEventListener("pagehide", onAbort);
    document.addEventListener("visibilitychange", onVisibility);
  }
  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onCancel);
  sheet.addEventListener("transitionend", onTransitionEnd);

  return {
    phase: () => phase,
    destroy() {
      clearTimers(); stopStale(); removeWindowTouch();
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      sheet.removeEventListener("transitionend", onTransitionEnd);
      if (opts.contentDrag) {
        sheet.removeEventListener("touchstart", onTouchStart); overlay.removeEventListener("touchmove", onOverlayTouchMove);
        window.removeEventListener("blur", onAbort); window.removeEventListener("pagehide", onAbort); document.removeEventListener("visibilitychange", onVisibility);
      }
      if (sheet.isConnected) clearInline();
    },
  };
}
