"use client";

/*
  매니저 대시보드 (매니저 모드 홈)
  - 내가 운영하는 센터 선택 (여러 개면 전환)
  - 오늘 수업 + 예약 현황 요약
  - 관리 메뉴: 수업/수강권조건/진도표/회원 (일부는 다음 단계에서 실연동)
  - "회원 모드로 전환" → 홈으로
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../components/Loading";
import UiIcon from "../components/UiIcon";
import { fetchMyCenters, fetchTodayClasses, type ManagedCenter, type TodayClass } from "../../lib/manager";
import { fetchClassAttendees, setAttendance, type ClassAttendee } from "../../lib/classes";
import { fetchMemberDetail, type MemberDetailData } from "../../lib/members";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../lib/roles";
import { fetchDashboardSummary, won, type DashboardSummary } from "../../lib/sales";

type DashPeriod = "today" | "7d" | "30d";

function kstToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}
function kstDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
}
function dashRangeFor(period: DashPeriod): { from: string; to: string } {
  const to = kstToday();
  if (period === "today") return { from: to, to };
  if (period === "7d") return { from: kstDaysAgo(6), to };
  return { from: kstDaysAgo(29), to };
}

export default function ManagerDashboard() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [activeCenterId, setActiveCenterId] = useState<string | null>(null);
  const [todayClasses, setTodayClasses] = useState<TodayClass[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 메뉴 노출용 유효 권한 (오너는 전권이라 계산하지 않음 — null이면 "아직 로딩중")
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);
  // 예약자 명단 / 회원 정보
  const [rosterClass, setRosterClass] = useState<TodayClass | null>(null);
  const [roster, setRoster] = useState<ClassAttendee[]>([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [memberInfo, setMemberInfo] = useState<{ name: string; profileId: string; data: MemberDetailData | null } | null>(null);
  const [attBusy, setAttBusy] = useState(false);
  // 매출 요약 대시보드 (P4)
  const [dashPeriod, setDashPeriod] = useState<DashPeriod>("today");
  const [dash, setDash] = useState<DashboardSummary | null>(null);
  const [dashLoading, setDashLoading] = useState(false);
  const [dashError, setDashError] = useState<string | null>(null);

  // 출결 처리 (출석/결석/노쇼/예약취소) — 취소는 되돌릴 수 없음
  async function handleAttendance(a: ClassAttendee, status: "attended" | "no_show" | "confirmed" | "cancelled") {
    if (a.status === "cancelled") {
      setError("이미 취소된 예약이라 출결 상태를 바꿀 수 없어요");
      return;
    }
    if (status === "cancelled") {
      const ok = await globalThis.appConfirm(
        `${a.name}님의 예약을 취소할까요?\n\n` +
        `· 사용한 수강권 횟수가 1회 복구돼요\n` +
        `· 취소 후에는 출석·결석·노쇼로 되돌릴 수 없어요\n\n` +
        `정말 취소하시겠어요?`
      );
      if (!ok) return;
    }
    setAttBusy(true);
    try {
      await setAttendance(a.reservationId, status);
      if (rosterClass) setRoster(await fetchClassAttendees(rosterClass.id));
      // 예약 n/N 숫자 즉시 반영
      if (activeCenterId) setTodayClasses(await fetchTodayClasses(activeCenterId));
    } catch (e: any) { setError(e.message); }
    finally { setAttBusy(false); }
  }

  async function openRoster(cls: TodayClass) {
    setRosterClass(cls);
    setRoster([]);
    setRosterLoading(true);
    try {
      setRoster(await fetchClassAttendees(cls.id));
    } catch (e: any) {
      // 실패 시 빈 명단이 "예약자 없음"으로 오인되지 않도록 시트를 닫고 상단 에러로만 알린다.
      setRosterClass(null);
      setError(e.message);
    } finally {
      setRosterLoading(false);
    }
  }

  async function openMemberInfo(a: ClassAttendee) {
    setMemberInfo({ name: a.name, profileId: a.profileId, data: null });
    try {
      const data = await fetchMemberDetail(a.profileId);
      setMemberInfo({ name: a.name, profileId: a.profileId, data });
    } catch (e: any) {
      // 실패 시 로딩 스피너가 무한히 남지 않도록 시트를 닫고 상단 에러로만 알린다.
      setMemberInfo(null);
      setError(e.message);
    }
  }

  const loadCenters = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchMyCenters();
      setCenters(list);
      if (list.length > 0) setActiveCenterId(list[0].id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCenters();
  }, [loadCenters]);

  useEffect(() => {
    if (!activeCenterId) return;
    fetchTodayClasses(activeCenterId)
      .then(setTodayClasses)
      .catch((e) => setError(e.message));
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return;
    let cancelled = false;
    setDashLoading(true);
    setDashError(null);
    const { from, to } = dashRangeFor(dashPeriod);
    fetchDashboardSummary(activeCenterId, from, to)
      .then((d) => { if (!cancelled) setDash(d); })
      .catch((e) => { if (!cancelled) setDashError(e.message); })
      .finally(() => { if (!cancelled) setDashLoading(false); });
    return () => { cancelled = true; };
  }, [activeCenterId, dashPeriod]);

  const activeCenter = centers.find((c) => c.id === activeCenterId);

  // 활성 센터의 메뉴 노출용 권한 계산 (오너는 전권이라 건너뜀)
  useEffect(() => {
    if (!activeCenter) return;
    if (activeCenter.isOwner) { setMyPerms(null); return; }
    let cancelled = false;
    setMyPerms(null);
    fetchMyEffectivePermissionKeys(activeCenter.managerCenterId, activeCenter.roleId)
      .then((keys) => { if (!cancelled) setMyPerms(keys); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [activeCenter]);

  // 메뉴 노출 가능 여부: 오너면 전권, 아니면 계산된 유효 권한에 포함될 때만.
  function canSeeMenu(permissionKey: string): boolean {
    return canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, permissionKey);
  }

  if (loading) {
    return (
      <div className="app-shell">
        <Loading />
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-shell">
        <div className="holiday-notice" style={{ marginTop: 60 }}>
          <div className="holiday-chip"><span className="hc-dot" />{error}</div>
        </div>
        <div style={{ padding: 20 }}>
          <a className="primary-btn" href="/mypage">마이페이지로</a>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell manager-home-v2">
      {/* 매니저 모드 헤더 */}
      <div className="mgr-mode-bar">
        <span className="mgr-mode-label">🏢 관리자 모드</span>
        <a className="mgr-mode-switch" href="/">회원 모드로 전환 ↩</a>
      </div>

      {/* 센터 선택 (여러 센터 운영 시) */}
      <div className="center-switcher">
        {centers.map((c) => (
          <button
            key={c.id}
            className={`center-chip ${c.id === activeCenterId ? "on" : ""}`}
            onClick={() => setActiveCenterId(c.id)}
          >
            {c.name}
            <span className="center-role">{c.roleName}</span>
          </button>
        ))}
      </div>

      <section className="manager-today-overview">
        <div className="manager-today-head">
          <div><span>오늘 할 일</span><b>{new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</b></div>
          <a href="/manager/classes">수업 관리 ›</a>
        </div>
        <div className="manager-today-metrics">
          <a href="/manager/classes"><span>오늘 수업</span><b>{todayClasses.length}</b></a>
          <a href="/manager/classes"><span>예약 인원</span><b>{todayClasses.reduce((sum, item) => sum + item.reserved, 0)}</b></a>
          <a href="/manager/classes"><span>마감 수업</span><b>{todayClasses.filter((item) => item.reserved >= item.capacity).length}</b></a>
        </div>
        <div className="manager-today-actions">
          {canSeeMenu("board.inquiry.view") && (
            <a href="/manager/inquiries"><UiIcon name="message" size={17} />문의 확인</a>
          )}
          {canSeeMenu("pass.order.view") && (
            <a href="/manager/orders"><UiIcon name="receipt" size={17} />주문 확인</a>
          )}
          {canSeeMenu("schedule.admin_assignment_log.view") && (
            <a href="/manager/admin-assignments"><UiIcon name="users" size={17} />회원 배치</a>
          )}
        </div>
      </section>

      {/* 매출 요약 대시보드 */}
      {canSeeMenu("pass.sales.view") && (
        <>
          <div className="period-tabs">
            {([["today", "오늘"], ["7d", "7일"], ["30d", "30일"]] as [DashPeriod, string][]).map(([p, label]) => (
              <button key={p} className={`period-chip ${dashPeriod === p ? "on" : ""}`} onClick={() => setDashPeriod(p)}>
                {label}
              </button>
            ))}
          </div>
          {dashLoading ? (
            <Loading />
          ) : dashError ? (
            <div className="daylist-empty" style={{ margin: "0 20px 14px" }}>매출 통계를 불러오지 못했어요: {dashError}</div>
          ) : dash ? (
            <>
              <div className="dash-cards">
                <div className="dash-card">
                  <div className="dash-card-label">오늘 매출</div>
                  <div className="dash-card-value">{won(dash.todayRevenue)}</div>
                </div>
                <div className="dash-card">
                  <div className="dash-card-label">이번 달 매출</div>
                  <div className="dash-card-value">{won(dash.monthRevenue)}</div>
                </div>
                <div className="dash-card">
                  <div className="dash-card-label">기간 매출 · {dash.periodPaymentCount}건</div>
                  <div className="dash-card-value">{won(dash.periodRevenue)}</div>
                </div>
                <div className="dash-card">
                  <div className="dash-card-label">미수금</div>
                  <div className="dash-card-value">{won(dash.unpaidTotal)}</div>
                </div>
                <div className="dash-card">
                  <div className="dash-card-label">수강권 매출</div>
                  <div className="dash-card-value">{won(dash.periodMembershipRevenue)}</div>
                </div>
                <div className="dash-card">
                  <div className="dash-card-label">상품 매출</div>
                  <div className="dash-card-value">{won(dash.periodGoodsRevenue)}</div>
                </div>
              </div>
              {dash.daily.length > 1 && (
                <div className="dash-daily">
                  {(() => {
                    const max = Math.max(1, ...dash.daily.map((d) => d.revenue));
                    return dash.daily.map((d) => (
                      <div
                        key={d.date}
                        className={`dash-daily-bar ${d.revenue > 0 ? "has-value" : ""}`}
                        style={{ height: `${Math.max(2, Math.round((d.revenue / max) * 100))}%` }}
                        title={`${d.date} · ${won(d.revenue)}`}
                      />
                    ));
                  })()}
                </div>
              )}
            </>
          ) : null}
        </>
      )}

      {/* 오늘 수업 요약 */}
      <div className="section-title" style={{ paddingTop: 8 }}>
        오늘 수업 {todayClasses.length > 0 && <span className="info">({todayClasses.length}개)</span>}
      </div>
      <div className="daylist" style={{ minHeight: 0 }}>
        {todayClasses.length === 0 ? (
          <div className="daylist-empty">오늘 등록된 수업이 없어요</div>
        ) : (
          todayClasses.map((cls) => {
            const full = cls.reserved >= cls.capacity;
            return (
              <div key={cls.id} className="class-row">
                <div className="class-color" style={{ background: "var(--accent)" }} />
                <div className="class-info">
                  <div className="class-row-title">{cls.title}</div>
                  <div className="class-row-meta">{cls.start}~{cls.end}</div>
                </div>
                <div className="class-right">
                  <button type="button" className={`class-count clickable ${full ? "full" : ""}`} onClick={() => openRoster(cls)}>
                    예약 {cls.reserved}/{cls.capacity} ›
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 관리 메뉴 */}
      <div className="menu-section-label">{activeCenter?.name ?? "센터"} 관리</div>
      {canSeeMenu("pass.create") && (
        <a className="list-row" href="/manager/membership-rules">
          <div className="left"><span className="icon"><UiIcon name="ticket" /></span>수강권 관리</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("pass.goods.view") && (
        <a className="list-row" href="/manager/goods">
          <div className="left"><span className="icon"><UiIcon name="receipt" /></span>상품 관리</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("customer.progress") && (
        <a className="list-row" href="/manager/progress/record">
          <div className="left"><span className="icon"><UiIcon name="edit" /></span>회원 진도 기록</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("customer.lead.view") && (
        <a className="list-row" href="/manager/leads">
          <div className="left"><span className="icon"><UiIcon name="message" /></span>상담고객 관리</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("facility.staff.view") && (
        <a className="list-row" href="/manager/staff">
          <div className="left"><span className="icon"><UiIcon name="shield" /></span>스태프 & 권한</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("pass.sales.view") && (
        <a className="list-row" href="/manager/sales">
          <div className="left"><span className="icon"><UiIcon name="receipt" /></span>매출 관리</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("board.notice.view") && (
        <a className="list-row" href="/manager/announcements">
          <div className="left"><span className="icon"><UiIcon name="megaphone" /></span>공지사항</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("board.inquiry.view") && (
        <a className="list-row" href="/manager/inquiries">
          <div className="left"><span className="icon"><UiIcon name="message" /></span>1:1 문의</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("facility.review.view") && (
        <a className="list-row" href="/manager/reviews">
          <div className="left"><span className="icon"><UiIcon name="star" /></span>후기 관리</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("pass.order.view") && (
        <a className="list-row" href="/manager/orders">
          <div className="left"><span className="icon"><UiIcon name="receipt" /></span>주문 관리 (수강권·상품 구매)</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("schedule.admin_assignment_log.view") && (
        <a className="list-row" href="/manager/admin-assignments">
          <div className="left"><span className="icon"><UiIcon name="users" /></span>관리자 배치 내역</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("facility.info") && (
        <a className="list-row" href="/manager/center-info">
          <div className="left"><span className="icon"><UiIcon name="building" /></span>센터 정보</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("facility.room") && (
        <a className="list-row" href="/manager/rooms">
          <div className="left"><span className="icon"><UiIcon name="grid" /></span>룸(장소) 관리</div>
          <span className="chevron">›</span>
        </a>
      )}
      {canSeeMenu("facility.operation") && (
        <a className="list-row" href="/manager/settings">
          <div className="left"><span className="icon"><UiIcon name="settings" /></span>운영 설정</div>
          <span className="chevron">›</span>
        </a>
      )}
      <div className="manager-menu-end-spacer" aria-hidden="true" />

      {/* 예약자 명단 시트 */}
      {rosterClass && (
        <div className="sheet-overlay" onClick={() => setRosterClass(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{rosterClass.title} 예약자</div>
            <div className="hist-summary" style={{ padding: "0 0 8px" }}>
              {rosterClass.start}~{rosterClass.end}
            </div>
            <div className="mem-detail-list">
              {rosterLoading ? (
                <Loading />
              ) : roster.length === 0 ? (
                <div className="daylist-empty" style={{ padding: 16 }}>예약자가 없어요</div>
              ) : (
                roster.map((a) => (
                  <div key={a.reservationId} className="roster-item">
                    <div className="roster-head">
                      <button className="roster-name-btn" onClick={() => openMemberInfo(a)}>
                        {a.name}
                        {a.status === "waitlisted" && a.waitlistOrder != null && <span className="roster-wait"> 대기{a.waitlistOrder}</span>}
                      </button>
                      <span className={`hist-status s-${a.status}`}>
                        {a.status === "confirmed" ? "확정" : a.status === "waitlisted" ? "대기"
                          : a.status === "attended" ? "출석" : a.status === "no_show" ? "노쇼" : "취소"}
                      </span>
                    </div>
                    <div className="roster-actions">
                      {a.status === "cancelled" ? (
                        <span className="att-locked">취소된 예약 · 변경 불가</span>
                      ) : (
                        <>
                          {/* 대기(waitlisted)는 아직 확정된 적이 없어 출석/결석을 매길 대상이 아니다 —
                              manager_set_attendance()도 이 상태에선 attended/no_show를 거부한다
                              (fix_attendance_consolidate_and_guard). 대기 취소만 남겨둔다. */}
                          {a.status !== "waitlisted" && (
                            <>
                              <button className={`att-btn ${a.status === "attended" ? "on" : ""}`} disabled={attBusy}
                                onClick={() => handleAttendance(a, "attended")}>출석</button>
                              {/* "결석" 버튼은 실제로는 status를 confirmed로 되돌려 표시를 취소하는
                                  동작이다(결석이라는 별도 상태는 없음) — 실제 결석 처리는 "결석(노쇼)". */}
                              <button className={`att-btn ${a.status === "confirmed" ? "on" : ""}`} disabled={attBusy}
                                onClick={() => handleAttendance(a, "confirmed")}>되돌리기</button>
                              <button className={`att-btn ${a.status === "no_show" ? "on" : ""}`} disabled={attBusy}
                                onClick={() => handleAttendance(a, "no_show")}>결석(노쇼)</button>
                            </>
                          )}
                          <button className="att-btn cancel" disabled={attBusy}
                            onClick={() => handleAttendance(a, "cancelled")}>예약취소</button>
                        </>
                      )}
                      <a className="att-btn prog" href={`/manager/progress/record?profile=${a.profileId}`}>진도</a>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="add-profile-actions" style={{ marginTop: 6 }}>
              <button className="ghost-btn" onClick={() => setRosterClass(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* 회원 정보 팝업 */}
      {memberInfo && (
        <div className="sheet-overlay" onClick={() => setMemberInfo(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{memberInfo.name}</div>
            {!memberInfo.data ? (
              <Loading />
            ) : (
              <>
                {memberInfo.data.activePasses.length > 0 && (
                  <div className="mem-pass-summary">
                    {memberInfo.data.activePasses.map((p) => (
                      <div key={p.id} className="mem-pass-chip">
                        {p.name}{p.remaining != null ? ` · ${p.remaining}회` : ""} <span className="mem-pass-exp">~{p.expiresAt}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>최근 예약</div>
                <div className="mem-detail-list" style={{ maxHeight: 200 }}>
                  {memberInfo.data.reservations.length === 0 ? (
                    <div className="daylist-empty" style={{ padding: 12 }}>예약 내역이 없어요</div>
                  ) : (
                    memberInfo.data.reservations.slice(0, 10).map((r) => (
                      <div key={r.id} className="mem-detail-row">
                        <span className="mem-detail-date">{r.date}</span>
                        <span className="mem-detail-main">{r.title}</span>
                      </div>
                    ))
                  )}
                </div>
                <a className="primary-btn" href={`/manager/members?profile=${memberInfo.profileId}`} style={{ marginTop: 10, display: "block", textAlign: "center" }}>회원 관리에서 전체 보기</a>
              </>
            )}
            <div className="add-profile-actions" style={{ marginTop: 6 }}>
              <button className="ghost-btn" onClick={() => setMemberInfo(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
