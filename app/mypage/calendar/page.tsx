"use client";

/*
  마이페이지 - 예약 캘린더 (풀스크린)
  - 월 달력에 예약한 날 점 표시 (프로필별 색)
  - 날짜 누르면 아래에 그날 수업 정보 + 개인 메모
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import {
  fetchMyReservationsForCalendar, updateReservationMemo, downloadIcs,
  type CalReservation,
} from "../../../lib/mypage";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "확정", waitlisted: "대기", attended: "출석", no_show: "노쇼",
};
const PALETTE = ["#C0392B", "#2c7a7b", "#8e44ad", "#e67e22", "#2980b9"];

export default function CalendarPage() {
  const [resv, setResv] = useState<CalReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cal, setCal] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; });
  const [selected, setSelected] = useState<string | null>(null);
  const [memoEdits, setMemoEdits] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setResv(await fetchMyReservationsForCalendar()); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const pad = (n: number) => String(n).padStart(2, "0");
  // 점은 센터 기준으로 색을 구분한다(요청: 같은 날 예약이 여러 건이어도 같은 센터면 점 하나만,
  // 다른 센터면 센터별로 다른 색 점을 각각 표시).
  const centerNames = Array.from(new Set(resv.map((r) => r.centerName)));
  const colorOf = (name: string) => PALETTE[Math.max(0, centerNames.indexOf(name)) % PALETTE.length];

  // 날짜별 예약
  const byDate: Record<string, CalReservation[]> = {};
  for (const r of resv) (byDate[r.date] ??= []).push(r);

  const first = new Date(cal.y, cal.m - 1, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(cal.y, cal.m, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const prevMonth = () => { setSelected(null); setCal((c) => c.m === 1 ? { y: c.y - 1, m: 12 } : { y: c.y, m: c.m - 1 }); };
  const nextMonth = () => { setSelected(null); setCal((c) => c.m === 12 ? { y: c.y + 1, m: 1 } : { y: c.y, m: c.m + 1 }); };

  const selectedItems = selected ? (byDate[selected] ?? []) : [];

  async function saveMemo(r: CalReservation) {
    const val = memoEdits[r.id] ?? r.memo ?? "";
    setSavingId(r.id);
    try {
      await updateReservationMemo(r.id, val);
      setResv((prev) => prev.map((x) => x.id === r.id ? { ...x, memo: val } : x));
    } catch (e: any) { setError(e.message); }
    finally { setSavingId(null); }
  }

  return (
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      <div className="back-header">
        <a className="side" href="/my-reservations">‹</a>
        <div className="title">예약 캘린더</div>
        <button className="cal-export-btn" onClick={() => {
          const upcoming = resv.filter((r) => r.status === "confirmed" || r.status === "waitlisted");
          if (upcoming.length === 0) { setError("내보낼 예약이 없어요"); return; }
          downloadIcs(upcoming, "우리동네클래스_예약.ics");
        }}>내 캘린더에 추가</button>
      </div>

      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="mypage-cal" style={{ margin: "12px 20px" }}>
            <div className="mypage-cal-head">
              <button onClick={prevMonth} aria-label="이전 달">‹</button>
              <span>{cal.y}.{pad(cal.m)}</span>
              <button onClick={nextMonth} aria-label="다음 달">›</button>
            </div>
            <div className="mypage-cal-grid">
              {["일","월","화","수","목","금","토"].map((d) => <div key={d} className="mypage-cal-dow">{d}</div>)}
              {cells.map((day, i) => {
                if (day === null) return <div key={i} className="mypage-cal-cell empty" />;
                const key = `${cal.y}-${pad(cal.m)}-${pad(day)}`;
                const items = byDate[key] ?? [];
                const dayCenters = Array.from(new Set(items.map((it) => it.centerName)));
                const isSel = selected === key;
                return (
                  <button key={i} className={`mypage-cal-cell tappable ${isSel ? "sel" : ""}`} onClick={() => setSelected(isSel ? null : key)}>
                    <span className="mypage-cal-day">{day}</span>
                    <div className="mypage-cal-dots">
                      {dayCenters.slice(0, 4).map((name) => (
                        <span key={name} className="mypage-cal-dot" style={{ background: colorOf(name) }} />
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
            {centerNames.length > 1 && (
              <div className="mypage-cal-legend">
                {centerNames.map((name) => (
                  <span key={name} className="mypage-cal-legend-item">
                    <span className="mypage-cal-dot" style={{ background: colorOf(name) }} />
                    {name}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 선택한 날 수업 정보 + 메모 */}
          {selected && (
            <div className="cal-detail">
              <div className="cal-detail-date">{selected.replace(/-/g, ".")}</div>
              {selectedItems.length === 0 ? (
                <div className="daylist-empty" style={{ padding: 16 }}>이 날은 예약이 없어요</div>
              ) : (
                selectedItems.map((r) => (
                  <div key={r.id} className="cal-detail-card">
                    <div className="cal-detail-top">
                      <div>
                        <div className="cal-detail-title">{r.time} · {r.title}</div>
                        <div className="cal-detail-sub">
                          {r.centerName}
                          {r.profileName && <span className="profile-tag sm" style={{ marginLeft: 6 }}>{r.profileName}</span>}
                        </div>
                      </div>
                      <span className={`hist-status s-${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                    </div>
                    <div className="cal-memo-row">
                      <input
                        className="input-field"
                        placeholder="메모 추가 (예: 준비물, 컨디션)"
                        value={memoEdits[r.id] ?? r.memo ?? ""}
                        onChange={(e) => setMemoEdits({ ...memoEdits, [r.id]: e.target.value })}
                      />
                      <button className="primary-btn small" disabled={savingId === r.id} onClick={() => saveMemo(r)}>
                        {savingId === r.id ? "저장" : "저장"}
                      </button>
                    </div>
                    <button className="cal-add-one" onClick={() => downloadIcs([r], `${r.title}.ics`)}>
                      캘린더에 추가
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
          <div style={{ height: 40 }} />
        </>
      )}
    </div>
  );
}
