"use client";

/*
  릴리스 폴리시 배치 8차(2026-09-17) — 관리자 알림 swipe actions(고정/삭제) 전용으로 만든
  범용 swipe-to-reveal row. 화면별 duplicate 구현을 피하려고 범용 컴포넌트로 분리했다(다른
  리스트에서도 필요해지면 재사용 가능).

  성능(3-4, 알림 70~100개에서도 부드러워야 함): pointermove마다 React state를 갱신하지 않는다
  — 드래그 중 위치는 ref + DOM 직접 조작(style.transform)만 쓰고, requestAnimationFrame으로
  묶어서 적용한다. 부모(리스트)로 올리는 state는 "지금 열려 있는 row id" 하나뿐이라
  swipe 자체가 리스트 전체를 리렌더시키지 않는다. transform/opacity만 사용(layout 속성
  변경 없음 → layout thrashing 최소화).

  제스처: 왼쪽으로 끌면 오른쪽 action 영역이 드러난다(iOS 네이티브 swipe action과 동일
  방향). 수직 스크롤과 충돌하지 않도록 첫 8px 이동까지는 수평/수직 의도를 판정만 하고
  실제 이동을 적용하지 않는다(threshold) — 수직으로 판단되면 그 제스처 동안은 그대로
  터치 스크롤에 맡긴다(CSS touch-action: pan-y, .swipe-row-content 참고).

  안정화 배치(2026-09-22, 태블릿/웹 QA) — 다음 세 가지를 추가:
  1) Pointer Events로 교체(Touch Events 전용이었음) — touch/pen/mouse 전부 같은 코드로
     동작. mouse는 눌렀다 뗄 때까지 요소 밖으로 나가도 계속 추적해야 하므로
     setPointerCapture를 쓴다(터치도 동일하게 캡처 — 리스트 스크롤 도중 손가락이 row
     경계를 살짝 벗어나도 제스처가 끊기지 않게).
  2) velocity 기반 flick — 기존엔 놓는 순간의 위치 비율(OPEN_RATIO)만 봐서, 짧게 끌고
     빠르게 놓는 "flick" 제스처가 거리 부족으로 무시될 수 있었다. 마지막 구간의
     속도(px/ms)를 같이 계산해 임계값을 넘으면 거리와 무관하게 방향대로 스냅한다.
  3) prefers-reduced-motion — 켜져 있으면 스냅 애니메이션을 즉시 전환(transition 없음)으로
     바꾼다.

  민감도 배치(2026-09-24) — 사용자 피드백: "지금은 정직하게 일정 범위 이상 끌어야
  버튼이 나오고 사라지는데, 조금만 밀어도 자연스러운 애니메이션과 함께 나오고
  사라지면 좋겠다." 기존 OPEN_RATIO(42%, actionWidth 144px 기준 약 60px)는 매번
  절반 가까이 끌어야 열렸고, 게다가 "닫는" 쪽은 항상 절대 위치(s.x) 기준으로만
  판정해서 이미 열린 상태에서 되돌리려면 반대로 훨씬 더 크게(약 84px) 끌어야 하는
  비대칭 문제도 있었다(열기 42% vs 닫기 실질 58%). 절대 비율 대신, 제스처 "시작
  상태 기준 상대 이동량"이 SMALL_TOGGLE_PX(약 16px, MOVE_THRESHOLD 8px보다 살짝
  큰 정도)만 넘으면 방향대로 스냅하도록 바꿔 열기/닫기 둘 다 동일하게 "조금만
  밀어도" 반응한다. 이 컴포넌트는 관리자/회원 알림 양쪽에서 공용으로 쓰이고
  모바일/태블릿 전부 같은 코드 경로라 여기 값만 바꾸면 앱 전체에 적용된다. 빠른
  flick(velocity)과 prefers-reduced-motion 처리는 기존 그대로 유지.
*/
import { useEffect, useRef, type ReactNode } from "react";

const MOVE_THRESHOLD = 8; // px — 이보다 작은 움직임에는 반응하지 않음(의도치 않은 오픈 방지, 방향 판정용)
const OVERSWIPE_CUSHION = 22; // px — actionWidth를 넘어서도 살짝 더 끌리는 여유(고무줄 느낌), 그 이상은 clamp
const SMALL_TOGGLE_PX = 16; // px — 시작 상태 기준 이만큼만 밀어도 방향대로 스냅(열기/닫기 동일하게 적용)
const FLICK_VELOCITY = 0.5; // px/ms — 이 이상으로 빠르게 놓으면 거리와 무관하게 방향대로 스냅
const FLICK_SAMPLE_WINDOW = 80; // ms — 이보다 오래된 샘플은 velocity 계산에서 버림(멈췄다 다시 움직인 경우 대비)

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

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
  const dragState = useRef<{
    pointerId: number | null;
    startX: number; startY: number; axis: "x" | "y" | null; dragging: boolean; x: number;
    samples: { t: number; x: number }[]; // velocity 계산용 최근 이동 샘플
  }>({
    pointerId: null, startX: 0, startY: 0, axis: null, dragging: false, x: 0, samples: [],
  });
  const isOpen = openId === id;
  const rafId = useRef<number | null>(null);

  function applyTransform(x: number, animate: boolean) {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animate && !prefersReducedMotion() ? "transform 220ms cubic-bezier(.22,.85,.32,1)" : "none";
    el.style.transform = `translateX(${x}px)`;
  }

  // 외부에서 openId가 바뀌면(다른 row를 열었거나, outside tap으로 전부 닫힘) 애니메이션과
  // 함께 동기화 — 이때만 정상적인 리렌더 경로(React state)를 타므로 비용이 거의 없다.
  useEffect(() => {
    const target = isOpen ? -actionWidth : 0;
    dragState.current.x = target;
    applyTransform(target, true);
  }, [isOpen, actionWidth]);

  function onPointerDown(e: React.PointerEvent) {
    const s = dragState.current;
    if (s.pointerId != null) return; // 이미 다른 포인터(멀티터치 등)를 추적 중이면 무시
    s.pointerId = e.pointerId;
    s.startX = e.clientX;
    s.startY = e.clientY;
    s.axis = null;
    s.dragging = true;
    s.samples = [{ t: performance.now(), x: e.clientX }];
    // x는 유지(이미 열려 있으면 열린 상태에서 이어서 드래그).
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = dragState.current;
    if (!s.dragging || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.axis) {
      if (Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return;
      s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (s.axis === "x") {
        // 방향이 수평으로 확정된 시점부터만 이후 제스처 동안 이 포인터를 계속 추적한다
        // (요소 밖으로 나가도 pointermove가 끊기지 않음 — mouse drag에 특히 중요).
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }
    }
    if (s.axis === "y") return; // 수직 스크롤에 맡김
    e.preventDefault();
    const base = isOpen ? -actionWidth : 0;
    const next = Math.max(-actionWidth - OVERSWIPE_CUSHION, Math.min(OVERSWIPE_CUSHION, base + dx));
    s.x = next;
    const now = performance.now();
    s.samples.push({ t: now, x: e.clientX });
    // 오래된 샘플은 버려서 "멈췄다가 다시 움직인" 경우 이전 구간이 velocity에 섞이지 않게 한다.
    while (s.samples.length > 1 && now - s.samples[0].t > FLICK_SAMPLE_WINDOW) s.samples.shift();
    if (rafId.current != null) cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(() => applyTransform(next, false));
  }

  function endDrag(e: React.PointerEvent) {
    const s = dragState.current;
    if (s.pointerId !== e.pointerId) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    s.pointerId = null;
    if (!s.dragging) return;
    s.dragging = false;
    if (s.axis !== "x") { s.axis = null; return; }
    s.axis = null;

    // velocity: 마지막 샘플 구간(최근 FLICK_SAMPLE_WINDOW ms) 기준 px/ms.
    const first = s.samples[0];
    const last = s.samples[s.samples.length - 1];
    const dt = last.t - first.t;
    const velocity = dt > 0 ? (last.x - first.x) / dt : 0;

    // 이 제스처가 "시작한 상태"(열림/닫힘) 기준 상대 이동량 — 절대 위치(s.x)가 아니라
    // base(제스처 시작 시점의 위치)로부터 얼마나 움직였는지로 판정해야 열기/닫기가
    // 대칭이 된다(주석 상단 "민감도 배치" 참고).
    const base = isOpen ? -actionWidth : 0;
    const dxFromBase = s.x - base;

    let shouldOpen: boolean;
    if (Math.abs(velocity) > FLICK_VELOCITY) {
      // 빠른 flick — 이동량과 무관하게 방향대로 스냅.
      shouldOpen = velocity < 0;
    } else if (!isOpen && dxFromBase < -SMALL_TOGGLE_PX) {
      shouldOpen = true; // 닫힌 상태 → 조금만 왼쪽으로 밀어도 열림
    } else if (isOpen && dxFromBase > SMALL_TOGGLE_PX) {
      shouldOpen = false; // 열린 상태 → 조금만 오른쪽으로 밀어도 닫힘
    } else {
      shouldOpen = isOpen; // 임계값 못 넘으면 원래 상태로 스냅백
    }
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
