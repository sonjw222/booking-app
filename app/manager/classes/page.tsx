"use client";

/*
  수업 관리 화면 (매니저용)
  - 내 센터의 수업 목록 (이번 달)
  - 수업 등록 / 수정 / 삭제 (하단 시트 폼)
  - 매니저 RLS 정책 필요 (reservation_functions.sql)
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import ManagerNav from "../../components/ManagerNav";
import CopyCalendar from "./CopyCalendar";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchRooms, type Room } from "../../../lib/rooms";
import {
  fetchClasses, createClass, updateClass, deleteClass,
  createRecurringClasses, expandRecurringDates,
  updateClassGroup, deleteClassGroup,
  fetchClassAttendees, setAttendance, fetchClassProducts, setClassProducts, setClassProductsBulk,
  autoAddRulesForClass, fetchAllPassProductIds, dowFromDate,
  fetchCenterHolidayDates,
  fetchCopyGroups, fetchCopyDateItems, planCopyByWeekday, planCopyByDate,
  copyByWeekday, copyByDate,
  type CopyGroup, type CopyDateItem, type CopyPlanItem,
  fetchBookableMembers, managerBookMember, type BookableMember,
  fetchUnplacedPasses, retryAutoBook, type UnplacedPass,
  type ManagedClass, type ClassInput, type ClassAttendee,
} from "../../../lib/classes";
import { fetchMemberDetail, type MemberDetailData } from "../../../lib/members";
import { fetchProducts, type Product } from "../../../lib/passes";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

const EMPTY: ClassInput = { title: "", date: "", start: "", end: "", capacity: 8, allowGoods: true, roomId: null, cancelDeadlineMin: null };

export default function ClassManagePage() {
  const nowD = new Date();
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [activeCenterId, setActiveCenterId] = useState<string | null>(null);
  const [classes, setClasses] = useState<ManagedClass[]>([]);
  const [holidayDates, setHolidayDates] = useState<Set<string>>(new Set());
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }

  // 달력 상태
  const [year, setYear] = useState<number>(nowD.getFullYear());
  const [month, setMonth] = useState<number>(nowD.getMonth() + 1);
  const [selectedDay, setSelectedDay] = useState<number>(nowD.getDate());

  // 폼 상태 (열림/수정 대상/입력값)
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editGroupId, setEditGroupId] = useState<string | null>(null);
  const [applyToGroup, setApplyToGroup] = useState(false);
  // 삭제 확인 시트
  const [deleteTarget, setDeleteTarget] = useState<ManagedClass | null>(null);
  const [form, setForm] = useState<ClassInput>(EMPTY);
  // 반복 등록 상태
  const [repeat, setRepeat] = useState(false);
  const [repDays, setRepDays] = useState<number[]>([]);
  // 요일별 시간·정원 개별 지정 (비워두면 공통값 사용)
  // 요일별 개별 지정 (비워두면 아래 공통값 사용)
  const [dayOverrides, setDayOverrides] = useState<Record<number, {
    start: string; end: string; capacity: string;
    roomId: string | null | undefined;   // undefined = 미지정(공통값 사용)
    cd: string; ch: string; cm: string;  // 취소마감 일/시간/분
  }>>({});
  const [perDayMode, setPerDayMode] = useState(false);
  // 예약취소 마감: 일/시간/분 입력 → 분으로 환산해 저장
  const [cancelD, setCancelD] = useState("");
  const [cancelH, setCancelH] = useState("");
  const [cancelM, setCancelM] = useState("");
  const [repFrom, setRepFrom] = useState("");
  const [repTo, setRepTo] = useState("");
  // 예약자 명단 시트
  const [rosterClass, setRosterClass] = useState<ManagedClass | null>(null);
  const [roster, setRoster] = useState<ClassAttendee[]>([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [attBusy, setAttBusy] = useState(false);
  // 스케줄 복사
  const [copySheet, setCopySheet] = useState(false);
  const [copyFrom, setCopyFrom] = useState("");
  const [copyTo, setCopyTo] = useState("");
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyMode, setCopyMode] = useState<"weekday" | "date">("weekday");
  const [copyGroups, setCopyGroups] = useState<CopyGroup[]>([]);
  const [copyDateItems, setCopyDateItems] = useState<CopyDateItem[]>([]);
  const [copySelected, setCopySelected] = useState<Set<string>>(new Set());
  const [copyPlan, setCopyPlan] = useState<CopyPlanItem[] | null>(null);
  const [copyView, setCopyView] = useState<"list" | "calendar">("list");
  // 보강 예약
  const [bookSheet, setBookSheet] = useState(false);
  const [bookMembers, setBookMembers] = useState<BookableMember[]>([]);
  const [bookKw, setBookKw] = useState("");
  const [bookPick, setBookPick] = useState<BookableMember | null>(null);
  const [bookMemId, setBookMemId] = useState<string | null>(null);
  const [bookDeduct, setBookDeduct] = useState(true);
  const [bookBusy, setBookBusy] = useState(false);
  // 미배치 수강권 (요일반)
  const [unplaced, setUnplaced] = useState<UnplacedPass[]>([]);
  const [unplacedSheet, setUnplacedSheet] = useState(false);
  const [unplacedBusy, setUnplacedBusy] = useState(false);
  // 회원 정보 팝업 (명단에서 이름 클릭)
  const [memberInfo, setMemberInfo] = useState<{ name: string; profileId: string; data: MemberDetailData | null } | null>(null);
  // 수강권 목록 + 폼에서 선택된 수강권
  const [passProducts, setPassProducts] = useState<Product[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const loadClasses = useCallback(async (centerId: string, y: number, m: number) => {
    setError(null);
    try {
      const from = `${y}-${String(m).padStart(2, "0")}-01`;
      const to = `${y}-${String(m).padStart(2, "0")}-${new Date(y, m, 0).getDate()}`;
      setClasses(await fetchClasses(centerId, from, to));
      setHolidayDates(await fetchCenterHolidayDates(centerId));
      try { setRooms(await fetchRooms(centerId)); } catch { /* 무시 */ }
      try { setUnplaced(await fetchUnplacedPasses(centerId)); } catch { setUnplaced([]); }
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchMyCenters();
        setCenters(list);
        if (list.length > 0) {
          setActiveCenterId(list[0].id);
          await loadClasses(list[0].id, year, month);
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadClasses]);

  // 달이 바뀌면 다시 로드
  useEffect(() => {
    if (activeCenterId) {
      loadClasses(activeCenterId, year, month);
      fetchProducts(activeCenterId, "pass").then(setPassProducts).catch(() => {});
    }
  }, [year, month, activeCenterId, loadClasses]);

  function goPrevMonth() {
    setSelectedDay(1);
    if (month === 1) { setYear((y) => y - 1); setMonth(12); }
    else setMonth((m) => m - 1);
  }
  function goNextMonth() {
    setSelectedDay(1);
    if (month === 12) { setYear((y) => y + 1); setMonth(1); }
    else setMonth((m) => m + 1);
  }

  // 일/시간/분 → 분 (모두 비면 null = 센터 설정 사용)
  function deadlineToMin(): number | null {
    const d = parseInt(cancelD || "0", 10) || 0;
    const h = parseInt(cancelH || "0", 10) || 0;
    const m = parseInt(cancelM || "0", 10) || 0;
    const total = d * 1440 + h * 60 + m;
    if (!cancelD && !cancelH && !cancelM) return null;
    return total;
  }
  // 분 → 일/시간/분 입력칸 채우기
  function fillDeadline(min: number | null) {
    if (min == null || min <= 0) { setCancelD(""); setCancelH(""); setCancelM(""); return; }
    setCancelD(String(Math.floor(min / 1440) || ""));
    setCancelH(String(Math.floor((min % 1440) / 60) || ""));
    setCancelM(String(min % 60 || ""));
  }

  function openCreate() {
    setEditId(null);
    setCancelD(""); setCancelH(""); setCancelM("");
    setEditGroupId(null);
    setApplyToGroup(false);
    const dayStr = `${year}-${String(month).padStart(2, "0")}-${String(selectedDay).padStart(2, "0")}`;
    const lastDay = `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
    setForm({ ...EMPTY, date: dayStr });
    setRepeat(false);
    setRepDays([]);
    setRepFrom(dayStr);
    setRepTo(lastDay);
    setSelectedProducts([]);
    setError(null);
    setFormOpen(true);
  }

  function toggleRepDay(d: number) {
    setRepDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort());
  }

  // --- 미배치 수강권 ---
  const loadUnplaced = useCallback(async (cid: string) => {
    try { setUnplaced(await fetchUnplacedPasses(cid)); }
    catch { setUnplaced([]); }
  }, []);

  async function handleRetryAutoBook(u: UnplacedPass) {
    setUnplacedBusy(true);
    try {
      const n = await retryAutoBook(u.membershipId);
      showToast(n > 0 ? `${n}개 수업에 배치했어요` : "배치할 수 있는 수업이 없어요 (정원 확인)");
      if (activeCenterId) {
        await loadUnplaced(activeCenterId);
        await loadClasses(activeCenterId, year, month);
      }
    } catch (e: any) { setError(e.message); }
    finally { setUnplacedBusy(false); }
  }

  // --- 보강 예약 ---
  async function openBookSheet() {
    if (!activeCenterId) return;
    setBookPick(null); setBookMemId(null); setBookKw(""); setBookDeduct(true);
    setBookSheet(true);
    try { setBookMembers(await fetchBookableMembers(activeCenterId)); }
    catch (e: any) { setError(e.message); }
  }
  async function handleBook() {
    if (!rosterClass || !bookPick) return;
    setBookBusy(true);
    try {
      const r = await managerBookMember(rosterClass.id, bookPick.profileId, bookMemId, bookDeduct);
      showToast(r.overCapacity ? "정원을 넘겨서 예약했어요" : "보강 예약을 넣었어요");
      setBookSheet(false);
      setRoster(await fetchClassAttendees(rosterClass.id));
      if (activeCenterId) await loadClasses(activeCenterId, year, month);
    } catch (e: any) { setError(e.message); }
    finally { setBookBusy(false); }
  }

  // --- 스케줄 복사 v2 ---
  function openCopy() {
    const now = new Date();
    const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nxt = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
    setCopyFrom(cur); setCopyTo(nxt);
    setCopyGroups([]); setCopyDateItems([]); setCopySelected(new Set());
    setCopyPlan(null); setCopyView("list"); setCopyMode("weekday");
    setCopySheet(true);
  }

  // 원본 달을 고르면 수업 목록 불러오기
  async function loadCopySource(month: string, mode: "weekday" | "date") {
    if (!activeCenterId || !month) return;
    setCopyBusy(true); setCopyPlan(null);
    try {
      if (mode === "weekday") {
        const gs = await fetchCopyGroups(activeCenterId, month);
        setCopyGroups(gs);
        setCopySelected(new Set(gs.map((g) => g.key)));   // 기본 전체선택
      } else {
        const its = await fetchCopyDateItems(activeCenterId, month);
        setCopyDateItems(its);
        setCopySelected(new Set(its.map((i) => i.key)));
      }
    } catch (e: any) { setError(e.message); }
    finally { setCopyBusy(false); }
  }

  function toggleCopyItem(key: string) {
    setCopySelected((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
    setCopyPlan(null);
  }
  function selectAllCopy() {
    setCopySelected(new Set(copyMode === "weekday" ? copyGroups.map((g) => g.key) : copyDateItems.map((i) => i.key)));
    setCopyPlan(null);
  }
  function clearAllCopy() { setCopySelected(new Set()); setCopyPlan(null); }

  async function handlePreviewCopy() {
    if (!activeCenterId || !copyFrom || !copyTo) { setError("복사할 달을 선택해주세요"); return; }
    if (copyFrom === copyTo) { setError("같은 달로는 복사할 수 없어요"); return; }
    if (copySelected.size === 0) { setError("복사할 수업을 선택해주세요"); return; }
    setCopyBusy(true);
    try {
      const plan = copyMode === "weekday"
        ? await planCopyByWeekday(activeCenterId, copyTo, copyGroups.filter((g) => copySelected.has(g.key)))
        : await planCopyByDate(activeCenterId, copyTo, copyDateItems.filter((i) => copySelected.has(i.key)));
      setCopyPlan(plan);
    } catch (e: any) { setError(e.message); }
    finally { setCopyBusy(false); }
  }

  async function handleCopy() {
    if (!activeCenterId) return;
    if (!confirm(`${copyFrom} → ${copyTo}\n선택한 수업을 복사할까요?`)) return;
    setCopyBusy(true);
    try {
      const n = copyMode === "weekday"
        ? await copyByWeekday(activeCenterId, copyTo, copyGroups.filter((g) => copySelected.has(g.key)))
        : await copyByDate(activeCenterId, copyTo, copyDateItems.filter((i) => copySelected.has(i.key)));
      showToast(`${n}개 수업을 복사했어요`);
      setCopySheet(false);
      if (activeCenterId) await loadClasses(activeCenterId, year, month);
    } catch (e: any) { setError(e.message); }
    finally { setCopyBusy(false); }
  }

  async function openRoster(c: ManagedClass) {
    setRosterClass(c);
    setRoster([]);
    setRosterLoading(true);
    try {
      setRoster(await fetchClassAttendees(c.id));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRosterLoading(false);
    }
  }

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
    } catch (e: any) { setError(e.message); }
    finally { setAttBusy(false); }
  }

  async function openMemberInfo(a: ClassAttendee) {    setMemberInfo({ name: a.name, profileId: a.profileId, data: null });
    try {
      const data = await fetchMemberDetail(a.profileId);
      setMemberInfo({ name: a.name, profileId: a.profileId, data });
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function openEdit(c: ManagedClass) {
    setEditId(c.id);
    setEditGroupId(c.recurringGroupId);
    setApplyToGroup(false);
    setForm({ title: c.title, date: c.date, start: c.start, end: c.end, capacity: c.capacity, allowGoods: c.allowGoods, roomId: c.roomId, cancelDeadlineMin: c.cancelDeadlineMin });
    fillDeadline(c.cancelDeadlineMin);
    setSelectedProducts([]);
    setError(null);
    setFormOpen(true);
    try {
      setSelectedProducts(await fetchClassProducts(c.id));
    } catch { /* 무시 */ }
  }

  async function save() {
    if (!activeCenterId) return;

    // 반복 등록 (신규일 때만)
    if (repeat && !editId) {
      if (!form.title.trim()) {
        setError("수업명을 입력해주세요");
        return;
      }
      if (!perDayMode && (!form.start || !form.end)) {
        setError("시작·종료 시간을 입력해주세요");
        return;
      }
      if (repDays.length === 0) { setError("반복할 요일을 선택해주세요"); return; }
      if (!repFrom || !repTo || repFrom > repTo) { setError("기간을 올바르게 선택해주세요"); return; }
      setBusy(true); setError(null);
      try {
        // 휴무일과 겹치는 날짜는 제외하고 생성
        const holidays = await fetchCenterHolidayDates(activeCenterId);
        const allDates = expandRecurringDates(repFrom, repTo, repDays);
        const validDates = allDates.filter((d) => !holidays.has(d));
        const skipped = allDates.length - validDates.length;
        if (validDates.length === 0) {
          setError("선택한 기간이 모두 휴무일이에요");
          setBusy(false);
          return;
        }
        // 요일별 개별 지정이면 요일마다 따로 생성, 아니면 한번에
        // (요일별 칸이 비어 있으면 공통 설정값이 그대로 들어감)
        let ids: string[] = [];
        if (perDayMode) {
          for (const dow of repDays) {
            const ov = dayOverrides[dow] ?? { start: "", end: "", capacity: "", roomId: undefined, cd: "", ch: "", cm: "" };
            const st = ov.start || form.start;
            const en = ov.end || form.end;
            const capNum = ov.capacity ? parseInt(ov.capacity, 10) : NaN;
            const cap = Number.isFinite(capNum) && capNum > 0 ? capNum : form.capacity;
            // 룸: undefined 면 공통값, null 이면 '없음', id 면 그 룸
            const rid = ov.roomId === undefined ? form.roomId : ov.roomId;
            // 취소마감: 세 칸 모두 비면 공통값
            const hasCd = !!(ov.cd || ov.ch || ov.cm);
            const ovMin = hasCd
              ? (parseInt(ov.cd || "0", 10) || 0) * 1440 + (parseInt(ov.ch || "0", 10) || 0) * 60 + (parseInt(ov.cm || "0", 10) || 0)
              : deadlineToMin();
            if (!st || !en) { setError(`${WEEKDAYS[dow]}요일 시간을 입력해주세요 (공통 설정도 비어 있어요)`); setBusy(false); return; }
            const partIds = await createRecurringClasses(activeCenterId, {
              title: form.title, daysOfWeek: [dow],
              fromDate: repFrom, toDate: repTo,
              start: st, end: en, capacity: cap, roomId: rid, cancelDeadlineMin: ovMin,
              excludeDates: holidays,
            });
            ids = ids.concat(partIds);
          }
        } else {
          ids = await createRecurringClasses(activeCenterId, {
            title: form.title, daysOfWeek: repDays,
            fromDate: repFrom, toDate: repTo,
            start: form.start, end: form.end, capacity: form.capacity, roomId: form.roomId, cancelDeadlineMin: deadlineToMin(),
            excludeDates: holidays,
          });
        }
        // 선택한 수강권을 모든 생성 수업에 연결
        if (selectedProducts.length > 0) await setClassProductsBulk(ids, selectedProducts);
        // 대상 수강권들의 예약조건에 이 수업(요일들/시간/수업명) 자동 추가
        const targetProducts = selectedProducts.length > 0
          ? selectedProducts
          : await fetchAllPassProductIds(activeCenterId);
        for (const dow of repDays) {
          const ov = dayOverrides[dow];
          const st = perDayMode && ov?.start ? ov.start : form.start;
          await autoAddRulesForClass(targetProducts, dow, st, form.title);
        }
        setFormOpen(false);
        await loadClasses(activeCenterId, year, month);
        setError(null);
        showToast(`${ids.length}개의 수업을 등록했어요${skipped > 0 ? ` (휴무일 ${skipped}일 제외)` : ""}`);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!form.title.trim() || !form.date || !form.start || !form.end) {
      setError("수업명·날짜·시작·종료 시간을 모두 입력해주세요");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 휴무일에는 수업 개설 차단
      const holidays = await fetchCenterHolidayDates(activeCenterId);
      if (!editId && holidays.has(form.date)) {
        setError("이 날짜는 휴무일이라 수업을 개설할 수 없어요");
        setBusy(false);
        return;
      }
      // 수강권 미지정이면 = 모든 수강권 대상, 지정이면 그 수강권들
      const targetProducts = selectedProducts.length > 0
        ? selectedProducts
        : await fetchAllPassProductIds(activeCenterId);
      const dow = dowFromDate(form.date);

      if (editId) {
        if (applyToGroup && editGroupId) {
          await updateClassGroup(editGroupId, form.title, form.start, form.end, form.capacity);
        } else {
          await updateClass(editId, { ...form, cancelDeadlineMin: deadlineToMin() });
        }
        await setClassProducts(editId, selectedProducts);
      } else {
        const newId = await createClass(activeCenterId, { ...form, cancelDeadlineMin: deadlineToMin() });
        await setClassProducts(newId, selectedProducts);
      }
      // 이 수업 조건(요일/시간/수업명)을 대상 수강권들의 예약조건에 자동 추가
      await autoAddRulesForClass(targetProducts, dow, form.start, form.title);

      setFormOpen(false);
      await loadClasses(activeCenterId, year, month);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function remove(c: ManagedClass) {
    setError(null);
    if (isPastClass(c)) {
      setError("이미 지난 수업은 삭제할 수 없어요");
      return;
    }
    setDeleteTarget(c);
  }

  function isPastClass(c: { date: string; end: string }): boolean {
    // 수업 종료시각이 지났으면 과거 수업
    return new Date(`${c.date}T${c.end}:00+09:00`).getTime() < Date.now();
  }

  async function doDelete(wholeGroup: boolean) {
    const c = deleteTarget;
    if (!c || !activeCenterId) return;
    setBusy(true);
    try {
      if (wholeGroup && c.recurringGroupId) {
        await deleteClassGroup(c.recurringGroupId);
      } else {
        await deleteClass(c.id);
      }
      setDeleteTarget(null);
      await loadClasses(activeCenterId, year, month);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="app-shell"><Loading /></div>;
  }

  // 달력 셀 + 수업 있는 날 표시
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const selectedKey = `${year}-${pad2(month)}-${pad2(selectedDay)}`;
  const firstDow = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const hasClassByDay: Record<number, number> = {};
  for (const c of classes) {
    const day = parseInt(c.date.slice(8, 10), 10);
    hasClassByDay[day] = (hasClassByDay[day] ?? 0) + 1;
  }

  const dayClasses = classes
    .filter((c) => c.date === selectedKey)
    .sort((a, b) => a.start.localeCompare(b.start));

  return (
    <div className="app-shell" style={{ paddingBottom: 170 }}>
      <div className="back-header">
        <button className="side cal-export-btn" style={{ fontSize: 12 }} onClick={openCopy}>복사</button>
        <div className="title">내 일정</div>
        <a className="side cal-export-btn" href="/manager/holidays" style={{ fontSize: 12 }}>휴무일</a>
      </div>

      {unplaced.length > 0 && (
        <button className="unplaced-banner" onClick={() => setUnplacedSheet(true)}>
          <span className="unplaced-icon">⚠️</span>
          <span className="unplaced-text">
            예약이 덜 배치된 요일반 수강권 <b>{unplaced.length}건</b>
          </span>
          <span className="unplaced-go">보기 ›</span>
        </button>
      )}

      <div className="center-switcher">
        {centers.map((c) => (
          <button
            key={c.id}
            className={`center-chip ${c.id === activeCenterId ? "on" : ""}`}
            onClick={async () => { setActiveCenterId(c.id); await loadClasses(c.id, year, month); }}
          >
            {c.name}
          </button>
        ))}
      </div>

      {/* 월 이동 */}
      <div className="cal-header">
        <div className="cal-month-nav">
          <button className="cal-nav-btn" onClick={goPrevMonth}>‹</button>
          <div className="cal-title">{year}.{pad2(month)}</div>
          <button className="cal-nav-btn" onClick={goNextMonth}>›</button>
        </div>
      </div>

      {/* 요일 */}
      <div className="cal-grid cal-weekdays">
        {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
          <div key={d} className={`cal-weekday ${i === 0 ? "sun" : ""} ${i === 6 ? "sat" : ""}`}>{d}</div>
        ))}
      </div>

      {/* 날짜 격자 */}
      <div className="cal-grid">
        {cells.map((day, i) => {
          if (day === null) return <div key={i} className="cal-cell empty" />;
          const dow = new Date(year, month - 1, day).getDay();
          const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;
          const isHoliday = holidayDates.has(dateStr);
          const cn = ["cal-cell"];
          if (day === selectedDay) cn.push("selected");
          if (isHoliday) cn.push("holiday");
          if (dow === 0) cn.push("sun");
          else if (dow === 6) cn.push("sat");
          return (
            <button key={i} className={cn.join(" ")} onClick={() => setSelectedDay(day)}>
              <span className="daynum-wrap"><span className="cal-daynum">{day}</span></span>
              <span className="cal-dots">
                {isHoliday ? <span className="cal-dot" style={{ background: "#c0392b" }} />
                  : hasClassByDay[day] ? <span className="cal-dot" style={{ background: "var(--accent)" }} /> : null}
              </span>
            </button>
          );
        })}
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      <div className="menu-section-label">{month}월 {selectedDay}일 수업 ({dayClasses.length})</div>

      {holidayDates.has(`${year}-${pad2(month)}-${pad2(selectedDay)}`) && (
        <div className="holiday-notice" style={{ margin: "0 20px 10px" }}>
          <div className="holiday-chip">🚫 이 날은 휴무일이에요 (수업 개설 불가)</div>
        </div>
      )}

      {dayClasses.length === 0 ? (
        holidayDates.has(`${year}-${pad2(month)}-${pad2(selectedDay)}`) ? (
          <div className="daylist-empty" style={{ paddingTop: 20 }}>휴무일이에요</div>
        ) : (
          <div className="empty-action">
            <div className="empty-action-text">이 날 등록된 수업이 없어요.</div>
            <button className="empty-action-btn" onClick={openCreate}>+ 수업 등록하기</button>
          </div>
        )
      ) : (
        <div className="daylist" style={{ minHeight: 0, paddingTop: 4 }}>
          {dayClasses.map((c) => (
            <div key={c.id} className="class-row" onClick={() => openEdit(c)} style={{ cursor: "pointer" }}>
              <div className="class-color" style={{ background: "var(--accent)" }} />
              <div className="class-info">
                <div className="class-row-title">{c.title}</div>
                <div className="class-row-meta">
                  {c.start}~{c.end} · <button type="button" className="res-count-link" onClick={(e) => { e.stopPropagation(); openRoster(c); }}>예약 {c.reserved}/{c.capacity} ›</button>
                </div>
              </div>
              {!isPastClass(c) && (
                <button className="profile-del" disabled={busy} onClick={(e) => { e.stopPropagation(); remove(c); }}>
                  삭제
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 하단 고정 등록 버튼 */}
      <button className="fab-btn" onClick={openCreate}>+ 수업 등록</button>

      {/* 등록/수정 시트 */}
      {formOpen && (
        <div className="sheet-overlay" onClick={() => setFormOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{editId ? "수업 수정" : "수업 등록"}</div>
            <input className="input-field" placeholder="수업명" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />

            {/* 반복 등록 토글 (신규일 때만) */}
            {!editId && (
              <div className="set-row" style={{ padding: "10px 0", borderBottom: "none" }}>
                <div className="set-label">매주 반복 등록</div>
                <button className={`switch ${repeat ? "on" : ""}`} onClick={() => setRepeat(!repeat)}>
                  <span className="knob" />
                </button>
              </div>
            )}

            {repeat && !editId ? (
              <>
                <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>반복 요일</div>
                <div className="mem-filters" style={{ padding: 0 }}>
                  {WEEKDAYS.map((d, i) => (
                    <button key={i} className={`filter-chip ${repDays.includes(i) ? "on" : ""}`} onClick={() => toggleRepDay(i)}>{d}</button>
                  ))}
                </div>
                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>기간</div>
                <div className="time-row">
                  <input className="input-field" type="date" value={repFrom} onChange={(e) => setRepFrom(e.target.value)} />
                  <span className="time-sep">~</span>
                  <input className="input-field" type="date" value={repTo} onChange={(e) => setRepTo(e.target.value)} />
                </div>
                {repDays.length > 0 && repFrom && repTo && repFrom <= repTo && (
                  <div className="rep-preview" style={{ marginBottom: 4 }}>
                    총 {expandRecurringDates(repFrom, repTo, repDays).length}개 수업이 만들어져요
                  </div>
                )}

                {/* 요일별 개별 지정 */}
                {repDays.length > 1 && (
                  <>
                    <div className="set-row" style={{ padding: "10px 0 4px" }}>
                      <div className="set-label">요일별로 다르게</div>
                      <button className={`switch ${perDayMode ? "on" : ""}`} onClick={() => setPerDayMode((v) => !v)}>
                        <span className="knob" />
                      </button>
                    </div>
                    {perDayMode && (
                      <div className="perday-wrap">
                        {[...repDays].sort((a, b) => a - b).map((d) => {
                          const ov = dayOverrides[d] ?? { start: "", end: "", capacity: "", roomId: undefined, cd: "", ch: "", cm: "" };
                          const setOv = (patch: Partial<typeof ov>) =>
                            setDayOverrides((prev) => ({ ...prev, [d]: { ...ov, ...patch } }));
                          return (
                            <div key={d} className="perday-row">
                              <div className="perday-dow">{WEEKDAYS[d]}요일</div>

                              <div className="perday-inputs">
                                <input className="input-field" type="time" value={ov.start} onChange={(e) => setOv({ start: e.target.value })} />
                                <span className="time-sep">~</span>
                                <input className="input-field" type="time" value={ov.end} onChange={(e) => setOv({ end: e.target.value })} />
                                <input className="input-field" inputMode="numeric" style={{ maxWidth: 66 }} placeholder="정원"
                                  value={ov.capacity} onChange={(e) => setOv({ capacity: e.target.value })} />
                              </div>

                              {rooms.length > 0 && (
                                <div className="perday-sub">
                                  <span className="perday-sub-label">룸</span>
                                  <div className="perday-chips">
                                    <button className={`filter-chip sm ${ov.roomId === undefined ? "on" : ""}`}
                                      onClick={() => setOv({ roomId: undefined })}>공통</button>
                                    <button className={`filter-chip sm ${ov.roomId === null ? "on" : ""}`}
                                      onClick={() => setOv({ roomId: null })}>없음</button>
                                    {rooms.map((r) => (
                                      <button key={r.id} className={`filter-chip sm ${ov.roomId === r.id ? "on" : ""}`}
                                        onClick={() => setOv({ roomId: r.id })}>{r.name}</button>
                                    ))}
                                  </div>
                                </div>
                              )}

                              <div className="perday-sub">
                                <span className="perday-sub-label">취소</span>
                                <div className="deadline-row">
                                  <input className="input-field deadline-num" inputMode="numeric" placeholder="0"
                                    value={ov.cd} onChange={(e) => setOv({ cd: e.target.value })} />
                                  <span className="deadline-unit">일</span>
                                  <input className="input-field deadline-num" inputMode="numeric" placeholder="0"
                                    value={ov.ch} onChange={(e) => setOv({ ch: e.target.value })} />
                                  <span className="deadline-unit">시간</span>
                                  <input className="input-field deadline-num" inputMode="numeric" placeholder="0"
                                    value={ov.cm} onChange={(e) => setOv({ cm: e.target.value })} />
                                  <span className="deadline-unit">분 전</span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        <div className="perm-guide" style={{ margin: "4px 0 0" }}>
                          비워둔 칸은 아래 <b>공통 설정</b> 값이 그대로 들어가요.
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              <input className="input-field" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            )}
            {perDayMode && repeat && !editId && (
              <div className="common-box-label">공통 설정 <span>· 위에서 비워둔 칸에 적용돼요</span></div>
            )}
            <div className={perDayMode && repeat && !editId ? "common-box" : ""}>
              <div className="menu-section-label" style={{ padding: "14px 0 6px" }}>시간</div>
              <div className="time-row">
                <input className="input-field" type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
                <span className="time-sep">~</span>
                <input className="input-field" type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
              </div>
              <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>정원</div>
              <div className="deadline-row">
                <input className="input-field" inputMode="numeric" style={{ maxWidth: 90 }}
                  value={form.capacity} placeholder="8"
                  onChange={(e) => {
                    const n = parseInt(e.target.value.replace(/[^0-9]/g, "") || "0", 10);
                    setForm({ ...form, capacity: n });
                  }} />
                <span className="deadline-unit">명</span>
              </div>

            {rooms.length > 0 && (
              <>
                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>룸(장소)</div>
                <div className="mem-filters" style={{ padding: 0 }}>
                  <button className={`filter-chip ${!form.roomId ? "on" : ""}`} onClick={() => setForm({ ...form, roomId: null })}>미지정</button>
                  {rooms.map((r) => (
                    <button key={r.id} className={`filter-chip ${form.roomId === r.id ? "on" : ""}`} onClick={() => setForm({ ...form, roomId: r.id })}>{r.name}</button>
                  ))}
                </div>
              </>
            )}

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>예약취소 가능 시간</div>
            <div className="deadline-row">
              <span className="deadline-pre">수업 시작</span>
              <input className="input-field deadline-num" inputMode="numeric" placeholder="0"
                value={cancelD} onChange={(e) => setCancelD(e.target.value)} />
              <span className="deadline-unit">일</span>
              <input className="input-field deadline-num" inputMode="numeric" placeholder="0"
                value={cancelH} onChange={(e) => setCancelH(e.target.value)} />
              <span className="deadline-unit">시간</span>
              <input className="input-field deadline-num" inputMode="numeric" placeholder="0"
                value={cancelM} onChange={(e) => setCancelM(e.target.value)} />
              <span className="deadline-unit">분 전까지</span>
            </div>
            <div className="perm-guide" style={{ margin: "4px 0 0" }}>
              모두 비우면 운영설정의 기본 취소 시간이 적용돼요.
            </div>
            </div>

            {/* 상품 사용 허용 */}
            <div className="set-row" style={{ padding: "12px 0", borderBottom: "none" }}>
              <div className="set-label">보유 상품 사용 허용<br /><span style={{ fontSize: 11, color: "var(--text-dim)" }}>회원이 예약 시 대여 상품 등을 함께 쓸 수 있어요</span></div>
              <button className={`switch ${form.allowGoods ? "on" : ""}`} onClick={() => setForm({ ...form, allowGoods: !form.allowGoods })}>
                <span className="knob" />
              </button>
            </div>

            {/* 예약 가능 수강권 선택 */}
            <div className="menu-section-label" style={{ padding: "8px 0 6px" }}>예약 가능 수강권</div>
            <div className="perm-guide" style={{ margin: "0 0 8px" }}>
              선택 안 하면 <b>모든 수강권</b>으로 예약 가능해요. 특정 수강권만 고르면 그 수강권 보유자만 예약할 수 있어요.
            </div>
            {passProducts.length === 0 ? (
              <div className="daylist-empty" style={{ padding: "8px 0" }}>
                <span style={{ fontSize: 12 }}>등록된 수강권이 없어요 (수강권 관리에서 먼저 추가)</span>
              </div>
            ) : (
              <div className="mem-filters" style={{ padding: "0 0 6px" }}>
                {passProducts.map((p) => (
                  <button
                    key={p.id}
                    className={`filter-chip ${selectedProducts.includes(p.id) ? "on" : ""}`}
                    onClick={() => setSelectedProducts((prev) => prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id])}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}

            {/* 반복 수업 일괄 적용 (그룹 소속 수정일 때만) */}
            {editId && editGroupId && (
              <div className="set-row" style={{ padding: "10px 0", borderBottom: "none" }}>
                <div className="set-label">모든 반복 수업에 적용<br /><span style={{ fontSize: 11, color: "var(--text-dim)" }}>수업명·시간·정원이 전체에 반영돼요 (날짜 제외)</span></div>
                <button className={`switch ${applyToGroup ? "on" : ""}`} onClick={() => setApplyToGroup(!applyToGroup)}>
                  <span className="knob" />
                </button>
              </div>
            )}

            <button className="primary-btn" style={{ marginTop: 20 }} disabled={busy} onClick={save}>
              {busy ? "저장 중..." : editId ? "수정하기" : "등록하기"}
            </button>
          </div>
        </div>
      )}

      {/* 삭제 확인 시트 */}
      {deleteTarget && (
        <div className="sheet-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">수업 삭제</div>
            <div className="perm-guide" style={{ margin: "0 0 14px" }}>
              &apos;{deleteTarget.title}&apos; ({deleteTarget.date} {deleteTarget.start})
              {deleteTarget.recurringGroupId ? " 은(는) 반복 수업이에요. 어떻게 삭제할까요?" : " 수업을 삭제할까요?"}
            </div>

            {deleteTarget.recurringGroupId ? (
              <div className="del-options">
                <button className="del-opt" disabled={busy} onClick={() => doDelete(false)}>
                  <div className="del-opt-title">이번 수업만 삭제</div>
                  <div className="del-opt-sub">{deleteTarget.date} 이 수업 하나만</div>
                </button>
                <button className="del-opt danger" disabled={busy} onClick={() => doDelete(true)}>
                  <div className="del-opt-title">반복 수업 전체 삭제</div>
                  <div className="del-opt-sub">같은 반복으로 만든 모든 수업</div>
                </button>
                <button className="ghost-btn" style={{ width: "100%", marginTop: 10 }} onClick={() => setDeleteTarget(null)}>취소</button>
              </div>
            ) : (
              <div className="add-profile-actions">
                <button className="ghost-btn" onClick={() => setDeleteTarget(null)}>취소</button>
                <button className="primary-btn danger-btn" disabled={busy} onClick={() => doDelete(false)}>삭제</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 예약자 명단 시트 */}
      {/* 보강 예약 - 회원 선택 */}
      {bookSheet && rosterClass && (
        <div className="sheet-overlay on-top" onClick={() => setBookSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">보강 예약</div>
            <div className="perm-guide" style={{ margin: "0 0 12px" }}>
              {rosterClass.date} {rosterClass.start} · {rosterClass.title}<br />
              수강권 요일 조건과 상관없이 예약을 넣을 수 있어요.
            </div>

            {!bookPick ? (
              <>
                <input className="input-field" placeholder="회원 이름 검색"
                  value={bookKw} onChange={(e) => setBookKw(e.target.value)} />
                <div className="book-member-list">
                  {bookMembers
                    .filter((m) => !bookKw.trim() || m.name.includes(bookKw.trim()))
                    .slice(0, 50)
                    .map((m) => (
                      <button key={m.profileId} className="book-member-row"
                        onClick={() => { setBookPick(m); setBookMemId(m.memberships[0]?.id ?? null); }}>
                        <span className="book-member-name">{m.name}</span>
                        <span className="book-member-pass">
                          {m.memberships.length > 0
                            ? `${m.memberships[0].name}${m.memberships[0].remaining != null ? ` ${m.memberships[0].remaining}회` : ""}`
                            : "수강권 없음"}
                        </span>
                      </button>
                    ))}
                  {bookMembers.length === 0 && (
                    <div className="daylist-empty" style={{ padding: 16 }}>회원이 없어요</div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>선택한 회원</div>
                <div className="book-picked">
                  <span>{bookPick.name}</span>
                  <button className="text-btn" onClick={() => setBookPick(null)}>변경</button>
                </div>

                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>사용할 수강권</div>
                {bookPick.memberships.length === 0 ? (
                  <div className="perm-guide" style={{ margin: 0 }}>
                    보유 수강권이 없어요. 수강권 없이 예약만 넣을 수 있어요.
                  </div>
                ) : (
                  <div className="mem-filters" style={{ padding: 0 }}>
                    <button className={`filter-chip ${!bookMemId ? "on" : ""}`} onClick={() => setBookMemId(null)}>
                      사용 안 함
                    </button>
                    {bookPick.memberships.map((mm) => (
                      <button key={mm.id} className={`filter-chip ${bookMemId === mm.id ? "on" : ""}`}
                        onClick={() => setBookMemId(mm.id)}>
                        {mm.name}{mm.remaining != null ? ` ${mm.remaining}회` : ""}
                      </button>
                    ))}
                  </div>
                )}

                {bookMemId && (
                  <div className="set-row" style={{ padding: "12px 0 4px" }}>
                    <div className="set-label">횟수 차감하기</div>
                    <button className={`switch ${bookDeduct ? "on" : ""}`} onClick={() => setBookDeduct((v) => !v)}>
                      <span className="knob" />
                    </button>
                  </div>
                )}
                {bookMemId && !bookDeduct && (
                  <div className="perm-guide" style={{ margin: "4px 0 0" }}>
                    보강 등 무료 수업이면 차감을 꺼두세요.
                  </div>
                )}
              </>
            )}

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setBookSheet(false)}>취소</button>
              <button className="primary-btn" disabled={bookBusy || !bookPick} onClick={handleBook}>
                {bookBusy ? "처리 중..." : "예약 넣기"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 미배치 수강권 */}
      {unplacedSheet && (
        <div className="sheet-overlay" onClick={() => setUnplacedSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">배치 안 된 수강권</div>
            <div className="perm-guide" style={{ margin: "0 0 12px" }}>
              요일반 수강권을 샀지만 정원이 차거나 수업이 없어서
              예약이 다 잡히지 못한 회원이에요.<br />
              <b>정원을 늘리거나 수업을 추가한 뒤</b> "다시 배치"를 누르면 자동으로 넣어드려요.
              보강 예약으로 직접 넣어도 돼요. (먼저 구매한 순서)
            </div>

            <div className="unplaced-list">
              {unplaced.map((u) => (
                <div key={u.membershipId} className="unplaced-row">
                  <div className="unplaced-main">
                    <div className="unplaced-name">
                      {u.memberName}
                      <span className="unplaced-remain">{u.remainingCount}회 남음</span>
                    </div>
                    <div className="unplaced-sub">
                      {u.productName}
                      {u.autoBookDays.length > 0 && (
                        <> · {u.autoBookDays.map((d) => WEEKDAYS[d]).join("·")}요일</>
                      )}
                      {u.expiresAt && <> · ~{u.expiresAt.slice(5).replace("-", "/")}</>}
                    </div>
                    <div className="unplaced-sub">{u.purchasedAt} 구매</div>
                  </div>
                  <button className="unplaced-retry" disabled={unplacedBusy}
                    onClick={() => handleRetryAutoBook(u)}>다시 배치</button>
                </div>
              ))}
            </div>

            <button className="ghost-btn" style={{ width: "100%", marginTop: 12 }} onClick={() => setUnplacedSheet(false)}>닫기</button>
          </div>
        </div>
      )}

      {/* 스케줄 복사 */}
      {copySheet && (
        <div className="sheet-overlay" onClick={() => setCopySheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">스케줄 복사</div>

            {/* 복사 방식 */}
            <div className="mem-filters" style={{ padding: 0 }}>
              <button className={`filter-chip ${copyMode === "weekday" ? "on" : ""}`}
                onClick={() => { setCopyMode("weekday"); setCopyPlan(null); if (copyFrom) loadCopySource(copyFrom, "weekday"); }}>
                요일 기준
              </button>
              <button className={`filter-chip ${copyMode === "date" ? "on" : ""}`}
                onClick={() => { setCopyMode("date"); setCopyPlan(null); if (copyFrom) loadCopySource(copyFrom, "date"); }}>
                날짜 기준
              </button>
            </div>
            <div className="perm-guide" style={{ margin: "6px 0 12px" }}>
              {copyMode === "weekday"
                ? "같은 요일에 배치돼요. (7월 화요일 수업 → 8월 모든 화요일)"
                : "같은 일자에 배치돼요. (7월 2일 수업 → 8월 2일)"}
            </div>

            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>복사할 달 (원본)</div>
            <input className="input-field" type="month" value={copyFrom}
              onChange={(e) => { setCopyFrom(e.target.value); loadCopySource(e.target.value, copyMode); }} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>붙여넣을 달 (대상)</div>
            <input className="input-field" type="month" value={copyTo}
              onChange={(e) => { setCopyTo(e.target.value); setCopyPlan(null); }} />

            {/* 수업 선택 */}
            {(copyMode === "weekday" ? copyGroups.length > 0 : copyDateItems.length > 0) && (
              <>
                <div className="copy-select-head">
                  <span className="menu-section-label" style={{ padding: 0 }}>
                    복사할 수업 ({copySelected.size})
                  </span>
                  <span className="copy-select-btns">
                    <button className="text-btn" onClick={selectAllCopy}>전체선택</button>
                    <button className="text-btn" onClick={clearAllCopy}>전체해제</button>
                  </span>
                </div>
                <div className="copy-select-list">
                  {copyMode === "weekday"
                    ? copyGroups.map((g) => (
                        <label key={g.key} className="copy-select-row">
                          <input type="checkbox" checked={copySelected.has(g.key)} onChange={() => toggleCopyItem(g.key)} />
                          <span className="copy-select-main">
                            <b>{g.title}</b>
                            <span className="copy-select-sub">
                              {WEEKDAYS[g.dow]}요일 {g.start}~{g.end} · 정원 {g.capacity}명 · {g.dates.length}회
                            </span>
                          </span>
                        </label>
                      ))
                    : copyDateItems.map((i) => (
                        <label key={i.key} className="copy-select-row">
                          <input type="checkbox" checked={copySelected.has(i.key)} onChange={() => toggleCopyItem(i.key)} />
                          <span className="copy-select-main">
                            <b>{i.title}</b>
                            <span className="copy-select-sub">
                              {i.date.slice(5).replace("-", "/")} ({WEEKDAYS[new Date(`${i.date}T12:00:00Z`).getUTCDay()]}) {i.start}~{i.end} · 정원 {i.capacity}명
                            </span>
                          </span>
                        </label>
                      ))}
                </div>
              </>
            )}

            <button className="ghost-btn" style={{ marginTop: 12 }} disabled={copyBusy} onClick={handlePreviewCopy}>
              {copyBusy ? "확인 중..." : "미리보기"}
            </button>

            {/* 미리보기 */}
            {copyPlan && (
              <>
                <div className="copy-select-head">
                  <span className="menu-section-label" style={{ padding: 0 }}>
                    복사될 수업 {copyPlan.length}개
                  </span>
                  <button className="copy-view-btn" onClick={() => setCopyView(copyView === "list" ? "calendar" : "list")}>
                    {copyView === "list" ? "📅 달력" : "☰ 목록"}
                  </button>
                </div>

                {copyPlan.length === 0 ? (
                  <div className="daylist-empty" style={{ padding: 16 }}>복사할 수업이 없어요</div>
                ) : copyView === "list" ? (
                  <div className="copy-preview">
                    {copyPlan.slice(0, 40).map((p, i) => (
                      <div key={i} className="copy-preview-row">
                        <span className="copy-preview-date">{p.date.slice(5).replace("-", "/")}</span>
                        <span className="copy-preview-title">{p.title}</span>
                        <span className="copy-preview-time">{p.start}</span>
                      </div>
                    ))}
                    {copyPlan.length > 40 && (
                      <div className="perm-guide" style={{ margin: "6px 0 0" }}>외 {copyPlan.length - 40}개 더…</div>
                    )}
                  </div>
                ) : (
                  <CopyCalendar month={copyTo} plan={copyPlan} />
                )}
              </>
            )}

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setCopySheet(false)}>취소</button>
              <button className="primary-btn" disabled={copyBusy || !copyPlan || copyPlan.length === 0} onClick={handleCopy}>
                복사하기
              </button>
            </div>
          </div>
        </div>
      )}

      {rosterClass && (
        <div className="sheet-overlay" onClick={() => setRosterClass(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{rosterClass.title} 예약자</div>
            <button className="ghost-btn" style={{ marginBottom: 10 }} onClick={openBookSheet}>
              + 회원 추가 (보강 예약)
            </button>
            <div className="hist-summary" style={{ padding: "0 0 8px" }}>
              {rosterClass.date} {rosterClass.start}~{rosterClass.end}
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

      {/* 회원 정보 팝업 (명단에서 이름 클릭) */}
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
