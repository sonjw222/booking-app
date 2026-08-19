"use client";

/*
  매니저 - 수업매출 캘린더
  - 결제일이 아니라 "수업이 실제로 열린 날짜" 기준 매출을 본다.
  - 기간 선택 → 그 기간 총 수업매출(기존 "매출" 화면과 동일한 개념의 요약 카드).
  - 월 캘린더 → 날짜별 금액 표시, 클릭하면 그 날 어떤 수업/상품으로 얼마 났는지 breakdown.
  - breakdown에서 수업(그룹) 클릭 → 회원/시간/장소 펼침. 횟수제 수강권 그룹은 회차별
    금액을 매니저가 직접 커스텀할 수 있는 편집 버튼도 함께 보여준다.
*/

import { useCallback, useEffect, useMemo, useState } from "react";
import ManagerNav from "../../components/ManagerNav";
import Loading from "../../components/Loading";
import DatePicker from "../../components/DatePicker";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { won } from "../../../lib/sales";
import {
  fetchClassRevenueDaily, fetchClassRevenueForDate, groupClassRevenueRows,
  fetchMembershipSessionEditData, setMembershipSessionAmounts,
  type ClassRevenueDaily, type ClassRevenueGroup,
} from "../../../lib/classRevenue";

function todayStr() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}
function monthStartStr() {
  return todayStr().slice(0, 8) + "01";
}

const TYPE_LABEL: Record<string, string> = {
  class: "수업", period_pass: "정기권", goods: "상품", refund: "환불",
};

export default function ClassRevenuePage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 기간 선택 → 그 기간 총 매출 요약
  const [from, setFrom] = useState(monthStartStr());
  const [to, setTo] = useState(todayStr());
  const [periodDaily, setPeriodDaily] = useState<ClassRevenueDaily[]>([]);
  const [periodLoading, setPeriodLoading] = useState(true);

  // 캘린더(월 단위 탐색, 위 기간선택과 별개)
  const [cal, setCal] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; });
  const [calDaily, setCalDaily] = useState<ClassRevenueDaily[]>([]);
  const [calLoading, setCalLoading] = useState(true);

  // 선택한 날짜의 breakdown
  const [selected, setSelected] = useState<string | null>(null);
  const [detailGroups, setDetailGroups] = useState<ClassRevenueGroup[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // 회차별 금액 편집 모달
  const [editTarget, setEditTarget] = useState<{ membershipId: string; classTitle: string | null } | null>(null);
  const [editAmounts, setEditAmounts] = useState<number[]>([]);
  const [editPaidTotal, setEditPaidTotal] = useState(0);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);

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

  const loadPeriod = useCallback(async () => {
    if (!centerId) return;
    setPeriodLoading(true);
    try { setPeriodDaily(await fetchClassRevenueDaily(centerId, from, to)); }
    catch (e: any) { setError(e.message); }
    finally { setPeriodLoading(false); setLoading(false); }
  }, [centerId, from, to]);
  useEffect(() => { loadPeriod(); }, [loadPeriod]);

  const pad = (n: number) => String(n).padStart(2, "0");
  const calFrom = `${cal.y}-${pad(cal.m)}-01`;
  const calDaysInMonth = new Date(cal.y, cal.m, 0).getDate();
  const calTo = `${cal.y}-${pad(cal.m)}-${pad(calDaysInMonth)}`;

  const loadCal = useCallback(async () => {
    if (!centerId) return;
    setCalLoading(true);
    try { setCalDaily(await fetchClassRevenueDaily(centerId, calFrom, calTo)); }
    catch (e: any) { setError(e.message); }
    finally { setCalLoading(false); }
  }, [centerId, calFrom, calTo]);
  useEffect(() => { loadCal(); }, [loadCal]);

  const periodTotal = useMemo(
    () => periodDaily.reduce((sum, d) => sum + d.total, 0), [periodDaily]
  );
  const periodByType = useMemo(() => ({
    classRevenue: periodDaily.reduce((s, d) => s + d.classRevenue, 0),
    periodPassRevenue: periodDaily.reduce((s, d) => s + d.periodPassRevenue, 0),
    goodsRevenue: periodDaily.reduce((s, d) => s + d.goodsRevenue, 0),
    refundAmount: periodDaily.reduce((s, d) => s + d.refundAmount, 0),
  }), [periodDaily]);

  const calByDate: Record<string, ClassRevenueDaily> = {};
  for (const d of calDaily) calByDate[d.date] = d;

  const startDow = new Date(cal.y, cal.m - 1, 1).getDay();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= calDaysInMonth; d++) cells.push(d);

  function prevMonth() { setSelected(null); setCal((c) => c.m === 1 ? { y: c.y - 1, m: 12 } : { y: c.y, m: c.m - 1 }); }
  function nextMonth() { setSelected(null); setCal((c) => c.m === 12 ? { y: c.y + 1, m: 1 } : { y: c.y, m: c.m + 1 }); }

  async function selectDate(dateKey: string) {
    if (selected === dateKey) { setSelected(null); return; }
    setSelected(dateKey);
    setExpandedKey(null);
    setDetailLoading(true);
    try {
      const rows = await fetchClassRevenueForDate(centerId!, dateKey);
      setDetailGroups(groupClassRevenueRows(rows));
    } catch (e: any) { setError(e.message); }
    finally { setDetailLoading(false); }
  }

  async function openSessionEdit(membershipId: string, classTitle: string | null) {
    setEditTarget({ membershipId, classTitle });
    setEditLoading(true);
    try {
      const data = await fetchMembershipSessionEditData(membershipId);
      setEditAmounts(data.amounts);
      setEditPaidTotal(data.paidTotal);
    } catch (e: any) { setError(e.message); setEditTarget(null); }
    finally { setEditLoading(false); }
  }

  const editSum = editAmounts.reduce((s, n) => s + (n || 0), 0);
  const editValid = editSum === editPaidTotal;

  async function saveSessionEdit() {
    if (!editTarget || !editValid) return;
    setEditSaving(true);
    try {
      await setMembershipSessionAmounts(editTarget.membershipId, editAmounts);
      showToast("회차별 금액을 저장했어요");
      setEditTarget(null);
      if (selected) await selectDate(selected); // 재조회로 반영
    } catch (e: any) { setError(e.message); }
    finally { setEditSaving(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">수업매출</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      <div className="back-header">
        <a className="side" href="/manager/sales">‹</a>
        <div className="title">수업매출</div>
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

      <div className="date-range">
        <DatePicker value={from} onChange={setFrom} label="수업매출 조회 시작일" />
        <span className="date-tilde">~</span>
        <DatePicker value={to} onChange={setTo} label="수업매출 조회 종료일" />
      </div>

      {loading ? (
        <Loading />
      ) : (
        <>
          {/* 기간 요약 */}
          <div className="sales-summary">
            <div className="sales-big">
              <div className="sales-big-label">기간 내 수업매출 합계</div>
              <div className="sales-big-value">{periodLoading ? "…" : won(periodTotal)}</div>
            </div>
          </div>
          <div className="menu-section-label">구분별</div>
          <div className="sales-breakdown">
            <div className="sales-bd-item"><span className="bd-label">수업(횟수제·정기권 이용분)</span><span className="bd-value">{won(periodByType.classRevenue)}</span></div>
            <div className="sales-bd-item"><span className="bd-label">정기권(구매일 전액 모드)</span><span className="bd-value">{won(periodByType.periodPassRevenue)}</span></div>
            <div className="sales-bd-item"><span className="bd-label">상품</span><span className="bd-value">{won(periodByType.goodsRevenue)}</span></div>
            <div className="sales-bd-item"><span className="bd-label">환불</span><span className="bd-value">{won(periodByType.refundAmount)}</span></div>
          </div>

          {/* 캘린더 */}
          <div className="mypage-cal" style={{ margin: "12px 20px" }}>
            <div className="mypage-cal-head">
              <button onClick={prevMonth}>‹</button>
              <span>{cal.y}.{pad(cal.m)}</span>
              <button onClick={nextMonth}>›</button>
            </div>
            <div className="mypage-cal-grid">
              {["일", "월", "화", "수", "목", "금", "토"].map((d) => <div key={d} className="mypage-cal-dow">{d}</div>)}
              {cells.map((day, i) => {
                if (day === null) return <div key={i} className="mypage-cal-cell empty" />;
                const key = `${cal.y}-${pad(cal.m)}-${pad(day)}`;
                const info = calByDate[key];
                const isSel = selected === key;
                return (
                  <button key={i} className={`mypage-cal-cell tappable ${isSel ? "sel" : ""}`} onClick={() => selectDate(key)}>
                    <span className="mypage-cal-day">{day}</span>
                    {!calLoading && info && info.total !== 0 && (
                      <span style={{ fontSize: 10, color: info.total > 0 ? "var(--brand, #2c7a7b)" : "#c0392b", display: "block" }}>
                        {(info.total / 10000).toFixed(info.total % 10000 === 0 ? 0 : 1)}만
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 선택한 날 breakdown */}
          {selected && (
            <div className="cal-detail">
              <div className="cal-detail-date">{selected.replace(/-/g, ".")}</div>
              {detailLoading ? (
                <Loading />
              ) : detailGroups.length === 0 ? (
                <div className="daylist-empty" style={{ padding: 16 }}>이 날은 매출이 없어요</div>
              ) : (
                detailGroups.map((g) => (
                  <div key={g.key} className="cal-detail-card">
                    <div className="cal-detail-top" style={{ cursor: "pointer" }} onClick={() => setExpandedKey(expandedKey === g.key ? null : g.key)}>
                      <div>
                        <div className="cal-detail-title">
                          {g.type === "class" ? (g.classTitle ?? "수업") : (g.productName ?? TYPE_LABEL[g.type])}
                        </div>
                        <div className="cal-detail-sub">
                          <span className="profile-tag sm">{TYPE_LABEL[g.type]}</span>
                          {g.type === "class" && g.time && (
                            <span style={{ marginLeft: 6 }}>
                              {new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(g.time))}
                              {g.place ? ` · ${g.place}` : ""}
                            </span>
                          )}
                        </div>
                      </div>
                      <span style={{ fontWeight: 600, color: g.total >= 0 ? undefined : "#c0392b" }}>{won(g.total)}</span>
                    </div>
                    {expandedKey === g.key && (
                      <div style={{ padding: "8px 0 0" }}>
                        {g.rows.map((r, i) => (
                          <div key={i} className="cal-detail-sub" style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                            <span>{r.profileName}{r.sessionIndex ? ` · ${r.sessionIndex}회차` : ""}</span>
                            <span>{won(r.amount)}</span>
                          </div>
                        ))}
                        {g.type === "class" && g.rows[0]?.membershipId && (
                          <button
                            className="primary-btn small"
                            style={{ marginTop: 6 }}
                            onClick={() => openSessionEdit(g.rows[0].membershipId!, g.classTitle)}
                          >
                            이 수강권 회차별 금액 수정
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
          <div style={{ height: 40 }} />
        </>
      )}

      {/* 회차별 금액 편집 모달 */}
      {editTarget && (
        <div className="sheet-overlay" onClick={() => !editSaving && setEditTarget(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">회차별 금액 수정{editTarget.classTitle ? ` — ${editTarget.classTitle}` : ""}</div>
            {editLoading ? (
              <Loading />
            ) : (
              <div style={{ padding: "8px 20px 20px" }}>
                <div className="set-soon-note" style={{ marginBottom: 10 }}>
                  회차 번호(N회차)에 금액을 지정해요 — 실제로 어떤 수업이 N번째가 되는지는
                  예약 순서에 따라 바뀔 수 있고, 그 수업에 이 금액이 그대로 따라가요. 합계는
                  이 수강권의 총 결제금액({won(editPaidTotal)})과 정확히 같아야 저장돼요.
                </div>
                {editAmounts.map((amt, i) => (
                  <div key={i} className="set-row" style={{ padding: "6px 0" }}>
                    <div className="set-label">{i + 1}회차</div>
                    <input
                      type="number" min={0} className="set-num" style={{ width: 90 }}
                      value={amt}
                      onChange={(e) => {
                        const v = Math.max(0, parseInt(e.target.value || "0", 10));
                        setEditAmounts((prev) => prev.map((p, idx) => idx === i ? v : p));
                      }}
                    />
                  </div>
                ))}
                <div className="set-row" style={{ borderTop: "1px solid var(--border, #eee)", marginTop: 8, paddingTop: 8 }}>
                  <div className="set-label">합계</div>
                  <div style={{ color: editValid ? undefined : "#c0392b", fontWeight: 600 }}>
                    {won(editSum)} {editValid ? "" : `(총 결제금액과 ${won(Math.abs(editSum - editPaidTotal))} 차이)`}
                  </div>
                </div>
                <button
                  className="primary-btn"
                  style={{ width: "100%", marginTop: 12 }}
                  disabled={!editValid || editSaving}
                  onClick={saveSessionEdit}
                >
                  {editSaving ? "저장 중" : "저장"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <ManagerNav />
    </div>
  );
}
