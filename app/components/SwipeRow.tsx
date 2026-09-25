"use client";

/*
  범용 swipe-to-reveal row — 회원/관리자 알림 공용(app/notifications, app/manager/notifications).

  실기기 QA 재설계(2026-09-25) — 사용자가 iPhone에서 발견한 문제:
    1) 왼쪽 방향 한 쪽에 "고정+삭제"가 같이 나와 헷갈린다 → 방향별로 분리:
       오른쪽→왼쪽 = rightAction(삭제), 왼쪽→오른쪽 = leftAction(고정/고정 해제).
    2) 조금만 밀고 놓으면 action 없는 빈 공간이 생긴 채 row가 어정쩡하게 멈춘다 →
       release 시 "닫힘(0)" 또는 "해당 action이 완전히 드러난 위치(±width)" 두 곳 중 하나로만
       스냅한다(중간 정지 상태가 존재하지 않는다).
    3) 손가락을 따라오는 거리가 손가락 이동량과 같아 반응이 굼뜨다 → 가로 의도가 확정된 뒤부터
       손가락보다 살짝 빠르게(최대 1.4배, 6~30px 구간에서 1.0→1.4로 부드럽게 증가 — 확정 순간
       튀지 않음) 따라온다. 7px 미만 움직임은 무시(의도치 않은 터치/스크롤 보호).
    4) 애니메이션: dragging 상태(즉시 응답, transition 없음)와 released 상태(rAF로 구동하는
       감속 이징)를 분리. 같은 프레임에서 content transform과 action 패널의 reveal 진행도
       (--swipe-p-l/r → label opacity)를 함께 갱신하므로 버튼 라벨/아이콘이 열림/닫힘 애니메이션에
       맞춰 자연스럽게 나타난다(CSS transition을 덧대는 방식이 아님).

  성능: pointermove마다 React state를 갱신하지 않는다 — 위치는 ref + DOM(style)로만 다루고, 부모로
  올리는 state는 "지금 열린 row id" 하나뿐이다.

  제스처 보호: touch-action: pan-y(CSS) — 수직 스크롤은 브라우저가 가져가면 pointercancel로 끝난다.
  가로 확정은 |dx| ≥ 7px 이면서 |dx| > |dy| × 1.5 일 때만 → 수직 스크롤 중 생긴 작은 x 움직임으로는
  열리지 않는다. 삭제/고정은 오직 버튼 탭으로만 실행된다(스와이프 자체는 열기만 함).
*/
import { useEffect, useRef, type ReactNode } from "react";

export const SWIPE_INTENT_PX = 7;          // 이보다 작은 움직임은 무시(방향 판정도 안 함)
export const SWIPE_AXIS_RATIO = 1.5;       // |dx| > |dy| * 1.5 일 때만 가로로 확정
export const SWIPE_GAIN_MAX = 1.4;         // 손가락 이동량 대비 row 이동량 최대 배율
const GAIN_RAMP_PX = 24;                   // 의도 확정(7px) 이후 이 거리에 걸쳐 gain이 1.0 → GAIN_MAX
export const SWIPE_OPEN_THRESHOLD_PX = 24; // 닫힌 상태에서 이만큼(표시 이동량) 끌면 열림 (손가락 ≈ 19px)
export const SWIPE_CLOSE_THRESHOLD_PX = 20; // 열린 상태에서 이만큼 되돌리면 닫힘
export const SWIPE_FLICK_VELOCITY = 0.35;  // px/ms — 이 이상으로 빠르게 놓으면 방향대로 스냅
const FLICK_MIN_TRAVEL_PX = 12;            // flick 판정에 필요한 최소 표시 이동량
const FLICK_SAMPLE_WINDOW = 100;           // ms — velocity 계산에 쓰는 최근 샘플 구간
const OVERSWIPE_MAX = 24;                  // px — action 폭을 넘어 끌 수 있는 고무줄 여유
const OVERSWIPE_RESISTANCE = 0.35;

export type SwipeSide = "left" | "right"; // left: 왼쪽 action이 열림(콘텐츠가 오른쪽으로), right: 오른쪽 action

/** 손가락 이동량 dx(부호 포함) → 표시할 row 이동량. 가로 확정 이후 1.0 → SWIPE_GAIN_MAX로 부드럽게 증가. */
export function applySwipeGain(dx: number): number {
  const abs = Math.abs(dx);
  const ramp = Math.min(1, Math.max(0, (abs - SWIPE_INTENT_PX) / GAIN_RAMP_PX));
  return dx * (1 + (SWIPE_GAIN_MAX - 1) * ramp);
}

/** action 폭을 넘는 구간에 고무줄 저항 적용. 범위 밖(반대 방향)은 0으로 clamp. */
export function clampSwipeX(x: number, leftWidth: number, rightWidth: number, base: number): number {
  const min = base > 0 ? 0 : -rightWidth; // 왼쪽 action이 열려 있으면 오른쪽으로 넘어가지 못함(그 반대도 동일)
  const max = base < 0 ? 0 : leftWidth;
  let v = x;
  // 닫는 방향의 끝(0)은 하드 clamp — 열려 있던 row가 반대편 action 영역으로 넘어가 보이지 않게.
  if (base < 0 && v > 0) v = 0;
  if (base > 0 && v < 0) v = 0;
  if (v > max) v = max + Math.min(OVERSWIPE_MAX, (v - max) * OVERSWIPE_RESISTANCE);
  if (v < min) v = min - Math.min(OVERSWIPE_MAX, (min - v) * OVERSWIPE_RESISTANCE);
  // action이 없는 쪽으로는 거의 움직이지 않게(살짝 저항감만) — 빈 공간이 드러나지 않도록.
  if (leftWidth <= 0 && v > 0) v = Math.min(6, v * 0.15);
  if (rightWidth <= 0 && v < 0) v = Math.max(-6, v * 0.15);
  return v;
}

export interface SwipeReleaseInput {
  x: number;            // release 시점의 표시 이동량(+ = 왼쪽 action 방향)
  velocity: number;     // 손가락 velocity(px/ms, + = 오른쪽으로)
  base: number;         // 제스처 시작 위치(0, +leftWidth, -rightWidth)
  leftWidth: number;
  rightWidth: number;
}

/**
 * release 결정 — 반환값은 스냅할 최종 위치(0 | +leftWidth | -rightWidth) 뿐이다. 중간 위치로는
 * 절대 정지하지 않는다(사용자 리포트의 "빈 공간이 생긴 채 고정" 방지).
 */
export function resolveSwipeRelease({ x, velocity, base, leftWidth, rightWidth }: SwipeReleaseInput): number {
  const fast = Math.abs(velocity) >= SWIPE_FLICK_VELOCITY;
  if (base === 0) {
    // 닫힌 상태에서 시작 — 방향별 action이 있을 때만 열린다.
    if (x > 0 && leftWidth > 0) {
      if (x >= SWIPE_OPEN_THRESHOLD_PX) return leftWidth;
      if (fast && velocity > 0 && x >= FLICK_MIN_TRAVEL_PX) return leftWidth;
    }
    if (x < 0 && rightWidth > 0) {
      if (-x >= SWIPE_OPEN_THRESHOLD_PX) return -rightWidth;
      if (fast && velocity < 0 && -x >= FLICK_MIN_TRAVEL_PX) return -rightWidth;
    }
    return 0; // threshold 미만 → closed로 복귀
  }
  // 열린 상태에서 시작 — 되돌리는 방향으로 조금만(또는 빠르게) 움직이면 닫힘, 아니면 그대로 유지.
  const openSide: SwipeSide = base > 0 ? "left" : "right";
  const towardClosed = openSide === "left" ? base - x : x - base; // 닫힘 방향으로 이동한 양(px)
  const velTowardClosed = openSide === "left" ? -velocity : velocity;
  if (towardClosed >= SWIPE_CLOSE_THRESHOLD_PX) return 0;
  if (fast && velTowardClosed > 0 && towardClosed >= 6) return 0;
  return base;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

// 빠르게 시작해 끝에서 감속하는 이징(easeOutQuart) — "손가락을 놓자마자 즉각 반응 → 부드럽게 정착".
const easeOut = (t: number) => 1 - Math.pow(1 - t, 4);

export default function SwipeRow({
  id, openId, onOpenChange, leftAction, rightAction,
  leftActionWidth = 88, rightActionWidth = 88, children, className,
}: {
  id: string;
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  leftAction?: ReactNode;   // 왼쪽→오른쪽 스와이프로 드러남(예: 고정/고정 해제)
  rightAction?: ReactNode;  // 오른쪽→왼쪽 스와이프로 드러남(예: 삭제)
  leftActionWidth?: number;
  rightActionWidth?: number;
  children: ReactNode;
  className?: string;
}) {
  const leftW = leftAction ? leftActionWidth : 0;
  const rightW = rightAction ? rightActionWidth : 0;
  const rowRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isOpen = openId === id;

  // 최신 props를 ref로 — pointer 핸들러/애니메이션 루프가 항상 최신 값을 본다.
  const cfg = useRef({ leftW, rightW, isOpen, openId, onOpenChange });
  cfg.current = { leftW, rightW, isOpen, openId, onOpenChange };

  const openSide = useRef<SwipeSide | null>(null);
  const pos = useRef(0);                       // 현재 표시 위치(px)
  const anim = useRef<number | null>(null);    // 진행 중인 released 애니메이션 rAF id
  const dragRaf = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const drag = useRef<{
    pointerId: number | null; startX: number; startY: number;
    axis: "x" | "y" | null; base: number; x: number; samples: { t: number; x: number }[];
  }>({ pointerId: null, startX: 0, startY: 0, axis: null, base: 0, x: 0, samples: [] });

  function paint(x: number) {
    pos.current = x;
    const content = contentRef.current;
    const row = rowRef.current;
    if (!content || !row) return;
    content.style.transform = x === 0 ? "" : `translate3d(${x}px,0,0)`;
    const { leftW: lw, rightW: rw } = cfg.current;
    const l = Math.max(0, x);
    const r = Math.max(0, -x);
    row.style.setProperty("--swipe-l", `${l}px`);
    row.style.setProperty("--swipe-r", `${r}px`);
    row.style.setProperty("--swipe-p-l", lw > 0 ? String(Math.min(1, l / lw)) : "0");
    row.style.setProperty("--swipe-p-r", rw > 0 ? String(Math.min(1, r / rw)) : "0");
  }

  function cancelAnim() {
    if (anim.current != null) { cancelAnimationFrame(anim.current); anim.current = null; }
  }

  // released 상태 — 현재 위치에서 target까지 rAF로 감속 이동(content와 action reveal을 같은 프레임에 갱신).
  function settleTo(target: number) {
    cancelAnim();
    const from = pos.current;
    if (from === target) { paint(target); rowRef.current?.setAttribute("data-swipe-state", "idle"); return; }
    if (prefersReducedMotion()) { paint(target); rowRef.current?.setAttribute("data-swipe-state", "idle"); return; }
    const dist = Math.abs(target - from);
    const duration = Math.min(320, 190 + dist * 1.1);
    const t0 = performance.now();
    rowRef.current?.setAttribute("data-swipe-state", "settling");
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      paint(from + (target - from) * easeOut(t));
      if (t < 1) anim.current = requestAnimationFrame(step);
      else { anim.current = null; paint(target); rowRef.current?.setAttribute("data-swipe-state", "idle"); }
    };
    anim.current = requestAnimationFrame(step);
  }

  // 외부에서 openId가 바뀌면(다른 row를 열었거나 outside tap으로 닫힘) 동기화.
  useEffect(() => {
    if (drag.current.axis === "x") return; // 드래그 중에는 건드리지 않음
    const target = isOpen ? (openSide.current === "left" ? leftW : -rightW) : 0;
    if (!isOpen) openSide.current = null;
    settleTo(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, leftW, rightW]);

  useEffect(() => () => { cancelAnim(); if (dragRaf.current != null) cancelAnimationFrame(dragRaf.current); }, []);

  function onPointerDown(e: React.PointerEvent) {
    const s = drag.current;
    if (s.pointerId != null) return; // 멀티터치 등 이미 추적 중
    if (e.pointerType === "mouse" && e.button !== 0) return;
    s.pointerId = e.pointerId;
    s.startX = e.clientX; s.startY = e.clientY;
    s.axis = null;
    s.base = pos.current;
    s.samples = [{ t: performance.now(), x: e.clientX }];
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = drag.current;
    if (s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.axis) {
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (adx < SWIPE_INTENT_PX && ady < SWIPE_INTENT_PX) return; // 1~6px 움직임은 무시
      if (adx > ady * SWIPE_AXIS_RATIO && adx >= SWIPE_INTENT_PX) {
        s.axis = "x";
        cancelAnim(); // 정착 애니메이션 도중 다시 잡으면 현재 위치에서 이어서 드래그
        s.base = pos.current;
        rowRef.current?.setAttribute("data-swipe-state", "dragging");
        try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); } catch { /* 이미 끝난 포인터 등 — 캡처 없이도 동작 */ }
        // 다른 row가 열려 있으면 즉시 닫는다.
        const { openId: cur, onOpenChange: change } = cfg.current;
        if (cur !== null && cur !== id) change(null);
      } else if (ady >= SWIPE_INTENT_PX) {
        s.axis = "y"; // 세로 스크롤에 맡김 — 이 제스처 동안은 아무것도 하지 않는다
      } else {
        return; // 아직 방향 불명확 — 조금 더 지켜본다
      }
    }
    if (s.axis !== "x") return;
    e.preventDefault();
    const next = clampSwipeX(s.base + applySwipeGain(dx), cfg.current.leftW, cfg.current.rightW, s.base);
    s.x = next; // release 판정은 rAF에 밀리지 않도록 이 값(마지막 계산 위치)을 쓴다
    const now = performance.now();
    s.samples.push({ t: now, x: e.clientX });
    while (s.samples.length > 1 && now - s.samples[0].t > FLICK_SAMPLE_WINDOW) s.samples.shift();
    if (dragRaf.current != null) cancelAnimationFrame(dragRaf.current);
    dragRaf.current = requestAnimationFrame(() => { dragRaf.current = null; paint(next); });
  }

  function endDrag(e: React.PointerEvent) {
    const s = drag.current;
    if (s.pointerId !== e.pointerId) return;
    try { (e.currentTarget as Element).releasePointerCapture?.(e.pointerId); } catch { /* 무시 */ }
    s.pointerId = null;
    const axis = s.axis;
    s.axis = null;
    if (axis !== "x") return;
    if (dragRaf.current != null) { cancelAnimationFrame(dragRaf.current); dragRaf.current = null; }
    // 드래그였다면 뒤따르는 click(내비게이션 등)은 삼킨다.
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);

    const first = s.samples[0];
    const last = s.samples[s.samples.length - 1];
    const dt = last.t - first.t;
    const velocity = dt > 0 ? (last.x - first.x) / dt : 0;

    const { leftW: lw, rightW: rw, onOpenChange: change } = cfg.current;
    paint(s.x);
    const target = resolveSwipeRelease({ x: s.x, velocity, base: s.base, leftWidth: lw, rightWidth: rw });
    if (target === 0) {
      openSide.current = null;
      settleTo(0);
      change(null);
    } else {
      openSide.current = target > 0 ? "left" : "right";
      settleTo(target);
      change(id);
    }
  }

  // 열린 상태에서 콘텐츠(아직 보이는 부분)를 탭하면 이동하지 않고 닫히기만 한다(iOS 관례).
  function handleContentClickCapture(e: React.MouseEvent) {
    if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); return; }
    if (cfg.current.isOpen) { e.preventDefault(); e.stopPropagation(); cfg.current.onOpenChange(null); }
  }

  return (
    <div ref={rowRef} className={`swipe-row ${className ?? ""}`} data-swipe-row-id={id} data-swipe-state="idle">
      {leftAction && (
        <div className="swipe-row-actions swipe-row-actions-left" style={{ ["--action-w" as string]: `${leftW}px` }}>
          <div className="swipe-action-inner">{leftAction}</div>
        </div>
      )}
      {rightAction && (
        <div className="swipe-row-actions swipe-row-actions-right" style={{ ["--action-w" as string]: `${rightW}px` }}>
          <div className="swipe-action-inner">{rightAction}</div>
        </div>
      )}
      <div
        ref={contentRef}
        className="swipe-row-content"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={handleContentClickCapture}
      >
        {children}
      </div>
    </div>
  );
}
