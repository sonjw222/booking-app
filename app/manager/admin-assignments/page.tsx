"use client";

/*
  매니저 - 관리자 배치 내역
  - 관리자 직접배치 / 무료 추가 배치 / 취소 로그 조회 (admin_action_logs)
  - 기본 조회 + 실무 필터만 구현 (통계 대시보드·엑셀 다운로드는 이번 범위 제외)
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import DatePicker from "../../components/DatePicker";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchAdminActionLogs, type AdminActionLog, type AdminActionLogFilters } from "../../../lib/adminAssignment";
import { RESERVATION_TYPE_LABELS, ADMIN_REASON_CODES, ADMIN_REASON_LABELS, type ReservationType, type AdminReasonCode } from "../../../lib/reservationTypes";

const ACTION_LABELS: Record<AdminActionLog["actionType"], string> = {
  CREATE_ASSIGNMENT: "일반 직접배치",
  CREATE_FREE: "무료 추가 배치",
  CANCEL_ASSIGNMENT: "직접배치 취소",
  CANCEL_FREE: "무료배치 취소",
};

const KST_DT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function fmt(iso: string) {
  return KST_DT.format(new Date(iso)).replace(/\. /g, "-").replace(".", "").replace(",", "");
}

export default function AdminAssignmentLogPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [logs, setLogs] = useState<AdminActionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [typeFilter, setTypeFilter] = useState<ReservationType | "all">("all");
  const [actionFilter, setActionFilter] = useState<AdminActionLog["actionType"] | "all">("all");
  const [capacityOnly, setCapacityOnly] = useState(false);
  const [reasonFilter, setReasonFilter] = useState<AdminReasonCode | "all">("all");
  const [keyword, setKeyword] = useState("");

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
      if (actionFilter !== "all") filters.actionType = actionFilter;
      if (capacityOnly) filters.capacityOverrideOnly = true;
      if (reasonFilter !== "all") filters.reasonCode = reasonFilter;
      setLogs(await fetchAdminActionLogs(centerId, filters));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId, fromDate, toDate, typeFilter, actionFilter, capacityOnly, reasonFilter]);
  useEffect(() => { load(); }, [load]);

  const kw = keyword.trim();
  const shown = kw
    ? logs.filter((l) => l.memberName.includes(kw) || l.adminName.includes(kw) || l.classTitle.includes(kw))
    : logs;

  if (loading && logs.length === 0) {
    return <div className="app-shell"><Loading /></div>;
  }

  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">관리자 배치 내역</div>
        <div className="side" />
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

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
      <div className="time-row" style={{ padding: "0 20px" }}>
        <DatePicker value={fromDate} onChange={setFromDate} label="조회 시작일" />
        <span className="time-sep">~</span>
        <DatePicker value={toDate} onChange={setToDate} label="조회 종료일" />
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

      <div className="menu-section-label" style={{ padding: "10px 20px 6px" }}>작업</div>
      <div className="mem-filters">
        <button className={`filter-chip ${actionFilter === "all" ? "on" : ""}`} onClick={() => setActionFilter("all")}>전체</button>
        {(Object.keys(ACTION_LABELS) as AdminActionLog["actionType"][]).map((a) => (
          <button key={a} className={`filter-chip ${actionFilter === a ? "on" : ""}`} onClick={() => setActionFilter(a)}>
            {ACTION_LABELS[a]}
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
        <div className="assignment-log-list">
          {shown.map((l) => (
            <article key={l.id} className={`assignment-log action-${l.actionType.toLowerCase()}`}>
              <div className="hist-main" style={{ width: "100%" }}>
                <div className="hist-title">
                  <span className="assignment-action">{ACTION_LABELS[l.actionType]}</span>
                  <strong>{l.memberName}</strong>
                  {l.capacityOverride && <span className="assignment-warning">정원 초과</span>}
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
            </article>
          ))}
        </div>
      )}

    </div>
  );
}
