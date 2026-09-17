"use client";

/*
  릴리스 폴리시 배치 8차(2026-09-17) — 관리자 알림 swipe actions(고정/삭제) 전용으로 만든
  범용 swipe-to-reveal row. 화면별 duplicate 구현을 피하려고 범용 컴포넌트로 분리했다(다른
  리스트에서도 필요해지면 재사용 가능).

  성능(3-4, 알림 70~100개에서도 부드러워야 함): touchmove마다 React state를 갱신하지 않는다
  — 드래그 중 위치는 ref + DOM 직접 조작(style.transform)만 쓰고, requestAnimationFrame으로
  묶어서 적용한다. 부모(리스트)로 올리는 state는 "지금 열려 있는 row id" 하나뿐이라
  swipe 자체가 리스트 전체를 리렌더시키지 않는다. transform/opacity만 사용(layout 속성
  변경 없음 → layout thrashing 최소화).

  제스처: 왼쪽으로 끌면 오른쪽 action 영역이 드러난다(iOS 네이티브 swipe action과 동일
  방향). 수직 스크롤과 충돌하지 않도록 첫 8px 이동까지는 수평/수직 의도를 판정만 하고
  실제 이동을 적용하지 않는다(threshold) — 수직으로 판단되면 그 제스처 동안은 그대로
  터치 스크롤에 맡긴다(touch-action: pan-y로 브라우저에도 힌트).
*/
import { useEffect, useRef, type ReactNode } from "react";

const MOVE_THRESHOLD = 8; // px — 이보다 작은 움직임에는 반응하지 않음(의도치 않은 오픈 방지)
const OVERSWIPE_CUSHION = 22; // px — actionWidth를 넘어서도 살짝 더 끌리는 여유(고무줄 느낌), 그 이상은 clamp
const OPEN_RATIO = 0.42; // actionWidth의 이 비율 이상 끌리면 스냅 오픈

export default function SwipeRow({
  id, openId, onOpenChange, actions, children, actionWidth = 144, className,
}: {
  id: string;
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  actions: ReactNode;
  children: ReactNode;
  actionWidth?: number;
  className?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startY: number; axis: "x" | "y" | null; dragging: boolean; x: number }>({
    startX: 0, startY: 0, axis: null, dragging: false, x: 0,
  });
  const isOpen = openId === id;
  const rafId = useRef<number | null>(null);

  function applyTransform(x: number, animate: boolean) {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animate ? "transform 220ms cubic-bezier(.22,.85,.32,1)" : "none";
    el.style.transform = `translateX(${x}px)`;
  }

  // 외부에서 openId가 바뀌면(다른 row를 열었거나, outside tap으로 전부 닫힘) 애니메이션과
  // 함께 동기화 — 이때만 정상적인 리렌더 경로(React state)를 타므로 비용이 거의 없다.
  useEffect(() => {
    const target = isOpen ? -actionWidth : 0;
    dragState.current.x = target;
    applyTransform(target, true);
  }, [isOpen, actionWidth]);

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    dragState.current = { startX: t.clientX, startY: t.clientY, axis: null, dragging: true, x: dragState.current.x };
  }

  function onTouchMove(e: React.TouchEvent) {
    const s = dragState.current;
    if (!s.dragging) return;
    const t = e.touches[0];
    const dx = t.clientX - s.startX;
    const dy = t.clientY - s.startY;
    if (!s.axis) {
      if (Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return;
      s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (s.axis === "y") return; // 수직 스크롤에 맡김
    e.preventDefault();
    const base = isOpen ? -actionWidth : 0;
    const next = Math.max(-actionWidth - OVERSWIPE_CUSHION, Math.min(OVERSWIPE_CUSHION, base + dx));
    s.x = next;
    if (rafId.current != null) cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(() => applyTransform(next, false));
  }

  function onTouchEnd() {
    const s = dragState.current;
    if (!s.dragging) return;
    s.dragging = false;
    if (s.axis !== "x") { s.axis = null; return; }
    s.axis = null;
    const shouldOpen = s.x < -actionWidth * OPEN_RATIO;
    const target = shouldOpen ? -actionWidth : 0;
    s.x = target;
    applyTransform(target, true);
    onOpenChange(shouldOpen ? id : null);
  }

  // 열린 상태에서 콘텐츠(아직 보이는 부분)를 탭하면 이동하지 않고 닫히기만 한다(iOS 관례).
  function handleContentClickCapture(e: React.MouseEvent) {
    if (isOpen) { e.preventDefault(); e.stopPropagation(); onOpenChange(null); }
  }

  return (
    <div className={`swipe-row ${className ?? ""}`} data-swipe-row-id={id}>
      <div className="swipe-row-actions" style={{ width: actionWidth }}>{actions}</div>
      <div
        ref={contentRef}
        className="swipe-row-content"
        style={{ transform: `translateX(${isOpen ? -actionWidth : 0}px)` }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onClickCapture={handleContentClickCapture}
      >
        {children}
      </div>
    </div>
  );
}
