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

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Loading from "../components/Loading";
import { useSearchParams, useRouter } from "next/navigation";
import BottomNav from "../components/BottomNav";
import {
  fetchMonthData,
  reserveClass, fetchUsableMembershipsByClass, reserveWithMembership, type UsableMembership,
  fetchMyGoodsByCenter,
  fetchPurchasableProductsByClass, type PurchasableProduct,
  cancelReservation,
  fetchMyProfiles,
  getMyAccountId,
  type ClassInfo,
  type MyGoods,
  type CenterInfo,
  type CenterHoliday,
  type BookingProfile,
} from "../../lib/reservations";
import { toKstIso } from "../../lib/kst";
import { formatInstructorNames } from "../../lib/instructorDisplay";
import UiIcon from "../components/UiIcon";
import SegmentedTabs from "../components/SegmentedTabs";
import { PUBLIC_HOLIDAYS } from "../../lib/publicHolidays";

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

// 사용 가능한 수강권이 여러 개일 때 기본으로 선택해줄 것을 고르는 우선순위
// 1) 만료일이 가장 가까운 것 → 2) 만료일이 같으면 잔여횟수가 가장 적은 것 → 3) 그 외엔 조회된 순서 그대로(안정 정렬)
// 어디까지나 "기본 선택"일 뿐이며, 사용자는 pass-pick-list에서 언제든 다른 수강권을 직접 고를 수 있음
function pickDefaultMembership(list: UsableMembership[]): string | null {
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => {
    if (a.expiresAt !== b.expiresAt) return a.expiresAt < b.expiresAt ? -1 : 1;
    return a.remainingCount - b.remainingCount;
  });
  return sorted[0].membershipId;
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
  const [timeFilter, setTimeFilter] = useState<"all" | "morning" | "afternoon" | "evening">("all");
  const [availableOnly, setAvailableOnly] = useState(false);
  const [year, setYear] = useState<number>(now.getFullYear());
  const [month, setMonth] = useState<number>(now.getMonth() + 1);
  const [selectedDay, setSelectedDay] = useState<number>(now.getDate());
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [centers, setCenters] = useState<CenterInfo[]>([]);
  const [centerPick, setCenterPick] = useState<string | null>(null); // 로컬 센터 필터
  const [centerSheet, setCenterSheet] = useState(false);
  // 수강권 선택 시트
  const [passSheet, setPassSheet] = useState<ClassInfo | null>(null);
  const [passPick, setPassPick] = useState<string | null>(null);
  // 선택된 날짜의 수업들에 대해 "사용 가능한 수강권"을 한 번에 조회한 결과 (classId -> 목록)
  const [usablePassesByClass, setUsablePassesByClass] = useState<Record<string, UsableMembership[]>>({});
  const [passesLoading, setPassesLoading] = useState(false);
  const passesReqRef = useRef(0);
  // 선택된 날짜의 수업들이 속한 센터별로 보유 상품(goods)을 한 번에 조회한 결과 (centerId -> 목록)
  const [goodsByCenter, setGoodsByCenter] = useState<Record<string, MyGoods[]>>({});
  const [goodsLoading, setGoodsLoading] = useState(false);
  const goodsReqRef = useRef(0);
  // 예약 모달에서 "사용 가능한 수강권 없음"일 때 보여줄, 구매하면 쓸 수 있는 상품 목록 (classId -> 목록)
  const [purchasableByClass, setPurchasableByClass] = useState<Record<string, PurchasableProduct[]>>({});
  const [purchasableLoading, setPurchasableLoading] = useState(false);
  const purchasableReqRef = useRef(0);
  const [holidays, setHolidays] = useState<CenterHoliday[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyClassId, setBusyClassId] = useState<string | null>(null);
  // 예약 확인 모달
  const [confirmClass, setConfirmClass] = useState<ClassInfo | null>(null);
  const [selectedGoodsId, setSelectedGoodsId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<BookingProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);

  const cells = useMemo(() => buildCalendarGrid(year, month), [year, month]);
  const selectedKey = dateKey(year, month, selectedDay);
  // 선택한 날짜의 수업 id 목록 (센터/카테고리 필터와 무관하게 그 날짜의 전체 수업 기준)
  const classIdsForSelectedDay = useMemo(
    () => classes.filter((c) => c.date === selectedKey).map((c) => c.id),
    [classes, selectedKey]
  );
  // 선택한 날짜의 수업 중 상품(goods) 사용이 허용된 수업들이 속한 센터 id 목록 (중복 제거)
  const centerIdsForSelectedDay = useMemo(() => {
    const ids = new Set<string>();
    for (const c of classes) {
      if (c.date === selectedKey && c.allowGoods) ids.add(c.centerId);
    }
    return Array.from(ids);
  }, [classes, selectedKey]);

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
      // 계정 조회는 한 번만: fetchMonthData/fetchMyProfiles가 각자 auth.getUser()+accounts를
      // 중복 조회하지 않도록 미리 구한 accountId를 넘겨서 두 요청을 병렬로 처리
      const accountId = await getMyAccountId();
      const [data, profs] = await Promise.all([
        fetchMonthData(year, month, accountId),
        fetchMyProfiles(accountId),
      ]);
      setClasses(data.classes);
      setCenters(data.centers);
      setHolidays(data.holidays);
      // 프로필 목록 (예약 주체 선택용). 대표 프로필을 기본 선택
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

  // 결제 완료 후 자동으로 돌아온 경우(?purchased=1): 짧은 완료 안내 토스트 표시
  // 지금 이 시스템은 결제 즉시 수강권이 발급되지 않고(매니저 수동 승인 후 발급) 관계로,
  // 그 수업에 지금 바로 쓸 수 있는 수강권이 생겼는지(usablePassesByClass) 확인한 뒤 문구를 다르게 보여줌.
  // 정확한 판단을 위해 위 자동 모달 오픈이 그 수업으로 완료되고(confirmClass 일치) + 그 날짜 배치 조회(passesLoading)가
  // 끝날 때까지 기다렸다가 딱 한 번만 표시. 표시 후 URL에서 이 플래그만 제거(openClassId/openDate 등은 유지)
  const purchasedToastShown = useRef(false);
  useEffect(() => {
    if (purchasedToastShown.current) return;
    const openClassId = searchParams.get("openClassId");
    if (searchParams.get("purchased") !== "1" || !openClassId) return;
    if (passesLoading) return; // 사용 가능한 수강권 조회 결과를 먼저 봐야 판단 가능
    if (!confirmClass || confirmClass.id !== openClassId) return; // 모달이 아직 그 수업으로 안 맞춰짐

    purchasedToastShown.current = true;
    const nowUsable = (usablePassesByClass[openClassId] ?? []).length > 0;
    showToast(
      nowUsable
        ? "✅ 상품 구매가 완료되었으며 이용 가능한 수강권이 등록되었습니다. 바로 예약을 진행할 수 있어요."
        : "✅ 상품 구매가 완료되었습니다. 수강권이 발급되면 예약을 진행할 수 있어요."
    );
    const params = new URLSearchParams(searchParams.toString());
    params.delete("purchased");
    router.replace(`/reservation?${params.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, confirmClass, passesLoading, usablePassesByClass]);

  // 선택한 날짜의 수업들에 대해 "사용 가능한 수강권"을 한 번에 조회 (수업별 반복 조회 방지)
  // activeProfileId나 날짜가 바뀔 때마다 다시 조회하며, 응답이 늦게 온 이전 요청은 무시함
  //
  // 이어서(같은 흐름 안에서): 사용 가능한 수강권이 하나도 없는 수업들만 골라
  // "구매하면 이 수업에 쓸 수 있는 상품" 목록도 한 번에 미리 가져와둔다.
  // → 모달을 실제로 열 때는 이미 준비된 결과를 읽기만 하므로 "확인 중..." 로딩이 거의 보이지 않음
  //   (수업별로 모달을 열 때마다 따로 조회하던 이전 방식보다 호출 수도 줄어듦 — 사용 가능한 수강권이
  //   있는 수업은 애초에 조회 대상에서 제외되기 때문)
  useEffect(() => {
    // 날짜/프로필이 바뀌면 이전에 캐시해둔 구매 가능 상품 목록도 함께 비움 (구매 후 등 상태가 달라졌을 수 있음)
    // + 이전 날짜에서 아직 진행 중이던 구매 가능 상품 조회가 있다면 여기서 무효화(reqId 증가)해서,
    //   나중에 그 응답이 늦게 도착해도 지금 날짜의 상태를 덮어쓰지 못하게 함
    setPurchasableByClass({});
    purchasableReqRef.current++;
    if (!activeProfileId || classIdsForSelectedDay.length === 0) {
      setUsablePassesByClass({});
      setPassesLoading(false);
      setPurchasableLoading(false);
      return;
    }
    const reqId = ++passesReqRef.current;
    setPassesLoading(true);
    fetchUsableMembershipsByClass(classIdsForSelectedDay, activeProfileId)
      .then((map) => {
        if (passesReqRef.current !== reqId) return; // 더 최신 요청이 이미 있으면 버림
        setUsablePassesByClass(map);

        // 사용 가능한 수강권이 없는 수업만 골라 구매 가능 상품을 미리 조회
        const emptyClassIds = classIdsForSelectedDay.filter((id) => (map[id] ?? []).length === 0);
        if (emptyClassIds.length === 0) {
          setPurchasableLoading(false);
          return;
        }
        const pReqId = ++purchasableReqRef.current;
        setPurchasableLoading(true);
        const pairs = emptyClassIds
          .map((id) => classes.find((c) => c.id === id))
          .filter((c): c is ClassInfo => !!c)
          .map((c) => ({ classId: c.id, centerId: c.centerId }));
        fetchPurchasableProductsByClass(pairs, profiles.map((p) => p.id))
          .then((pmap) => {
            if (purchasableReqRef.current !== pReqId) return; // 더 최신 요청(날짜 전환 등)이 있으면 버림
            setPurchasableByClass(pmap);
          })
          .catch(() => {
            if (purchasableReqRef.current !== pReqId) return;
            setPurchasableByClass({});
          })
          .finally(() => {
            if (purchasableReqRef.current !== pReqId) return;
            setPurchasableLoading(false);
          });
      })
      .catch(() => {
        if (passesReqRef.current !== reqId) return;
        setUsablePassesByClass({});
        setPurchasableLoading(false);
      })
      .finally(() => {
        if (passesReqRef.current !== reqId) return;
        setPassesLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classIdsForSelectedDay, activeProfileId]);

  // 선택한 날짜의 수업들이 속한 센터들에 대해 "보유 상품(goods)"을 한 번에 조회 (센터별 반복 조회 방지)
  // activeProfileId나 날짜가 바뀔 때마다 다시 조회하며, 응답이 늦게 온 이전 요청은 무시함
  useEffect(() => {
    if (!activeProfileId || centerIdsForSelectedDay.length === 0) {
      setGoodsByCenter({});
      setGoodsLoading(false);
      return;
    }
    const reqId = ++goodsReqRef.current;
    setGoodsLoading(true);
    fetchMyGoodsByCenter(activeProfileId, centerIdsForSelectedDay)
      .then((map) => {
        if (goodsReqRef.current !== reqId) return; // 더 최신 요청이 이미 있으면 버림
        setGoodsByCenter(map);
      })
      .catch(() => {
        if (goodsReqRef.current !== reqId) return;
        setGoodsByCenter({});
      })
      .finally(() => {
        if (goodsReqRef.current !== reqId) return;
        setGoodsLoading(false);
      });
  }, [centerIdsForSelectedDay, activeProfileId]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  // 이 프로필이 이 수업에 쓸 수 있는 수강권 이름 목록 (중복 제거)
  // classId별로 매 렌더링마다 Set을 새로 만들지 않도록, usablePassesByClass가 바뀔 때만 한 번에 계산
  const usableProductNamesByClass = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [classId, list] of Object.entries(usablePassesByClass)) {
      const seen = new Set<string>();
      for (const m of list) seen.add(m.productName);
      map.set(classId, Array.from(seen));
    }
    return map;
  }, [usablePassesByClass]);
  function usableProductNames(classId: string): string[] {
    return usableProductNamesByClass.get(classId) ?? [];
  }

  function handleReserve(cls: ClassInfo) {
    // 예약 확인 모달 열기 — 수강권/상품 모두 이미 배치로 가져온 결과에서 즉시 계산
    // (수업을 누른 시점에 추가 조회가 없으므로 이전 수업의 결과가 섞이거나 잠깐 보이는 일이 없음)
    setConfirmClass(cls);
    setSelectedGoodsId(null);
    const list = usablePassesByClass[cls.id] ?? [];
    setPassPick(pickDefaultMembership(list));
  }

  // 배치 조회가 모달이 열린 뒤에 도착한 경우를 대비해, 결과가 갱신되면 기본 선택을 다시 맞춰줌
  useEffect(() => {
    if (!confirmClass) return;
    const list = usablePassesByClass[confirmClass.id] ?? [];
    setPassPick(pickDefaultMembership(list));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmClass, usablePassesByClass]);

  async function doReserve() {
    const cls = confirmClass;
    if (!cls) return;
    if (busyClassId) return; // 중복 클릭/중복 요청 방지 (disabled 렌더링 전에 두 번 눌리는 경우 대비)
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
    if (busyClassId) return; // 중복 클릭/중복 요청 방지
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
  // 카테고리 필터 시 해당 종목 센터들의 id 집합 (centers/categoryFilter가 바뀔 때만 새로 계산 —
  // 매 렌더링마다 새 Set을 만들면 아래 dayClasses useMemo의 deps가 매번 "새 객체"로 보여 무효화됨)
  const categoryCenterIds = useMemo(
    () =>
      categoryFilter
        ? new Set(centers.filter((c) => c.categories.includes(categoryFilter)).map((c) => c.id))
        : null,
    [centers, categoryFilter]
  );

  const publicHoliday = PUBLIC_HOLIDAYS[selectedKey];
  const centerHolidays = holidays.filter((h) => h.date === selectedKey);
  const effectiveCenter = centerPick ?? centerFilter;
  const effectiveCenterName = effectiveCenter
    ? (centers.find((c) => c.id === effectiveCenter)?.name ?? "센터")
    : "전체 센터";
  const inTimeRange = (start: string) => {
    const hour = Number(start.split(":")[0]);
    if (timeFilter === "morning") return hour < 12;
    if (timeFilter === "afternoon") return hour >= 12 && hour < 18;
    if (timeFilter === "evening") return hour >= 18;
    return true;
  };
  // 날짜/센터/카테고리 필터가 바뀔 때만 다시 계산 (매 렌더링마다 3중 filter+sort를 새로 만들지 않음)
  const dayClasses = useMemo(
    () =>
      classes
        .filter((c) => c.date === selectedKey)
        .filter((c) => !effectiveCenter || c.centerId === effectiveCenter)
        .filter((c) => !categoryCenterIds || categoryCenterIds.has(c.centerId))
        .filter((c) => !availableOnly || c.reserved < c.capacity)
        .filter((c) => inTimeRange(c.start))
        .sort((a, b) => a.start.localeCompare(b.start)),
    [classes, selectedKey, effectiveCenter, categoryCenterIds, availableOnly, timeFilter]
  );
  // 예약 확인 모달에 표시할 수강권/상품 목록 (배치 조회 결과에서 파생 — 별도 조회 없음)
  const passList = confirmClass ? (usablePassesByClass[confirmClass.id] ?? []) : [];
  const confirmGoods = confirmClass ? (goodsByCenter[confirmClass.centerId] ?? []) : [];

  if (loading) {
    return (
      <div className="app-shell">
        <Loading />
      </div>
    );
  }

  if (error) {
    const needsLogin = error.includes("로그인");
    return (
      <div className="app-shell auth-required-state">
        <UiIcon name={needsLogin ? "user" : "info"} size={31} />
        <h1>{needsLogin ? "로그인이 필요해요" : "예약 정보를 불러오지 못했어요"}</h1>
        <p>{needsLogin ? "로그인하면 수강권을 확인하고 바로 예약할 수 있어요." : error}</p>
        <div className="auth-required-actions">
          {needsLogin ? <a className="primary-btn" href="/login?next=/reservation">로그인하고 계속하기</a> : <button className="primary-btn" onClick={load}>다시 불러오기</button>}
          <a className="ghost-btn" href="/">홈으로 돌아가기</a>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell member-reservation">
      {toast && <div className="toast">{toast}</div>}

      <div className="resv-page-head"><h1>예약</h1></div>
      <div className="booking-steps" aria-label="예약 진행 단계">
        <div className="booking-step complete"><span>✓</span><b>날짜 선택</b></div><i />
        <div className={`booking-step ${confirmClass ? "complete" : "active"}`} aria-current={!confirmClass ? "step" : undefined}><span>{confirmClass ? "✓" : "2"}</span><b>수업 선택</b></div><i />
        <div className={`booking-step ${confirmClass ? "active" : ""}`} aria-current={confirmClass ? "step" : undefined}><span>3</span><b>예약 확인</b></div>
      </div>

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

      {categoryFilter && (
        <div className="center-filter-banner">
          <span>{categoryFilter} 수업만 보는 중{categoryCenterIds && categoryCenterIds.size === 0 ? " (해당 종목 센터 없음)" : ""}</span>
          <a href="/reservation" className="center-filter-clear">전체 보기</a>
        </div>
      )}

      <div className="cal-header">
        <div className="cal-toolbar">
          <div className="cal-month-control cal-month-nav">
            <button className="cal-nav-btn" onClick={goPrevMonth} aria-label="이전 달">‹</button>
            <div className="cal-title">{year}.{pad(month)}</div>
            <button className="cal-nav-btn" onClick={goNextMonth} aria-label="다음 달">›</button>
          </div>
          <button className="cal-center-pick" onClick={() => setCenterSheet(true)} aria-label={`센터 선택, 현재 ${effectiveCenterName}`}>
            <span>{effectiveCenterName}</span><b>⌄</b>
          </button>
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
                {dots.length > 0 && <span className={`cal-dot ${bookedDays[key] ? "mine" : ""}`} />}
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

      <div className="reservation-list-controls">
        <SegmentedTabs
          value={timeFilter}
          onChange={(value) => setTimeFilter(value as typeof timeFilter)}
          label="수업 시간대"
          items={[
            { value: "all", label: "전체" },
            { value: "morning", label: "오전" },
            { value: "afternoon", label: "오후" },
            { value: "evening", label: "저녁" },
          ]}
        />
        <button className={`availability-filter ${availableOnly ? "on" : ""}`} onClick={() => setAvailableOnly((value) => !value)}>
          <span aria-hidden="true" /> 잔여석만
        </button>
      </div>

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
          dayClasses.map((cls, index) => {
            const center = centers.find((c) => c.id === cls.centerId);
            const full = cls.reserved >= cls.capacity;
            // 지금 선택된 프로필 기준으로 내 예약 상태 판단
            const mineRec = activeProfileId ? cls.myByProfile[activeProfileId] : undefined;
            const mine = !!mineRec;
            const busy = busyClassId === cls.id;
            // Track 2: 수업이 이미 시작됐으면 새 예약 버튼 자체를 숨긴다(서버 reserve_class()도
            // 별도로 차단 — UI는 보조 수단일 뿐 서버가 최종 방어선).
            const hasStarted = new Date(toKstIso(cls.date, cls.start)).getTime() <= Date.now();
            const passNames = usableProductNames(cls.id);
            const instructorText = formatInstructorNames(cls.instructorNames);
            const hour = Number(cls.start.split(":")[0]);
            const period = hour < 12 ? "오전" : hour < 18 ? "오후" : "저녁";
            const previousHour = index > 0 ? Number(dayClasses[index - 1].start.split(":")[0]) : -1;
            const previousPeriod = previousHour < 0 ? "" : previousHour < 12 ? "오전" : previousHour < 18 ? "오후" : "저녁";
            return (
              <Fragment key={cls.id}>
              {period !== previousPeriod && <div className="reservation-period-label">{period}</div>}
              <div className={`class-row ${mine ? "mine" : ""}`}>
                <div className="class-time"><strong>{cls.start}</strong><span>{cls.end}</span></div>
                <div className="class-info">
                  <div className="class-row-title">
                    {cls.title}
                    {cls.classFormat === "private" && <span className="booked-tag private-tag">프라이빗</span>}
                    {mineRec?.status === "confirmed" && <span className="booked-tag">내 예약</span>}
                    {mineRec?.status === "waitlisted" && <span className="booked-tag">대기중</span>}
                  </div>
                  <div className="class-row-place">{center?.name}{instructorText ? ` · ${instructorText}` : ""}</div>
                  {cls.place && <div className="class-row-meta">{cls.place}</div>}
                  <div className="center-class-passes">
                    {passesLoading ? (
                      <span className="class-pass-chip all skeleton-shimmer">수강권 확인 중...</span>
                    ) : passNames.length > 0 ? (
                      <>
                        <span className="class-pass-label">사용 가능:</span>
                        {passNames.map((n) => (
                          <span key={n} className="class-pass-chip">{n}</span>
                        ))}
                      </>
                    ) : (
                      <span className="class-pass-chip all">사용 가능한 수강권 없음</span>
                    )}
                  </div>
                </div>
                <div className="class-right">
                  {cls.showReservedCount ? (
                    <div className={`class-count ${full ? "full" : ""}`}>
                      예약 {cls.reserved}/{cls.capacity}
                    </div>
                  ) : (
                    // 운영설정에서 인원 표시를 껐으면 정원마감 여부만(정확한 인원수는 숨김)
                    full && <div className="class-count full">마감</div>
                  )}
                  {mine ? (
                    <button className="mini-btn done" disabled={busy} onClick={() => handleCancel(cls)}>
                      {busy ? "..." : "취소"}
                    </button>
                  ) : hasStarted ? (
                    <div className="mini-btn-note">수업이 시작되었습니다.</div>
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
              </Fragment>
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
            {passesLoading ? (
              <div className="perm-guide skeleton-shimmer" style={{ margin: "0 0 10px" }}>수강권 확인 중...</div>
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
                  현재 사용할 수 있는 수강권이 없어요.
                </div>
                {purchasableLoading ? (
                  <div className="perm-guide skeleton-shimmer" style={{ margin: 0 }}>구매 가능한 수강권 확인 중...</div>
                ) : (purchasableByClass[confirmClass.id]?.length ?? 0) > 0 ? (
                  <div>
                    <div className="perm-guide" style={{ margin: "0 0 6px" }}>
                      이 수업은 아래 수강권으로 예약할 수 있어요.
                    </div>
                    <ul className="purchasable-pass-list">
                      {(purchasableByClass[confirmClass.id] ?? []).map((p) => (
                        <li key={p.productId} className="purchasable-pass-item">{p.productName}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <button
                  className="no-pass-buy-btn"
                  onClick={() => {
                    const c = confirmClass;
                    if (!c) return;
                    const ids = (purchasableByClass[c.id] ?? []).map((p) => p.productId);
                    const idsParam = ids.length > 0 ? `&productIds=${ids.join(",")}` : "";
                    // 지금 보고 있던 센터 필터도 함께 넘겨서, 나중에 예약 화면으로 돌아올 때 그대로 복원되게 함
                    const centerParam = effectiveCenter ? `&reserveCenter=${effectiveCenter}` : "";
                    router.push(
                      `/center/${c.centerId}?buy=1&reserveClassId=${c.id}&reserveDate=${encodeURIComponent(c.date)}${centerParam}${idsParam}`
                    );
                  }}
                >
                  수강권 구매하기
                </button>
              </div>
            )}
            <div className="confirm-class" style={{ marginTop: 18 }}>
              <div className="confirm-class-title">{confirmClass.title}</div>
              {confirmClass.description && (
                <div className="confirm-class-sub" style={{ whiteSpace: "pre-wrap" }}>{confirmClass.description}</div>
              )}
              <div className="confirm-class-sub">{confirmClass.place} · {confirmClass.date} {confirmClass.start}</div>
              {confirmClass.instructorNames.length > 0 && (
                // 목록 화면(class-row-place)은 "A, B 외 N명"으로 줄여 보여주지만, 강사가
                // 많으면 회원이 전체 명단을 볼 방법이 없어진다는 피드백(2026-08-12) — 예약
                // 확인 상세에서는 줄이지 않고 전원을 보여준다.
                <div className="confirm-class-sub">담당 강사: {confirmClass.instructorNames.join(", ")}</div>
              )}
            </div>

            {confirmClass.allowGoods && (
              <>
                <div className="menu-section-label" style={{ padding: "8px 0 6px" }}>보유 상품 사용 (선택)</div>
                {goodsLoading ? (
                  <div className="perm-guide skeleton-shimmer" style={{ margin: 0 }}>상품 불러오는 중...</div>
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
