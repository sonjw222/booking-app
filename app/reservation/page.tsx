"use client";

/*
  예약 캘린더 화면 - Supabase 실연동 버전
  - 달력: 주말·공휴일만 색상, 수업 있는 날 센터별 점, 내 예약 있는 날 동그라미
  - 센터 휴무일: 날짜 선택 시 리스트 상단 안내
  - 예약/취소 버튼이 실제로 DB에 반영됨 (reservation_functions.sql 필요)

  사전 준비:
  1. Supabase에 schema.sql + reservation_functions.sql 실행
  2. AUTH_SETUP.md 의 RLS 정책 실행 + 로그인 상태여야 함
*/

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Loading from "../components/Loading";
import { useSearchParams, useRouter } from "next/navigation";
import BottomNav from "../components/BottomNav";
import {
  fetchMonthData,
  reserveClass, fetchUsableMemberships, reserveWithMembership, type UsableMembership,
  fetchMyGoodsForCenter,
  cancelReservation,
  fetchMyProfiles,
  type ClassInfo,
  type MyGoods,
  type CenterInfo,
  type CenterHoliday,
  type BookingProfile,
} from "../../lib/reservations";


// 공휴일 (나중에 공휴일 API 또는 테이블로 교체 가능)
const PUBLIC_HOLIDAYS: Record<string, string> = { "2026-07-17": "제헌절" };

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function dateKey(year: number, month: number, day: number) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function buildCalendarGrid(year: number, month: number) {
  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export default function ReservationCalendar() {
  return (
    <Suspense fallback={<Loading />}>
      <ReservationCalendarContent />
    </Suspense>
  );
}

function ReservationCalendarContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const now = new Date();
  const [year, setYear] = useState<number>(now.getFullYear());
  const [month, setMonth] = useState<number>(now.getMonth() + 1);
  const [selectedDay, setSelectedDay] = useState<number>(now.getDate());
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [centers, setCenters] = useState<CenterInfo[]>([]);
  const [centerPick, setCenterPick] = useState<string | null>(null); // 로컬 센터 필터
  const [centerSheet, setCenterSheet] = useState(false);
  // 수강권 선택 시트
  const [passSheet, setPassSheet] = useState<ClassInfo | null>(null);
  const [passList, setPassList] = useState<UsableMembership[]>([]);
  const [passPick, setPassPick] = useState<string | null>(null);
  const [passBusy, setPassBusy] = useState(false);
  const [holidays, setHolidays] = useState<CenterHoliday[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyClassId, setBusyClassId] = useState<string | null>(null);
  // 예약 확인 모달
  const [confirmClass, setConfirmClass] = useState<ClassInfo | null>(null);
  const [confirmGoods, setConfirmGoods] = useState<MyGoods[]>([]);
  const [selectedGoodsId, setSelectedGoodsId] = useState<string | null>(null);
  const [loadingGoods, setLoadingGoods] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<BookingProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);

  const cells = useMemo(() => buildCalendarGrid(year, month), [year, month]);

  // 이전/다음 달 이동
  function goPrevMonth() {
    setMonth((m) => (m === 1 ? 12 : m - 1));
    setYear((y) => (month === 1 ? y - 1 : y));
    setSelectedDay(1);
  }
  function goNextMonth() {
    setMonth((m) => (m === 12 ? 1 : m + 1));
    setYear((y) => (month === 12 ? y + 1 : y));
    setSelectedDay(1);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMonthData(year, month);
      setClasses(data.classes);
      setCenters(data.centers);
      setHolidays(data.holidays);
      // 프로필 목록 (예약 주체 선택용). 대표 프로필을 기본 선택
      const profs = await fetchMyProfiles();
      setProfiles(profs);
      setActiveProfileId((prev) => prev ?? profs.find((p) => p.isPrimary)?.id ?? profs[0]?.id ?? null);
    } catch (e: any) {
      setError(e.message ?? "데이터를 불러오지 못했어요");
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    load();
  }, [load]);

  // 결제 완료 후 "아까 그 수업 예약하러 가기"로 돌아온 경우: 해당 수업 모달 자동 오픈
  const autoOpenDone = useRef(false);
  useEffect(() => {
    if (autoOpenDone.current) return;
    if (loading) return;
    const openClassId = searchParams.get("openClassId");
    const openDate = searchParams.get("openDate");
    if (!openClassId || !openDate) return;
    if (!activeProfileId) return; // 프로필 준비 후

    // openDate(YYYY-MM-DD)에 해당하는 날짜로 이동
    const [y, m, d] = openDate.split("-").map(Number);
    if (y && m && d) {
      if (y !== year || m !== month) { setYear(y); setMonth(m); return; } // 달 바뀌면 재로드 후 다시 시도
      setSelectedDay(d);
    }
    const target = classes.find((c) => c.id === openClassId);
    if (target) {
      autoOpenDone.current = true;
      handleReserve(target);
    }
  }, [loading, classes, activeProfileId, searchParams, year, month]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function handleReserve(cls: ClassInfo) {
    // 예약 확인 모달 열기 (상품 허용 수업이면 보유 상품 로드)
    setConfirmClass(cls);
    setSelectedGoodsId(null);
    setConfirmGoods([]);
    if (cls.allowGoods && activeProfileId) {
      setLoadingGoods(true);
      try {
        const goods = await fetchMyGoodsForCenter(activeProfileId, cls.centerId);
        setConfirmGoods(goods);
      } catch { /* 상품 로드 실패해도 예약은 가능 */ }
      finally { setLoadingGoods(false); }
    }
    // 사용할 수 있는 수강권 (계정 내 다른 프로필 것 포함)
    if (activeProfileId) {
      setPassBusy(true);
      setPassPick(null);
      try {
        const list = await fetchUsableMemberships(cls.id, activeProfileId);
        setPassList(list);
        if (list.length > 0) setPassPick(list[0].membershipId);
      } catch { setPassList([]); }
      finally { setPassBusy(false); }
    }
  }

  async function doReserve() {
    const cls = confirmClass;
    if (!cls) return;
    setBusyClassId(cls.id);
    try {
      const status = passPick
        ? await reserveWithMembership(cls.id, activeProfileId!, passPick)
        : await reserveClass(cls.id, activeProfileId, selectedGoodsId);
      const who = profiles.find((p) => p.id === activeProfileId);
      const prefix = who && !who.isPrimary ? `${who.name} · ` : "";
      showToast(prefix + (status === "confirmed" ? "예약이 완료됐어요!" : "정원이 차서 대기 등록됐어요"));
      setConfirmClass(null);
      await load();
    } catch (e: any) {
      showToast(e.message);
    } finally {
      setBusyClassId(null);
    }
  }

  async function handleCancel(cls: ClassInfo) {
    const mine = activeProfileId ? cls.myByProfile[activeProfileId] : undefined;
    if (!mine) return;
    if (!confirm("이 수업 예약을 취소할까요?")) return;
    setBusyClassId(cls.id);
    try {
      await cancelReservation(mine.reservationId);
      showToast("예약이 취소됐어요");
      await load();
    } catch (e: any) {
      showToast(e.message);
    } finally {
      setBusyClassId(null);
    }
  }

  // 날짜별 점/예약 표시 계산
  const { dotsByDay, bookedDays } = useMemo(() => {
    const dots: Record<string, string[]> = {};
    const booked: Record<string, boolean> = {};
    for (const cls of classes) {
      const center = centers.find((c) => c.id === cls.centerId);
      if (!center) continue;
      if (!dots[cls.date]) dots[cls.date] = [];
      if (!dots[cls.date].includes(center.color)) dots[cls.date].push(center.color);
      // 어느 프로필이든 예약이 있으면 그 날 동그라미 표시
      if (Object.keys(cls.myByProfile).length > 0) booked[cls.date] = true;
    }
    return { dotsByDay: dots, bookedDays: booked };
  }, [classes, centers]);

  const centerFilter = searchParams.get("center");
  const categoryFilter = searchParams.get("category");
  const filteredCenterName = centerFilter ? centers.find((c) => c.id === centerFilter)?.name : null;
  // 카테고리 필터 시 해당 종목 센터들의 id 집합
  const categoryCenterIds = categoryFilter
    ? new Set(centers.filter((c) => c.categories.includes(categoryFilter)).map((c) => c.id))
    : null;

  const selectedKey = dateKey(year, month, selectedDay);
  const publicHoliday = PUBLIC_HOLIDAYS[selectedKey];
  const centerHolidays = holidays.filter((h) => h.date === selectedKey);
  const effectiveCenter = centerPick ?? centerFilter;
  const dayClasses = classes
    .filter((c) => c.date === selectedKey)
    .filter((c) => !effectiveCenter || c.centerId === effectiveCenter)
    .filter((c) => !categoryCenterIds || categoryCenterIds.has(c.centerId))
    .sort((a, b) => a.start.localeCompare(b.start));

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
          <div className="holiday-chip">
            <span className="hc-dot" />
            {error}
          </div>
        </div>
        <div style={{ padding: 20 }}>
          <button className="primary-btn" onClick={load}>다시 시도</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      {centers.length > 1 && (
        <div className="resv-top-bar">
          <div className="resv-top-title">예약</div>
          <button className="resv-center-pick" onClick={() => setCenterSheet(true)}>
            {effectiveCenter ? (centers.find((c) => c.id === effectiveCenter)?.name ?? "센터") : "전체 센터"}
          </button>
        </div>
      )}

      {centerSheet && (
        <div className="sheet-overlay" onClick={() => setCenterSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">센터 선택</div>
            <button className={`filter-chip ${!effectiveCenter ? "on" : ""}`} style={{ width: "100%", marginBottom: 6 }}
              onClick={() => { setCenterPick(null); setCenterSheet(false); }}>전체 센터</button>
            {centers.map((c) => (
              <button key={c.id} className={`filter-chip ${effectiveCenter === c.id ? "on" : ""}`} style={{ width: "100%", marginBottom: 6 }}
                onClick={() => { setCenterPick(c.id); setCenterSheet(false); }}>{c.name}</button>
            ))}
            <button className="ghost-btn" style={{ width: "100%", marginTop: 6 }} onClick={() => setCenterSheet(false)}>닫기</button>
          </div>
        </div>
      )}

      {centerFilter && filteredCenterName && (
        <div className="center-filter-banner">
          <span>📍 {filteredCenterName} 수업만 보는 중</span>
          <a href="/reservation" className="center-filter-clear">전체 보기</a>
        </div>
      )}

      {categoryFilter && (
        <div className="center-filter-banner">
          <span>🏷️ {categoryFilter} 수업만 보는 중{categoryCenterIds && categoryCenterIds.size === 0 ? " (해당 종목 센터 없음)" : ""}</span>
          <a href="/reservation" className="center-filter-clear">전체 보기</a>
        </div>
      )}

      <div className="cal-header">
        <div className="cal-month-nav">
          <button className="cal-nav-btn" onClick={goPrevMonth}>‹</button>
          <div className="cal-title">{year}.{pad(month)}</div>
          <button className="cal-nav-btn" onClick={goNextMonth}>›</button>
        </div>
        <div className="cal-legend">
          {centers.map((c) => (
            <span key={c.id} className="legend-item">
              <span className="legend-dot" style={{ background: c.color }} />
              {c.name}
            </span>
          ))}
        </div>
      </div>

      <div className="cal-grid cal-weekdays">
        {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
          <div key={d} className={`cal-weekday ${i === 0 ? "sun" : ""} ${i === 6 ? "sat" : ""}`}>
            {d}
          </div>
        ))}
      </div>

      <div className="cal-grid">
        {cells.map((day, i) => {
          if (day === null) return <div key={i} className="cal-cell empty" />;
          const key = dateKey(year, month, day);
          const dow = new Date(year, month - 1, day).getDay();
          const dots = dotsByDay[key] || [];
          const classNames = ["cal-cell"];
          if (day === selectedDay) classNames.push("selected");
          if (dow === 0 || PUBLIC_HOLIDAYS[key]) classNames.push("sun");
          else if (dow === 6) classNames.push("sat");
          if (bookedDays[key]) classNames.push("booked");
          return (
            <button key={i} className={classNames.join(" ")} onClick={() => setSelectedDay(day)}>
              <span className="daynum-wrap">
                <span className="cal-daynum">{day}</span>
              </span>
              <span className="cal-dots">
                {dots.map((color) => (
                  <span key={color} className="cal-dot" style={{ background: color }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <div className="daylist-header">
        {pad(month)}.{pad(selectedDay)} 수업
        {publicHoliday && <span className="pub-badge">{publicHoliday}</span>}
      </div>

      {/* 예약 주체 선택: 프로필이 2개 이상일 때만 표시 (자녀 대신 예약 등) */}
      {profiles.length > 1 && (
        <div className="profile-picker">
          <span className="profile-picker-label">프로필:</span>
          <div className="profile-picker-chips">
            {profiles.map((p) => (
              <button
                key={p.id}
                className={`center-chip ${p.id === activeProfileId ? "on" : ""}`}
                onClick={() => setActiveProfileId(p.id)}
              >
                {p.name}{p.isPrimary ? " (나)" : p.label ? ` · ${p.label}` : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {centerHolidays.length > 0 && (
        <div className="holiday-notice">
          {centerHolidays.map((h, idx) => {
            const center = centers.find((c) => c.id === h.centerId);
            return (
              <div key={idx} className="holiday-chip">
                <span className="hc-dot" />
                {center?.name ?? "센터"} 휴무일{h.reason ? ` (${h.reason})` : ""}
              </div>
            );
          })}
        </div>
      )}

      <div className="daylist">
        {dayClasses.length === 0 ? (
          <div className="daylist-empty">
            {centerHolidays.length > 0 ? "선택한 센터는 휴무일이에요" : "이 날은 예약 가능한 수업이 없어요"}
          </div>
        ) : (
          dayClasses.map((cls) => {
            const center = centers.find((c) => c.id === cls.centerId);
            const full = cls.reserved >= cls.capacity;
            // 지금 선택된 프로필 기준으로 내 예약 상태 판단
            const mineRec = activeProfileId ? cls.myByProfile[activeProfileId] : undefined;
            const mine = !!mineRec;
            const busy = busyClassId === cls.id;
            return (
              <div key={cls.id} className={`class-row ${mine ? "mine" : ""}`}>
                <div className="class-color" style={{ background: center?.color }} />
                <div className="class-info">
                  <div className="class-row-title">
                    {cls.title}
                    {mineRec?.status === "confirmed" && <span className="booked-tag">내 예약</span>}
                    {mineRec?.status === "waitlisted" && <span className="booked-tag">대기중</span>}
                  </div>
                  <div className="class-row-meta">
                    {cls.start}~{cls.end}
                  </div>
                  <div className="class-row-place">{cls.place}</div>
                </div>
                <div className="class-right">
                  <div className={`class-count ${full ? "full" : ""}`}>
                    예약 {cls.reserved}/{cls.capacity}
                  </div>
                  {mine ? (
                    <button className="mini-btn done" disabled={busy} onClick={() => handleCancel(cls)}>
                      {busy ? "..." : "취소"}
                    </button>
                  ) : (
                    <button
                      className={`mini-btn ${full ? "wait" : ""}`}
                      disabled={busy}
                      onClick={() => handleReserve(cls)}
                    >
                      {busy ? "..." : full ? "대기" : "예약"}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
      {/* 예약 확인 모달 */}
      {confirmClass && (
        <div className="sheet-overlay" onClick={() => setConfirmClass(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">예약하시겠어요?</div>

            {/* 사용할 수강권 선택 (계정 내 공유) */}
            {passBusy ? (
              <div className="perm-guide" style={{ margin: "0 0 10px" }}>수강권 확인 중...</div>
            ) : passList.length > 0 ? (
              <>
                <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>사용할 수강권</div>
                <div className="pass-pick-list">
                  {passList.map((m) => (
                    <button key={m.membershipId}
                      className={`pass-pick-row ${passPick === m.membershipId ? "on" : ""}`}
                      onClick={() => setPassPick(m.membershipId)}>
                      <span className="pass-pick-main">
                        <b>{m.productName}</b>
                        <span className="pass-pick-sub">
                          {m.remainingCount}회 남음 · ~{m.expiresAt?.slice(5).replace("-", "/")}
                          {!m.isMine && m.ownerProfile && <> · {m.ownerProfile} 보유</>}
                        </span>
                      </span>
                      <span className="pass-pick-check">{passPick === m.membershipId ? "●" : "○"}</span>
                    </button>
                  ))}
                </div>
                <div className="perm-guide" style={{ margin: "6px 0 0" }}>
                  수강권 하나는 <b>한 프로필만</b> 사용할 수 있어요.
                  아직 사용하지 않은 수강권은 어느 프로필이든 쓸 수 있지만,
                  한 번 사용하면 그 프로필 전용이 돼요.
                </div>
              </>
            ) : (
              <div className="no-pass-row">
                <div className="perm-guide" style={{ margin: 0 }}>
                  이 수업에 쓸 수 있는 수강권이 없어요.
                </div>
                <button
                  className="no-pass-buy-btn"
                  onClick={() => {
                    const c = confirmClass;
                    if (!c) return;
                    router.push(
                      `/center/${c.centerId}?buy=1&reserveClassId=${c.id}&reserveDate=${encodeURIComponent(c.date)}`
                    );
                  }}
                >
                  수강권 구매하기
                </button>
              </div>
            )}
            <div className="confirm-class" style={{ marginTop: 18 }}>
              <div className="confirm-class-title">{confirmClass.title}</div>
              <div className="confirm-class-sub">{confirmClass.place} · {confirmClass.date} {confirmClass.start}</div>
            </div>

            {confirmClass.allowGoods && (
              <>
                <div className="menu-section-label" style={{ padding: "8px 0 6px" }}>보유 상품 사용 (선택)</div>
                {loadingGoods ? (
                  <div className="perm-guide" style={{ margin: 0 }}>상품 불러오는 중...</div>
                ) : confirmGoods.length === 0 ? (
                  <div className="perm-guide" style={{ margin: 0 }}>사용 가능한 상품이 없어요</div>
                ) : (
                  <div className="goods-select-list">
                    <button className={`goods-select ${selectedGoodsId === null ? "on" : ""}`} onClick={() => setSelectedGoodsId(null)}>
                      <span>사용 안 함</span>
                    </button>
                    {confirmGoods.map((g) => (
                      <button key={g.id} className={`goods-select ${selectedGoodsId === g.id ? "on" : ""}`} onClick={() => setSelectedGoodsId(g.id)}>
                        <span>{g.name}</span>
                        <span className="goods-remain">{g.unlimited ? "무제한" : `${g.remaining}회 남음`}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setConfirmClass(null)}>취소</button>
              <button className="primary-btn" disabled={busyClassId === confirmClass.id} onClick={doReserve}>
                {busyClassId === confirmClass.id ? "예약 중..." : "예약하기"}
              </button>
            </div>
          </div>
        </div>
      )}

      <BottomNav />
    </div>
  );
}
