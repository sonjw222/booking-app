"use client";

/*
  매니저 - 휴무일 설정
  - 날짜 + 사유로 휴무일 추가
  - 목록에서 삭제 (지난 날짜는 흐리게)
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchHolidays, addHoliday, deleteHoliday, type Holiday } from "../../../lib/holidays";

function todayStr() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}
function fmtDate(d: string) {
  const dt = new Date(d + "T00:00:00+09:00");
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short" }).format(dt);
}

export default function HolidaysPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [date, setDate] = useState(todayStr());
  const [confirmHoliday, setConfirmHoliday] = useState<{ classCount: number; reservationCount: number } | null>(null);
  const [reason, setReason] = useState("");

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchMyCenters();
        setCenters(list);
        if (list.length > 0) setCenterId(list[0].id);
        else setLoading(false);
      } catch (e: any) { setError(e.message); setLoading(false); }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try { setHolidays(await fetchHolidays(centerId)); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  async function handleAdd(force = false) {
    if (!centerId || !date) { setError("날짜를 선택해주세요"); return; }
    setBusy(true);
    try {
      const result = await addHoliday(centerId, date, reason.trim(), force);
      if (result.needsConfirm) {
        // 예약자가 있는 수업이 있으면 확인 요청
        setConfirmHoliday({ classCount: result.classCount, reservationCount: result.reservationCount });
        setBusy(false);
        return;
      }
      setReason("");
      setConfirmHoliday(null);
      const msg = result.deletedClasses > 0
        ? `휴무일 지정 완료 (수업 ${result.deletedClasses}개 삭제${result.cancelledReservations > 0 ? `, 예약 ${result.cancelledReservations}건 취소` : ""})`
        : "휴무일을 추가했어요";
      showToast(msg);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete(h: Holiday) {
    if (!confirm(`${fmtDate(h.date)} 휴무일을 삭제할까요?`)) return;
    setBusy(true);
    try {
      await deleteHoliday(h.id);
      showToast("삭제했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">휴무일 설정</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  const today = todayStr();

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">휴무일 설정</div>
        <div className="side" />
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="perm-guide">
        휴무일로 지정하면 그날은 회원이 예약할 수 없어요. (정기휴무, 빙질정비 등)
      </div>

      {/* 추가 폼 */}
      <div className="hol-add">
        <input type="date" className="input-field" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="input-field" placeholder="사유 (선택)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="primary-btn small" disabled={busy} onClick={() => handleAdd()}>추가</button>
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {loading ? (
        <Loading />
      ) : holidays.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 30 }}>등록된 휴무일이 없어요</div>
      ) : (
        <div className="hol-list">
          {holidays.map((h) => {
            const past = h.date < today;
            return (
              <div key={h.id} className={`hol-row ${past ? "past" : ""}`}>
                <div className="hol-main">
                  <div className="hol-date">{fmtDate(h.date)}</div>
                  {h.reason && <div className="hol-reason">{h.reason}</div>}
                </div>
                <button className="text-btn danger" disabled={busy} onClick={() => handleDelete(h)}>삭제</button>
              </div>
            );
          })}
        </div>
      )}
      {/* 예약자 있는 수업 삭제 확인 */}
      {confirmHoliday && (
        <div className="sheet-overlay" onClick={() => setConfirmHoliday(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">휴무일로 지정할까요?</div>
            <div className="perm-guide" style={{ margin: "0 0 14px" }}>
              {date}에 수업 <b>{confirmHoliday.classCount}개</b>가 있고,
              그중 <b>{confirmHoliday.reservationCount}건</b>의 예약이 있어요.<br /><br />
              계속하면 <b>예약이 모두 취소되고 수업이 삭제</b>돼요. 반복수업이면 이 날짜만 삭제돼요.
              취소된 회원에게는 별도로 안내해주세요.
            </div>
            <div className="del-options">
              <button className="del-opt danger" disabled={busy} onClick={() => handleAdd(true)}>
                <div className="del-opt-title">예약 취소하고 휴무일 지정</div>
                <div className="del-opt-sub">수업 {confirmHoliday.classCount}개 삭제 · 예약 {confirmHoliday.reservationCount}건 취소</div>
              </button>
              <button className="ghost-btn" style={{ width: "100%", marginTop: 10 }} onClick={() => setConfirmHoliday(null)}>취소</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
