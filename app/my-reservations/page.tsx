"use client";

/*
  내 예약 (하단 네비 탭)
  - 마이페이지에 있던 예약내역을 이 화면으로 이동
  - 예약 목록 + 캘린더 바로가기
*/

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchMyPage, type HistoryItem } from "../../lib/mypage";
import Loading from "../components/Loading";
import BottomNav from "../components/BottomNav";
import { memberFacingBadge, type ReservationType } from "../../lib/reservationTypes";
import UiIcon from "../components/UiIcon";
import SegmentedTabs from "../components/SegmentedTabs";
import EmptyState from "../components/EmptyState";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "예약 확정",
  waitlisted: "대기",
  cancelled: "취소",
  completed: "완료",
  no_show: "노쇼",
  attended: "출석",
};

function splitWhen(when: string) {
  const [date = when, time = ""] = when.split(" ");
  return { date, time };
}

function dateHeading(date: string) {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  return `${parsed.getMonth() + 1}월 ${parsed.getDate()}일 ${weekdays[parsed.getDay()]}요일`;
}

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
  const grouped = useMemo(() => {
    const map = new Map<string, HistoryItem[]>();
    for (const item of shown) {
      const { date } = splitWhen(item.when);
      const current = map.get(date) ?? [];
      current.push(item);
      map.set(date, current);
    }
    return Array.from(map.entries());
  }, [shown]);

  return (
    <div className="app-shell member-my-reservations">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      <div className="back-header">
        <div className="side" />
        <div className="title">내 예약</div>
        <a className="side cal-export-btn" href="/mypage/calendar" aria-label="캘린더"><UiIcon name="calendar" size={27} /></a>
      </div>

      <SegmentedTabs value={filter} onChange={setFilter} label="예약 내역 종류"
        items={[{ value: "upcoming", label: "예정된 예약" },{ value: "past", label: "지난 예약" },{ value: "all", label: "전체" }]} />

      {loading ? <Loading /> : shown.length === 0 ? (
        <EmptyState icon="calendar" title={filter === "upcoming" ? "예정된 예약이 없어요" : "예약 내역이 없어요"}
          description={filter === "upcoming" ? "원하는 수업을 찾아 예약해보세요." : "수업을 이용하면 이곳에 기록이 쌓여요."}
          action={filter === "upcoming" ? <a className="primary-btn" href="/reservation">수업 둘러보기</a> : undefined} />
      ) : (
        <div className="reservation-history">
          {grouped.map(([date, items], groupIndex) => (
            <section className="reservation-date-group" key={date}>
              <div className="reservation-date-head">
                <h2>{dateHeading(date)}</h2>
                {groupIndex === 0 && filter === "upcoming" && <span>가장 가까운 일정</span>}
              </div>
              <div className="reservation-date-list">
                {items.map((h) => {
                  const { time } = splitWhen(h.when);
                  return <div key={h.id} className="hist-item">
                    <div className="hist-time">{time}</div>
                    <div className="hist-main">
                      <div className="hist-title">
                        {h.profileName && <span className="profile-tag sm">{h.profileName}</span>}
                        <span className="hist-title-text">{h.title}</span>
                        {memberFacingBadge(h.reservationType as ReservationType) && <span className="profile-tag sm reservation-type-tag">{memberFacingBadge(h.reservationType as ReservationType)}</span>}
                        {h.status === "cancelled" && h.cancelSource === "HOLIDAY" && <span className="profile-tag sm holiday-cancel-tag">센터 휴무로 자동 취소</span>}
                      </div>
                      <div className="hist-sub">{h.centerName}</div>
                    </div>
                    <span className={`hist-status s-${h.status}`}>{STATUS_LABEL[h.status] ?? h.status}</span>
                  </div>;
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <BottomNav />
    </div>
  );
}
