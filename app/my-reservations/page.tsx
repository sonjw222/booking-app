"use client";

/*
  내 예약 (하단 네비 탭)
  - 마이페이지에 있던 예약내역을 이 화면으로 이동
  - 예약 목록 + 캘린더 바로가기
*/

import { useCallback, useEffect, useState } from "react";
import { fetchMyPage, type HistoryItem } from "../../lib/mypage";
import Loading from "../components/Loading";
import BottomNav from "../components/BottomNav";
import { memberFacingBadge, type ReservationType } from "../../lib/reservationTypes";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "예약확정",
  waitlisted: "대기중",
  cancelled: "취소됨",
  completed: "완료",
  no_show: "노쇼",
  attended: "출석",
};

export default function MyReservationsPage() {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">("upcoming");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await fetchMyPage();
      setHistory(data.history);
    } catch (e: any) { setError(e.message ?? "불러오지 못했어요"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = history.filter((h) => {
    if (filter === "upcoming") return h.status === "confirmed" || h.status === "waitlisted";
    if (filter === "past") return h.status === "attended" || h.status === "no_show" || h.status === "cancelled";
    return true;
  });

  return (
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      <div className="back-header">
        <div className="side" />
        <div className="title">내 예약</div>
        <a className="side cal-export-btn" href="/mypage/calendar" style={{ fontSize: 12 }}>캘린더</a>
      </div>

      <div className="mem-filters">
        <button className={`filter-chip ${filter === "upcoming" ? "on" : ""}`} onClick={() => setFilter("upcoming")}>예정</button>
        <button className={`filter-chip ${filter === "past" ? "on" : ""}`} onClick={() => setFilter("past")}>지난 예약</button>
        <button className={`filter-chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>전체</button>
      </div>

      {loading ? <Loading /> : shown.length === 0 ? (
        <div className="daylist-empty" style={{ padding: "40px 20px" }}>
          {filter === "upcoming" ? "예정된 예약이 없어요" : "예약 내역이 없어요"}
        </div>
      ) : (
        <div style={{ padding: "0 4px" }}>
          {shown.map((h) => (
            <div key={h.id} className="hist-item">
              <div className="hist-main">
                <div className="hist-title">
                  {h.profileName && <span className="profile-tag sm">{h.profileName}</span>}
                  {h.title}
                  {memberFacingBadge(h.reservationType as ReservationType) && (
                    <span className="profile-tag sm">{memberFacingBadge(h.reservationType as ReservationType)}</span>
                  )}
                  {h.status === "cancelled" && h.cancelSource === "HOLIDAY" && (
                    <span className="profile-tag sm holiday-cancel-tag">센터 휴무로 자동 취소</span>
                  )}
                </div>
                <div className="hist-sub">{h.centerName} · {h.when}</div>
              </div>
              <span className={`hist-status s-${h.status}`}>{STATUS_LABEL[h.status] ?? h.status}</span>
            </div>
          ))}
        </div>
      )}

      <BottomNav />
    </div>
  );
}
