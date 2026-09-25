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
import { usePathname } from "next/navigation";

/*
  실기기 QA 개선(2026-09-25) — 이전 구현은 (1) 여는 swipe가 "화면 왼쪽 24px 가장자리"에서 시작한
  제스처만 인정해 rail 위 어디서든 밀어도 안 열렸고, (2) 회원용 .member-desktop-nav에는 아예
  적용되지 않았고, (3) 로고(brand) 링크를 눌러도 펼쳐지지 않았다. 지금은:
    - rail(nav 요소) 안에서 시작한 터치/펜 제스처만 처리 — 오른쪽으로 밀면 펼침, 펼친 상태에서
      왼쪽으로 밀면 접힘. 페이지 콘텐츠(캐러셀/SwipeRow/가로 스크롤)와는 이벤트가 겹치지 않는다.
    - 방향 잠금: 7px 이상 움직였을 때 |dx| > |dy|×1.5 면 가로, 아니면 세로(=rail 스크롤에 맡기고
      제스처 취소). 가로로 확정된 뒤 dx가 TRIGGER_PX(24)를 넘는 즉시(손을 떼기 전에) 반응한다.
    - 로고 링크는 compact 상태에서 터치하면 이동 대신 펼침(펼친 뒤엔 정상 이동), 메뉴 항목(a/button)은
      언제나 즉시 라우팅. swipe 직후 발생할 수 있는 click은 삼킨다.
    - 경로가 바뀌면 compact로 복귀(태블릿/중간 폭 정책).
*/
export const NAV_RAIL_MEDIA = "(min-width: 768px) and (max-width: 1359px)";
export const SWIPE_INTENT_PX = 7;   // 방향 판정 전 최소 이동량 — 1~6px 떨림은 무시
export const AXIS_RATIO = 1.5;      // |dx| > |dy|×1.5 일 때만 가로
export const TRIGGER_PX = 24;       // 가로 확정 후 이만큼 밀면 즉시 펼침/접힘
export const FLICK_VELOCITY = 0.45; // px/ms — 빠른 flick은 TRIGGER_PX 미만이어도 인정
const FLICK_MIN_PX = 10;
const SAMPLE_WINDOW = 90;           // ms

/** rail 제스처 판정(순수 함수 — 단위 테스트 대상). null이면 아직/영영 아무 것도 하지 않음. */
export function resolveRailSwipe(dx: number, dy: number, velocity: number, expanded: boolean): "expand" | "collapse" | null {
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx < SWIPE_INTENT_PX || adx <= ady * AXIS_RATIO) return null; // 세로/불명확 → 취소
  if (!expanded) {
    if (dx >= TRIGGER_PX) return "expand";
    if (dx >= FLICK_MIN_PX && velocity >= FLICK_VELOCITY) return "expand";
  } else {
    if (dx <= -TRIGGER_PX) return "collapse";
    if (dx <= -FLICK_MIN_PX && velocity <= -FLICK_VELOCITY) return "collapse";
  }
  return null;
}

function velocityOf(samples: { t: number; x: number }[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0], last = samples[samples.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

export function useExpandableNavRail(scrollStorageKey: string) {
  const navRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [inRailRange, setInRailRange] = useState(false);
  const pathname = usePathname();
  const lastPointerType = useRef<string>("mouse");
  const swiped = useRef(false); // 방금 swipe로 처리한 제스처 — 뒤따르는 click을 삼킨다
  const expandedRef = useRef(false);
  expandedRef.current = expanded;

  // 768–1359px(rail 확장 대상 구간) 여부를 매체 쿼리로 정확히 추적 — 리사이즈/회전에도 반응.
  // 1360px 이상은 이미 상시 244px sidebar라 손대지 않는다(원래 정책).
  useEffect(() => {
    const mq = window.matchMedia(NAV_RAIL_MEDIA);
    const update = () => setInRailRange(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // 범위를 벗어나면(예: 회전/리사이즈로 데스크톱 폭) 강제로 접힌 상태.
  useEffect(() => { if (!inRailRange) setExpanded(false); }, [inRailRange]);

  // 경로가 바뀌면 compact로 복귀 — 클라이언트 전환/풀 리로드 어느 쪽이든 같은 결과.
  useEffect(() => { setExpanded(false); }, [pathname]);

  // 1) rail 위에서 시작한 가로 swipe — 펼침(→)/접힘(←). 마우스는 hover/click이 이미 처리.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !inRailRange) return;
    const g = { active: false, decided: false, startX: 0, startY: 0, samples: [] as { t: number; x: number }[] };
    function onPointerDown(e: PointerEvent) {
      lastPointerType.current = e.pointerType;
      if (e.pointerType === "mouse") return;
      g.active = true; g.decided = false; g.startX = e.clientX; g.startY = e.clientY;
      g.samples = [{ t: performance.now(), x: e.clientX }];
    }
    function onPointerMove(e: PointerEvent) {
      if (!g.active || g.decided) return;
      const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
      const now = performance.now();
      g.samples.push({ t: now, x: e.clientX });
      while (g.samples.length > 1 && now - g.samples[0].t > SAMPLE_WINDOW) g.samples.shift();
      if (Math.abs(dy) >= SWIPE_INTENT_PX && Math.abs(dy) >= Math.abs(dx) * 0.7) { g.active = false; return; } // 세로 의도 → 취소
      const decision = resolveRailSwipe(dx, dy, velocityOf(g.samples), expandedRef.current);
      if (decision) {
        g.decided = true;
        swiped.current = true;
        window.setTimeout(() => { swiped.current = false; }, 350);
        setExpanded(decision === "expand");
      }
    }
    function end() { g.active = false; }
    // swipe 직후의 click(메뉴 항목 우발 이동 등)은 캡처 단계에서 삼킨다.
    // 로고(.desktop-brand) 링크는 compact 상태에서 터치하면 이동 대신 펼침 — Next <Link>는 자신의
    // onClick에서 바로 라우팅하므로 버블 단계(React onClick)로는 늦다 → 여기(캡처 단계)서 처리한다.
    function onClickCapture(e: MouseEvent) {
      if (swiped.current) { e.preventDefault(); e.stopPropagation(); return; }
      const target = e.target as HTMLElement | null;
      if (!expandedRef.current && lastPointerType.current !== "mouse" && target?.closest(".desktop-brand")) {
        e.preventDefault(); e.stopPropagation();
        setExpanded(true);
      }
    }
    nav.addEventListener("pointerdown", onPointerDown);
    nav.addEventListener("pointermove", onPointerMove);
    nav.addEventListener("pointerup", end);
    nav.addEventListener("pointercancel", end);
    nav.addEventListener("click", onClickCapture, true);
    return () => {
      nav.removeEventListener("pointerdown", onPointerDown);
      nav.removeEventListener("pointermove", onPointerMove);
      nav.removeEventListener("pointerup", end);
      nav.removeEventListener("pointercancel", end);
      nav.removeEventListener("click", onClickCapture, true);
    };
  }, [inRailRange]);

  // 2) 펼친 상태 — rail 바깥 탭/클릭, ESC로 닫기.
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

  // rail 탭으로 펼치기 — compact 상태에서:
  //  · 빈 영역(로고/구분선/여백 등 링크·버튼이 아닌 곳)을 누르면 펼침
  //  · 로고(.desktop-brand) 링크의 터치 탭은 위 캡처 리스너가 처리(이동 대신 펼침, 펼친 뒤엔 정상 이동)
  //  · 메뉴 항목(a/button)은 여기서 가로채지 않고 항상 즉시 라우팅(이중 내비게이션/탭 딜레이 금지)
  function handleRailClick(e: React.MouseEvent) {
    if (!inRailRange || expanded) return;
    const target = e.target as HTMLElement;
    if (target.closest("a,button")) return;
    setExpanded(true);
  }

  // 메뉴 선택 후 768–1359에서는 compact rail로 복귀(경로 변경 effect가 이미 처리하지만, 같은
  // 경로를 다시 눌렀을 때도 접히도록 유지).
  function collapseAfterNavigate() {
    if (inRailRange) setExpanded(false);
  }

  // 3) scroll position 유지 — route 이동/compact↔expanded 전환에도 세션 동안 유지.
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
