"use client";

/*
  안정화 배치(2026-09-22) — Tablet/Web expandable navigation drawer.

  768–1359px 구간에는 이미 CSS만으로 hover/focus-within 확장이 구현돼 있다
  (app/globals.css, `@media (min-width:768px) and (max-width:1359px) and (hover:hover)
  and (pointer:fine)`) — 마우스 사용자는 이미 rail에 hover하면 244px 넓이로 펼쳐진다.
  터치 전용 기기(Android/iPad 태블릿)는 `hover:hover`를 만족하지 못해 이 경로를 탈 수
  없는 게 실제로 빠진 부분이었다 — 그래서 완전히 새 CSS 체계를 만들지 않고, 이 훅이
  대신 `.workspace-sidebar`/`.member-desktop-nav`에 `nav-expanded` 클래스를 얹어
  기존 hover 선택자와 동일한 최종 CSS 결과가 나오게만 한다(:hover,:focus-within과
  나란히 `.nav-expanded`를 추가해두면 됨 — app/globals.css 참고).

  ManagerNav/AdminNav 두 곳이 거의 동일한 제스처 로직(edge-swipe로 열기, 반대 방향
  swipe/바깥 클릭/ESC로 닫기, route 이동 후 자동 collapse, scroll position 유지)을
  필요로 해서 훅으로 뽑았다 — SwipeRow.tsx와 같은 기법(Pointer Events, 8px 방향 판정,
  velocity 기반 flick)을 재사용하되 대상이 "row 하나"가 아니라 "화면 왼쪽 edge"라
  구현은 별도로 둔다.

  1360px 이상은 이 훅을 아예 호출하지 않는 쪽으로 사용한다(이미 상시 노출되는
  244px 텍스트 sidebar 정책 — 새 overlay를 또 만들지 않음).
*/
import { useEffect, useRef, useState } from "react";

const EDGE_ZONE = 24; // px — 화면 왼쪽 이 폭 안에서 시작한 제스처만 "edge swipe"로 인정
const OPEN_DISTANCE = 60; // px — 이 이상 오른쪽으로 끌면 펼침(닫힌 상태에서 여는 edge-swipe)
const CLOSE_DISTANCE = 40; // px — 펼쳐진 상태에서 왼쪽으로 이 이상 끌면 닫힘
const FLICK_VELOCITY = 0.5; // px/ms — SwipeRow.tsx와 동일 기준(빠른 flick은 거리 무관하게 인정)
const MOVE_THRESHOLD = 8; // px — 방향(가로/세로) 판정 전 최소 이동량, 세로 스크롤과 구분
const SAMPLE_WINDOW = 80; // ms — velocity 계산에 쓰는 최근 샘플 유지 시간

type Axis = "x" | "y" | null;
interface GestureState {
  active: boolean;
  startX: number;
  startY: number;
  axis: Axis;
  samples: { t: number; x: number }[];
}

function newState(): GestureState {
  return { active: false, startX: 0, startY: 0, axis: null, samples: [] };
}

function velocityOf(s: GestureState): number {
  if (s.samples.length < 2) return 0;
  const first = s.samples[0];
  const last = s.samples[s.samples.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

export function useExpandableNavRail(scrollStorageKey: string) {
  const navRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [inRailRange, setInRailRange] = useState(false);

  // 768–1359px(터치 확장 대상 구간) 여부를 매체 쿼리로 정확히 추적한다 — 리사이즈/
  // 회전에도 반응. 1360px 이상은 이미 상시 sidebar라 여기서 손대지 않는다.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px) and (max-width: 1359px)");
    const update = () => setInRailRange(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // 리사이즈로 범위를 벗어나면(예: 태블릿을 데스크톱 폭으로) 강제로 접힌 상태로.
  useEffect(() => { if (!inRailRange) setExpanded(false); }, [inRailRange]);

  // 1) 닫힌 상태 — 왼쪽 끝에서 오른쪽으로 미는 edge-swipe로 펼치기.
  useEffect(() => {
    if (!inRailRange || expanded) return;
    const s = newState();
    function onPointerDown(e: PointerEvent) {
      if (e.pointerType === "mouse") return; // mouse는 이미 hover로 펼쳐짐 — edge-swipe 불필요
      if (e.clientX > EDGE_ZONE) return;
      s.active = true; s.startX = e.clientX; s.startY = e.clientY; s.axis = null;
      s.samples = [{ t: performance.now(), x: e.clientX }];
    }
    function onPointerMove(e: PointerEvent) {
      if (!s.active) return;
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      if (!s.axis) {
        if (Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return;
        s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      if (s.axis !== "x") return;
      const now = performance.now();
      s.samples.push({ t: now, x: e.clientX });
      while (s.samples.length > 1 && now - s.samples[0].t > SAMPLE_WINDOW) s.samples.shift();
    }
    function onPointerUp(e: PointerEvent) {
      if (!s.active) return;
      s.active = false;
      if (s.axis !== "x") return;
      const dx = e.clientX - s.startX;
      if (dx > OPEN_DISTANCE || velocityOf(s) > FLICK_VELOCITY) setExpanded(true);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
    };
  }, [inRailRange, expanded]);

  // 2) 펼친 상태 — nav 영역 안에서 왼쪽으로 미는 swipe로 닫기(반대 방향).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !inRailRange || !expanded) return;
    const s = newState();
    function onPointerDown(e: PointerEvent) {
      if (e.pointerType === "mouse") return;
      s.active = true; s.startX = e.clientX; s.startY = e.clientY; s.axis = null;
      s.samples = [{ t: performance.now(), x: e.clientX }];
    }
    function onPointerMove(e: PointerEvent) {
      if (!s.active) return;
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      if (!s.axis) {
        if (Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return;
        s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      if (s.axis !== "x") return;
      const now = performance.now();
      s.samples.push({ t: now, x: e.clientX });
      while (s.samples.length > 1 && now - s.samples[0].t > SAMPLE_WINDOW) s.samples.shift();
    }
    function onPointerUp(e: PointerEvent) {
      if (!s.active) return;
      s.active = false;
      if (s.axis !== "x") return;
      const dx = e.clientX - s.startX;
      if (dx < -CLOSE_DISTANCE || velocityOf(s) < -FLICK_VELOCITY) setExpanded(false);
    }
    nav.addEventListener("pointerdown", onPointerDown);
    nav.addEventListener("pointermove", onPointerMove);
    nav.addEventListener("pointerup", onPointerUp);
    nav.addEventListener("pointercancel", onPointerUp);
    return () => {
      nav.removeEventListener("pointerdown", onPointerDown);
      nav.removeEventListener("pointermove", onPointerMove);
      nav.removeEventListener("pointerup", onPointerUp);
      nav.removeEventListener("pointercancel", onPointerUp);
    };
  }, [inRailRange, expanded]);

  // 3) 펼친 상태 — 바깥 클릭 / ESC로 닫기.
  useEffect(() => {
    if (!expanded) return;
    function onPointerDownOutside(e: PointerEvent) {
      const nav = navRef.current;
      if (nav && !nav.contains(e.target as Node)) setExpanded(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setExpanded(false);
    }
    document.addEventListener("pointerdown", onPointerDownOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDownOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded]);

  // rail의 "빈 영역"(브랜드 로고/구분선/여백 — 실제 링크·버튼이 아닌 곳)을 클릭해도
  // 펼쳐지게 한다. 메뉴 항목 자체(a/button)는 여기서 가로채지 않고 항상 즉시
  // 라우팅되게 둔다(요구사항 10 — 이중 네비게이션/탭 딜레이 금지).
  function handleRailClick(e: React.MouseEvent) {
    if (!inRailRange || expanded) return;
    const target = e.target as HTMLElement;
    if (target.closest("a,button")) return;
    setExpanded(true);
  }

  // 메뉴 선택 후 768–1359에서는 compact rail로 자연스럽게 복귀(클라이언트 전환 항목만
  // 명시적으로 필요 — 전체 페이지 리로드인 항목은 리로드 자체로 상태가 초기화됨).
  function collapseAfterNavigate() {
    if (inRailRange) setExpanded(false);
  }

  // 4) scroll position 유지 — route 이동/compact↔expanded 전환에도 세션 동안 유지.
  // 이 nav는 클라이언트 전환 시 계속 마운트 상태로 남지만, 메뉴 대부분은 여전히
  // <a href>(전체 페이지 리로드)라 컴포넌트가 다시 마운트된다 — sessionStorage를 써서
  // 두 경우 모두 커버한다(리로드돼도 세션스토리지는 유지됨).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    try {
      const saved = sessionStorage.getItem(scrollStorageKey);
      if (saved != null) el.scrollTop = Number(saved) || 0;
    } catch { /* 무시 — 실패해도 스크롤이 0에서 시작할 뿐 기능엔 영향 없음 */ }

    let raf = 0;
    function onScroll() {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try { sessionStorage.setItem(scrollStorageKey, String(el!.scrollTop)); } catch { /* 무시 */ }
      });
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // scrollStorageKey는 호출 쪽에서 상수로 고정해 쓴다(마운트 1회만 부착).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { navRef, scrollRef, expanded, handleRailClick, collapseAfterNavigate };
}
