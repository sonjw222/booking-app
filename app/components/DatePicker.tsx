"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import UiIcon from "./UiIcon";

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
  const [openUp, setOpenUp] = useState(false);
  const [year, setYear] = useState(initial.getFullYear());
  const [month, setMonth] = useState(initial.getMonth());
  const root = useRef<HTMLDivElement>(null);
  const selected = parseDate(value);
  const cells = useMemo(() => {
    const leading = new Date(year, month, 1).getDay();
    const count = new Date(year, month + 1, 0).getDate();
    return [...Array(leading).fill(null), ...Array.from({ length: count }, (_, index) => index + 1)];
  }, [year, month]);

  useEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);

  function move(delta: number) {
    const next = new Date(year, month + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth());
  }

  function toggle() {
    if (!open && root.current) {
      const rect = root.current.getBoundingClientRect();
      setOpenUp(window.innerHeight - rect.bottom < 350 && rect.top > 350);
    }
    setOpen((current) => !current);
  }

  return <div className="app-date-picker" ref={root}>
    <button type="button" className="app-date-trigger" onClick={toggle} aria-expanded={open} aria-haspopup="dialog">
      <UiIcon name="calendar" size={17} />
      <span>{value ? `${value.replaceAll("-", ". ")}.` : "날짜 선택"}</span>
    </button>
    {open && <div className={`app-date-popover ${openUp ? "open-up" : ""}`} role="dialog" aria-label={label ?? "날짜 선택"}>
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
    </div>}
  </div>;
}
