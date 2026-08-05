"use client";

/*
  매니저 - 센터 운영 설정 (17항목)
  - 예약/취소 시간, 폐강, 대기, 표시 여부, 기능 on/off
  - 오너 또는 운영정보 설정 권한(facility.operation) 필요
*/

import { useCallback, useEffect, useState } from "react";
import ManagerNav from "../../components/ManagerNav";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchSettings, saveSettings, type CenterSettings } from "../../../lib/settings";

const SLOT_UNITS: { value: string; label: string }[] = [
  { value: "hour", label: "정시" },
  { value: "30min", label: "30분" },
  { value: "20min", label: "20분" },
  { value: "15min", label: "15분" },
  { value: "10min", label: "10분" },
  { value: "5min", label: "5분" },
];

export default function SettingsPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [s, setS] = useState<CenterSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }

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
    try {
      setS(await fetchSettings(centerId));
      setDirty(false);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  // 설정값 갱신 헬퍼
  function up<K extends keyof CenterSettings>(key: K, val: CenterSettings[K]) {
    setS((prev) => (prev ? { ...prev, [key]: val } : prev));
    setDirty(true);
  }

  async function handleSave() {
    if (!centerId || !s) return;
    setBusy(true);
    try {
      await saveSettings(centerId, s);
      showToast("설정을 저장했어요");
      setDirty(false);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">운영 설정</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  // 숫자 입력 (음수 방지)
  const numInput = (val: number, onCh: (n: number) => void, w = 56, disabled = false) => (
    <input
      type="number" min={0} className="set-num" style={{ width: w }}
      value={val} disabled={disabled}
      onChange={(e) => onCh(Math.max(0, parseInt(e.target.value || "0", 10)))}
    />
  );

  // Track 4 운영설정 재감사: 스케줄러 인프라가 없어 저장만 되고 실제로 작동하지 않는 항목 —
  // 정상 기능처럼 보이지 않도록 "준비 중" 배지를 붙이고 입력을 비활성화한다(값 자체는 유지).
  const soonBadge = <span className="set-soon-badge">준비 중</span>;

  // 토글 스위치
  const toggle = (on: boolean, onCh: (b: boolean) => void) => (
    <button className={`switch ${on ? "on" : ""}`} onClick={() => onCh(!on)}>
      <span className="knob" />
    </button>
  );

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">운영 설정</div>
        <button className="header-action" disabled={busy || !dirty} onClick={handleSave}>
          {busy ? "저장 중" : dirty ? "저장" : "저장됨"}
        </button>
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

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {loading || !s ? (
        <Loading />
      ) : (
        <div className="settings-wrap">
          {/* 01. 예약·취소 가능 시간 */}
          <div className="set-section-title">예약·취소 가능 시간</div>
          <div className="set-row col">
            <div className="set-label">그룹 수업 예약</div>
            <div className="set-inline">수업 {numInput(s.groupBookDaysBefore, (n) => up("groupBookDaysBefore", n))}일 전
              <input type="time" className="set-time" value={s.groupBookTime} onChange={(e) => up("groupBookTime", e.target.value)} />까지</div>
          </div>
          <div className="set-row col">
            <div className="set-label">그룹 수업 취소</div>
            <div className="set-inline">수업 {numInput(s.groupCancelDaysBefore, (n) => up("groupCancelDaysBefore", n))}일 전
              <input type="time" className="set-time" value={s.groupCancelTime} onChange={(e) => up("groupCancelTime", e.target.value)} />까지</div>
          </div>
          <div className="set-row col">
            <div className="set-label">프라이빗 예약</div>
            <div className="set-inline">수업 {numInput(s.privateBookDaysBefore, (n) => up("privateBookDaysBefore", n))}일 전
              <input type="time" className="set-time" value={s.privateBookTime} onChange={(e) => up("privateBookTime", e.target.value)} />까지</div>
          </div>
          <div className="set-row col">
            <div className="set-label">프라이빗 취소</div>
            <div className="set-inline">수업 {numInput(s.privateCancelDaysBefore, (n) => up("privateCancelDaysBefore", n))}일 전
              <input type="time" className="set-time" value={s.privateCancelTime} onChange={(e) => up("privateCancelTime", e.target.value)} />까지</div>
          </div>

          {/* 02. 당일 예약 */}
          <div className="set-section-title">당일 예약</div>
          <div className="set-row">
            <div className="set-label">당일 예약 허용</div>
            <button className={`switch ${s.allowSameDayBooking ? "on" : ""}`} onClick={() => up("allowSameDayBooking", !s.allowSameDayBooking)}>
              <span className="knob" />
            </button>
          </div>
          {s.allowSameDayBooking && (
            <div className="set-row col">
              <div className="set-label">당일 예약 변경 가능 시간 (그룹 수업, 시작 전까지) {soonBadge}</div>
              <div className="set-inline">{numInput(s.sameDayChangeHours, (n) => up("sameDayChangeHours", n), 56, true)}시간
                {numInput(s.sameDayChangeMinutes, (n) => up("sameDayChangeMinutes", n), 56, true)}분 전</div>
              <div className="set-soon-note">예약 마감/취소 규칙과는 별개로 "당일 한정 변경 유예시간"을
                자동으로 적용하려면 정기 실행 스케줄러가 필요해 아직 실제로 반영되지 않아요.</div>
            </div>
          )}

          {/* 03. 폐강 */}
          <div className="set-section-title">수업 폐강 시간 {soonBadge}</div>
          <div className="set-row col">
            <div className="set-label">최소 인원 미달 시, 시작 전 자동 폐강</div>
            <div className="set-inline">{numInput(s.autocancelHours, (n) => up("autocancelHours", n), 56, true)}시간
              {numInput(s.autocancelMinutes, (n) => up("autocancelMinutes", n), 56, true)}분 전</div>
            <div className="set-soon-note">최소 인원 자동 판정에는 정기 실행 스케줄러가 필요해 아직
              실제로 반영되지 않아요 — 폐강은 수업 관리 화면에서 수동으로 처리해주세요.</div>
          </div>

          {/* 04. 대기 자동 예약 */}
          <div className="set-section-title">예약대기 자동 예약 시간 {soonBadge}</div>
          <div className="set-row col">
            <div className="set-label">공석 발생 시, 시작 전까지 자동 예약 (0이면 취소시간 적용)</div>
            <div className="set-inline">{numInput(s.waitlistAutoHours, (n) => up("waitlistAutoHours", n), 56, true)}시간
              {numInput(s.waitlistAutoMinutes, (n) => up("waitlistAutoMinutes", n), 56, true)}분 전</div>
            <div className="set-soon-note">공석 발생 시 대기자 확정은 취소 시점에 즉시 처리되고
              있어요(정상 동작) — 여기 설정된 "몇 시간 전까지만" 조건은 아직 적용되지 않아요.</div>
          </div>

          {/* 05. 대기 횟수 */}
          <div className="set-section-title">예약 대기 가능 횟수</div>
          <div className="set-row">
            <div className="set-label">한 주 그룹수업 최대 대기 (0이면 대기 기능 끔)</div>
            <div className="set-inline">{numInput(s.waitlistWeeklyLimit, (n) => up("waitlistWeeklyLimit", n))}회</div>
          </div>

          {/* 06. 일일 예약 */}
          <div className="set-section-title">일일 예약 가능 횟수</div>
          <div className="set-row">
            <div className="set-label">일일 예약 횟수 제한</div>
            {toggle(s.dailyBookLimitEnabled, (b) => up("dailyBookLimitEnabled", b))}
          </div>
          {s.dailyBookLimitEnabled && (
            <div className="set-row">
              <div className="set-label">하루 최대</div>
              <div className="set-inline">{numInput(s.dailyBookLimit ?? 1, (n) => up("dailyBookLimit", n))}회</div>
            </div>
          )}

          {/* 07. 예약 오픈 기한 */}
          <div className="set-section-title">예약 가능 기한 (오픈 시점)</div>
          <div className="set-row col">
            <div className="set-label">그룹 수업</div>
            <div className="set-inline">수업 {numInput(s.groupOpenDaysBefore, (n) => up("groupOpenDaysBefore", n))}일 전
              <input type="time" className="set-time" value={s.groupOpenTime} onChange={(e) => up("groupOpenTime", e.target.value)} />부터</div>
          </div>
          <div className="set-row col">
            <div className="set-label">프라이빗</div>
            <div className="set-inline">수업 {numInput(s.privateOpenDaysBefore, (n) => up("privateOpenDaysBefore", n))}일 전
              <input type="time" className="set-time" value={s.privateOpenTime} onChange={(e) => up("privateOpenTime", e.target.value)} />부터</div>
          </div>

          {/* 08. 슬롯 단위 */}
          <div className="set-section-title">프라이빗 예약 시간 단위</div>
          <div className="mem-filters" style={{ padding: "0 20px 8px" }}>
            {SLOT_UNITS.map((u) => (
              <button key={u.value} className={`filter-chip ${s.privateSlotUnit === u.value ? "on" : ""}`} onClick={() => up("privateSlotUnit", u.value)}>{u.label}</button>
            ))}
          </div>

          {/* 09. 동시 최대 */}
          <div className="set-section-title">프라이빗 동시 수업 최대 개수</div>
          <div className="set-row">
            <div className="set-label">같은 시간대 최대 개수 제한</div>
            {toggle(s.privateMaxConcurrentEnabled, (b) => up("privateMaxConcurrentEnabled", b))}
          </div>
          {s.privateMaxConcurrentEnabled && (
            <div className="set-row">
              <div className="set-label">최대</div>
              <div className="set-inline">{numInput(s.privateMaxConcurrent ?? 1, (n) => up("privateMaxConcurrent", n))}개</div>
            </div>
          )}

          {/* 10. 인원 표시 */}
          <div className="set-section-title">회원 앱 인원 표시</div>
          <div className="set-row">
            <div className="set-label">그룹 수업 예약 인원 표시</div>
            {toggle(s.showGroupReservedCount, (b) => up("showGroupReservedCount", b))}
          </div>
          <div className="set-row">
            <div className="set-label">그룹 수업 대기 인원 표시</div>
            {toggle(s.showGroupWaitlistCount, (b) => up("showGroupWaitlistCount", b))}
          </div>

          {/* 11~17. 기능 on/off */}
          <div className="set-section-title">기능 사용 여부</div>
          {/* E-6: 문의 게시판/락커/라운지 사용 토글 제거 — 어디서도 이 값을 읽는 코드가 없어
              (docs/TODO.md에 근거 기록) 관리자가 켜고 꺼도 실제 효과가 없는 항목이었다.
              DB 컬럼(use_inquiry_board/use_locker/use_lounge)은 이번에 지우지 않는다(향후
              기능 플래그로 재사용될 수 있어 별도 migration 이슈로 분리). */}
          {([
            ["showAllClasses", "수강권으로 볼 수 없는 수업도 표시"],
            ["deductOnLateCancel", "취소 시간 이후 취소 시 횟수 차감"],
            ["autoUnpaidInput", "수강권 미수금 자동 입력"],
            ["showPointHistory", "회원앱 포인트 내역 조회"],
          ] as [keyof CenterSettings, string][]).map(([key, label]) => (
            <div className="set-row" key={key}>
              <div className="set-label">{label}</div>
              {toggle(s[key] as boolean, (b) => up(key, b as any))}
            </div>
          ))}

          <div style={{ height: 40 }} />
        </div>
      )}
      <ManagerNav />
    </div>
  );
}
