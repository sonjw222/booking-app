"use client";

import Link from "next/link";
import SheetOverlay from "../../components/SheetOverlay";

/*
  수업 관리 화면 (매니저용)
  - 내 센터의 수업 목록 (이번 달)
  - 수업 등록 / 수정 / 삭제 (하단 시트 폼)
  - 매니저 RLS 정책 필요 (reservation_functions.sql)
*/

import { useCallback, useEffect, useRef, useState } from "react";
import Loading from "../../components/Loading";
import DatePicker from "../../components/DatePicker";
import MonthPicker from "../../components/MonthPicker";
import AmPmTimeInput from "../../components/AmPmTimeInput";
import UiIcon from "../../components/UiIcon";
import { dhmToMinutes, minutesToDhm } from "../../../lib/deadlineInput";
import { formatInstructorNames, toggleTrainerSelection, trainerPreviewItems, TRAINER_PREVIEW_EMPTY } from "../../../lib/instructorDisplay";
import CopyCalendar from "./CopyCalendar";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchRooms, type Room } from "../../../lib/rooms";
import CalendarAddSheet from "../../components/CalendarAddSheet";
import { describeCalendarResult, detectCalendarPlatform, type CalendarAddResult } from "../../../lib/calendarAdd";
import { classToEvent, filterEventsByMonth, holidaysToEvents, monthPrefix, type CalendarEventItem } from "../../../lib/calendarEvents";
import {
  fetchClasses, createClass, updateClass, updateClassPassSelectionMode, deleteClass,
  createRecurringClasses, createRecurringClassesPerDay, createClassOnDateSlots, expandRecurringDates,
  updateClassGroup, deleteClassGroup, diffGroupFields, passPolicyChanged, type PassPolicy,
  fetchClassAttendees, setAttendance, fetchClassProducts, setClassProducts, setClassProductsBulk,
  fetchClassTrainers, setClassTrainers, setClassTrainersBulk, setClassTrainersForGroup, fetchClassPassSelectionMode,
  fetchCenterHolidayDates,
  fetchCopyGroups, fetchCopyDateItems, planCopyByWeekday, planCopyByDate,
  copyByWeekday, copyByDate,
  type CopyGroup, type CopyDateItem, type CopyPlanItem,
  fetchBookableMembers, managerBookMember, type BookableMember, maskPhone,
  fetchUnplacedPasses, retryAutoBook, unplacedReasonText, type UnplacedPass,
  type ManagedClass, type ClassInput, type ClassAttendee,
  isValidClassTimeRange, checkScheduleConflicts, type ScheduleConflict,
} from "../../../lib/classes";
import { fetchStaff, fetchMyEffectivePermissionKeys, canSeeManagerMenu, type Staff } from "../../../lib/roles";
import { fetchClassMemos, createClassMemo, updateClassMemo, deleteClassMemo, type ScheduleMemo } from "../../../lib/scheduleMemos";
import { getMyAccountId } from "../../../lib/authAccount";
import { addSlot, allSlots, countClasses, removeSlot, updateSlot, validateSlots, MAX_TIME_SLOTS, type TimeSlot } from "../../../lib/classTimeSlots";
import { formatMonthDayWeekday } from "../../../lib/kst";
import { fetchMemberDetail, type MemberDetailData } from "../../../lib/members";
import { fetchSettings, type CenterSettings } from "../../../lib/settings";
import {
  fetchProducts, fetchRulesForProducts, findScheduleExcludedProducts, ruleToText,
  type Product, type ScheduleRule,
} from "../../../lib/passes";
import { assignReservation, cancelAdminReservation, type AssignmentType } from "../../../lib/adminAssignment";
import {
  ADMIN_REASON_CODES, ADMIN_REASON_LABELS, type AdminReasonCode,
  normalizeReasonDetail, adminBadges,
} from "../../../lib/reservationTypes";

import { toUserMessage } from "../../../lib/userError";
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// start/end 기본값이 빈 문자열이면 AmPmTimeInput이 "오전 12시 00분"을 화면엔 보여주면서도
// 관리자가 드롭다운을 하나도 안 건드리면 form.start/end는 계속 ""로 남아, "모두
// 입력해주세요" 검증에 걸린다(2026-09-06 UX 감사 — 정각 시간을 만들려던 게 아니라 화면에
// 보이는 값과 실제 저장되는 값이 달라서 생긴 문제였다). 애초에 유효한 시각으로 채워두면
// 이 불일치 자체가 없어지고, 매번 시간을 직접 다 고를 필요도 없어진다.
const EMPTY: ClassInput = { title: "", description: "", date: "", start: "10:00", end: "11:00", capacity: 8, allowGoods: true, allowCancel: true, roomId: null, cancelDeadlineMin: null, bookingDeadlineMin: null, classFormat: "group" };

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
  const [calSheet, setCalSheet] = useState<{ items: CalendarEventItem[]; subtitle: string } | null>(null);
  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }

  // 달력 상태
  const [year, setYear] = useState<number>(nowD.getFullYear());
  const [month, setMonth] = useState<number>(nowD.getMonth() + 1);
  const [selectedDay, setSelectedDay] = useState<number>(nowD.getDate());

  // 폼 상태 (열림/수정 대상/입력값)
  const [formOpen, setFormOpen] = useState(false);
  // 취소 버튼/배경 탭/드래그 닫기가 전부 같은 함수를 쓴다(B-11) — unsaved 확인 정책이나 state 정리가
  // 앞으로 추가되더라도 세 경로가 어긋나지 않는다. drag-to-dismiss 자체는 이제 공용
  // SheetOverlay(lib/sheetDrag.ts)가 처리한다(2026-10-01, 23fcb9d의 로컬 구현을 공용으로 승격).
  function closeFormSheet() {
    setFormOpen(false);
  }
  const [editId, setEditId] = useState<string | null>(null);
  const [editGroupId, setEditGroupId] = useState<string | null>(null);
  // QA Fix Batch(2026-09-18) — 정원 축소 invariant(요청 2번)의 클라이언트 측 사전 체크용.
  // 서버(update_class_safe)가 최종 권한이라 이 값이 없거나 틀려도 안전하지만, 저장을
  // 누르기 전에 더 친절한 안내를 보여주기 위해 수정 시트를 열 때 현재 확정 인원을
  // 기억해둔다.
  const [editReservedCount, setEditReservedCount] = useState(0);
  const [applyToGroup, setApplyToGroup] = useState(false);
  // 2026-10-01(QA 10) — "시간도 함께 변경"(기본 OFF). 꺼져 있으면 그룹 적용 시 각 수업의 기존 날짜·시간을 유지한다.
  const [applyTimeToGroup, setApplyTimeToGroup] = useState(false);
  // 수정 시트를 연 시점의 값 — "모든 반복 수업에 적용" 때 사용자가 실제로 바꾼 공통 필드만 그룹에 보내기 위한 기준.
  const origFormRef = useRef<ClassInput | null>(null);
  // 삭제 확인 시트
  const [deleteTarget, setDeleteTarget] = useState<ManagedClass | null>(null);
  // 수업 메모 (schedule_memos, class_id 경로) — 수정 시트를 열 때만 로드
  const [memos, setMemos] = useState<ScheduleMemo[]>([]);
  const [memoInput, setMemoInput] = useState("");
  const [memoBusy, setMemoBusy] = useState(false);
  const [editingMemoId, setEditingMemoId] = useState<string | null>(null);
  const [editingMemoContent, setEditingMemoContent] = useState("");
  const [myAccountId, setMyAccountId] = useState<string | null>(null);
  useEffect(() => { getMyAccountId().then(setMyAccountId).catch(() => {}); }, []);
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
    extraSlots?: TimeSlot[];             // 이 요일의 추가 타임(2026-10-02, 첫 타임은 위 start/end)
  }>>({});
  // 새 수업 등록 전용 "한 날 여러 타임": 첫 타임은 form.start/form.end, 두 번째 이후는 여기(수정 화면에서는 쓰지 않음)
  const [extraSlots, setExtraSlots] = useState<TimeSlot[]>([]);
  const [perDayMode, setPerDayMode] = useState(false);
  // 예약취소 마감: 일/시간/분 입력 → 분으로 환산해 저장
  const [centerSettings, setCenterSettings] = useState<CenterSettings | null>(null);
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
  // 상품별 예약조건(membership_schedule_rules) — "모든 수강권 허용"을 골라도 상품 자체의
  // 요일/시간 조건은 별개로 계속 적용된다는 걸 관리자에게 보여주기 위한 경고 계산용
  // (P1-15: 실제 QA에서 이 상호작용 때문에 "모든 수강권 허용"인데도 예약 가능 수강권이
  // 0개가 되는 게 재현됨 — RPC 로직은 그대로 두고 UI에서만 미리 알려준다).
  const [rulesByProduct, setRulesByProduct] = useState<Record<string, ScheduleRule[]>>({});
  const [passSearch, setPassSearch] = useState(""); // P3: 예약 가능 수강권 선택 목록 검색
  // UX 감사(B-6) — 수강권이 많은 센터에서는 검색만으로는 "선택 안 한 나머지"가 여전히
  // 100개+ 그대로 인라인 노출됐다. 검색 중이 아닐 때는 미선택 항목을 접어두고 필요하면
  // 펼쳐보게 한다(이미 선택된 항목은 접히지 않고 항상 보임).
  const [productsExpanded, setProductsExpanded] = useState(false);
  // 담당 강사(class_trainers) 후보 = 이 센터의 active 스태프 전체(역할 구분 없음), 폼에서 선택된 account_id 목록
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [selectedTrainers, setSelectedTrainers] = useState<string[]>([]);
  const [trainerSearch, setTrainerSearch] = useState("");
  // 룸/강사 겹침 경고(2026-09-06 UX 감사) — 서버가 막지 않으므로 화면에서만 알려주고
  // 저장은 그대로 허용한다(일부 센터는 의도적으로 겹치게 운영하기도 함).
  const [scheduleConflicts, setScheduleConflicts] = useState<ScheduleConflict[]>([]);
  // openEdit()이 재진입/재클릭으로 여러 번 겹쳐 호출될 때, 늦게 도착한 fetchClassProducts
  // 결과가 최신 openEdit 호출이나 사용자의 chip 선택을 덮어쓰지 않도록 하는 요청 토큰과
  // "이 open 세션 동안 사용자가 이미 선택을 편집했는지"(dirty) 플래그.
  const openTokenRef = useRef(0);
  const userEditedRef = useRef(false);
  // 담당 강사 선택용 별도 dirty 플래그 — 수강권 chip 편집과 강사 chip 편집은 서로 다른
  // fetch(fetchClassProducts/fetchClassTrainers)를 지연시킬 수 있어, 한쪽 편집이 다른 쪽의
  // 정상 하이드레이트까지 막지 않도록 독립적으로 추적한다.
  const trainerEditedRef = useRef(false);
  // 수정 시작 시점(서버에서 읽은 실제 값)의 예약 가능 수강권 설정 — "바뀌었는지"를 집합 비교로 판정해 그룹 전체 적용 여부를 정한다.
  const origPassRef = useRef<PassPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!formOpen || !activeCenterId || !form.date || !form.start || !form.end) { setScheduleConflicts([]); return; }
    let cancelled = false;
    checkScheduleConflicts(activeCenterId, form.date, form.start, form.end, {
      roomId: form.roomId, trainerAccountIds: selectedTrainers, excludeClassId: editId ?? undefined,
    }).then((cs) => { if (!cancelled) setScheduleConflicts(cs); })
      .catch(() => { if (!cancelled) setScheduleConflicts([]); });
    return () => { cancelled = true; };
  }, [formOpen, activeCenterId, form.date, form.start, form.end, form.roomId, selectedTrainers, editId]);

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
      setError(toUserMessage(e));
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
        setError(toUserMessage(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadClasses]);

  // 달이 바뀌면 다시 로드
  useEffect(() => {
    if (activeCenterId) {
      loadClasses(activeCenterId, year, month);
      fetchProducts(activeCenterId, "pass")
        .then((list) => {
          setPassProducts(list);
          return fetchRulesForProducts(list.map((p) => p.id));
        })
        .then((rules) => setRulesByProduct(rules))
        .catch(() => { /* 무시 */ });
      fetchStaff(activeCenterId)
        .then((list) => setStaffList(list.filter((s) => s.status === "active")))
        .catch(() => { /* 무시 */ });
    }
  }, [year, month, activeCenterId, loadClasses]);

  // 2026-10-01(B-1/B-2) — 예약/취소 마감을 비워두면 운영설정 기본값이 적용되는데, 화면에는
  // 그 기본값이 뭔지 전혀 안 보여서 "0일 0시간 0분"처럼 보이는 빈 입력칸만 있었다(실제로는
  // 운영설정의 날짜+시각 기준 값이 적용됨). year/month와 무관하게 센터가 바뀔 때만 다시
  // 불러온다(수업 목록처럼 달마다 새로 부를 필요 없음).
  useEffect(() => {
    if (!activeCenterId) { setCenterSettings(null); return; }
    fetchSettings(activeCenterId).then(setCenterSettings).catch(() => setCenterSettings(null));
  }, [activeCenterId]);

  const activeCenter = centers.find((c) => c.id === activeCenterId);

  useEffect(() => {
    if (!activeCenter) return;
    if (activeCenter.isOwner) { setMyPerms(null); return; }
    let cancelled = false;
    setMyPerms(null);
    fetchMyEffectivePermissionKeys(activeCenter.managerCenterId, activeCenter.roleId)
      .then((keys) => { if (!cancelled) setMyPerms(keys); })
      .catch((e) => { if (!cancelled) setError(toUserMessage(e)); });
    return () => { cancelled = true; };
  }, [activeCenter]);

  function canDo(key: string): boolean {
    return canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, key);
  }
  // 수업/그룹 삭제와 휴무일 추가가 같은 키를 공유한다(P0-6에서 지적된 재사용, 의도적으로
  // 그대로 둠 — 세분화하려면 새 permission key + SQL 변경이 필요해 이번 배치 범위 밖).
  const canDeleteClass = canDo("schedule.own.group.delete");
  const canAssignReservation = canDo("schedule.makeup");
  const canAssignAnyStatus = canDo("customer.member.assign_any_status");
  const canAddMemo = canDo("schedule.memo.create");
  const canEditOwnMemo = canDo("schedule.memo.update"); // 본인 메모 수정에도 이 키가 필요
  const canManageAnyMemo = activeCenter?.isOwner ?? false; // 다른 사람 메모는 오너만 — 위임 불가(서버 RLS와 동일 규칙)

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

  // 2026-10-01(B-2) — 운영설정 기본값을 "N일 전 HH:MM까지"라는 운영설정 화면과 동일한
  // 형식 그대로 보여준다(수업 등록의 일/시간/분-전 입력 형식으로 억지로 환산하지 않음 —
  // 환산하려면 이 수업의 실제 시작 날짜·시각 기준으로 날짜 계산이 필요해 버그 위험이
  // 크고, 운영설정 화면에서 이미 쓰는 표현을 그대로 재사용하는 쪽이 더 안전하고 일관적).
  function effectiveDeadlineText(kind: "book" | "cancel"): string | null {
    if (!centerSettings) return null;
    const isPrivate = form.classFormat === "private";
    const daysBefore = kind === "book"
      ? (isPrivate ? centerSettings.privateBookDaysBefore : centerSettings.groupBookDaysBefore)
      : (isPrivate ? centerSettings.privateCancelDaysBefore : centerSettings.groupCancelDaysBefore);
    const time = kind === "book"
      ? (isPrivate ? centerSettings.privateBookTime : centerSettings.groupBookTime)
      : (isPrivate ? centerSettings.privateCancelTime : centerSettings.groupCancelTime);
    return `운영설정 기본값: 수업 ${daysBefore}일 전 ${time}까지`;
  }

  function openCreate() {
    setEditId(null);
    setCancelD(""); setCancelH(""); setCancelM("");
    setBookD(""); setBookH(""); setBookM("");
    setEditGroupId(null);
    setApplyToGroup(false);
    setApplyTimeToGroup(false);
    const dayStr = `${year}-${String(month).padStart(2, "0")}-${String(selectedDay).padStart(2, "0")}`;
    const lastDay = `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
    setForm({ ...EMPTY, date: dayStr });
    setExtraSlots([]);
    setDayOverrides({});
    setRepeat(false);
    setRepDays([]);
    setRepFrom(dayStr);
    setRepTo(lastDay);
    // 기본값 'all'(전체 허용)을 "모든 수강권이 체크된 상태"로 표현한다(아래 저장 로직 참고 —
    // 선택 개수가 전체 개수와 같으면 mode='all'). 신규 등록 폼을 열 때 빈 목록으로 시작하면
    // 저장이 막히므로(0개 선택 금지) 항상 전체 체크로 시작한다.
    setSelectedProducts(passProducts.map((p) => p.id));
    setPassSearch("");
    setProductsExpanded(false);
    setSelectedTrainers([]);
    setTrainerSearch("");
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
      showToast(n > 0 ? `${n}개 수업에 배치했어요` : "배치할 수 있는 수업이 없어요 (아래 사유 확인)");
      if (activeCenterId) {
        await loadUnplaced(activeCenterId);
        await loadClasses(activeCenterId, year, month);
      }
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setUnplacedBusy(false); }
  }

  // --- 관리자 직접배치 / 무료 추가 배치 ---
  function openAssignMemberPicker() {
    if (!activeCenterId) return;
    setAssignKw("");
    setAssignMemberSheet(true);
    fetchBookableMembers(activeCenterId).then(setAssignMembersList).catch((e: any) => setError(toUserMessage(e)));
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
      setError(toUserMessage(e));
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
      setError(toUserMessage(e));
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
    catch (e: any) { setError(toUserMessage(e)); }
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
    } catch (e: any) { setError(toUserMessage(e)); }
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
    } catch (e: any) { setError(toUserMessage(e)); }
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
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setCopyBusy(false); }
  }

  async function handleCopy() {
    if (!activeCenterId) return;
    if (!(await globalThis.appConfirm(`${copyFrom} → ${copyTo}\n선택한 수업을 복사할까요?`))) return;
    setCopyBusy(true);
    try {
      const result = copyMode === "weekday"
        ? await copyByWeekday(activeCenterId, copyTo, copyGroups.filter((g) => copySelected.has(g.key)))
        : await copyByDate(activeCenterId, copyTo, copyDateItems.filter((i) => copySelected.has(i.key)));
      showToast(
        `${result.count}개 수업을 복사했어요` +
        (result.failedCount > 0 ? ` (수강권 제한·담당 강사 ${result.failedCount}건은 못 옮겼어요 — 수업별로 직접 확인해주세요)` : "")
      );
      setCopySheet(false);
      if (activeCenterId) await loadClasses(activeCenterId, year, month);
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setCopyBusy(false); }
  }

  async function openRoster(c: ManagedClass) {
    setRosterClass(c);
    setRoster([]);
    setRosterLoading(true);
    try {
      setRoster(await fetchClassAttendees(c.id));
    } catch (e: any) {
      setError(toUserMessage(e));
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
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setAttBusy(false); }
  }

  async function openMemberInfo(a: ClassAttendee) {    setMemberInfo({ name: a.name, profileId: a.profileId, data: null });
    if (!activeCenterId) return;
    try {
      const data = await fetchMemberDetail(a.profileId, activeCenterId);
      setMemberInfo({ name: a.name, profileId: a.profileId, data });
    } catch (e: any) {
      setError(toUserMessage(e));
    }
  }

  async function openEdit(c: ManagedClass) {
    // 이 open 호출 고유 토큰 + "이 open 세션 동안 사용자가 직접 편집했는지" 플래그로,
    // 늦게 도착하는 초기 hydrate fetch가 그사이의 사용자 편집이나 더 최신 openEdit 호출을
    // 덮어쓰지 못하게 한다(race 수정, P2-20 — 실측으로 원인 확인: fetch가 chip 클릭보다
    // 늦게 끝나면 setSelectedProducts(ids)가 사용자의 선택을 조용히 덮어썼었다).
    const myToken = ++openTokenRef.current;
    userEditedRef.current = false;
    trainerEditedRef.current = false;
    origPassRef.current = null;
    setEditId(c.id);
    setEditGroupId(c.recurringGroupId);
    setApplyToGroup(false);
    setApplyTimeToGroup(false);
    setEditReservedCount(c.reserved);
    const openedForm: ClassInput = { title: c.title, description: c.description ?? "", date: c.date, start: c.start, end: c.end, capacity: c.capacity, allowGoods: c.allowGoods, allowCancel: c.allowCancel, roomId: c.roomId, cancelDeadlineMin: c.cancelDeadlineMin, bookingDeadlineMin: c.bookingDeadlineMin, classFormat: c.classFormat };
    origFormRef.current = openedForm;
    setForm(openedForm);
    fillDeadline(c.cancelDeadlineMin);
    fillBookDeadline(c.bookingDeadlineMin);
    // 'all'이면(class_allowed_products는 원래 비어 있음) 전체 체크 상태로 즉시 보여준다 —
    // fetchClassProducts가 끝나기 전까지 잠깐 "0개 선택"(저장 차단 상태)으로 보이는 걸 방지.
    // 목록(ManagedClass.passSelectionMode)은 방금 저장 직후 재클릭한 경우 아직 갱신 전일 수
    // 있어(save()가 loadClasses() 완료 전에 시트부터 닫음) 여기서는 최선의 추정치로만 쓴다 —
    // 아래 fetchClassPassSelectionMode()의 실측값이 도착하면 그 값으로 다시 덮어쓴다.
    setSelectedProducts(c.passSelectionMode === "all" ? passProducts.map((p) => p.id) : []);
    setPassSearch("");
    setProductsExpanded(false);
    setSelectedTrainers([]);
    setTrainerSearch("");
    setError(null);
    setFormOpen(true);
    try {
      // c.passSelectionMode(목록 캐시)를 신뢰하지 않고 이 class의 실제 현재 값을 다시 조회한다.
      const [ids, freshMode] = await Promise.all([fetchClassProducts(c.id), fetchClassPassSelectionMode(c.id)]);
      // 원본 설정은 사용자의 편집 여부와 무관하게 항상 기록한다(최신 openEdit 호출의 값만).
      if (myToken === openTokenRef.current) origPassRef.current = { mode: freshMode === "all" ? "all" : "selected", productIds: freshMode === "all" ? [] : ids };
      const isStale = myToken !== openTokenRef.current || userEditedRef.current;
      if (!isStale) setSelectedProducts(freshMode === "all" ? passProducts.map((p) => p.id) : ids);
    } catch { /* 무시 */ }
    try {
      const tids = await fetchClassTrainers(c.id);
      const isTrainerStale = myToken !== openTokenRef.current || trainerEditedRef.current;
      if (!isTrainerStale) setSelectedTrainers(tids);
    } catch { /* 무시 */ }
    setMemos([]);
    setMemoInput("");
    setEditingMemoId(null);
    try {
      const list = await fetchClassMemos(c.id);
      if (myToken === openTokenRef.current) setMemos(list);
    } catch { /* 무시 */ }
  }

  async function handleAddMemo() {
    if (!editId || !memoInput.trim()) return;
    setMemoBusy(true);
    try {
      await createClassMemo(editId, memoInput.trim());
      setMemoInput("");
      setMemos(await fetchClassMemos(editId));
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setMemoBusy(false); }
  }

  async function handleSaveMemoEdit() {
    if (!editId || !editingMemoId || !editingMemoContent.trim()) return;
    setMemoBusy(true);
    try {
      await updateClassMemo(editingMemoId, editingMemoContent.trim());
      setEditingMemoId(null);
      setMemos(await fetchClassMemos(editId));
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setMemoBusy(false); }
  }

  async function handleDeleteMemo(memoId: string) {
    if (!editId) return;
    if (!(await globalThis.appConfirm("이 메모를 삭제할까요?"))) return;
    setMemoBusy(true);
    try {
      await deleteClassMemo(memoId);
      setMemos(await fetchClassMemos(editId));
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setMemoBusy(false); }
  }

  // 수강권 허용 정책 판정: 0개 선택이면 저장을 막는다(전체 허용은 반드시 "전체 선택"으로
  // 표현해야 함 — 아무것도 안 고른 상태와 구분). 선택 개수가 그 센터의 pass 전체 개수와
  // 같으면 mode='all'(class_allowed_products는 비워서 저장 — 스냅샷이 아니라 "그 순간의
  // 모든 pass"를 항상 가리키게 해, 나중에 pass가 추가돼도 자동 포함됨). 그 사이면 'selected'.
  function resolvePassSelection(): { mode: "all" | "selected"; productIds: string[] } | null {
    if (passProducts.length > 0 && selectedProducts.length === 0) return null;
    if (passProducts.length === 0 || selectedProducts.length === passProducts.length) {
      return { mode: "all", productIds: [] };
    }
    return { mode: "selected", productIds: selectedProducts };
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
      // 한 날 여러 타임: 첫 타임(form.start/end) + 추가 타임 각각에 기존 시간 범위 검증 + 완전 중복 차단
      const commonSlots = allSlots({ start: form.start, end: form.end }, extraSlots);
      if (!perDayMode) {
        const slotErr = validateSlots(commonSlots);
        if (slotErr) { setError(slotErr); return; }
      }
      if (repDays.length === 0) { setError("반복할 요일을 선택해주세요"); return; }
      if (!repFrom || !repTo || repFrom > repTo) { setError("기간을 올바르게 선택해주세요"); return; }
      const resolved = resolvePassSelection();
      if (!resolved) {
        setError("예약 가능 수강권을 최소 1개 이상 선택해주세요 (전체 허용은 '전체 선택' 버튼을 사용하세요)");
        return;
      }
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
        const passMode = resolved.mode;
        let ids: string[] = [];
        if (perDayMode) {
          // 요일마다 다른 설정(시간/정원/룸/취소마감)을 먼저 전부 계산해두고, RPC는 아래에서
          // 한 번만 호출한다(요일별로 따로 호출하면 그 개수만큼 별도 트랜잭션이 생겨 중간
          // 요일에서 실패 시 이전 요일들만 반영된 채 남는 원자성 문제가 있었음).
          const days: { dow: number; start: string; end: string; capacity: number; roomId?: string | null; cancelDeadlineMin?: number | null; slots?: { start: string; end: string }[] }[] = [];
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
            // 요일마다 타임 개수가 달라도 된다: 첫 타임(요일별 값 또는 공통값) + 그 요일의 추가 타임
            const daySlots = allSlots({ start: st, end: en }, ov.extraSlots);
            const slotErr = validateSlots(daySlots, `${WEEKDAYS[dow]}요일`);
            if (slotErr) { setError(slotErr); setBusy(false); return; }
            days.push({ dow, start: st, end: en, capacity: cap, roomId: rid, cancelDeadlineMin: ovMin, slots: ov.extraSlots && ov.extraSlots.length > 0 ? daySlots : undefined });
          }
          ids = await createRecurringClassesPerDay(activeCenterId, {
            title: form.title,
            description: form.description,
            fromDate: repFrom, toDate: repTo,
            days,
            // 예약마감(CLASS-001)은 요일별 개별 지정 UI가 없어 공통 설정값을 그대로 쓴다
            // (취소마감의 요일별 오버라이드와 달리, 예약마감은 이번 배치 범위를 공통값으로
            // 한정함 — 모바일 컴팩트 그리드에 3-select 오전/오후 UI를 넣기엔 공간이 부족).
            bookingDeadlineMin: bookDeadlineToMin(),
            passSelectionMode: passMode,
            excludeDates: holidays,
          });
        } else {
          ids = await createRecurringClasses(activeCenterId, {
            title: form.title, description: form.description, daysOfWeek: repDays,
            fromDate: repFrom, toDate: repTo,
            start: form.start, end: form.end, capacity: form.capacity, roomId: form.roomId, cancelDeadlineMin: deadlineToMin(),
            bookingDeadlineMin: bookDeadlineToMin(),
            passSelectionMode: passMode,
            excludeDates: holidays,
            // 추가 타임이 없으면 undefined → 기존과 완전히 같은 단일 타임 반복 등록
            slots: extraSlots.length > 0 ? commonSlots : undefined,
          });
        }
        // 선택한 수강권을 모든 생성 수업에 연결('all'이면 productIds가 비어 있어 아무것도 안 씀)
        if (resolved.productIds.length > 0) await setClassProductsBulk(ids, resolved.productIds);
        // 선택한 담당 강사를 모든 생성 수업에 연결
        if (selectedTrainers.length > 0) await setClassTrainersBulk(ids, selectedTrainers);
        setFormOpen(false);
        await loadClasses(activeCenterId, year, month);
        setError(null);
        showToast(`${ids.length}개의 수업을 등록했어요${skipped > 0 ? ` (휴무일 ${skipped}일 제외)` : ""}`);
      } catch (e: any) {
        setError(toUserMessage(e));
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
    // 새 수업 등록에서 시간을 추가했다면 모든 타임을 검증한다(수정 화면에는 추가 타임이 없다)
    const singleSlots = allSlots({ start: form.start, end: form.end }, !editId ? extraSlots : []);
    if (singleSlots.length > 1) {
      const slotErr = validateSlots(singleSlots);
      if (slotErr) { setError(slotErr); return; }
    }
    // QA Fix Batch(2026-09-18) — 정원 축소 invariant(요청 2번)의 클라이언트 측 사전
    // 체크. 서버(update_class_safe)가 동일 조건을 최종적으로 다시 검사해 거부하므로
    // 이 체크를 우회해도 안전하다 — 여기서는 저장 버튼을 누르기 전에 더 친절하게
    // 안내하기 위한 것뿐.
    if (editId && !applyToGroup && form.capacity < editReservedCount) {
      setError(`현재 확정 예약 인원보다 적게 정원을 줄일 수 없습니다. (현재 확정 ${editReservedCount}명)`);
      return;
    }
    const resolved = resolvePassSelection();
    if (!resolved) {
      setError("예약 가능 수강권을 최소 1개 이상 선택해주세요 (전체 허용은 '전체 선택' 버튼을 사용하세요)");
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
      const passMode = resolved.mode;
      let promotedCount = 0;
      let groupAppliedCount = 0;
      let groupCreatedCount = 0;
      let groupCarriedPassPolicy = false;   // 그룹 RPC가 수강권 설정까지 같은 트랜잭션에서 처리했는지
      if (editId) {
        if (applyToGroup && editGroupId) {
          // 공통 속성(수업명 + 이 시트에서 "바뀐" 소개·정원·룸·취소/예약 마감·취소 허용·상품 허용)을 같은 반복 그룹
          // 전체에 한 번에 반영한다. 날짜·시간은 각 수업의 기존 값을 유지하되, 지금 편집 중인 수업 자신의 날짜/시간
          // 변경은 반드시 저장한다. 모든 수업의 시간까지 바꾸려면 "시간도 함께 변경"을 명시적으로 켠 경우에만 보낸다.
          const orig = origFormRef.current;
          const cur: ClassInput = { ...form, cancelDeadlineMin: deadlineToMin(), bookingDeadlineMin: bookDeadlineToMin() };
          const changes = orig ? diffGroupFields(orig, cur) : { description: form.description ?? "" };
          // 예약 가능 수강권: 사용자가 실제로 바꾼 경우에만 그룹 전체에 적용(집합 비교). 원본을 아직 못 읽었으면 사용자가 손댄 경우로 본다.
          const nextPolicy: PassPolicy = { mode: resolved.mode, productIds: resolved.productIds };
          const passChanged = origPassRef.current ? passPolicyChanged(origPassRef.current, nextPolicy) : userEditedRef.current;
          if (passChanged) changes.passPolicy = nextPolicy;
          groupCarriedPassPolicy = passChanged;
          const ownChanged = !!orig && (orig.date !== form.date || orig.start !== form.start || orig.end !== form.end);
          const groupIds = await updateClassGroup(editGroupId, form.title, form.capacity, {
            changes,
            // 같은 날 여러 타임으로 등록된 그룹은 편집 중인 수업과 "원래 같은 시각"의 수업에만 시간 변경을 적용한다(타임끼리 덮어쓰기 방지)
            time: applyTimeToGroup ? { start: form.start, end: form.end, only: orig ? { start: orig.start, end: orig.end } : undefined } : undefined,
            own: ownChanged || applyTimeToGroup ? { id: editId, date: form.date, start: form.start, end: form.end } : undefined,
          });
          groupAppliedCount = groupIds.length;
          // 수강권 설정을 바꿨다면 위 그룹 RPC가 같은 트랜잭션에서 그룹 전체(편집 중인 수업 포함)에 이미 적용했다.
          // 바꾸지 않았다면 기존 그룹의 수강권 설정을 건드리지 않고, 이 수업만 현재 화면 값에 맞춰 둔다(기존 동작).
          if (!groupCarriedPassPolicy) await updateClassPassSelectionMode(editId, passMode);
          // 담당 강사는 title/시간/정원과 마찬가지로 그룹 전체에 동일하게 적용한다.
          await setClassTrainersForGroup(groupIds, selectedTrainers);
        } else {
          const result = await updateClass(editId, { ...form, cancelDeadlineMin: deadlineToMin(), bookingDeadlineMin: bookDeadlineToMin(), passSelectionMode: passMode });
          promotedCount = result.promotedCount;
          await setClassTrainers(editId, selectedTrainers);
        }
        if (!groupCarriedPassPolicy) await setClassProducts(editId, resolved.productIds);
      } else if (singleSlots.length > 1) {
        // 한 날짜 여러 타임: 한 번에(한 트랜잭션 또는 실패 시 보상 삭제) 만들고, 수강권/강사는 만들어진 모든 수업에 적용한다.
        const newIds = await createClassOnDateSlots(
          activeCenterId,
          { ...form, cancelDeadlineMin: deadlineToMin(), bookingDeadlineMin: bookDeadlineToMin(), passSelectionMode: passMode },
          singleSlots,
        );
        if (resolved.productIds.length > 0) await setClassProductsBulk(newIds, resolved.productIds);
        if (selectedTrainers.length > 0) await setClassTrainersBulk(newIds, selectedTrainers);
        groupCreatedCount = newIds.length;
      } else {
        const newId = await createClass(activeCenterId, { ...form, cancelDeadlineMin: deadlineToMin(), bookingDeadlineMin: bookDeadlineToMin(), passSelectionMode: passMode });
        await setClassProducts(newId, resolved.productIds);
        await setClassTrainers(newId, selectedTrainers);
      }

      setFormOpen(false);
      await loadClasses(activeCenterId, year, month);
      // QA Fix Batch(2026-09-18) — 정원 확대로 대기자가 자동 승격됐으면(요청 3번)
      // 관리자에게 알려준다. 0명이면 조용히 넘어간다(정원을 늘렸지만 대기자가
      // 없었거나, 애초에 정원을 줄이거나 그대로 둔 경우).
      if (groupCreatedCount > 0) {
        showToast(`${groupCreatedCount}개의 수업을 등록했어요`);
      } else if (groupAppliedCount > 0) {
        showToast(`반복 수업 ${groupAppliedCount}개를 수정했어요`);
      } else if (promotedCount > 0) {
        showToast(`대기자 ${promotedCount}명이 자동으로 확정 예약으로 전환됐어요`);
      }
    } catch (e: any) {
      setError(toUserMessage(e));
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
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="app-shell"><Loading /></div>;
  }

  // 달력 셀 + 수업 있는 날 표시
  const pad2 = (n: number) => String(n).padStart(2, "0");
  // 반복 등록 미리보기 개수 = 날짜 수 × 타임 수(요일별 모드는 요일마다 그 요일 날짜 수 × 그 요일 타임 수의 합)
  const previewClassCount = (() => {
    if (!repeat || repDays.length === 0 || !repFrom || !repTo || repFrom > repTo) return 0;
    if (perDayMode) {
      return repDays.reduce((sum, dow) => {
        const dates = expandRecurringDates(repFrom, repTo, [dow]).length;
        return sum + countClasses(dates, 1 + (dayOverrides[dow]?.extraSlots?.length ?? 0));
      }, 0);
    }
    return countClasses(expandRecurringDates(repFrom, repTo, repDays).length, 1 + extraSlots.length);
  })();
  const selectedKey = `${year}-${pad2(month)}-${pad2(selectedDay)}`;
  /*
    "내 캘린더에 추가"(2026-09-26) — 회원 예약 캘린더와 같은 공용 시트/서비스(CalendarAddSheet,
    lib/calendarAdd.ts, lib/calendarEvents.ts). 지금 화면에 표시 중인 달(year/month)과 지금 선택된
    센터(activeCenterId) 범위의 수업 + 센터 휴무일만 목록에 올린다. 월/센터를 바꾼 뒤 누르면 클릭 시점의
    화면 상태로 다시 계산된다. 취소된 수업은 제외. 연속된 휴무일은 하나의 하루 종일 기간으로 합친다.
  */
  function openCalendarSheet() {
    if (!activeCenter) return;
    const roomOf = (id: string | null) => (id ? rooms.find((r) => r.id === id) : undefined);
    const classEvents = classes
      .filter((c) => c.status !== "cancelled")
      .map((c) => classToEvent(c, { centerName: activeCenter.name, roomName: roomOf(c.roomId)?.name, roomAddress: roomOf(c.roomId)?.address }));
    const prefix = monthPrefix(year, month);
    const holidayEvents = holidaysToEvents(Array.from(holidayDates).filter((d) => d.startsWith(prefix)), activeCenter.id, activeCenter.name);
    setCalSheet({
      items: filterEventsByMonth([...classEvents, ...holidayEvents], year, month),
      subtitle: `${activeCenter.name} · ${year}년 ${month}월 일정`,
    });
  }

  function handleCalendarResult(result: CalendarAddResult) {
    const msg = describeCalendarResult(result) ?? (result.kind === "shared" && detectCalendarPlatform() === "web" ? "캘린더 파일을 내보냈어요. 파일을 열어 캘린더에 추가해주세요" : null);
    if (msg) { setToast(msg); setTimeout(() => setToast(null), 3000); }
  }

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
    <div className="app-shell manager-classes-v2" style={{ paddingBottom: 170 }}>
      {/* ManagerChrome(공용 헤더) 마이그레이션 이후 .back-header는 기본적으로 숨겨진다
          (globals.css). 일반적인 "제목 숨기고 오른쪽 버튼 하나만" 패턴(.header-action)과
          달리 이 화면은 좌우 버튼 2개 + 가운데 제목 구조라 그 패턴이 안 맞아서, 아래
          .manager-classes-v2 > .back-header 전용 규칙으로 이 화면의 헤더만 원래 3분할
          레이아웃 그대로 다시 보이게 한다(globals.css 참고) — 그 규칙이 없으면 "복사"/
          "휴무일" 버튼이 완전히 사라지고 클릭도 안 되는 상태였다. */}
      <div className="back-header">
        <button className="side cal-export-btn cal-copy-btn" style={{ fontSize: 12 }} onClick={openCopy}>일정 복사</button>
        <div className="title">내 일정</div>
        {!assignMode && <button className="primary-btn workspace-create-class" onClick={openCreate}>+ 수업 등록</button>}
        <Link className="side cal-export-btn" href="/manager/holidays" style={{ fontSize: 12 }} prefetch={false}>휴무일</Link>
      </div>

      {unplaced.length > 0 && (
        <button className="unplaced-banner" onClick={() => setUnplacedSheet(true)}>
          <span className="unplaced-icon" aria-hidden="true">!</span>
          <span className="unplaced-text">
            예약이 덜 배치된 요일반 수강권 <b>{unplaced.length}건</b>
          </span>
          <span className="unplaced-go">보기 <b aria-hidden="true">›</b></span>
        </button>
      )}

      {!assignMode ? (
        canAssignReservation && (
          <button className="unplaced-banner direct-assign-row" onClick={openAssignMemberPicker}>
            <span className="unplaced-icon direct" aria-hidden="true">+</span>
            <span className="unplaced-text">회원 직접배치</span>
            <span className="unplaced-go">시작 <b aria-hidden="true">›</b></span>
          </button>
        )
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

      <section className="manager-calendar-panel" aria-label="수업 달력">
      {/* 월 이동 */}
      <div className="cal-header manager-cal-header">
        <div className="cal-month-nav">
          <button className="cal-nav-btn" onClick={goPrevMonth} aria-label="이전 달">‹</button>
          <div className="cal-title">{year}.{pad2(month)}</div>
          <button className="cal-nav-btn" onClick={goNextMonth} aria-label="다음 달">›</button>
        </div>
        <label className="manager-center-select">
          <select
            aria-label="센터 선택"
            value={activeCenterId ?? ""}
            onChange={async (event) => {
              const centerId = event.target.value;
              setActiveCenterId(centerId);
              await loadClasses(centerId, year, month);
            }}
          >
            {centers.map((center) => <option key={center.id} value={center.id}>{center.name}</option>)}
          </select>
        </label>
      </div>
      <div className="manager-cal-add-row">
        <button type="button" className="cal-export-btn" onClick={openCalendarSheet} disabled={!activeCenter}>내 캘린더에 추가</button>
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
            <button key={i} aria-label={`${month}월 ${day}일`} aria-pressed={day === selectedDay} className={cn.join(" ")} onClick={() => setSelectedDay(day)}>
              <span className="daynum-wrap"><span className="cal-daynum">{day}</span></span>
              <span className="cal-dots">
                {isHoliday ? <span className="cal-dot" style={{ background: "var(--danger)" }} />
                  : hasClassByDay[day] ? <span className="cal-dot" style={{ background: "var(--accent)" }} /> : null}
              </span>
            </button>
          );
        })}
      </div>
      </section>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}
      {calSheet && (
        <CalendarAddSheet
          items={calSheet.items}
          subtitle={calSheet.subtitle}
          platform={detectCalendarPlatform()}
          onClose={() => setCalSheet(null)}
          onDone={handleCalendarResult}
          onError={(m) => setError(m)}
        />
      )}

      <section className="manager-agenda-panel" aria-label="선택한 날짜의 수업">
      <div className="menu-section-label">{formatMonthDayWeekday(year, month, selectedDay)} 수업 ({dayClasses.length})</div>

      {holidayDates.has(`${year}-${pad2(month)}-${pad2(selectedDay)}`) && (
        <div className="holiday-notice manager-holiday-notice">
          <div className="holiday-chip">
            <span className="hc-mark" aria-hidden="true" />
            <span><b>센터 휴무일</b><small>이 날은 수업을 개설할 수 없어요.</small></span>
          </div>
        </div>
      )}

      {dayClasses.length === 0 ? (
        holidayDates.has(`${year}-${pad2(month)}-${pad2(selectedDay)}`) ? (
          <div className="daylist-empty daylist-empty--xs">휴무일이에요</div>
        ) : assignMode ? (
          <div className="daylist-empty daylist-empty--xs">이 날 등록된 수업이 없어요.</div>
        ) : (
          <div className="empty-action manager-class-empty">
            <div className="empty-action-text">이 날 등록된 수업이 없어요.</div>
          </div>
        )
      ) : assignMode ? (
        <div className="daylist" style={{ minHeight: 0, paddingTop: 4 }}>
          {dayClasses.map((c) => {
            const { ok, reason } = classAssignability(c);
            const full = c.reserved >= c.capacity;
            return (
              <div key={c.id} className="class-row">
                <div className="class-color" style={{ background: ok ? "var(--accent)" : "var(--text-dim)" }} />
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
          {dayClasses.map((c) => {
            const instructorText = formatInstructorNames(c.instructorNames);
            return (
            <div key={c.id} className="class-row" onClick={() => openEdit(c)} style={{ cursor: "pointer" }}>
              <div className="class-color" style={{ background: "var(--accent)" }} />
              <div className="class-info">
                <div className="class-row-title">{c.title}</div>
                <div className="class-row-meta">
                  {c.start}~{c.end}
                  {instructorText && ` · ${instructorText}`}
                </div>
              </div>
              <div className="class-row-actions">
                {/* UX 감사(B-2) — 예전엔 "예약 N/M ›"가 21px짜리 인라인 텍스트 링크뿐이라
                    매니저가 매일 여는 예약자/출석 화면 진입이 오탭에 취약했다. 별도 버튼으로
                    분리해 44px 터치 영역을 확보(수업 수정은 행 전체 탭으로 계속 가능). */}
                <button type="button" className="class-row-roster-btn" onClick={(e) => { e.stopPropagation(); openRoster(c); }}>
                  예약 {c.reserved}/{c.capacity} ›
                </button>
                {!isPastClass(c) && canDeleteClass && (
                  <button className="profile-del" disabled={busy} onClick={(e) => { e.stopPropagation(); remove(c); }}>
                    삭제
                  </button>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}
      </section>

      {/* 하단 고정 등록 버튼 */}
      {!assignMode && <button className="fab-btn" onClick={openCreate}>+ 수업 등록</button>}

      {/* 등록/수정 시트 */}
      {formOpen && (
        <SheetOverlay className="sheet-overlay" onClick={closeFormSheet}>
          <div className="sheet direct-member-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{editId ? "수업 수정" : "수업 등록"}</div>
            <input aria-label="수업명" className="input-field" placeholder="수업명" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>수업 소개 (선택)</div>
            <textarea aria-label="회원이 예약할 때 수업명 아래에 보여요" className="input-field" style={{ minHeight: 70, resize: "vertical", lineHeight: 1.5 }}
              placeholder="회원이 예약할 때 수업명 아래에 보여요" value={form.description ?? ""}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />

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
                    <button aria-pressed={repDays.includes(i)} key={i} className={`filter-chip ${repDays.includes(i) ? "on" : ""}`} onClick={() => toggleRepDay(i)}>{d}</button>
                  ))}
                </div>
                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>기간</div>
                <div className="time-row">
                  <DatePicker value={repFrom} onChange={setRepFrom} label="반복 시작일" />
                  <span className="time-sep">~</span>
                  <DatePicker value={repTo} onChange={setRepTo} label="반복 종료일" />
                </div>
                {repDays.length > 0 && repFrom && repTo && repFrom <= repTo && (
                  <div className="rep-preview" style={{ marginBottom: 4 }}>
                    총 {previewClassCount}개 수업이 만들어져요
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
                                <input aria-label="정원" className="input-field" inputMode="numeric" style={{ maxWidth: 66 }} placeholder="정원"
                                  value={ov.capacity} onChange={(e) => setOv({ capacity: e.target.value })} />
                              </div>

                              {/* 이 요일의 추가 타임 — 요일마다 타임 개수가 달라도 된다 */}
                              {(ov.extraSlots ?? []).map((sl, idx) => (
                                <div key={sl.id} className="perday-inputs perday-slot-extra">
                                  <input aria-label={`${WEEKDAYS[d]}요일 시간 ${idx + 2} 시작`} className="input-field" type="time" value={sl.start}
                                    onChange={(e) => setOv({ extraSlots: updateSlot(ov.extraSlots ?? [], sl.id, { start: e.target.value }) })} />
                                  <span className="time-sep">~</span>
                                  <input aria-label={`${WEEKDAYS[d]}요일 시간 ${idx + 2} 종료`} className="input-field" type="time" value={sl.end}
                                    onChange={(e) => setOv({ extraSlots: updateSlot(ov.extraSlots ?? [], sl.id, { end: e.target.value }) })} />
                                  <button type="button" className="time-slot-remove" aria-label={`${WEEKDAYS[d]}요일 시간 ${idx + 2} 삭제`}
                                    onClick={() => setOv({ extraSlots: removeSlot(ov.extraSlots ?? [], sl.id) })}>삭제</button>
                                </div>
                              ))}
                              {(ov.extraSlots?.length ?? 0) + 1 < MAX_TIME_SLOTS && (
                                <button type="button" className="time-slot-add"
                                  onClick={() => setOv({ extraSlots: addSlot(ov.extraSlots ?? [], { start: ov.start || form.start, end: ov.end || form.end }) })}>+ 시간 추가</button>
                              )}

                              {rooms.length > 0 && (
                                <div className="perday-sub">
                                  <span className="perday-sub-label">룸</span>
                                  <div className="perday-chips">
                                    <button aria-pressed={ov.roomId === undefined} className={`filter-chip sm ${ov.roomId === undefined ? "on" : ""}`}
                                      onClick={() => setOv({ roomId: undefined })}>공통</button>
                                    <button aria-pressed={ov.roomId === null} className={`filter-chip sm ${ov.roomId === null ? "on" : ""}`}
                                      onClick={() => setOv({ roomId: null })}>없음</button>
                                    {rooms.map((r) => (
                                      <button aria-pressed={ov.roomId === r.id} key={r.id} className={`filter-chip sm ${ov.roomId === r.id ? "on" : ""}`}
                                        onClick={() => setOv({ roomId: r.id })}>{r.name}</button>
                                    ))}
                                  </div>
                                </div>
                              )}

                              <div className="perday-sub">
                                <span className="perday-sub-label">취소</span>
                                <div className="deadline-row">
                                  <input aria-label="요일별 취소 마감 일" className="input-field deadline-num" inputMode="numeric" placeholder="0"
                                    value={ov.cd} onChange={(e) => setOv({ cd: e.target.value })} />
                                  <span className="deadline-unit">일</span>
                                  <input aria-label="요일별 취소 마감 시간" className="input-field deadline-num" inputMode="numeric" placeholder="0"
                                    value={ov.ch} onChange={(e) => setOv({ ch: e.target.value })} />
                                  <span className="deadline-unit">시간</span>
                                  <input aria-label="요일별 취소 마감 분" className="input-field deadline-num" inputMode="numeric" placeholder="0"
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
              <DatePicker value={form.date} onChange={(date) => setForm({ ...form, date })} label="수업 날짜" />
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
              {/* 같은 날 여러 타임(새 수업 등록 전용): 시간 추가 → 같은 수업명/설정으로 타임마다 수업이 만들어진다.
                  요일별로 다르게 모드에서는 각 요일 카드 안에서 추가한다. 수정 화면에서는 보이지 않는다. */}
              {!editId && !(perDayMode && repeat) && (
                <>
                  {extraSlots.map((sl, idx) => (
                    <div key={sl.id} className="time-slot-extra">
                      <div className="time-slot-extra-head">
                        <span>시간 {idx + 2}</span>
                        <button type="button" className="time-slot-remove" aria-label={`시간 ${idx + 2} 삭제`}
                          onClick={() => setExtraSlots((prev) => removeSlot(prev, sl.id))}>삭제</button>
                      </div>
                      <div className="ampm-time-row">
                        <span className="ampm-time-label">시작</span>
                        <AmPmTimeInput value={sl.start} onChange={(v) => setExtraSlots((prev) => updateSlot(prev, sl.id, { start: v }))} />
                      </div>
                      <div className="ampm-time-row">
                        <span className="ampm-time-label">종료</span>
                        <AmPmTimeInput value={sl.end} onChange={(v) => setExtraSlots((prev) => updateSlot(prev, sl.id, { end: v }))} />
                      </div>
                    </div>
                  ))}
                  {extraSlots.length + 1 < MAX_TIME_SLOTS && (
                    <button type="button" className="time-slot-add"
                      onClick={() => setExtraSlots((prev) => addSlot(prev, { start: form.start, end: form.end }))}>+ 시간 추가</button>
                  )}
                  {extraSlots.length > 0 && (
                    <div className="perm-guide" style={{ margin: "6px 0 0" }}>
                      {repeat ? "선택한 모든 날짜마다 " : "이 날짜에 "}시간 {extraSlots.length + 1}개만큼 수업이 만들어져요.
                    </div>
                  )}
                </>
              )}
              <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>수업 형태</div>
              <div className="mem-filters" style={{ padding: 0 }}>
                <button aria-pressed={form.classFormat !== "private"} className={`filter-chip ${form.classFormat !== "private" ? "on" : ""}`}
                  onClick={() => setForm({ ...form, classFormat: "group" })}>그룹</button>
                <button aria-pressed={form.classFormat === "private"} className={`filter-chip ${form.classFormat === "private" ? "on" : ""}`}
                  onClick={() => setForm({ ...form, classFormat: "private", capacity: 1 })}>프라이빗(1:1)</button>
              </div>

              <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>정원</div>
              <div className="deadline-row">
                <input aria-label="8" className="input-field" inputMode="numeric" style={{ maxWidth: 90 }}
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
                  <button aria-pressed={!form.roomId} className={`filter-chip ${!form.roomId ? "on" : ""}`} onClick={() => setForm({ ...form, roomId: null })}>미지정</button>
                  {rooms.map((r) => (
                    <button aria-pressed={form.roomId === r.id} key={r.id} className={`filter-chip ${form.roomId === r.id ? "on" : ""}`} onClick={() => setForm({ ...form, roomId: r.id })}>{r.name}</button>
                  ))}
                </div>
              </>
            )}

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>예약 가능 시간(마감)</div>
            <div className="deadline-row">
              <span className="deadline-pre">수업 시작</span>
              <input aria-label="예약 마감 일" className="input-field deadline-num" inputMode="numeric" placeholder="0"
                value={bookD} onChange={(e) => setBookD(e.target.value)} />
              <span className="deadline-unit">일</span>
              <input aria-label="예약 마감 시간" className="input-field deadline-num" inputMode="numeric" placeholder="0"
                value={bookH} onChange={(e) => setBookH(e.target.value)} />
              <span className="deadline-unit">시간</span>
              <input aria-label="예약 마감 분" className="input-field deadline-num" inputMode="numeric" placeholder="0"
                value={bookM} onChange={(e) => setBookM(e.target.value)} />
              <span className="deadline-unit">분 전까지</span>
            </div>
            {/* 2026-10-01(B-1/B-2) — 빈 칸이면 운영설정 기본값이 적용된다는 사실은 알아도
                "그래서 지금 실제로 며칠 전인지"는 이 화면만으로 알 수 없었다 — 운영설정
                화면과 같은 표현으로 실제 적용값을 바로 보여준다(별도 변환 없이 그대로,
                DB에는 여전히 비워둔 상태 그대로 저장돼 나중에 운영설정이 바뀌면 자동으로
                따라간다 — B-3, override를 새로 저장하지 않음). 값을 입력해 override한
                뒤에는 "운영설정 값으로 되돌리기"로 다시 상속 상태(빈 칸)로 되돌릴 수 있다. */}
            {bookD === "" && bookH === "" && bookM === "" ? (
              effectiveDeadlineText("book") && (
                <div className="perm-guide" style={{ margin: "4px 0 0" }}>{effectiveDeadlineText("book")} (운영설정 값 사용 중)</div>
              )
            ) : (
              <div className="perm-guide" style={{ margin: "4px 0 0", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span>이 수업만 다른 값으로 지정했어요(운영설정보다 우선 적용).</span>
                <button type="button" className="text-btn" style={{ fontWeight: 800 }} onClick={() => fillBookDeadline(null)}>운영설정 값으로 되돌리기</button>
              </div>
            )}

            <div className="set-row" style={{ padding: "12px 0", borderBottom: "none" }}>
              <div className="set-label">예약 취소 완전 불가<br /><span style={{ fontSize: 11, color: "var(--text-dim)" }}>특강 등 — 켜면 회원이 예약을 스스로 취소할 수 없어요(관리자 취소/노쇼 처리는 그대로 가능)</span></div>
              <button className={`switch ${!form.allowCancel ? "on" : ""}`} onClick={() => setForm({ ...form, allowCancel: !form.allowCancel })}>
                <span className="knob" />
              </button>
            </div>

            {form.allowCancel && (
              <>
                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>예약취소 가능 시간</div>
                <div className="deadline-row">
                  <span className="deadline-pre">수업 시작</span>
                  <input aria-label="취소 마감 일" className="input-field deadline-num" inputMode="numeric" placeholder="0"
                    value={cancelD} onChange={(e) => setCancelD(e.target.value)} />
                  <span className="deadline-unit">일</span>
                  <input aria-label="취소 마감 시간" className="input-field deadline-num" inputMode="numeric" placeholder="0"
                    value={cancelH} onChange={(e) => setCancelH(e.target.value)} />
                  <span className="deadline-unit">시간</span>
                  <input aria-label="취소 마감 분" className="input-field deadline-num" inputMode="numeric" placeholder="0"
                    value={cancelM} onChange={(e) => setCancelM(e.target.value)} />
                  <span className="deadline-unit">분 전까지</span>
                </div>
                {cancelD === "" && cancelH === "" && cancelM === "" ? (
                  effectiveDeadlineText("cancel") && (
                    <div className="perm-guide" style={{ margin: "4px 0 0" }}>{effectiveDeadlineText("cancel")} (운영설정 값 사용 중)</div>
                  )
                ) : (
                  <div className="perm-guide" style={{ margin: "4px 0 0", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span>이 수업만 다른 값으로 지정했어요(운영설정보다 우선 적용).</span>
                    <button type="button" className="text-btn" style={{ fontWeight: 800 }} onClick={() => fillDeadline(null)}>운영설정 값으로 되돌리기</button>
                  </div>
                )}
              </>
            )}
            </div>

            {/* 상품 사용 허용 */}
            <div className="set-row" style={{ padding: "12px 0", borderBottom: "none" }}>
              <div className="set-label">보유 상품 사용 허용<br /><span style={{ fontSize: 11, color: "var(--text-dim)" }}>회원이 예약 시 대여 상품 등을 함께 쓸 수 있어요</span></div>
              <button className={`switch ${form.allowGoods ? "on" : ""}`} onClick={() => setForm({ ...form, allowGoods: !form.allowGoods })}>
                <span className="knob" />
              </button>
            </div>

            {/* 예약 가능 수강권 선택 (P3: class_allowed_products, 수강권 허용 정책 변경) */}
            <div className="menu-section-label" style={{ padding: "8px 0 6px" }}>예약 가능 수강권</div>
            <div className="perm-guide" style={{ margin: "0 0 4px" }}>
              {passProducts.length > 0 && selectedProducts.length === 0
                ? <span className="is-error-text"><UiIcon name="alert" size={13} /> 최소 1개 이상 선택해야 저장할 수 있어요.
                  모든 수강권을 허용하려면 아래 <b>전체 선택</b> 버튼을 눌러주세요.</span>
                : selectedProducts.length === passProducts.length
                ? <><b>모든 수강권</b>으로 예약 가능해요(전체 선택). 이 경우 각 수강권 자체에 걸린
                  요일/시간 예약조건(수강권 관리)은 이것과 별개로 계속 적용되고, 나중에 수강권이
                  추가돼도 자동으로 포함돼요.</>
                : <><b>{selectedProducts.length}개</b> 수강권만 이 수업에 사용할 수 있어요. 이렇게 특정
                  수강권을 이 수업에 직접 지정하면, 그 수강권 자체의 요일/시간 예약조건과 무관하게
                  이 수업에서 사용할 수 있어요(직접 지정이 예약조건보다 우선).</>}
            </div>
            {(() => {
              if (!form.date || !form.start || !form.title.trim() || passProducts.length === 0) return null;
              const [y, m, d] = form.date.split("-").map(Number);
              if (!y || !m || !d) return null;
              const classDow = new Date(y, m - 1, d).getDay();
              const target = { dayOfWeek: classDow, startTime: form.start, classTitle: form.title.trim() };

              if (selectedProducts.length === passProducts.length) {
                // 모든 수강권 허용 — 수강권 자체의 예약조건이 그대로 적용되므로, 실제로 배제되는
                // 수강권이 있으면 경고로 안내한다.
                const excluded = findScheduleExcludedProducts(
                  passProducts.map((p) => ({ id: p.id, name: p.name })),
                  rulesByProduct,
                  target
                );
                if (excluded.length === 0) return null;
                return (
                  <div className="perm-guide is-error schedule-rule-warning" style={{ margin: "0 0 8px" }}>
                    <UiIcon name="alert" size={13} /> 이 수업({WEEKDAYS[classDow]}요일 {form.start})에서는 <b>{excluded.length}개</b> 수강권을
                    실제로 쓸 수 없어요(수강권 자체의 예약조건과 안 맞음):
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                      {excluded.map((ex) => (
                        <li key={ex.productId} className="schedule-rule-warning-item" style={{ fontSize: 12 }}>
                          {ex.productName} — 허용 조건: {ex.rules.map(ruleToText).join(" 또는 ")}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              }

              // 특정 수강권 직접 지정 — 선택된 수강권은 예약조건과 무관하게 이 수업에서 사용
              // 가능하다(서버 override와 동일 조건). 원래 조건이 있던 것만 골라 안내한다.
              const selectedPassProducts = passProducts.filter((p) => selectedProducts.includes(p.id));
              const overridden = findScheduleExcludedProducts(
                selectedPassProducts.map((p) => ({ id: p.id, name: p.name })),
                rulesByProduct,
                target
              );
              if (overridden.length === 0) return null;
              return (
                <div className="perm-guide is-info schedule-rule-override-note" style={{ margin: "0 0 8px" }}>
                  <UiIcon name="info" size={13} /> 아래 <b>{overridden.length}개</b> 수강권은 원래 예약조건이 있지만, 이 수업에 직접
                  지정했으므로 그 조건과 무관하게 사용할 수 있어요(직접 지정이 우선):
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {overridden.map((ex) => (
                      <li key={ex.productId} className="schedule-rule-override-item" style={{ fontSize: 12 }}>
                        {ex.productName} — 원래 조건: {ex.rules.map(ruleToText).join(" 또는 ")}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            {passProducts.length === 0 ? (
              <div className="daylist-empty" style={{ padding: "8px 0" }}>
                <span style={{ fontSize: 12 }}>등록된 수강권이 없어요 (수강권 관리에서 먼저 추가)</span>
              </div>
            ) : (
              <>
                {passProducts.length > 1 && (
                  <input aria-label="수강권 이름 검색"
                    className="input-field"
                    style={{ marginBottom: 8 }}
                    placeholder="수강권 이름 검색"
                    value={passSearch}
                    onChange={(e) => setPassSearch(e.target.value)}
                  />
                )}
                <div style={{ display: "flex", gap: 10, marginBottom: 6 }}>
                  {selectedProducts.length < passProducts.length && (
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => {
                        userEditedRef.current = true;
                        setSelectedProducts(passProducts.map((p) => p.id));
                      }}
                    >
                      전체 선택(모든 수강권 허용)
                    </button>
                  )}
                  {selectedProducts.length > 0 && (
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => {
                        userEditedRef.current = true;
                        setSelectedProducts([]);
                      }}
                    >
                      전체 해제
                    </button>
                  )}
                </div>
                {(() => {
                  const COLLAPSE_THRESHOLD = 20;
                  const q = passSearch.trim().toLowerCase();
                  const filtered = q ? passProducts.filter((p) => p.name.toLowerCase().includes(q)) : passProducts;
                  if (filtered.length === 0) {
                    return (
                      <div className="daylist-empty" style={{ padding: "8px 0" }}>
                        <span style={{ fontSize: 12 }}>"{passSearch}"와 일치하는 수강권이 없어요</span>
                      </div>
                    );
                  }
                  const chip = (p: Product) => (
                    <button aria-pressed={selectedProducts.includes(p.id)}
                      key={p.id}
                      className={`filter-chip ${selectedProducts.includes(p.id) ? "on" : ""}`}
                      onClick={() => {
                        // dirty 플래그 — 클릭 이벤트 핸들러 본문은(setState 함수형
                        // 업데이터와 달리) StrictMode에서 두 번 호출되지 않는다.
                        userEditedRef.current = true;
                        setSelectedProducts((prev) =>
                          prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id]
                        );
                      }}
                    >
                      {p.name}
                    </button>
                  );
                  // 검색 중이면 필터링 자체가 이미 목록을 좁혀주므로 접지 않고 전부 보여준다.
                  if (q) {
                    return <div className="mem-filters class-allowed-products-list" style={{ padding: "0 0 6px" }}>{filtered.map(chip)}</div>;
                  }
                  // "전체 선택"(기본값, 신규 등록 폼이 항상 시작하는 상태)일 때는 위 안내
                  // 문구가 이미 "모든 수강권으로 예약 가능"이라고 설명해주므로, 접힌 채로
                  // 시작해 개별 취소가 필요할 때만 펼치게 한다 — 이게 실제로 100개+ 인라인
                  // 노출이 나타나던 지점이었다(신규 등록은 항상 전체선택으로 시작해서
                  // "선택 안 한 나머지" 기준 접기만으로는 커버가 안 됐음).
                  const isAllMode = selectedProducts.length === passProducts.length;
                  if (isAllMode && !productsExpanded && filtered.length > COLLAPSE_THRESHOLD) {
                    return (
                      <button type="button" className="text-btn" onClick={() => setProductsExpanded(true)}>
                        전체 {filtered.length}개 목록 보기 (특정 수강권만 제외하려면)
                      </button>
                    );
                  }
                  const chosen = filtered.filter((p) => selectedProducts.includes(p.id));
                  const rest = filtered.filter((p) => !selectedProducts.includes(p.id));
                  const showAllRest = productsExpanded || rest.length <= COLLAPSE_THRESHOLD;
                  const restShown = showAllRest ? rest : rest.slice(0, COLLAPSE_THRESHOLD);
                  return (
                    <>
                      {chosen.length > 0 && (
                        <div className="mem-filters class-allowed-products-list" style={{ padding: "0 0 6px" }}>{chosen.map(chip)}</div>
                      )}
                      {restShown.length > 0 && (
                        <div className="mem-filters class-allowed-products-list" style={{ padding: "0 0 6px" }}>{restShown.map(chip)}</div>
                      )}
                      {!showAllRest && (
                        <button type="button" className="text-btn" onClick={() => setProductsExpanded(true)}>
                          나머지 {rest.length - COLLAPSE_THRESHOLD}개 더 보기
                        </button>
                      )}
                    </>
                  );
                })()}
              </>
            )}

            {/* 담당 강사 선택 (복수 지정 가능, class_trainers) */}
            <div className="menu-section-label" style={{ padding: "8px 0 6px" }}>담당 강사</div>
            <div className="perm-guide" style={{ margin: "0 0 4px" }}>
              선택하지 않아도 수업은 정상 등록돼요. 여러 명을 함께 지정할 수 있어요.
            </div>
            {staffList.length === 0 ? (
              <div className="daylist-empty" style={{ padding: "8px 0" }}>
                <span style={{ fontSize: 12 }}>등록된 스태프가 없어요 (스태프 & 권한에서 먼저 추가)</span>
              </div>
            ) : (
              <>
                {staffList.length > 1 && (
                  <input aria-label="강사 이름 검색"
                    className="input-field"
                    style={{ marginBottom: 8 }}
                    placeholder="강사 이름 검색"
                    value={trainerSearch}
                    onChange={(e) => setTrainerSearch(e.target.value)}
                  />
                )}
                {(() => {
                  const q = trainerSearch.trim().toLowerCase();
                  const filtered = q ? staffList.filter((s) => s.name.toLowerCase().includes(q)) : staffList;
                  if (filtered.length === 0) {
                    return (
                      <div className="daylist-empty" style={{ padding: "8px 0" }}>
                        <span style={{ fontSize: 12 }}>"{trainerSearch}"와 일치하는 스태프가 없어요</span>
                      </div>
                    );
                  }
                  return (
                    <div className="mem-filters class-trainers-list" style={{ padding: "0 0 6px" }}>
                      {filtered.map((s) => (
                        <button aria-pressed={selectedTrainers.includes(s.accountId)}
                          key={s.accountId}
                          className={`filter-chip ${selectedTrainers.includes(s.accountId) ? "on" : ""}`}
                          onClick={() => {
                            trainerEditedRef.current = true;
                            // 선택 순서가 곧 저장/표시 순서 — 새로 선택하면 맨 뒤, 해제 후 다시 선택해도 맨 뒤
                            setSelectedTrainers((prev) => toggleTrainerSelection(prev, s.accountId));
                          }}
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                  );
                })()}
                {/* 표시 순서 미리보기 — 선택/해제 즉시 반영. 저장되는 순서이자 회원/관리자 화면에 보이는 순서다. */}
                <div className="trainer-order-preview" aria-live="polite">
                  <div className="trainer-order-title">표시 순서 미리보기</div>
                  {(() => {
                    const items = trainerPreviewItems(selectedTrainers, Object.fromEntries(staffList.map((s) => [s.accountId, s.name])));
                    if (items.length === 0) return <div className="trainer-order-empty">{TRAINER_PREVIEW_EMPTY}</div>;
                    return (
                      <ol className="trainer-order-list">
                        {items.map((it) => (
                          <li key={it.accountId}><b>{it.position}</b><span>{it.name}</span></li>
                        ))}
                      </ol>
                    );
                  })()}
                </div>
              </>
            )}

            {scheduleConflicts.length > 0 && (
              <div className="perm-guide is-warning" style={{ margin: "8px 0" }}>
                <UiIcon name="alert" size={13} /> 같은 시간대에 이미 다른 수업이 있어요(저장은 그대로 진행돼요):
                {scheduleConflicts.map((c, i) => (
                  <div key={i}>{c.kind === "room" ? "룸" : "강사"} 겹침 · {c.title}({c.start}~{c.end})</div>
                ))}
              </div>
            )}

            {/* 반복 수업 일괄 적용 (그룹 소속 수정일 때만) */}
            {editId && editGroupId && (
              <div className="set-row" style={{ padding: "10px 0", borderBottom: "none" }}>
                <div className="set-label">모든 반복 수업에 적용<br /><span style={{ fontSize: 11, color: "var(--text-dim)" }}>수업명·소개·정원·룸·담당 강사와 변경한 수강권 설정이 반복 수업 전체에 적용돼요. 날짜·시간은 수업별로 유지돼요.</span></div>
                <button className={`switch ${applyToGroup ? "on" : ""}`} onClick={() => { setApplyToGroup(!applyToGroup); if (applyToGroup) setApplyTimeToGroup(false); }}>
                  <span className="knob" />
                </button>
              </div>
            )}
            {editId && editGroupId && applyToGroup && (
              <div className="set-row" style={{ padding: "4px 0 10px", borderBottom: "none" }}>
                <div className="set-label">시간도 함께 변경<br /><span style={{ fontSize: 11, color: "var(--text-dim)" }}>켜면 모든 반복 수업의 시작·종료 시간이 위에 입력한 시간으로 바뀌어요. 요일마다 시간이 다르면 꺼두세요.</span></div>
                <button className={`switch ${applyTimeToGroup ? "on" : ""}`} aria-pressed={applyTimeToGroup} onClick={() => setApplyTimeToGroup(!applyTimeToGroup)}>
                  <span className="knob" />
                </button>
              </div>
            )}

            {editId && (
              <div className="set-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10, padding: "14px 0" }}>
                <div className="set-label">관리자 메모<br /><span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 500 }}>센터 운영자만 보는 내부 메모이며 회원에게 표시되지 않아요. (회원에게 보이는 설명은 위의 ‘수업 소개’에 적어주세요.)</span></div>
                {memos.map((m) => {
                  const canEditThis = (m.authorAccountId === myAccountId && canEditOwnMemo) || canManageAnyMemo;
                  return (
                    <div key={m.id} style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px" }}>
                      {editingMemoId === m.id ? (
                        <>
                          <textarea
                            className="input-field" style={{ width: "100%", minHeight: 60 }}
                            value={editingMemoContent} onChange={(e) => setEditingMemoContent(e.target.value)}
                          />
                          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                            <button className="quiet-action" disabled={memoBusy} onClick={handleSaveMemoEdit}>저장</button>
                            <button className="quiet-action" disabled={memoBusy} onClick={() => setEditingMemoId(null)}>취소</button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{m.content}</div>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{m.authorName} · {new Date(m.createdAt).toLocaleString("ko-KR")}</span>
                            {canEditThis && (
                              <div style={{ display: "flex", gap: 6 }}>
                                <button className="quiet-action" disabled={memoBusy} onClick={() => { setEditingMemoId(m.id); setEditingMemoContent(m.content); }}>수정</button>
                                <button className="quiet-action danger" disabled={memoBusy} onClick={() => handleDeleteMemo(m.id)}>삭제</button>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
                {canAddMemo && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <textarea aria-label="관리자 메모 입력"
                      className="input-field" style={{ flex: 1, minHeight: 40 }}
                      placeholder="운영자만 보는 메모를 남겨보세요" value={memoInput} onChange={(e) => setMemoInput(e.target.value)}
                    />
                    <button className="quiet-action" disabled={memoBusy || !memoInput.trim()} onClick={handleAddMemo}>등록</button>
                  </div>
                )}
              </div>
            )}

            {/* 2026-10-01(B-6) — 예전엔 "등록하기"(저장) 버튼 하나뿐이라 저장하지 않고
                나가려면 배경을 눌러 닫는 방법뿐이었다(뒤로가기/명시적 취소 버튼 없음).
                취소 버튼을 추가하고, 배경 탭과 완전히 같은 동작(setFormOpen(false))을
                쓴다 — drag-to-dismiss(B-9~B-11)도 같은 동작을 공유한다. */}
            <div className="add-profile-actions sheet-actions-37" style={{ marginTop: 20 }}>
              <button className="ghost-btn" disabled={busy} onClick={closeFormSheet}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={save}>
                {busy ? "저장 중..." : editId ? "수정하기" : "등록하기"}
              </button>
            </div>
          </div>
        </SheetOverlay>
      )}

      {/* 삭제 확인 시트 */}
      {deleteTarget && (
        <SheetOverlay className="sheet-overlay" swipeDismiss={false} onClick={() => setDeleteTarget(null)}>
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
        </SheetOverlay>
      )}

      {/* 예약자 명단 시트 */}
      {/* 보강 예약 - 회원 선택 */}
      {bookSheet && rosterClass && (
        <SheetOverlay className="sheet-overlay on-top" onClick={() => setBookSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">보강 예약</div>
            <div className="perm-guide" style={{ margin: "0 0 12px" }}>
              {rosterClass.date} {rosterClass.start} · {rosterClass.title}<br />
              수강권 요일 조건과 상관없이 예약을 넣을 수 있어요.
            </div>

            {!bookPick ? (
              <>
                <input aria-label="회원 이름 검색" className="input-field" placeholder="회원 이름 검색"
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
                    <button aria-pressed={!bookMemId} className={`filter-chip ${!bookMemId ? "on" : ""}`} onClick={() => setBookMemId(null)}>
                      사용 안 함
                    </button>
                    {bookPick.memberships.map((mm) => (
                      <button aria-pressed={bookMemId === mm.id} key={mm.id} className={`filter-chip ${bookMemId === mm.id ? "on" : ""}`}
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
        </SheetOverlay>
      )}

      {/* 미배치 수강권 */}
      {unplacedSheet && (
        <SheetOverlay className="sheet-overlay" onClick={() => setUnplacedSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">배치 안 된 수강권</div>
            <div className="perm-guide" style={{ margin: "0 0 12px" }}>
              요일반 수강권을 샀지만 정원이 차거나 수업이 없어서
              예약이 다 잡히지 못한 회원이에요. 수강권 만료일 이후의 수업은 횟수가 남아 있어도 자동으로 예약하지 않아요.<br />
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
                    {/* 미배치 사유 — 만료일 초과 / 정원 부족 / 조건 불일치 / 이미 예약 등을 구분해서 보여준다 */}
                    <div className={`unplaced-reason ${u.reason === "outside_membership_period" ? "is-expired" : ""}`}>
                      {unplacedReasonText(u)}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <button className="unplaced-retry" disabled={unplacedBusy || !u.canRetry}
                      title={u.canRetry ? undefined : "수강권 만료일이 지나 다시 배치할 수 없어요"}
                      onClick={() => handleRetryAutoBook(u)}>다시 배치</button>
                    {canAssignReservation && !u.expired && (
                      <button className="unplaced-retry" style={{ background: "var(--surface)", color: "var(--text)" }}
                        onClick={() => startAssignFromUnplaced(u)}>직접배치</button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <button className="ghost-btn" style={{ width: "100%", marginTop: 12 }} onClick={() => setUnplacedSheet(false)}>닫기</button>
          </div>
        </SheetOverlay>
      )}

      {/* 스케줄 복사 */}
      {copySheet && (
        <SheetOverlay className="sheet-overlay" onClick={() => setCopySheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">스케줄 복사</div>

            {/* 복사 방식 */}
            <div className="mem-filters" style={{ padding: 0 }}>
              <button aria-pressed={copyMode === "weekday"} className={`filter-chip ${copyMode === "weekday" ? "on" : ""}`}
                onClick={() => { setCopyMode("weekday"); setCopyPlan(null); if (copyFrom) loadCopySource(copyFrom, "weekday"); }}>
                요일 기준
              </button>
              <button aria-pressed={copyMode === "date"} className={`filter-chip ${copyMode === "date" ? "on" : ""}`}
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
            <MonthPicker value={copyFrom} label="복사할 달" onChange={(value) => { setCopyFrom(value); loadCopySource(value, copyMode); }} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>붙여넣을 달 (대상)</div>
            <MonthPicker value={copyTo} label="붙여넣을 달" onChange={(value) => { setCopyTo(value); setCopyPlan(null); }} />

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
                    {copyView === "list" ? <><UiIcon name="calendar" size={14} /> 달력</> : <><UiIcon name="list" size={14} /> 목록</>}
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
        </SheetOverlay>
      )}

      {rosterClass && (
        <SheetOverlay className="sheet-overlay" onClick={() => setRosterClass(null)}>
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
                        {a.goodsLabel && <span className="roster-goods"> · {a.goodsLabel}</span>}
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
                          ) : canAssignReservation ? (
                            <button className="att-btn cancel" disabled={attBusy}
                              onClick={() => { setAdminCancelTarget(a); setAdminCancelReason(""); }}>관리자 배치 취소</button>
                          ) : null}
                        </>
                      )}
                      <Link className="att-btn prog" href={`/manager/progress/record?profile=${a.profileId}`} prefetch={false}>진도</Link>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="add-profile-actions" style={{ marginTop: 6 }}>
              <button className="ghost-btn" onClick={() => setRosterClass(null)}>닫기</button>
            </div>
          </div>
        </SheetOverlay>
      )}

      {/* 회원 정보 팝업 (명단에서 이름 클릭) */}
      {memberInfo && (
        <SheetOverlay className="sheet-overlay" onClick={() => setMemberInfo(null)}>
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
                        {p.name}{p.remaining != null ? ` · ${p.remaining}회` : ""} <span className="mem-pass-exp">~{p.expiresAt ?? "무제한"}</span>
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
                <Link className="primary-btn" href={`/manager/members?profile=${memberInfo.profileId}`} style={{ marginTop: 10, display: "block", textAlign: "center" }} prefetch={false}>회원 관리에서 전체 보기</Link>
              </>
            )}
            <div className="add-profile-actions" style={{ marginTop: 6 }}>
              <button className="ghost-btn" onClick={() => setMemberInfo(null)}>닫기</button>
            </div>
          </div>
        </SheetOverlay>
      )}
      {/* 직접배치 - 대상 회원 선택 */}
      {assignMemberSheet && (
        <SheetOverlay className="sheet-overlay on-top" onClick={() => setAssignMemberSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">직접배치 대상 회원 선택</div>
            <input aria-label="회원 이름 검색" className="input-field" placeholder="회원 이름 검색"
              value={assignKw} onChange={(e) => setAssignKw(e.target.value)} />
            <div className="book-member-list">
              {assignMembersList
                .filter((m) => !assignKw.trim() || m.name.includes(assignKw.trim()))
                .slice(0, 50)
                .map((m) => {
                  // 휴면·만료 회원은 customer.member.assign_any_status가 있어야 배치 가능(서버가
                  // 최종 방어선) — 없는 스태프에겐 미리 비활성화해 눌러도 거부당할 걸 알려준다.
                  const blocked = m.memberStatus && m.memberStatus !== "active" && !canAssignAnyStatus;
                  return (
                    <button key={m.profileId} className="book-member-row" disabled={!!blocked} onClick={() => pickAssignMember(m)}>
                      <span className="book-member-identity"><span className="book-member-avatar">{m.name.slice(0, 1)}</span><span className="book-member-name">{m.name}</span></span>
                      <span className={`book-member-pass ${m.memberships.length === 0 ? "empty" : ""}`}>
                        {blocked
                          ? (m.memberStatus === "expired" ? "만료회원 · 권한 없음" : "휴면회원 · 권한 없음")
                          : m.memberships.length > 0
                          ? `${m.memberships[0].name}${m.memberships[0].remaining != null ? ` ${m.memberships[0].remaining}회` : ""}`
                          : "수강권 없음"}
                      </span>
                    </button>
                  );
                })}
              {assignMembersList.length === 0 && (
                <div className="daylist-empty" style={{ padding: 16 }}>회원이 없어요</div>
              )}
            </div>
            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setAssignMemberSheet(false)}>취소</button>
            </div>
          </div>
        </SheetOverlay>
      )}

      {/* 직접배치 - 확인 팝업 (일반 직접배치 / 무료 추가 배치 / 정원 초과) */}
      {assignConfirm && assignMember && (
        <SheetOverlay className="sheet-overlay on-top" swipeDismiss={false} onClick={() => !assignBusy && setAssignConfirm(null)}>
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
                      <button aria-pressed={assignConfirm.membershipId === mm.id} key={mm.id} className={`filter-chip ${assignConfirm.membershipId === mm.id ? "on" : ""}`}
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
                <span className="is-error-text" style={{ fontWeight: 700 }}>(필수)</span>
              )}
            </div>
            <div className="mem-filters" style={{ padding: 0 }}>
              {ADMIN_REASON_CODES.map((code) => (
                <button aria-pressed={assignConfirm.reasonCode === code} key={code} className={`filter-chip ${assignConfirm.reasonCode === code ? "on" : ""}`}
                  onClick={() => setAssignConfirm({ ...assignConfirm, reasonCode: code })}>
                  {ADMIN_REASON_LABELS[code]}
                </button>
              ))}
            </div>
            {assignConfirm.reasonCode === "OTHER" && (
              <>
                <textarea aria-label="상세 사유 (필수, 최대 200자)" className="input-field" style={{ marginTop: 8, minHeight: 60, width: "100%" }}
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
        </SheetOverlay>
      )}

      {/* 관리자 배치 취소 확인 */}
      {adminCancelTarget && (
        <SheetOverlay className="sheet-overlay on-top" swipeDismiss={false} onClick={() => !adminCancelBusy && setAdminCancelTarget(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">이 회원의 관리자 배치 예약을 취소하시겠습니까?</div>
            <div className="perm-guide" style={{ margin: "0 0 12px" }}>
              관리자 배치 취소 내역은 별도로 기록되며 회원에게 취소 알림이 전송됩니다.
            </div>
            <div className="hist-summary" style={{ padding: "0 0 8px" }}>{adminCancelTarget.name} 회원</div>
            <input aria-label="취소 사유 (선택)" className="input-field" placeholder="취소 사유 (선택)"
              value={adminCancelReason} onChange={(e) => setAdminCancelReason(e.target.value)} />
            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" disabled={adminCancelBusy} onClick={() => setAdminCancelTarget(null)}>취소</button>
              <button className="primary-btn danger-btn" disabled={adminCancelBusy} onClick={handleAdminCancel}>
                {adminCancelBusy ? "처리 중..." : "관리자 배치 취소"}
              </button>
            </div>
          </div>
        </SheetOverlay>
      )}

    </div>
  );
}
