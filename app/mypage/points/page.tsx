"use client";

/*
  회원 - 포인트 내역 (P1-1)
  - point_transactions(통합 원장) 기준 적립/사용 내역, 최신순
  - 운영설정 "회원앱 포인트 내역 조회"(show_point_history)가 꺼진 센터의 내역은 제외됨
    (fetchMyPointHistory 안에서 필터링됨)
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import { fetchMyPointHistory, type PointHistoryItem } from "../../../lib/mypage";

function fmtDateHeader(d: string) {
  const dt = new Date(d + "T00:00:00+09:00");
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short",
  }).format(dt);
}

export default function PointHistoryPage() {
  const [items, setItems] = useState<PointHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setItems(await fetchMyPointHistory()); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 날짜별 그룹
  const byDate: Record<string, PointHistoryItem[]> = {};
  for (const i of items) (byDate[i.date] ??= []).push(i);
  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  return (
    <div className="app-shell">
      <div className="back-header">
        <a className="side" href="/mypage">‹</a>
        <div className="title">포인트 내역</div>
        <div className="side" />
      </div>

      {items.length > 0 && (
        <div className="hist-summary">총 {items.length}건</div>
      )}

      {error && <div className="auth-msg error" style={{ margin: "8px 20px" }}>{error}</div>}

      {loading ? (
        <Loading />
      ) : dates.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 40 }}>포인트 내역이 없어요</div>
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
                      {i.reason ?? "포인트 변동"}
                    </div>
                    <div className="fullhist-center">{i.centerName}</div>
                  </div>
                  <span
                    className="hist-status"
                    style={{
                      background: i.amount >= 0 ? "var(--success-soft)" : "var(--danger-soft)",
                      color: i.amount >= 0 ? "var(--success)" : "var(--danger)",
                    }}
                  >
                    {i.amount >= 0 ? "+" : ""}{i.amount.toLocaleString()} P
                  </span>
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
