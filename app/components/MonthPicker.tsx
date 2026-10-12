"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computePopoverPosition, type PopoverPosition } from "../../lib/popoverPosition";
import UiIcon from "./UiIcon";
const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);
export default function MonthPicker({ value, onChange, label }: { value: string; onChange: (value: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(Number(value.slice(0, 4)) || new Date().getFullYear());
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  function reposition() {
    if (!trigger.current || !panel.current) return;
    setPos(computePopoverPosition(trigger.current.getBoundingClientRect(),
      { width: panel.current.offsetWidth, height: panel.current.scrollHeight + panel.current.offsetHeight - panel.current.clientHeight },
      { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight }));
  }
  useLayoutEffect(() => { if (open) reposition(); }, [open, year]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    panel.current?.querySelector<HTMLElement>("button.on, .app-month-grid button")?.focus();
    return () => { window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [open]);
  return <div className="app-date-picker app-month-picker" ref={root}>
    <input className="app-date-native-proxy" type="month" value={value} onChange={(event) => onChange(event.target.value)} aria-hidden="true" tabIndex={-1} />
    <button type="button" className="app-date-trigger" ref={trigger} onClick={() => { setPos(null); setYear(Number(value.slice(0, 4)) || new Date().getFullYear()); setOpen((current) => !current); }} aria-expanded={open} aria-haspopup="dialog">
      <UiIcon name="calendar" size={17} /><span>{value ? `${value.slice(0, 4)}년 ${Number(value.slice(5))}월` : "월 선택"}</span>
    </button>
    {open && createPortal(<div ref={panel} className="app-date-popover app-month-popover is-floating" role="dialog" aria-label={label ?? "월 선택"} data-overlay-portal=""
      style={pos ? { top: pos.top, left: pos.left, maxWidth: "calc(100vw - 16px)", ...(pos.maxHeight ? { maxHeight: pos.maxHeight, overflowY: "auto" } : {}) } : { visibility: "hidden" }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="app-date-head"><button type="button" onClick={() => setYear((v) => v - 1)} aria-label="이전 해">‹</button><strong>{year}년</strong><button type="button" onClick={() => setYear((v) => v + 1)} aria-label="다음 해">›</button></div>
      <div className="app-month-grid">{MONTHS.map((month) => { const next = `${year}-${String(month).padStart(2, "0")}`; return <button type="button" key={month} className={value === next ? "on" : ""} aria-pressed={value === next} onClick={() => { onChange(next); setOpen(false); trigger.current?.focus(); }}>{month}월</button>; })}</div>
    </div>, document.body)}
  </div>;
}
