"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import UiIcon from "./UiIcon";
import { computePopoverPosition, type PopoverPosition } from "../../lib/popoverPosition";

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return year && month && day ? new Date(year, month - 1, day) : new Date();
}

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export default function DatePicker({ value, onChange, label }: { value: string; onChange: (value: string) => void; label?: string }) {
  const initial = parseDate(value);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  const [host, setHost] = useState<Element | null>(null);
  const [year, setYear] = useState(initial.getFullYear());
  const [month, setMonth] = useState(initial.getMonth());
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const selected = parseDate(value);
  const cells = useMemo(() => {
    const leading = new Date(year, month, 1).getDay();
    const count = new Date(year, month + 1, 0).getDate();
    return [...Array(leading).fill(null), ...Array.from({ length: count }, (_, index) => index + 1)];
  }, [year, month]);

  // 팝오버는 부모(.sheet 등 overflow 컨테이너)에 잘리지 않도록 포털로 렌더링한다. 시트 안이면 같은 SheetOverlay의
  // 자식으로 넣어 포커스 트랩/ESC/닫기 동작과 React 이벤트 전파(.sheet의 stopPropagation)를 그대로 유지하고,
  // 시트 밖이면 body에 붙인다. 위치는 트리거 기준 fixed 좌표로 계산한다.
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !popover.current?.contains(target)) setOpen(false);
    };
    // 캘린더가 열려 있을 땐 ESC가 캘린더만 닫고, 상위 시트는 닫지 않는다(capture에서 먼저 처리).
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape, true); };
  }, [open]);

  function reposition() {
    const anchor = trigger.current, panel = popover.current;
    if (!anchor || !panel) return;
    const rect = anchor.getBoundingClientRect();
    const vv = window.visualViewport;
    setPos(computePopoverPosition(rect, { width: panel.offsetWidth, height: panel.scrollHeight + (panel.offsetHeight - panel.clientHeight) },
      { width: window.innerWidth, height: vv ? Math.min(vv.height, window.innerHeight) : window.innerHeight }));
  }

  // 열릴 때, 월이 바뀌어 높이(5~6주)가 달라질 때 다시 계산한다(페인트 전에).
  useLayoutEffect(() => { if (open) reposition(); }, [open, year, month, host]);

  useEffect(() => {
    if (!open) return;
    const handler = () => reposition();
    window.addEventListener("resize", handler);
    window.addEventListener("scroll", handler, true);
    window.visualViewport?.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("scroll", handler, true);
      window.visualViewport?.removeEventListener("resize", handler);
    };
  }, [open]);

  // 키보드 접근성: 위치가 잡혀 보이게 된 다음 프레임에, 선택일(없으면 오늘, 없으면 첫 날짜)로 포커스를 옮긴다.
  useEffect(() => {
    if (!open || !pos) return;
    // 클릭 직후에는 브라우저가 포커스 이동을 무시하는 경우가 있어(특히 reduced-motion), 적용될 때까지 짧게 재시도한다.
    let timer = 0, tries = 0;
    const focusTarget = () => {
      const panel = popover.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const grid = panel.querySelector(".app-date-grid");
      const target = grid?.querySelector<HTMLElement>("button.on") ?? grid?.querySelector<HTMLElement>("button.today") ?? grid?.querySelector<HTMLElement>("button");
      target?.focus({ preventScroll: true });
      if (!panel.contains(document.activeElement) && ++tries < 5) timer = window.setTimeout(focusTarget, 50);
    };
    const raf = requestAnimationFrame(focusTarget);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(timer); };
  }, [open, !!pos]);

  function move(delta: number) {
    const next = new Date(year, month + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth());
  }

  function toggle() {
    if (!open) {
      setPos(null);
      setHost(root.current?.closest("[data-sheet-overlay]") ?? document.body);
    }
    setOpen((current) => !current);
  }

  return <div className="app-date-picker" ref={root}>
    {/* 기존 자동화와 브라우저 날짜 입력 계약은 유지하고, 화면에는 앱 전용 달력을 표시한다. */}
    <input
      className="app-date-native-proxy"
      type="date"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-hidden="true"
      tabIndex={-1}
    />
    <button type="button" className="app-date-trigger" ref={trigger} onClick={toggle} aria-expanded={open} aria-haspopup="dialog">
      <UiIcon name="calendar" size={17} />
      <span>{value ? `${value.replaceAll("-", ". ")}.` : "날짜 선택"}</span>
    </button>
    {open && host && createPortal(<div ref={popover} className="app-date-popover is-floating" role="dialog" aria-label={label ?? "날짜 선택"} data-placement={pos?.placement}
      style={pos ? { top: pos.top, left: pos.left, ...(pos.maxHeight ? { maxHeight: pos.maxHeight, overflowY: "auto" as const } : {}) } : { top: 0, left: 0, visibility: "hidden" }}>
      <div className="app-date-head">
        <button type="button" onClick={() => move(-1)} aria-label="이전 달">‹</button>
        <strong>{year}년 {month + 1}월</strong>
        <button type="button" onClick={() => move(1)} aria-label="다음 달">›</button>
      </div>
      <div className="app-date-week">{["일", "월", "화", "수", "목", "금", "토"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="app-date-grid">{cells.map((day, index) => {
        if (day == null) return <i key={index} />;
        const today = new Date();
        const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
        const isSelected = !!value && selected.getFullYear() === year && selected.getMonth() === month && selected.getDate() === day;
        return <button type="button" key={index} className={`${isSelected ? "on" : ""} ${isToday ? "today" : ""}`.trim()}
          aria-pressed={isSelected} onClick={() => { onChange(dateKey(year, month, day)); setOpen(false); }}>{day}</button>;
      })}</div>
    </div>, host)}
  </div>;
}
