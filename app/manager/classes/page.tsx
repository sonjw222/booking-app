"use client";

/*
  수업 관리 화면 (매니저용)
  - 내 센터의 수업 목록 (이번 달)
  - 수업 등록 / 수정 / 삭제 (하단 시트 폼)
  - 매니저 RLS 정책 필요 (reservation_functions.sql)
*/

import { useCallback, useEffect, useRef, useState } from "react";
import { diagEvent } from "../../../lib/_diag220"; // TEMP-DIAG(P2-20, 제거 예정)
import Loading from "../../components/Loading";
import ManagerNav from "../../components/ManagerNav";
import AmPmTimeInput from "../../components/AmPmTimeInput";
import { dhmToMinutes, minutesToDhm } from "../../../lib/deadlineInput";
import CopyCalendar from "./CopyCalendar";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchRooms, type Room } from "../../../lib/rooms";
import {
  fetchClasses, createClass, updateClass, deleteClass,
  createRecurringClasses, expandRecurringDates,
  updateClassGroup, deleteClassGroup,
  fetchClassAttendees, setAttendance, fetchClassProducts, setClassProducts, setClassProductsBulk,
  fetchCenterHolidayDates,
  fetchCopyGroups, fetchCopyDateItems, planCopyByWeekday, planCopyByDate,
  copyByWeekday, copyByDate,
  type CopyGroup, type CopyDateItem, type CopyPlanItem,
  fetchBookableMembers, managerBookMember, type BookableMember, maskPhone,
  fetchUnplacedPasses, retryAutoBook, type UnplacedPass,
  type ManagedClass, type ClassInput, type ClassAttendee,
  isValidClassTimeRange,
} from "../../../lib/classes";
import { fetchMemberDetail, type MemberDetailData } from "../../../lib/members";
import { fetchProducts, type Product } from "../../../lib/passes";
import { assignReservation, cancelAdminReservation, type AssignmentType } from "../../../lib/adminAssignment";
import {
  ADMIN_REASON_CODES, ADMIN_REASON_LABELS, type AdminReasonCode,
  normalizeReasonDetail, adminBadges,
} from "../../../lib/reservationTypes";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

const EMPTY: ClassInput = { title: "", date: "", start: "", end: "", capacity: 8, allowGoods: true, roomId: null, cancelDeadlineMin: null, bookingDeadlineMin: null, classFormat: "group" };

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
  const [bookD, setBookD] = useState("");
  const [bookH, setBookH] = useState("");
  const [bookM, setBookM] = useState("");
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
  // 관리자 직접배치 / 무료 추가 배치
  const [assignMode, setAssignMode] = useState(false);
  const [assignMember, setAssignMember] = useState<BookableMember | null>(null);
  const [assignPrefillMembershipId, setAssignPrefillMembershipId] = useState<string | null>(null);
  const [assignMemberSheet, setAssignMemberSheet] = useState(false);
  const [assignMembersList, setAssignMembersList] = useState<BookableMember[]>([]);
  const [assignKw, setAssignKw] = useState("");
  const [assignMenuFor, setAssignMenuFor] = useState<string | null>(null);
  type AssignConfirmState = {
    classItem: ManagedClass;
    type: AssignmentType;
    membershipId: string | null;
    reasonCode: AdminReasonCode | null;
    reasonDetail: string;
    capacityBlocked: boolean;
  };
  const [assignConfirm, setAssignConfirm] = useState<AssignConfirmState | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);
  // 관리자 배치 취소 (예약자 명단에서)
  const [adminCancelTarget, setAdminCancelTarget] = useState<ClassAttendee | null>(null);
  const [adminCancelReason, setAdminCancelReason] = useState("");
  const [adminCancelBusy, setAdminCancelBusy] = useState(false);
  // 회원 정보 팝업 (명단에서 이름 클릭)
  const [memberInfo, setMemberInfo] = useState<{ name: string; profileId: string; data: MemberDetailData | null } | null>(null);
  // 수강권 목록 + 폼에서 선택된 수강권
  const [passProducts, setPassProducts] = useState<Product[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [passSearch, setPassSearch] = useState(""); // P3: 예약 가능 수강권 선택 목록 검색
  // TEMP-DIAG(P2-20, 제거 예정): openEdit()이 재진입/재클릭으로 여러 번 겹쳐 호출될 때
  // "늦게 도착한 fetchClassProducts 결과가 최신 openEdit 호출을 덮어쓰는지"를 구분하기 위한 토큰,
  // 그리고 이 open 세션 동안 사용자가 이미 칩을 클릭했는지("dirty") 여부.
  const openTokenRef = useRef(0);
  const userEditedRef = useRef(false);
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
      // TEMP-DIAG(P2-20, 제거 예정): passProducts 로딩 useEffect — 재실행 빈도/실패 여부 확인용.
      diagEvent("EFFECT_PASSPRODUCTS_START", { activeCenterId, year, month });
      fetchProducts(activeCenterId, "pass")
        .then((list) => {
          diagEvent("EFFECT_PASSPRODUCTS_DONE", { activeCenterId, count: list.length });
          setPassProducts(list);
        })
        .catch((e: any) => {
          diagEvent("EFFECT_PASSPRODUCTS_ERROR", { activeCenterId, errorMessage: e?.message, errorCode: e?.code });
        });
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
  function goToday() {
    const t = new Date();
    setYear(t.getFullYear());
    setMonth(t.getMonth() + 1);
    setSelectedDay(t.getDate());
  }

  // 일/시간/분 ↔ 분 변환은 lib/deadlineInput.ts의 공용 함수를 쓴다(취소마감/예약마감 동일 규칙,
  // CLASS-001에서 예약마감 추가 시 취소마감과 로직 중복 대신 공용화 + 단위테스트 가능하도록 정리).
  function deadlineToMin(): number | null {
    return dhmToMinutes(cancelD, cancelH, cancelM);
  }
  function fillDeadline(min: number | null) {
    const { d, h, m } = minutesToDhm(min);
    setCancelD(d); setCancelH(h); setCancelM(m);
  }
  function bookDeadlineToMin(): number | null {
    return dhmToMinutes(bookD, bookH, bookM);
  }
  function fillBookDeadline(min: number | null) {
    const { d, h, m } = minutesToDhm(min);
    setBookD(d); setBookH(h); setBookM(m);
  }

  function openCreate() {
    setEditId(null);
    setCancelD(""); setCancelH(""); setCancelM("");
    setBookD(""); setBookH(""); setBookM("");
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
    setPassSearch("");
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

  // --- 관리자 직접배치 / 무료 추가 배치 ---
  function openAssignMemberPicker() {
    if (!activeCenterId) return;
    setAssignKw("");
    setAssignMemberSheet(true);
    fetchBookableMembers(activeCenterId).then(setAssignMembersList).catch((e: any) => setError(e.message));
  }

  function pickAssignMember(m: BookableMember, prefillMembershipId: string | null = null) {
    setAssignMember(m);
    setAssignPrefillMembershipId(prefillMembershipId);
    setAssignMemberSheet(false);
    setAssignMode(true);
  }

  function exitAssignMode() {
    setAssignMode(false);
    setAssignMember(null);
    setAssignPrefillMembershipId(null);
    setAssignMenuFor(null);
  }

  // 미배치 수강권 목록에서 바로 직접배치로 진입 (회원+수강권 미리 채움)
  function startAssignFromUnplaced(u: UnplacedPass) {
    setUnplacedSheet(false);
    pickAssignMember(
      {
        profileId: u.profileId,
        name: u.memberName,
        phone: null,
        memberStatus: "active",
        memberships: [{ id: u.membershipId, name: u.productName, remaining: u.remainingCount }],
      },
      u.membershipId
    );
  }

  // 수업이 배치 가능한 상태인지 (취소/마감/시작됨 여부)
  function classAssignability(c: ManagedClass): { ok: boolean; reason: string | null } {
    if (c.status === "cancelled") return { ok: false, reason: "취소된 수업" };
    if (c.status === "closed") return { ok: false, reason: "마감된 수업" };
    const started = new Date(`${c.date}T${c.start}:00+09:00`).getTime() <= Date.now();
    if (started) return { ok: false, reason: "이미 시작됨" };
    return { ok: true, reason: null };
  }

  function openAssignConfirm(c: ManagedClass, type: AssignmentType) {
    setAssignMenuFor(null);
    if (!assignMember) return;
    const membershipId = type === "ADMIN_ASSIGNMENT"
      ? (assignPrefillMembershipId ?? assignMember.memberships[0]?.id ?? null)
      : null;
    setAssignConfirm({
      classItem: c, type, membershipId,
      reasonCode: null, reasonDetail: "",
      capacityBlocked: c.reserved >= c.capacity,
    });
  }

  async function handleAssignSubmit(force: boolean) {
    if (!assignConfirm || !assignMember) return;
    const { classItem, type, membershipId, reasonCode, reasonDetail, capacityBlocked } = assignConfirm;

    if (type === "ADMIN_ASSIGNMENT" && !membershipId) { setError("사용할 수강권을 선택해주세요"); return; }
    if (type === "ADMIN_FREE" && !reasonCode) { setError("무료 추가 배치 사유를 선택해주세요"); return; }
    if (capacityBlocked && !reasonCode) { setError("정원 초과 배치 사유를 입력해주세요"); return; }
    if (reasonCode === "OTHER" && !normalizeReasonDetail(reasonDetail)) { setError("기타 사유를 입력해주세요"); return; }

    setAssignBusy(true);
    setError(null);
    try {
      const result = await assignReservation({
        classId: classItem.id,
        profileId: assignMember.profileId,
        assignmentType: type,
        membershipId,
        reasonCode,
        reasonDetail: normalizeReasonDetail(reasonDetail),
        forceCapacity: force,
      });
      if (result.needsCapacityConfirm) {
        setAssignConfirm({ ...assignConfirm, capacityBlocked: true });
        return;
      }
      const dateLabel = classItem.date.slice(5).replace("-", "/");
      showToast(`${assignMember.name} 회원이 ${dateLabel} ${classItem.start} ${classItem.title} 수업에 배치되었습니다.`);
      setAssignConfirm(null);
      if (activeCenterId) {
        await loadClasses(activeCenterId, year, month);
        await loadUnplaced(activeCenterId);
        if (rosterClass?.id === classItem.id) setRoster(await fetchClassAttendees(classItem.id));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAssignBusy(false);
    }
  }

  async function handleAdminCancel() {
    if (!adminCancelTarget) return;
    setAdminCancelBusy(true);
    try {
      await cancelAdminReservation(adminCancelTarget.reservationId, adminCancelReason);
      showToast("관리자 배치 예약을 취소했어요");
      setAdminCancelTarget(null);
      setAdminCancelReason("");
      if (rosterClass) setRoster(await fetchClassAttendees(rosterClass.id));
      if (activeCenterId) await loadClasses(activeCenterId, year, month);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAdminCancelBusy(false);
    }
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
    // TEMP-DIAG(P2-20, 제거 예정): 이 open 호출 고유 토큰 + "이 open 세션 동안 사용자가
    // 직접 편집했는지" 플래그. 늦게 도착하는 초기 hydrate fetch가 그사이의 사용자 편집을
    // 덮어쓰는지(Race A), 또는 그사이 다른 openEdit 호출이 있었는지(Race D)를 구분한다.
    const myToken = ++openTokenRef.current;
    userEditedRef.current = false;
    diagEvent("OPEN_START", { classId: c.id, token: myToken });
    setEditId(c.id);
    setEditGroupId(c.recurringGroupId);
    setApplyToGroup(false);
    setForm({ title: c.title, date: c.date, start: c.start, end: c.end, capacity: c.capacity, allowGoods: c.allowGoods, roomId: c.roomId, cancelDeadlineMin: c.cancelDeadlineMin, bookingDeadlineMin: c.bookingDeadlineMin, classFormat: c.classFormat });
    fillDeadline(c.cancelDeadlineMin);
    fillBookDeadline(c.bookingDeadlineMin);
    setSelectedProducts([]);
    setPassSearch("");
    setError(null);
    setFormOpen(true);
    try {
      const ids = await fetchClassProducts(c.id);
      // race 수정(P2-20, 실측 confirm): 이 초기 hydrate fetch는 시트를 연 시점의 저장된
      // 선택값을 "미리 채워 넣기" 위한 것뿐이다 — 그게 도착하기 전에 사용자가 이미 칩을
      // 클릭했거나(userEditedRef) 그사이 다른 openEdit이 또 호출됐다면(토큰 불일치),
      // 이 결과는 더 이상 "최신 진실"이 아니므로 적용하지 않는다. 실측(diagEvent 타임라인,
      // run 31296479955)으로 이 경합이 "칩 클릭 → 저장" 실패의 정확한 원인임을 확인했다:
      // fetch가 클릭보다 늦게 끝나면 setSelectedProducts(ids)가 사용자의 선택을 조용히 덮어썼다.
      const isStale = myToken !== openTokenRef.current || userEditedRef.current;
      diagEvent("APPLY_FETCH_RESULT", { // TEMP-DIAG(P2-20, 제거 예정)
        classId: c.id,
        token: myToken,
        ids,
        isStaleToken: myToken !== openTokenRef.current,
        userEditedSinceOpen: userEditedRef.current,
        applied: !isStale,
      });
      if (!isStale) setSelectedProducts(ids);
    } catch (e: any) {
      diagEvent("FETCH_CLASS_PRODUCTS_CAUGHT_ERROR", { classId: c.id, token: myToken, errorMessage: e?.message, errorCode: e?.code });
    }
  }

  async function save() {
    // TEMP-DIAG(P2-20, 제거 예정): save() 진입 시점 state snapshot.
    diagEvent("SAVE_START", { editId, repeat, selectedProducts, openToken: openTokenRef.current }); // TEMP-DIAG(P2-20, 제거 예정)
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
      if (!perDayMode && !isValidClassTimeRange(form.start, form.end)) {
        setError("종료시간은 시작시간 이후여야 해요 (자정을 넘기는 경우는 6시간 이내만 허용)");
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
              // 예약마감(CLASS-001)은 요일별 개별 지정 UI가 없어 공통 설정값을 그대로 쓴다
              // (취소마감의 요일별 오버라이드와 달리, 예약마감은 이번 배치 범위를 공통값으로
              // 한정함 — 모바일 컴팩트 그리드에 3-select 오전/오후 UI를 넣기엔 공간이 부족).
              bookingDeadlineMin: bookDeadlineToMin(),
              excludeDates: holidays,
            });
            ids = ids.concat(partIds);
          }
        } else {
          ids = await createRecurringClasses(activeCenterId, {
            title: form.title, daysOfWeek: repDays,
            fromDate: repFrom, toDate: repTo,
            start: form.start, end: form.end, capacity: form.capacity, roomId: form.roomId, cancelDeadlineMin: deadlineToMin(),
            bookingDeadlineMin: bookDeadlineToMin(),
            excludeDates: holidays,
          });
        }
        // 선택한 수강권을 모든 생성 수업에 연결
        if (selectedProducts.length > 0) await setClassProductsBulk(ids, selectedProducts);
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
    if (!isValidClassTimeRange(form.start, form.end)) {
      setError("종료시간은 시작시간 이후여야 해요 (자정을 넘기는 경우는 6시간 이내만 허용)");
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
      if (editId) {
        if (applyToGroup && editGroupId) {
          await updateClassGroup(editGroupId, form.title, form.start, form.end, form.capacity);
        } else {
          await updateClass(editId, { ...form, cancelDeadlineMin: deadlineToMin(), bookingDeadlineMin: bookDeadlineToMin() });
        }
        // TEMP-DIAG(P2-20, 제거 예정): setClassProducts 호출 직전 state snapshot(updateClass 이후).
        diagEvent("SET_CLASS_PRODUCTS_CALL_EDIT", { editId, selectedProducts });
        await setClassProducts(editId, selectedProducts);
      } else {
        const newId = await createClass(activeCenterId, { ...form, cancelDeadlineMin: deadlineToMin(), bookingDeadlineMin: bookDeadlineToMin() });
        diagEvent("SET_CLASS_PRODUCTS_CALL_NEW", { newId, selectedProducts });
        await setClassProducts(newId, selectedProducts);
      }

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
        <button className="cal-export-btn" style={{ fontSize: 12 }} onClick={openCopy}>복사</button>
        <div className="title">내 일정</div>
        <a className="cal-export-btn" href="/manager/holidays" style={{ fontSize: 12 }}>휴무일</a>
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

      {!assignMode ? (
        <button className="unplaced-banner" style={{ background: "var(--surface-2, #f4f4f4)" }} onClick={openAssignMemberPicker}>
          <span className="unplaced-icon">🗓️</span>
          <span className="unplaced-text">회원 직접배치</span>
          <span className="unplaced-go">시작 ›</span>
        </button>
      ) : (
        <div className="assign-banner">
          <div className="assign-banner-main">
            <div className="assign-banner-title">직접배치 대상 회원</div>
            <div className="assign-banner-name">
              {assignMember?.name}
              <span className="assign-banner-phone"> · {maskPhone(assignMember?.phone ?? null)}</span>
            </div>
            <div className="assign-banner-sub">
              {assignMember && assignMember.memberships.length > 0
                ? assignMember.memberships.map((m) => `${m.name}${m.remaining != null ? ` ${m.remaining}회` : ""}`).join(", ")
                : "보유 수강권 없음"}
              {assignMember?.memberStatus && assignMember.memberStatus !== "active" && (
                <> · {assignMember.memberStatus === "expired" ? "만료회원" : "휴면회원"}</>
              )}
            </div>
          </div>
          <button className="ghost-btn assign-banner-exit" onClick={exitAssignMode}>직접배치 종료</button>
        </div>
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
        <button className="text-btn" onClick={goToday}>오늘</button>
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
        ) : assignMode ? (
          <div className="daylist-empty" style={{ paddingTop: 20 }}>이 날 등록된 수업이 없어요.</div>
        ) : (
          <div className="empty-action">
            <div className="empty-action-text">이 날 등록된 수업이 없어요.</div>
            <button className="empty-action-btn" onClick={openCreate}>+ 수업 등록하기</button>
          </div>
        )
      ) : assignMode ? (
        <div className="daylist" style={{ minHeight: 0, paddingTop: 4 }}>
          {dayClasses.map((c) => {
            const { ok, reason } = classAssignability(c);
            const full = c.reserved >= c.capacity;
            return (
              <div key={c.id} className="class-row">
                <div className="class-color" style={{ background: ok ? "var(--accent)" : "#999" }} />
                <div className="class-info">
                  <div className="class-row-title">{c.title}</div>
                  <div className="class-row-meta">
                    {c.start}~{c.end} · 예약 {c.reserved}/{c.capacity}
                    {full && <span className="hist-status s-cancelled" style={{ marginLeft: 6 }}>정원 마감</span>}
                    {!ok && <span className="hist-status s-cancelled" style={{ marginLeft: 6 }}>{reason}</span>}
                  </div>
                </div>
                {ok && (
                  <div className="assign-menu-wrap">
                    <button className="ghost-btn" onClick={() => setAssignMenuFor(assignMenuFor === c.id ? null : c.id)}>
                      배치 ▼
                    </button>
                    {assignMenuFor === c.id && (
                      <div className="assign-menu">
                        <button onClick={() => openAssignConfirm(c, "ADMIN_ASSIGNMENT")}>
                          <b>일반 직접배치</b>
                          <span>기존 미배치 건 또는 연결된 수강권을 사용해 배치합니다.</span>
                        </button>
                        <button onClick={() => openAssignConfirm(c, "ADMIN_FREE")}>
                          <b>무료 추가 배치</b>
                          <span>수강권 및 미배치 횟수를 사용하지 않고 무료로 추가 예약합니다.</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
      {!assignMode && <button className="fab-btn" onClick={openCreate}>+ 수업 등록</button>}

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
              <div className="ampm-time-row">
                <span className="ampm-time-label">시작</span>
                <AmPmTimeInput value={form.start} onChange={(v) => setForm({ ...form, start: v })} />
              </div>
              <div className="ampm-time-row">
                <span className="ampm-time-label">종료</span>
                <AmPmTimeInput value={form.end} onChange={(v) => setForm({ ...form, end: v })} />
              </div>
              <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>수업 형태</div>
              <div className="mem-filters" style={{ padding: 0 }}>
                <button className={`filter-chip ${form.classFormat !== "private" ? "on" : ""}`}
                  onClick={() => setForm({ ...form, classFormat: "group" })}>그룹</button>
                <button className={`filter-chip ${form.classFormat === "private" ? "on" : ""}`}
                  onClick={() => setForm({ ...form, classFormat: "private", capacity: 1 })}>프라이빗(1:1)</button>
              </div>

              <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>정원</div>
              <div className="deadline-row">
                <input className="input-field" inputMode="numeric" style={{ maxWidth: 90 }}
                  value={form.capacity} placeholder="8"
                  disabled={form.classFormat === "private"}
                  onChange={(e) => {
                    const n = parseInt(e.target.value.replace(/[^0-9]/g, "") || "0", 10);
                    setForm({ ...form, capacity: n });
                  }} />
                <span className="deadline-unit">명</span>
                {form.classFormat === "private" && (
                  <span className="deadline-unit" style={{ color: "var(--text-dim)" }}>(프라이빗은 항상 1명)</span>
                )}
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

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>예약 가능 시간(마감)</div>
            <div className="deadline-row">
              <span className="deadline-pre">수업 시작</span>
              <input className="input-field deadline-num" inputMode="numeric" placeholder="0"
                value={bookD} onChange={(e) => setBookD(e.target.value)} />
              <span className="deadline-unit">일</span>
              <input className="input-field deadline-num" inputMode="numeric" placeholder="0"
                value={bookH} onChange={(e) => setBookH(e.target.value)} />
              <span className="deadline-unit">시간</span>
              <input className="input-field deadline-num" inputMode="numeric" placeholder="0"
                value={bookM} onChange={(e) => setBookM(e.target.value)} />
              <span className="deadline-unit">분 전까지</span>
            </div>
            <div className="perm-guide" style={{ margin: "4px 0 0" }}>
              모두 비우면 운영설정의 기본 예약 마감 시간이 적용돼요. 지정하면 이 수업에는
              운영설정보다 이 값이 우선 적용돼요(CLASS-001).
            </div>

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

            {/* 예약 가능 수강권 선택 (P3: class_allowed_products) */}
            <div className="menu-section-label" style={{ padding: "8px 0 6px" }}>예약 가능 수강권</div>
            <div className="perm-guide" style={{ margin: "0 0 8px" }}>
              {selectedProducts.length === 0
                ? <>선택 안 하면 <b>모든 수강권</b>으로 예약 가능해요. 특정 수강권만 고르면 그 수강권 보유자만 예약할 수 있어요.</>
                : <><b>{selectedProducts.length}개</b> 수강권만 이 수업에 사용할 수 있어요.</>}
            </div>
            {passProducts.length === 0 ? (
              <div className="daylist-empty" style={{ padding: "8px 0" }}>
                <span style={{ fontSize: 12 }}>등록된 수강권이 없어요 (수강권 관리에서 먼저 추가)</span>
              </div>
            ) : (
              <>
                {passProducts.length > 1 && (
                  <input
                    className="input-field"
                    style={{ marginBottom: 8 }}
                    placeholder="수강권 이름 검색"
                    value={passSearch}
                    onChange={(e) => setPassSearch(e.target.value)}
                  />
                )}
                {selectedProducts.length > 0 && (
                  <button
                    className="text-btn"
                    style={{ marginBottom: 6 }}
                    onClick={() => {
                      userEditedRef.current = true; // TEMP-DIAG(P2-20, 제거 예정)
                      diagEvent("SET_SELECTED_PRODUCTS", { source: "deselect-all-button", prev: selectedProducts, next: [] });
                      setSelectedProducts([]);
                    }}
                  >
                    선택 해제 (모든 수강권 허용으로 전환)
                  </button>
                )}
                {(() => {
                  const q = passSearch.trim().toLowerCase();
                  const filtered = q ? passProducts.filter((p) => p.name.toLowerCase().includes(q)) : passProducts;
                  if (filtered.length === 0) {
                    return (
                      <div className="daylist-empty" style={{ padding: "8px 0" }}>
                        <span style={{ fontSize: 12 }}>"{passSearch}"와 일치하는 수강권이 없어요</span>
                      </div>
                    );
                  }
                  return (
                    <div className="mem-filters class-allowed-products-list" style={{ padding: "0 0 6px" }}>
                      {filtered.map((p) => (
                        <button
                          key={p.id}
                          className={`filter-chip ${selectedProducts.includes(p.id) ? "on" : ""}`}
                          onClick={() => {
                            // TEMP-DIAG(P2-20, 제거 예정): dirty 플래그 — 클릭 이벤트 핸들러 본문은
                            // (setState 함수형 업데이터와 달리) StrictMode에서 두 번 호출되지 않는다.
                            userEditedRef.current = true;
                            diagEvent("CHIP_CLICK", { productId: p.id });
                            setSelectedProducts((prev) => {
                              const next = prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id];
                              diagEvent("SET_SELECTED_PRODUCTS", { source: "chip", productId: p.id, prev, next });
                              return next;
                            });
                          }}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </>
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
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <button className="unplaced-retry" disabled={unplacedBusy}
                      onClick={() => handleRetryAutoBook(u)}>다시 배치</button>
                    <button className="unplaced-retry" style={{ background: "var(--surface-2, #eee)", color: "var(--text)" }}
                      onClick={() => startAssignFromUnplaced(u)}>직접배치</button>
                  </div>
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
                    {a.reservationType !== "MEMBER" && (
                      <div className="roster-badges">
                        {adminBadges({ type: a.reservationType, isCapacityOverride: a.isCapacityOverride, status: a.status }).map((b) => (
                          <span key={b} className="hist-status s-waitlisted">{b}</span>
                        ))}
                      </div>
                    )}
                    <div className="roster-actions">
                      {a.status === "cancelled" ? (
                        <span className="att-locked">취소된 예약 · 변경 불가</span>
                      ) : (
                        <>
                          {/* 대기(waitlisted)는 아직 확정된 적이 없어(수강권도 차감 안 됨) "출석/결석"을
                              매길 대상이 아니다 — manager_set_attendance()도 이 상태에선 attended/no_show를
                              거부한다(fix_attendance_consolidate_and_guard). 대기 취소만 남겨둔다. */}
                          {a.status !== "waitlisted" && (
                            <>
                              <button className={`att-btn ${a.status === "attended" ? "on" : ""}`} disabled={attBusy}
                                onClick={() => handleAttendance(a, "attended")}>출석</button>
                              {/* 결석(absence) 상태는 이 시스템에 없다 — 실제 결석 처리는 아래 "노쇼" 버튼이다.
                                  이 버튼은 status를 confirmed로 되돌려 출석/노쇼 표시를 취소(미정 상태로)한다 —
                                  예전엔 "결석"이라는 잘못된 라벨이 붙어 있어 실제 동작과 이름이 반대였다. */}
                              <button className={`att-btn ${a.status === "confirmed" ? "on" : ""}`} disabled={attBusy}
                                onClick={() => handleAttendance(a, "confirmed")}>되돌리기</button>
                              <button className={`att-btn ${a.status === "no_show" ? "on" : ""}`} disabled={attBusy}
                                onClick={() => handleAttendance(a, "no_show")}>결석(노쇼)</button>
                            </>
                          )}
                          {a.reservationType === "MEMBER" ? (
                            <button className="att-btn cancel" disabled={attBusy}
                              onClick={() => handleAttendance(a, "cancelled")}>예약취소</button>
                          ) : (
                            <button className="att-btn cancel" disabled={attBusy}
                              onClick={() => { setAdminCancelTarget(a); setAdminCancelReason(""); }}>관리자 배치 취소</button>
                          )}
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
      {/* 직접배치 - 대상 회원 선택 */}
      {assignMemberSheet && (
        <div className="sheet-overlay on-top" onClick={() => setAssignMemberSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">직접배치 대상 회원 선택</div>
            <input className="input-field" placeholder="회원 이름 검색"
              value={assignKw} onChange={(e) => setAssignKw(e.target.value)} />
            <div className="book-member-list">
              {assignMembersList
                .filter((m) => !assignKw.trim() || m.name.includes(assignKw.trim()))
                .slice(0, 50)
                .map((m) => (
                  <button key={m.profileId} className="book-member-row" onClick={() => pickAssignMember(m)}>
                    <span className="book-member-name">{m.name}</span>
                    <span className="book-member-pass">
                      {m.memberships.length > 0
                        ? `${m.memberships[0].name}${m.memberships[0].remaining != null ? ` ${m.memberships[0].remaining}회` : ""}`
                        : "수강권 없음"}
                    </span>
                  </button>
                ))}
              {assignMembersList.length === 0 && (
                <div className="daylist-empty" style={{ padding: 16 }}>회원이 없어요</div>
              )}
            </div>
            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setAssignMemberSheet(false)}>취소</button>
            </div>
          </div>
        </div>
      )}

      {/* 직접배치 - 확인 팝업 (일반 직접배치 / 무료 추가 배치 / 정원 초과) */}
      {assignConfirm && assignMember && (
        <div className="sheet-overlay on-top" onClick={() => !assignBusy && setAssignConfirm(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {assignConfirm.capacityBlocked ? (
              <>
                <div className="sheet-title">정원이 모두 찼습니다.</div>
                <div className="perm-guide" style={{ margin: "0 0 12px" }}>그래도 이 회원을 추가로 배치하시겠어요?</div>
              </>
            ) : (
              <>
                <div className="sheet-title">
                  {assignConfirm.type === "ADMIN_ASSIGNMENT" ? "회원을 이 수업에 배치하시겠습니까?" : "무료 추가 예약을 등록하시겠습니까?"}
                </div>
                <div className="perm-guide" style={{ margin: "0 0 12px" }}>
                  {assignConfirm.type === "ADMIN_ASSIGNMENT"
                    ? "관리자가 직접 배치한 예약은 수강권 종류 및 회원 예약 가능 시간 제한과 관계없이 등록됩니다."
                    : "이 예약은 이용권이나 미배치 횟수를 차감하지 않으며, 회원은 무료로 수업에 참여할 수 있습니다."}
                </div>
              </>
            )}

            {/* UI-004 B-3: 회원 이름과 수업 정보를 한 줄에 "·"로 이어붙이면 모바일에서 줄바꿈될 때
                두 정보가 뒤섞여 중복처럼 읽힌다는 피드백 — 이름/수업 정보를 별도 줄로 분리한다. */}
            <div className="hist-summary" style={{ padding: "0 0 8px" }}>
              <div className="assign-confirm-member">{assignMember.name} 회원</div>
              <div className="assign-confirm-class">{assignConfirm.classItem.date} {assignConfirm.classItem.start} · {assignConfirm.classItem.title}</div>
            </div>

            {assignConfirm.type === "ADMIN_ASSIGNMENT" && (
              <>
                <div className="menu-section-label" style={{ padding: "8px 0 6px" }}>사용할 미배치건/수강권</div>
                {assignMember.memberships.length === 0 ? (
                  <div className="perm-guide" style={{ margin: 0 }}>
                    이 회원은 보유한 수강권이 없어요. 무료 추가 배치를 이용해주세요.
                  </div>
                ) : (
                  <div className="mem-filters" style={{ padding: 0 }}>
                    {assignMember.memberships.map((mm) => (
                      <button key={mm.id} className={`filter-chip ${assignConfirm.membershipId === mm.id ? "on" : ""}`}
                        onClick={() => setAssignConfirm({ ...assignConfirm, membershipId: mm.id })}>
                        {mm.name}{mm.remaining != null ? ` ${mm.remaining}회` : ""}
                      </button>
                    ))}
                  </div>
                )}
                <div className="perm-guide" style={{ margin: "6px 0 0" }}>취소 시 이 수강권/미배치 상태가 그대로 복구돼요.</div>
              </>
            )}
            {assignConfirm.type === "ADMIN_FREE" && (
              <div className="perm-guide" style={{ margin: "0 0 8px" }}>수강권과 미배치 횟수는 차감되지 않아요.</div>
            )}

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
              배치 사유 {(assignConfirm.type === "ADMIN_FREE" || assignConfirm.capacityBlocked) && (
                <span style={{ color: "#c0392b", fontWeight: 700 }}>(필수)</span>
              )}
            </div>
            <div className="mem-filters" style={{ padding: 0 }}>
              {ADMIN_REASON_CODES.map((code) => (
                <button key={code} className={`filter-chip ${assignConfirm.reasonCode === code ? "on" : ""}`}
                  onClick={() => setAssignConfirm({ ...assignConfirm, reasonCode: code })}>
                  {ADMIN_REASON_LABELS[code]}
                </button>
              ))}
            </div>
            {assignConfirm.reasonCode === "OTHER" && (
              <>
                <textarea className="input-field" style={{ marginTop: 8, minHeight: 60, width: "100%" }}
                  placeholder="상세 사유 (필수, 최대 200자)" maxLength={200}
                  value={assignConfirm.reasonDetail}
                  onChange={(e) => setAssignConfirm({ ...assignConfirm, reasonDetail: e.target.value })} />
                <div className="perm-guide" style={{ margin: "2px 0 0", textAlign: "right" }}>
                  {assignConfirm.reasonDetail.length}/200
                </div>
              </>
            )}

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" disabled={assignBusy} onClick={() => setAssignConfirm(null)}>취소</button>
              <button className="primary-btn" disabled={assignBusy} onClick={() => handleAssignSubmit(assignConfirm.capacityBlocked)}>
                {assignBusy ? "배치 중..." : assignConfirm.capacityBlocked ? "그래도 배치" : "확인"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 관리자 배치 취소 확인 */}
      {adminCancelTarget && (
        <div className="sheet-overlay on-top" onClick={() => !adminCancelBusy && setAdminCancelTarget(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">이 회원의 관리자 배치 예약을 취소하시겠습니까?</div>
            <div className="perm-guide" style={{ margin: "0 0 12px" }}>
              관리자 배치 취소 내역은 별도로 기록되며 회원에게 취소 알림이 전송됩니다.
            </div>
            <div className="hist-summary" style={{ padding: "0 0 8px" }}>{adminCancelTarget.name} 회원</div>
            <input className="input-field" placeholder="취소 사유 (선택)"
              value={adminCancelReason} onChange={(e) => setAdminCancelReason(e.target.value)} />
            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" disabled={adminCancelBusy} onClick={() => setAdminCancelTarget(null)}>취소</button>
              <button className="primary-btn danger-btn" disabled={adminCancelBusy} onClick={handleAdminCancel}>
                {adminCancelBusy ? "처리 중..." : "관리자 배치 취소"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ManagerNav />
    </div>
  );
}
