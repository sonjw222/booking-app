"use client";
import { useEffect, useRef, useState } from "react";
import UiIcon from "./UiIcon";
const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);
export default function MonthPicker({ value, onChange, label }: { value: string; onChange: (value: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(Number(value.slice(0, 4)) || new Date().getFullYear());
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  return <div className="app-date-picker app-month-picker" ref={root}>
    <input className="app-date-native-proxy" type="month" value={value} onChange={(event) => onChange(event.target.value)} aria-hidden="true" tabIndex={-1} />
    <button type="button" className="app-date-trigger" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-haspopup="dialog">
      <UiIcon name="calendar" size={17} /><span>{value ? `${value.slice(0, 4)}년 ${Number(value.slice(5))}월` : "월 선택"}</span>
    </button>
    {open && <div className="app-date-popover app-month-popover" role="dialog" aria-label={label ?? "월 선택"}>
      <div className="app-date-head"><button type="button" onClick={() => setYear((v) => v - 1)} aria-label="이전 해">‹</button><strong>{year}년</strong><button type="button" onClick={() => setYear((v) => v + 1)} aria-label="다음 해">›</button></div>
      <div className="app-month-grid">{MONTHS.map((month) => { const next = `${year}-${String(month).padStart(2, "0")}`; return <button type="button" key={month} className={value === next ? "on" : ""} aria-pressed={value === next} onClick={() => { onChange(next); setOpen(false); }}>{month}월</button>; })}</div>
    </div>}
  </div>;
}
