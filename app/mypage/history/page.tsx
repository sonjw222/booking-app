"use client";

/*
  회원 - 전체 예약 내역 (날짜별)
  - 수강권 구매 이후 예약한 모든 수업을 날짜별로 그룹핑
  - 상태 필터 (전체 / 예약확정 / 출석 / 취소 / 노쇼)
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import { fetchFullHistory, type FullHistoryItem } from "../../../lib/mypage";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "예약확정",
  waitlisted: "대기중",
  cancelled: "취소됨",
  attended: "출석완료",
  no_show: "노쇼",
};

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "attended", label: "출석" },
  { key: "confirmed", label: "예약확정" },
  { key: "cancelled", label: "취소" },
  { key: "no_show", label: "노쇼" },
];

function fmtDateHeader(d: string) {
  const dt = new Date(d + "T00:00:00+09:00");
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short",
  }).format(dt);
}

export default function HistoryPage() {
  const [items, setItems] = useState<FullHistoryItem[]>([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setItems(await fetchFullHistory()); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = filter === "all" ? items : items.filter((i) => i.status === filter);

  // 날짜별 그룹
  const byDate: Record<string, FullHistoryItem[]> = {};
  for (const i of filtered) (byDate[i.lessonDate] ??= []).push(i);
  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  // 월별 요약 (출석 횟수)
  const attendedCount = items.filter((i) => i.status === "attended").length;

  return (
    <div className="app-shell">
      <div className="back-header">
        <a className="side" href="/mypage">‹</a>
        <div className="title">전체 예약 내역</div>
        <div className="side" />
      </div>

      {/* 상태 필터 */}
      <div className="mem-filters">
        {FILTERS.map((f) => (
          <button key={f.key} className={`filter-chip ${filter === f.key ? "on" : ""}`} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {items.length > 0 && (
        <div className="hist-summary">
          총 {items.length}건 · 출석 {attendedCount}회
        </div>
      )}

      {error && <div className="auth-msg error" style={{ margin: "8px 20px" }}>{error}</div>}

      {loading ? (
        <Loading />
      ) : dates.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 40 }}>예약 내역이 없어요</div>
      ) : (
        <div className="fullhist">
          {dates.map((date) => (
            <div key={date} className="fullhist-day">
              <div className="fullhist-date">{fmtDateHeader(date)}</div>
              {byDate[date].map((i) => (
                <div key={i.id} className="fullhist-item">
                  <div className="fullhist-time">{i.timeText}</div>
                  <div className="fullhist-main">
                    <div className="fullhist-title">
                      {i.profileName && <span className="profile-tag sm">{i.profileName}</span>}
                      {i.title}
                    </div>
                    <div className="fullhist-center">{i.centerName}</div>
                  </div>
                  <span className={`hist-status s-${i.status}`}>{STATUS_LABEL[i.status]}</span>
                </div>
              ))}
            </div>
          ))}
          <div style={{ height: 40 }} />
        </div>
      )}
    </div>
  );
}
