"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import UiIcon from "./UiIcon";

function parseDate(value: string) {
  const [y, m, d] = value.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : new Date();
}
function key(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export default function DatePicker({ value, onChange, label }: { value: string; onChange: (value: string) => void; label?: string }) {
  const initial = parseDate(value);
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const [year, setYear] = useState(initial.getFullYear());
  const [month, setMonth] = useState(initial.getMonth());
  const root = useRef<HTMLDivElement>(null);
  const selected = parseDate(value);
  const cells = useMemo(() => {
    const leading = new Date(year, month, 1).getDay();
    const count = new Date(year, month + 1, 0).getDate();
    return [...Array(leading).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  }, [year, month]);

  useEffect(() => {
    const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  function move(delta: number) {
    const next = new Date(year, month + delta, 1);
    setYear(next.getFullYear()); setMonth(next.getMonth());
  }

  function toggle() {
    if (!open && root.current) {
      const rect = root.current.getBoundingClientRect();
      setOpenUp(window.innerHeight - rect.bottom < 350 && rect.top > 350);
    }
    setOpen((value) => !value);
  }

  return (
    <div className="app-date-picker" ref={root}>
      <button type="button" className="app-date-trigger" onClick={toggle} aria-expanded={open}>
        <UiIcon name="calendar" size={17} />
        <span>{value ? `${value.replaceAll("-", ". ")}.` : "날짜 선택"}</span>
      </button>
      {open && (
        <div className={`app-date-popover ${openUp ? "open-up" : ""}`} role="dialog" aria-label={label ?? "날짜 선택"}>
          <div className="app-date-head">
            <button type="button" onClick={() => move(-1)} aria-label="이전 달">‹</button>
            <strong>{year}년 {month + 1}월</strong>
            <button type="button" onClick={() => move(1)} aria-label="다음 달">›</button>
          </div>
          <div className="app-date-week">{["일","월","화","수","목","금","토"].map((d) => <span key={d}>{d}</span>)}</div>
          <div className="app-date-grid">
            {cells.map((day, i) => day == null ? <i key={i} /> : (() => {
              const today = new Date();
              const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
              const isSelected = !!value && selected.getFullYear() === year && selected.getMonth() === month && selected.getDate() === day;
              return <button type="button" key={i} className={`${isSelected ? "on" : ""} ${isToday ? "today" : ""}`.trim()}
                onClick={() => { onChange(key(year, month, day)); setOpen(false); }}>{day}</button>
            })())}
          </div>
        </div>
      )}
    </div>
  );
}
