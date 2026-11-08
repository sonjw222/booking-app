"use client";
import { fetchCancellationNotice } from "../../lib/cancelPreview";

/*
  내 예약 (하단 네비 탭)
  - 마이페이지에 있던 예약내역을 이 화면으로 이동
  - 예약 목록 + 캘린더 바로가기
*/

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchMyReservationHistory, type HistoryItem } from "../../lib/mypage";
import { cancelReservation } from "../../lib/reservations";
import Loading from "../components/Loading";
import { memberFacingBadge, type ReservationType } from "../../lib/reservationTypes";
import { formatMonthDayWeekday } from "../../lib/kst";
import UiIcon from "../components/UiIcon";
import SegmentedTabs from "../components/SegmentedTabs";
import EmptyState from "../components/EmptyState";
import { toUserMessage } from "../../lib/userError";
import { hapticWarning } from "../../lib/nativeHaptics";
import { useResumeRefresh } from "../../lib/useResumeRefresh";
import { startAtMs, classifyReservationDisplay } from "../../lib/reservationDisplay";

function splitWhen(when: string) {
  const [date = when, time = ""] = when.split(" ");
  return { date, time };
}

function dateHeading(date: string) {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return formatMonthDayWeekday(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

export default function MyReservationsPage() {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">("upcoming");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(msg: string) {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => { setToast(null); toastTimerRef.current = null; }, 2500);
  }
  useEffect(() => () => {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
  }, []);

  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const load = useCallback(async (opts?: { background?: boolean }) => {
    // background(PERF-013 앱 복귀 재조회): 스피너 전환 없이 조용히 데이터만 교체
    // (아직 한 번도 불러오지 못한 상태에서 실패하면 빈 목록으로 두지 않고 오류 화면을 보여준다)
    const seq = ++requestSeqRef.current;
    if (!opts?.background) { setLoading(true); setError(null); }
    try {
      const data = await fetchMyReservationHistory();
      // 화면 이탈 후이거나 더 새로운 요청이 있으면 오래된 응답은 버린다
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      hasLoadedRef.current = true;
      setHistory(data);
      setError(null);
      setLoading(false);
    } catch (e: unknown) {
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      if (!opts?.background || !hasLoadedRef.current) {
        setHistory([]);
        setError(toUserMessage(e, "불러오지 못했어요"));
      }
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void load(); });
    return () => { disposed = true; mountedRef.current = false; };
  }, [load]);
  // PERF-013: 5분 이상 백그라운드였다가 돌아오면 내 예약 목록만 조용히 재조회
  useResumeRefresh(() => load({ background: true }));

  // UX 감사(A-4) 대응 — 예전엔 이 화면 카드가 읽기 전용이라 취소하려면 /reservation으로
  // 가서 같은 날짜를 다시 찾아야 했다(app/reservation/page.tsx의 handleCancel과 동일 RPC 재사용).
  async function handleCancel(h: HistoryItem) {
    if (busyId) return;
    setBusyId(h.id);
    try {
      const notice = await fetchCancellationNotice(h.id);
      if (!(await globalThis.appConfirm(`${h.title} 예약을 취소할까요?\n${notice}\n최종 취소 조건은 서버에서 다시 확인해요.`))) return;
      const { deducted } = await cancelReservation(h.id);
      showToast(deducted ? "취소됐지만 마감 이후라 수강권 1회가 차감됐어요" : "예약이 취소됐어요");
      void hapticWarning();
      await load();
    } catch (e: unknown) {
      showToast(toUserMessage(e, "취소하지 못했어요"));
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
      {toast && <div className="toast" role="status" aria-live="polite" aria-atomic="true">{toast}</div>}

      <div className="back-header">
        <div className="side" />
        <div className="title">내 예약</div>
        <Link className="side cal-export-btn" href="/mypage/calendar" aria-label="캘린더" prefetch={false}><UiIcon name="calendar" size={27} /></Link>
      </div>
      <nav className="reservation-top-tabs" aria-label="예약 메뉴">
        <Link href="/reservation" prefetch={false}>수업 예약</Link>
        <Link href="/my-reservations" aria-current="page" prefetch={false}>내 예약</Link>
      </nav>

      <SegmentedTabs value={filter} onChange={setFilter} label="예약 내역 종류"
        items={[{ value: "upcoming", label: "예정된 예약" },{ value: "past", label: "지난 예약" },{ value: "all", label: "전체" }]} />

      {loading ? <Loading /> : error ? (
        <div role="alert" className="my-reservations-error">
          <EmptyState icon="calendar" title="예약 내역을 불러오지 못했어요" description={error}
            action={<button type="button" className="primary-btn" onClick={() => load()}>다시 시도</button>} />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState icon="calendar" title={filter === "upcoming" ? "예정된 예약이 없어요" : "예약 내역이 없어요"}
          description={filter === "upcoming" ? "원하는 수업을 찾아 예약해보세요." : "수업을 이용하면 이곳에 기록이 쌓여요."}
          action={filter === "upcoming" ? <Link className="primary-btn" href="/reservation" prefetch={false}>수업 둘러보기</Link> : undefined} />
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
                          aria-label={`${h.title} 예약 취소`}
                          style={{ minWidth: 44, minHeight: 44 }}
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
