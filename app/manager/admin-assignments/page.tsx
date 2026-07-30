"use client";

/*
  매니저 - 관리자 배치 내역 (관리자 활동기록)
  - 관리자 직접배치 / 무료 추가 배치 / 취소 로그 조회 (admin_action_logs)
  - 기본 조회 + 실무 필터 + 상세보기 + 되돌리기 (통계 대시보드·엑셀 다운로드는 이번 범위 제외)
*/

import { useCallback, useEffect, useState } from "react";
import ManagerNav from "../../components/ManagerNav";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchAdminActionLogs, isRevertEligible, revertAdminActionLog,
  type AdminActionLog, type AdminActionLogFilters,
} from "../../../lib/adminAssignment";
import { RESERVATION_TYPE_LABELS, ADMIN_REASON_CODES, ADMIN_REASON_LABELS, type ReservationType, type AdminReasonCode } from "../../../lib/reservationTypes";

const ACTION_LABELS: Record<AdminActionLog["actionType"], string> = {
  CREATE_ASSIGNMENT: "일반 직접배치",
  CREATE_FREE: "무료 추가 배치",
  CANCEL_ASSIGNMENT: "직접배치 취소",
  CANCEL_FREE: "무료배치 취소",
};

// 행위 필터 프리셋: "직접취소"는 CANCEL_ASSIGNMENT/CANCEL_FREE 두 가지를 하나로 묶어 보여준다.
// admin_action_logs 조회는 단일 값 eq 필터만 지원하므로(불필요한 API 확장 방지), CREATE_* 두
// 종류는 서버 필터를 그대로 쓰고 "직접취소"만 서버에서 전체를 받아 클라이언트에서 좁힌다.
type ActionPreset = "all" | "CREATE_ASSIGNMENT" | "CREATE_FREE" | "CANCEL";
const ACTION_PRESET_LABEL: Record<ActionPreset, string> = {
  all: "전체", CREATE_ASSIGNMENT: "직접배치", CREATE_FREE: "무료배치", CANCEL: "직접취소",
};

const KST_DT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function fmt(iso: string) {
  return KST_DT.format(new Date(iso)).replace(/\. /g, "-").replace(".", "").replace(",", "");
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function daysAgoStr(n: number) { return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10); }

export default function AdminAssignmentLogPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [logs, setLogs] = useState<AdminActionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }

  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [periodPreset, setPeriodPreset] = useState<"today" | "7d" | "30d" | "all" | "custom">("all");
  const [typeFilter, setTypeFilter] = useState<ReservationType | "all">("all");
  const [actionPreset, setActionPreset] = useState<ActionPreset>("all");
  const [capacityOnly, setCapacityOnly] = useState(false);
  const [reasonFilter, setReasonFilter] = useState<AdminReasonCode | "all">("all");
  const [keyword, setKeyword] = useState("");

  const [detailLog, setDetailLog] = useState<AdminActionLog | null>(null);
  const [revertReason, setRevertReason] = useState("");
  const [revertBusy, setRevertBusy] = useState(false);

  function applyPeriodPreset(p: "today" | "7d" | "30d" | "all") {
    setPeriodPreset(p);
    if (p === "today") { setFromDate(todayStr()); setToDate(todayStr()); }
    else if (p === "7d") { setFromDate(daysAgoStr(7)); setToDate(todayStr()); }
    else if (p === "30d") { setFromDate(daysAgoStr(30)); setToDate(todayStr()); }
    else { setFromDate(""); setToDate(""); }
  }

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
      const filters: AdminActionLogFilters = {};
      if (fromDate) filters.fromDate = fromDate;
      if (toDate) filters.toDate = toDate;
      if (typeFilter !== "all") filters.reservationType = typeFilter;
      if (actionPreset === "CREATE_ASSIGNMENT" || actionPreset === "CREATE_FREE") filters.actionType = actionPreset;
      if (capacityOnly) filters.capacityOverrideOnly = true;
      if (reasonFilter !== "all") filters.reasonCode = reasonFilter;
      setLogs(await fetchAdminActionLogs(centerId, filters));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId, fromDate, toDate, typeFilter, actionPreset, capacityOnly, reasonFilter]);
  useEffect(() => { load(); }, [load]);

  const kw = keyword.trim();
  const shown = logs
    .filter((l) => actionPreset !== "CANCEL" || l.actionType.startsWith("CANCEL_"))
    .filter((l) => !kw || l.memberName.includes(kw) || l.adminName.includes(kw) || l.classTitle.includes(kw));

  async function handleRevert() {
    if (!detailLog) return;
    setRevertBusy(true);
    try {
      await revertAdminActionLog(detailLog, revertReason);
      showToast("관리자 배치를 취소했어요");
      setDetailLog(null);
      setRevertReason("");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRevertBusy(false);
    }
  }

  if (loading && logs.length === 0) {
    return <div className="app-shell"><Loading /></div>;
  }

  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">관리자 활동기록</div>
        <div className="side" />
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="menu-section-label" style={{ padding: "10px 20px 6px" }}>기간</div>
      <div className="mem-filters">
        <button className={`pill-btn ${periodPreset === "today" ? "on" : ""}`} onClick={() => applyPeriodPreset("today")}>오늘</button>
        <button className={`pill-btn ${periodPreset === "7d" ? "on" : ""}`} onClick={() => applyPeriodPreset("7d")}>7일</button>
        <button className={`pill-btn ${periodPreset === "30d" ? "on" : ""}`} onClick={() => applyPeriodPreset("30d")}>30일</button>
        <button className={`pill-btn ${periodPreset === "all" ? "on" : ""}`} onClick={() => applyPeriodPreset("all")}>전체</button>
      </div>
      <div className="time-row" style={{ padding: "8px 20px 0" }}>
        <input className="input-field" type="date" value={fromDate}
          onChange={(e) => { setFromDate(e.target.value); setPeriodPreset("custom"); }} />
        <span className="time-sep">~</span>
        <input className="input-field" type="date" value={toDate}
          onChange={(e) => { setToDate(e.target.value); setPeriodPreset("custom"); }} />
      </div>

      <div className="menu-section-label" style={{ padding: "10px 20px 6px" }}>배치 유형</div>
      <div className="mem-filters">
        <button className={`filter-chip ${typeFilter === "all" ? "on" : ""}`} onClick={() => setTypeFilter("all")}>전체</button>
        <button className={`filter-chip ${typeFilter === "ADMIN_ASSIGNMENT" ? "on" : ""}`} onClick={() => setTypeFilter("ADMIN_ASSIGNMENT")}>
          {RESERVATION_TYPE_LABELS.ADMIN_ASSIGNMENT}
        </button>
        <button className={`filter-chip ${typeFilter === "ADMIN_FREE" ? "on" : ""}`} onClick={() => setTypeFilter("ADMIN_FREE")}>
          {RESERVATION_TYPE_LABELS.ADMIN_FREE}
        </button>
      </div>

      <div className="menu-section-label" style={{ padding: "10px 20px 6px" }}>행위</div>
      <div className="mem-filters">
        {(Object.keys(ACTION_PRESET_LABEL) as ActionPreset[]).map((p) => (
          <button key={p} className={`filter-chip ${actionPreset === p ? "on" : ""}`} onClick={() => setActionPreset(p)}>
            {ACTION_PRESET_LABEL[p]}
          </button>
        ))}
      </div>

      <div className="menu-section-label" style={{ padding: "10px 20px 6px" }}>배치 사유</div>
      <div className="mem-filters">
        <button className={`filter-chip ${reasonFilter === "all" ? "on" : ""}`} onClick={() => setReasonFilter("all")}>전체</button>
        {ADMIN_REASON_CODES.map((code) => (
          <button key={code} className={`filter-chip ${reasonFilter === code ? "on" : ""}`} onClick={() => setReasonFilter(code)}>
            {ADMIN_REASON_LABELS[code]}
          </button>
        ))}
      </div>

      <div className="set-row" style={{ padding: "10px 20px" }}>
        <div className="set-label">정원 초과 배치만 보기</div>
        <button className={`switch ${capacityOnly ? "on" : ""}`} onClick={() => setCapacityOnly((v) => !v)}>
          <span className="knob" />
        </button>
      </div>

      <div style={{ padding: "0 20px" }}>
        <input className="input-field" placeholder="회원 / 관리자 / 수업명 검색"
          value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      </div>

      <div className="menu-section-label" style={{ padding: "14px 20px 6px" }}>결과 ({shown.length})</div>

      {shown.length === 0 ? (
        <div className="daylist-empty" style={{ padding: "40px 20px" }}>조건에 맞는 배치 내역이 없어요</div>
      ) : (
        <div style={{ padding: "0 4px" }}>
          {shown.map((l) => (
            <button
              key={l.id}
              className="hist-item"
              style={{ flexDirection: "column", alignItems: "flex-start", width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer" }}
              onClick={() => setDetailLog(l)}
            >
              <div className="hist-main" style={{ width: "100%" }}>
                <div className="hist-title">
                  <span className="profile-tag sm">{ACTION_LABELS[l.actionType]}</span>
                  {l.memberName} 회원
                  {l.capacityOverride && <span className="profile-tag sm">정원 초과 배치</span>}
                </div>
                <div className="hist-sub">
                  {l.classTitle} · {l.classStart ? fmt(l.classStart) : ""}
                </div>
                <div className="hist-sub">
                  배치 관리자 {l.adminName}
                  {l.reasonCode && <> · 사유 {ADMIN_REASON_LABELS[l.reasonCode]}</>}
                  {l.reasonDetail && <> ({l.reasonDetail})</>}
                </div>
                <div className="hist-sub">{fmt(l.createdAt)}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 상세보기 */}
      {detailLog && (
        <div className="sheet-overlay" onClick={() => { setDetailLog(null); setRevertReason(""); }}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">활동 상세</div>

            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>행위</div>
            <div className="hist-summary">{ACTION_LABELS[detailLog.actionType]}</div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>관리자</div>
            <div className="hist-summary">{detailLog.adminName}</div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>회원</div>
            <div className="hist-summary">
              {detailLog.memberName}
              {detailLog.memberProfileId && (
                <a className="text-btn" style={{ marginLeft: 8 }} href={`/manager/members?profile=${detailLog.memberProfileId}`}>회원 상세 ›</a>
              )}
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>수업</div>
            <div className="hist-summary">
              {detailLog.classTitle} {detailLog.classStart ? `· ${fmt(detailLog.classStart)}` : ""}
              <a className="text-btn" style={{ marginLeft: 8 }} href="/manager/classes">수업으로 ›</a>
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>사유</div>
            <div className="hist-summary">
              {detailLog.reasonCode ? ADMIN_REASON_LABELS[detailLog.reasonCode] : "미지정"}
              {detailLog.reasonDetail && <div className="hist-sub" style={{ marginTop: 4 }}>{detailLog.reasonDetail}</div>}
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>기타</div>
            <div className="hist-sub">
              정원 초과 배치: {detailLog.capacityOverride ? "예" : "아니오"} · 수강권 차감: {detailLog.membershipConsumed ? "예" : "아니오"}
            </div>
            <div className="hist-sub" style={{ marginTop: 2 }}>{fmt(detailLog.createdAt)}</div>

            {isRevertEligible(detailLog) && (
              <>
                <div className="menu-section-label" style={{ padding: "14px 0 6px" }}>되돌리기</div>
                <div className="perm-guide" style={{ margin: "0 0 8px" }}>
                  이 회원의 관리자 배치 예약을 취소하시겠습니까? 관리자 배치 취소 내역은 별도로 기록되며
                  회원에게 취소 알림이 전송됩니다.
                </div>
                <input className="input-field" placeholder="취소 사유 (선택)"
                  value={revertReason} onChange={(e) => setRevertReason(e.target.value)} />
              </>
            )}

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => { setDetailLog(null); setRevertReason(""); }}>닫기</button>
              {isRevertEligible(detailLog) && (
                <button className="primary-btn danger-btn" disabled={revertBusy} onClick={handleRevert}>
                  {revertBusy ? "처리 중..." : "되돌리기(배치 취소)"}
                </button>
              )}
            </div>
            {!isRevertEligible(detailLog) && (detailLog.actionType === "CREATE_ASSIGNMENT" || detailLog.actionType === "CREATE_FREE") && (
              <div className="perm-guide" style={{ margin: "8px 0 0", textAlign: "center" }}>
                이미 취소되었거나 수업이 시작되어 되돌릴 수 없어요.
              </div>
            )}
          </div>
        </div>
      )}

      <ManagerNav />
    </div>
  );
}
