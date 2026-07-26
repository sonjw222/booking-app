"use client";

/*
  스케줄 복사 미리보기 - 달력 보기
  - 대상 달의 달력에 복사될 수업을 표시
  - 날짜를 누르면 아래에 그날 수업 목록 (이름 / 시간 / 정원)
*/

import { useState } from "react";

type PlanItem = { date: string; title: string; start: string; end: string; capacity: number };
type Props = { month: string; plan: PlanItem[] };

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

export default function CopyCalendar({ month, plan }: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  if (!month) return null;
  const [y, m] = month.split("-").map(Number);

  // 날짜별 개수
  const byDate: Record<string, PlanItem[]> = {};
  for (const p of plan) (byDate[p.date] ??= []).push(p);

  const first = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
  const startDow = first.getUTCDay();
  const lastDay = new Date(Date.UTC(y, m, 0, 12, 0, 0)).getUTCDate();

  const cells: (string | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= lastDay; d++) {
    cells.push(`${month}-${String(d).padStart(2, "0")}`);
  }

  const dayItems = selected ? (byDate[selected] ?? []) : [];

  return (
    <div className="copy-cal">
      <div className="copy-cal-title">{y}년 {m}월</div>
      <div className="copy-cal-week">
        {WEEK.map((w) => <div key={w} className="copy-cal-wd">{w}</div>)}
      </div>
      <div className="copy-cal-grid">
        {cells.map((date, i) => {
          if (!date) return <div key={i} className="copy-cal-cell empty" />;
          const items = byDate[date] ?? [];
          const day = parseInt(date.slice(8), 10);
          return (
            <button
              key={i}
              className={`copy-cal-cell ${items.length > 0 ? "has" : ""} ${selected === date ? "on" : ""}`}
              onClick={() => setSelected(selected === date ? null : date)}
            >
              <span className="copy-cal-day">{day}</span>
              {items.length > 0 && <span className="copy-cal-dot">{items.length}</span>}
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="copy-cal-detail">
          <div className="copy-cal-detail-date">{selected.replace(/-/g, ".")}</div>
          {dayItems.length === 0 ? (
            <div className="daylist-empty" style={{ padding: 12 }}>이 날은 수업이 없어요</div>
          ) : (
            dayItems
              .sort((a, b) => a.start.localeCompare(b.start))
              .map((it, i) => (
                <div key={i} className="copy-cal-item">
                  <span className="copy-cal-item-time">{it.start}~{it.end}</span>
                  <span className="copy-cal-item-title">{it.title}</span>
                  <span className="copy-cal-item-cap">정원 {it.capacity}명</span>
                </div>
              ))
          )}
        </div>
      )}
    </div>
  );
}
