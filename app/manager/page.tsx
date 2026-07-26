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
import ManagerNav from "../components/ManagerNav";
import { fetchMyCenters, fetchTodayClasses, type ManagedCenter, type TodayClass } from "../../lib/manager";
import { fetchClassAttendees, setAttendance, type ClassAttendee } from "../../lib/classes";
import { fetchMemberDetail, type MemberDetailData } from "../../lib/members";

export default function ManagerDashboard() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [activeCenterId, setActiveCenterId] = useState<string | null>(null);
  const [todayClasses, setTodayClasses] = useState<TodayClass[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 예약자 명단 / 회원 정보
  const [rosterClass, setRosterClass] = useState<TodayClass | null>(null);
  const [roster, setRoster] = useState<ClassAttendee[]>([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [memberInfo, setMemberInfo] = useState<{ name: string; profileId: string; data: MemberDetailData | null } | null>(null);
  const [attBusy, setAttBusy] = useState(false);

  // 출결 처리 (출석/결석/노쇼/예약취소) — 취소는 되돌릴 수 없음
  async function handleAttendance(a: ClassAttendee, status: "attended" | "no_show" | "confirmed" | "cancelled") {
    if (a.status === "cancelled") {
      setError("이미 취소된 예약이라 출결 상태를 바꿀 수 없어요");
      return;
    }
    if (status === "cancelled") {
      const ok = confirm(
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

  const activeCenter = centers.find((c) => c.id === activeCenterId);

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
    <div className="app-shell">
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
      <a className="list-row" href="/manager/membership-rules">
        <div className="left"><span className="icon">🎫</span>수강권 관리</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/manager/goods">
        <div className="left"><span className="icon">🎽</span>상품 관리</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/manager/progress/record">
        <div className="left"><span className="icon">📈</span>회원 진도 기록</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/manager/staff">
        <div className="left"><span className="icon">🔑</span>스태프 & 권한</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/manager/sales">
        <div className="left"><span className="icon">💰</span>매출 관리</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/manager/announcements">
        <div className="left"><span className="icon">📢</span>공지사항</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/manager/inquiries">
        <div className="left"><span className="icon">💬</span>1:1 문의</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/manager/reviews">
        <div className="left"><span className="icon">⭐</span>후기 관리</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/manager/orders">
        <div className="left"><span className="icon">🧾</span>주문 관리 (수강권·상품 구매)</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/manager/center-info">
        <div className="left"><span className="icon">🏢</span>센터 정보</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/manager/rooms">
        <div className="left"><span className="icon">🚪</span>룸(장소) 관리</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/manager/settings">
        <div className="left"><span className="icon">⚙️</span>운영 설정</div>
        <span className="chevron">›</span>
      </a>

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
                          <button className={`att-btn ${a.status === "attended" ? "on" : ""}`} disabled={attBusy}
                            onClick={() => handleAttendance(a, "attended")}>출석</button>
                          <button className={`att-btn ${a.status === "confirmed" ? "on" : ""}`} disabled={attBusy}
                            onClick={() => handleAttendance(a, "confirmed")}>결석</button>
                          <button className={`att-btn ${a.status === "no_show" ? "on" : ""}`} disabled={attBusy}
                            onClick={() => handleAttendance(a, "no_show")}>노쇼</button>
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
      <ManagerNav />
    </div>
  );
}
