"use client";

/*
  내 예약 (하단 네비 탭)
  - 마이페이지에 있던 예약내역을 이 화면으로 이동
  - 예약 목록 + 캘린더 바로가기
*/

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchMyReservationHistory, type HistoryItem } from "../../lib/mypage";
import { cancelReservation } from "../../lib/reservations";
import Loading from "../components/Loading";
import { memberFacingBadge, type ReservationType } from "../../lib/reservationTypes";
import { formatMonthDayWeekday } from "../../lib/kst";
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
  return formatMonthDayWeekday(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

// startAt(classes.start_time, timestamptz 원본 ISO)로만 미래/과거를 판정한다 — when은
// KST 표시용으로 포맷된 문자열이라 비교에 쓰면 안 된다. 파싱 실패/결측(연결된 수업이
// 삭제된 경우 등)은 판정 불가 상태로 null 반환 — 예정/지난 어느 쪽에도 강제로 넣지 않는다.
export function startAtMs(h: Pick<HistoryItem, "startAt">): number | null {
  if (!h.startAt) return null;
  const t = new Date(h.startAt).getTime();
  return Number.isNaN(t) ? null : t;
}

// 지난 예약이지만 아직 최종 상태(출석/노쇼/취소)가 기록되지 않은 경우(여전히 confirmed나
// waitlisted) — 새 상태를 만들지 않고 배지를 아예 안 보여준다.
const FINAL_PAST_STATUSES = new Set(["attended", "no_show", "cancelled"]);

// 정책(2026-09-14 릴리스 폴리시 배치, 2026-09-14 사용자 피드백으로 취소 건 규칙 수정) —
// 예정된 예약: startAt > now && 상태가 confirmed/waitlisted. 지난 예약: startAt <= now면
// 상태 무관하게 무조건 지난 예약 + "취소된 예약은 수업 시작 전/후 상관없이 항상 지난
// 예약"(사용자 명시 지시 — 미래 시간의 취소 건이 "전체"에만 보이고 예정/지난 어디에도
// 없는 게 애매하다는 피드백) — 즉 isPast는 "시각이 지났거나 OR 상태가 cancelled"로
// 판정한다. 지난 예약에서는 "예약 확정"/"대기"/취소 버튼을 절대 렌더링하지 않는다 —
// 최종 상태(출석/노쇼/취소)가 있으면 그것만 배지로 보여주고, 없으면(아직 출석 처리
// 전 등) 새 상태를 만들지 않고 배지 없이 비워둔다. 이 함수 하나를 필터링과 카드 렌더링
// 양쪽에서 재사용해 두 곳의 판정이 어긋나지 않게 한다 — 순수 함수라 단위 테스트로
// 경계값(startAt==now, 미래 취소 포함)을 직접 검증할 수 있다.
export function classifyReservationDisplay(
  h: Pick<HistoryItem, "startAt" | "status">,
  now: number
): { isPast: boolean; badgeLabel: string | null; cancellable: boolean } {
  const t = startAtMs(h);
  const timeIsPast = t !== null && t <= now;
  const isPast = timeIsPast || h.status === "cancelled";
  const badgeLabel = isPast
    ? (FINAL_PAST_STATUSES.has(h.status) ? STATUS_LABEL[h.status] : null)
    : (STATUS_LABEL[h.status] ?? h.status);
  const cancellable = !isPast && (h.status === "confirmed" || h.status === "waitlisted");
  return { isPast, badgeLabel, cancellable };
}

export default function MyReservationsPage() {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">("upcoming");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await fetchMyReservationHistory();
      setHistory(data);
    } catch (e: any) { setError(e.message ?? "불러오지 못했어요"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // UX 감사(A-4) 대응 — 예전엔 이 화면 카드가 읽기 전용이라 취소하려면 /reservation으로
  // 가서 같은 날짜를 다시 찾아야 했다(app/reservation/page.tsx의 handleCancel과 동일 RPC 재사용).
  async function handleCancel(h: HistoryItem) {
    if (busyId) return;
    if (!(await globalThis.appConfirm("이 수업 예약을 취소할까요?"))) return;
    setBusyId(h.id);
    try {
      const { deducted } = await cancelReservation(h.id);
      showToast(deducted ? "취소됐지만 마감 이후라 수강권 1회가 차감됐어요" : "예약이 취소됐어요");
      await load();
    } catch (e: any) {
      showToast(e.message ?? "취소하지 못했어요");
    } finally {
      setBusyId(null);
    }
  }

  // now는 렌더마다 다시 계산 — 탭을 오래 열어두고 있어도(예: 취소 후 새로고침) 시각
  // 경계가 갱신되도록 한다. "예정된 예약" = 수업 시작 시각이 현재보다 미래 + 확정/대기
  // 상태. "지난 예약" = 시작 시각이 현재 이하가 된 모든 예약(상태 무관, startAt<=now).
  // 시작 시각을 알 수 없는(startAt null) 예약은 예정/지난 어느 탭에도 넣지 않고 "전체"에서만
  // 보여준다 — 잘못된 탭에 잘못 분류하는 것보다 안전하다.
  const now = Date.now();
  const shown = history.filter((h) => {
    const { isPast, cancellable } = classifyReservationDisplay(h, now);
    // "예정된 예약" 탭 조건(미래 + 확정/대기)은 취소 버튼 노출 조건과 정확히 같다.
    if (filter === "upcoming") return cancellable;
    if (filter === "past") return isPast;
    return true;
  });
  const sorted = useMemo(() => {
    const arr = [...shown];
    arr.sort((a, b) => {
      const ta = startAtMs(a) ?? 0;
      const tb = startAtMs(b) ?? 0;
      // 지난 예약: 최근순(내림차순). 예정된 예약/전체: 가까운 순(오름차순).
      return filter === "past" ? tb - ta : ta - tb;
    });
    return arr;
  }, [shown, filter]);
  const grouped = useMemo(() => {
    const map = new Map<string, HistoryItem[]>();
    for (const item of sorted) {
      const { date } = splitWhen(item.when);
      const current = map.get(date) ?? [];
      current.push(item);
      map.set(date, current);
    }
    return Array.from(map.entries());
  }, [sorted]);

  return (
    <div className="app-shell member-my-reservations">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <div className="side" />
        <div className="title">내 예약</div>
        <a className="side cal-export-btn" href="/mypage/calendar" aria-label="캘린더"><UiIcon name="calendar" size={27} /></a>
      </div>
      <nav className="reservation-top-tabs" aria-label="예약 메뉴">
        <a href="/reservation">수업 예약</a>
        <a href="/my-reservations" aria-current="page">내 예약</a>
      </nav>

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
                  const { badgeLabel, cancellable } = classifyReservationDisplay(h, now);
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
                    {(badgeLabel || cancellable) && (
                    <div className="hist-right">
                      {badgeLabel && <span className={`hist-status s-${h.status}`}>{badgeLabel}</span>}
                      {cancellable && (
                        <button
                          type="button"
                          className="hist-cancel-btn"
                          disabled={busyId === h.id}
                          onClick={() => handleCancel(h)}
                        >
                          취소
                        </button>
                      )}
                    </div>
                    )}
                  </div>;
                })}
              </div>
            </section>
          ))}
        </div>
      )}

    </div>
  );
}
