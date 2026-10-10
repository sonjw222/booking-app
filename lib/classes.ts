/*
  수업 관리 데이터 함수 (매니저용)
  - 특정 센터의 수업 목록 조회 / 생성 / 수정 / 삭제
  - 매니저 RLS 정책(reservation_functions.sql)이 있어야 생성·수정이 동작
*/

import { supabase } from "./supabaseClient";
import type { ReservationType } from "./reservationTypes";
import { toKstIso } from "./kst";
import { appendTrainerNames } from "./instructorDisplay";

import { todayKstYmd } from "./membershipExpiry";
export type ManagedClass = {
  id: string;
  title: string;
  description: string | null; // 수업 소개 (회원 화면 목록에는 안 보이고 예약 상세에서만 표시)
  date: string; // "2026-07-14"
  start: string; // "07:10"
  end: string;
  capacity: number;
  reserved: number;
  recurringGroupId: string | null;
  allowGoods: boolean;
  allowCancel: boolean; // false면 회원이 예약을 스스로 취소할 수 없음(특강 등)
  roomId: string | null;
  cancelDeadlineMin: number | null; // null이면 운영설정 기본값 사용
  bookingDeadlineMin: number | null; // null이면 운영설정 기본값 사용(CLASS-001)
  classFormat: "group" | "private";  // CLASS-001 D-2: 그룹/프라이빗(1:1) 구분
  status: string; // "open" | "cancelled" | "closed"
  // 수강권 허용 정책: all=이 센터의 모든 active pass 허용(class_allowed_products는 비워둠),
  // selected=class_allowed_products에 명시적으로 저장된 product만 허용(1개 이상)
  passSelectionMode: "all" | "selected";
  instructorNames: string[]; // 담당 강사 이름 목록(class_trainers). 미지정이면 빈 배열
};

const KST_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const KST_TIME = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });

// 자정을 넘기는 것으로 인정하는 최대 길이(분). 23:00→01:00(2시간) 같은 심야 수업은
// 허용하되, 10:00→09:00(23시간) 같은 입력 실수는 "종료시간이 시작시간 이전"으로 거부한다.
const MAX_OVERNIGHT_MINUTES = 6 * 60;

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// 종료시간이 시작시간보다 늦으면 같은 날 안에서 끝나는 것이라 항상 유효.
// 그 외(종료 <= 시작)엔 자정을 넘긴 것으로 보되, 그 길이가 MAX_OVERNIGHT_MINUTES를
// 넘으면(=사실상 시작시간 이후가 아닌 것으로 봐야 할 만큼 뒤집힌 값) 무효 처리한다.
export function isValidClassTimeRange(start: string, end: string): boolean {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (e > s) return true;
  const overnightMinutes = 24 * 60 - s + e;
  return overnightMinutes > 0 && overnightMinutes <= MAX_OVERNIGHT_MINUTES;
}

function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// end_time을 계산할 때 쓸 날짜 — 자정을 넘기는 경우(위 isValidClassTimeRange가 허용하는
// 범위 안)엔 다음날 날짜를 쓴다.
export function classEndDate(date: string, start: string, end: string): string {
  return timeToMinutes(end) <= timeToMinutes(start) ? addOneDay(date) : date;
}

function assertValidClassTimeRange(start: string, end: string): void {
  if (!isValidClassTimeRange(start, end)) {
    throw new Error("종료시간은 시작시간 이후여야 해요 (자정을 넘기는 경우는 6시간 이내만 허용)");
  }
}

export type ScheduleConflict = { classId: string; title: string; start: string; end: string; kind: "room" | "trainer" };

// 룸/강사가 같은 시간대에 겹치는 다른 수업이 있는지 확인 — create_class_safe/
// create_recurring_classes_safe/set_class_trainers_safe 등 서버 쪽엔 이 검증이 전혀 없다
// (2026-09-06 UX 감사). 일부 센터는 한 룸을 여러 수업이 동시에 쓰거나 강사가 겹치게
// 배정되는 걸 의도적으로 허용하므로, 여기서는 "막지 않고 경고만" 한다 — 호출부가 이
// 결과를 저장을 막는 데 쓰지 않도록 주의.
export async function checkScheduleConflicts(
  centerId: string, date: string, start: string, end: string,
  opts: { roomId?: string | null; trainerAccountIds?: string[]; excludeClassId?: string }
): Promise<ScheduleConflict[]> {
  const roomId = opts.roomId ?? null;
  const trainerIds = opts.trainerAccountIds ?? [];
  if (!date || !start || !end || (!roomId && trainerIds.length === 0)) return [];

  const dayClasses = await fetchClasses(centerId, date, date);
  const newStart = timeToMinutes(start);
  const newEnd = timeToMinutes(end) <= newStart ? timeToMinutes(end) + 24 * 60 : timeToMinutes(end);

  const overlapping = dayClasses.filter((c) => {
    if (c.id === opts.excludeClassId || c.status === "cancelled") return false;
    const cStart = timeToMinutes(c.start);
    const cEnd = timeToMinutes(c.end) <= cStart ? timeToMinutes(c.end) + 24 * 60 : timeToMinutes(c.end);
    return newStart < cEnd && cStart < newEnd;
  });
  if (overlapping.length === 0) return [];

  // 겹치는 수업이 여럿이어도 강사 조회는 1회(class_trainers .in) — 경고 용도라 실패는 무시한다.
  let trainersByClass: Record<string, string[]> = {};
  if (trainerIds.length > 0) {
    try { trainersByClass = await fetchClassTrainersBatch(overlapping.map((c) => c.id)); } catch { /* 경고 전용 */ }
  }
  const out: ScheduleConflict[] = [];
  for (const c of overlapping) {
    if (roomId && c.roomId === roomId) {
      out.push({ classId: c.id, title: c.title, start: c.start, end: c.end, kind: "room" });
    }
    if (trainerIds.length > 0 && (trainersByClass[c.id] ?? []).some((id) => trainerIds.includes(id))) {
      out.push({ classId: c.id, title: c.title, start: c.start, end: c.end, kind: "trainer" });
    }
  }
  return out;
}

// 여러 수업의 담당 강사 account_id를 한 번에 조회 (수업별 N회 조회 대체).
export async function fetchClassTrainersBatch(classIds: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (classIds.length === 0) return out;
  const { data, error } = await supabase
    .from("class_trainers")
    .select("class_id, account_id")
    .in("class_id", classIds);
  if (error) throw new Error("담당 강사를 불러오지 못했어요: " + error.message);
  for (const r of (data ?? []) as { class_id: string; account_id: string }[]) {
    (out[r.class_id] ??= []).push(r.account_id);
  }
  return out;
}

// 월 이동/센터 전환 등 연속 요청에서 "가장 마지막에 시작한 요청"만 반영하기 위한 가드.
export function createLatestGuard() {
  let seq = 0;
  return {
    next(): number { return ++seq; },
    isLatest(token: number): boolean { return token === seq; },
    invalidate(): void { seq++; },
  };
}

// 캘린더 렌더용 순수 집계 — 날짜(일)별 수업 수, 선택일 수업(시작시간 순). 입력 O(n).
export function countClassesByDay(classes: { date: string }[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const c of classes) {
    const day = parseInt(c.date.slice(8, 10), 10);
    out[day] = (out[day] ?? 0) + 1;
  }
  return out;
}

export function classesOnDate<T extends { date: string; start: string }>(classes: T[], dateKey: string): T[] {
  return classes.filter((c) => c.date === dateKey).sort((a, b) => a.start.localeCompare(b.start));
}

export async function fetchClasses(centerId: string, fromDate: string, toDate: string): Promise<ManagedClass[]> {
  // ⚠️ center_id로 이미 좁혀서 조회하니 PostgREST 기본 응답 행 수 제한(1000행)에 안 걸릴
  // 거라고 가정했었는데(과거 fetchMonthData 수정 당시의 가정 — lib/reservations.ts 참고),
  // 테스트 데이터가 많이 쌓인 센터 하나만으로도 실제로 걸리는 것을 확인했다(관리자 수업
  // 화면에서 이번 달 앞부분 수업만 1000개까지 보이고 그 뒤 수업은 통째로 안 보임). 같은
  // 이유로 fetchMonthData가 이미 쓰고 있는 .range() 페이지 단위 반복 조회를 여기도 적용한다.
  const rows: any[] = [];
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("classes")
      .select("id, title, description, start_time, end_time, capacity, recurring_group_id, allow_goods, allow_cancel, room_id, cancel_deadline_min, booking_deadline_min, class_format, status, pass_selection_mode")
      .eq("center_id", centerId)
      .gte("start_time", toKstIso(fromDate, "00:00"))
      .lte("start_time", toKstIso(toDate, "23:59"))
      .order("start_time")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error("수업을 불러오지 못했어요: " + error.message);
    rows.push(...(page ?? []));
    if (!page || page.length < PAGE_SIZE) break;
  }

  const ids = (rows ?? []).map((c) => c.id);
  const counts: Record<string, number> = {};
  // 수업별 담당 강사 이름. key = classId (관리자 목록에 담당 강사를 표시하기 위함 — QA에서
  // 발견: 회원 화면은 이미 fetchMonthData()가 class_trainer_names RPC로 채우고 있었지만
  // 관리자 목록(fetchClasses)에는 이 데이터가 아예 없었다. 새 RPC/테이블 없이 회원 화면과
  // 동일한 class_trainer_names RPC를 그대로 재사용).
  const instructorNamesByClass: Record<string, string[]> = {};
  if (ids.length > 0) {
    // ids가 많아지면(위 1000행 제한 수정으로 한 센터가 한 달에 수백~수천 개 수업을 가질 수
    // 있게 됨) .in()에 그 UUID를 전부 나열한 요청 URL이 너무 길어져 PostgREST가 "Bad
    // Request"로 거부한다(fetchMonthData의 CHUNK_SIZE와 동일한 이유) — 청크로 나눠 조회한다.
    const CHUNK_SIZE = 150;
    const idChunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) idChunks.push(ids.slice(i, i + CHUNK_SIZE));
    const [countChunkResults, trainerChunkResults] = await Promise.all([
      Promise.all(
        idChunks.map((chunk) => supabase.from("class_reservation_counts").select("class_id, confirmed_count").in("class_id", chunk))
      ),
      Promise.all(
        idChunks.map((chunk) => supabase.rpc("class_trainer_names", { p_class_ids: chunk }))
      ),
    ]);
    for (const { data: countRows } of countChunkResults) {
      for (const r of countRows ?? []) counts[r.class_id] = r.confirmed_count;
    }
    for (const { data: trainerRows, error: trainerErr } of trainerChunkResults) {
      if (trainerErr) throw new Error("담당 강사를 불러오지 못했어요: " + trainerErr.message);
      appendTrainerNames(instructorNamesByClass, trainerRows as any);   // 서버가 정한 선택 순서(sort_order) 그대로
    }
  }

  return (rows ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description ?? null,
    date: KST_DATE.format(new Date(c.start_time)),
    start: KST_TIME.format(new Date(c.start_time)),
    end: KST_TIME.format(new Date(c.end_time)),
    capacity: c.capacity,
    reserved: counts[c.id] ?? 0,
    recurringGroupId: c.recurring_group_id ?? null,
    allowGoods: c.allow_goods ?? false,
    allowCancel: c.allow_cancel ?? true,
    roomId: c.room_id ?? null,
    cancelDeadlineMin: c.cancel_deadline_min ?? null,
    bookingDeadlineMin: c.booking_deadline_min ?? null,
    classFormat: (c.class_format ?? "group") as "group" | "private",
    status: c.status ?? "open",
    passSelectionMode: (c.pass_selection_mode ?? "all") as "all" | "selected",
    instructorNames: instructorNamesByClass[c.id] ?? [],
  }));
}

export type ClassInput = {
  title: string;
  description?: string | null; // 수업 소개 (선택, 회원 예약 상세에만 표시)
  date: string;
  start: string;
  end: string;
  capacity: number;
  allowGoods: boolean;
  allowCancel?: boolean;               // false면 회원 셀프취소 불가(특강 등). 기본값 true
  roomId?: string | null;
  cancelDeadlineMin?: number | null;   // 예약취소 마감 (분). null이면 센터 설정 사용
  bookingDeadlineMin?: number | null;  // 예약마감 (분). null이면 센터 설정 사용(CLASS-001)
  classFormat?: "group" | "private";   // CLASS-001 D-2, 기본값 group
  passSelectionMode?: "all" | "selected"; // 기본값 'all'(컬럼 기본값과 동일)
};

// P1-5b: create_class_safe RPC를 거친다 — own/other 세분권한(schedule.own/other.
// {group|private}.create/update)이 서버 함수 안에서 판정되므로 직접 insert하지 않는다.
export async function createClass(centerId: string, input: ClassInput): Promise<string> {
  assertValidClassTimeRange(input.start, input.end);
  const { data, error } = await supabase.rpc("create_class_safe", {
    p_center_id: centerId,
    p_title: input.title,
    p_description: input.description ?? null,
    p_start_time: toKstIso(input.date, input.start),
    p_end_time: toKstIso(classEndDate(input.date, input.start, input.end), input.end),
    p_capacity: input.capacity,
    p_allow_goods: input.allowGoods,
    p_room_id: input.roomId ?? null,
    p_cancel_deadline_min: input.cancelDeadlineMin ?? null,
    p_booking_deadline_min: input.bookingDeadlineMin ?? null,
    p_class_format: input.classFormat ?? "group",
    p_pass_selection_mode: input.passSelectionMode ?? "all",
    p_allow_cancel: input.allowCancel ?? true,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return data as string;
}

// QA Fix Batch(2026-09-18) — update_class_safe()가 이제 정원 축소를 확정 인원 미만으로
// 거부하고(서버가 최종 권한 — 아래 app/manager/classes/page.tsx의 사전 체크는 UX 편의일
// 뿐), 정원 확대 시 대기자를 자동 승격한 뒤 promoted_count를 반환한다. 반환 타입이
// void→json으로 바뀌었지만 기존 호출부는 error만 확인했으므로 하위호환된다 — 여기서
// promotedCount를 노출해 호출부가 원하면 안내 토스트를 띄울 수 있게 했다.
export async function updateClass(classId: string, input: ClassInput): Promise<{ promotedCount: number }> {
  assertValidClassTimeRange(input.start, input.end);
  const { data, error } = await supabase.rpc("update_class_safe", {
    p_class_id: classId,
    p_title: input.title,
    p_description: input.description ?? null,
    p_start_time: toKstIso(input.date, input.start),
    p_end_time: toKstIso(classEndDate(input.date, input.start, input.end), input.end),
    p_capacity: input.capacity,
    p_allow_goods: input.allowGoods,
    p_room_id: input.roomId ?? null,
    p_cancel_deadline_min: input.cancelDeadlineMin ?? null,
    p_booking_deadline_min: input.bookingDeadlineMin ?? null,
    p_class_format: input.classFormat ?? "group",
    p_pass_selection_mode: input.passSelectionMode ?? "all",
    p_allow_cancel: input.allowCancel ?? true,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return { promotedCount: (data as any)?.promoted_count ?? 0 };
}

// 반복 그룹 일괄 적용(updateClassGroup)은 title/start/end/capacity만 바꾸고 이 인스턴스의
// 다른 필드는 건드리지 않는다 — 그 흐름에서도 이 인스턴스의 수강권 정책만 selectedProducts와
// 어긋나지 않게 컬럼 하나만 좁게 갱신하기 위한 함수(updateClass 전체 재작성 대신).
export async function updateClassPassSelectionMode(classId: string, mode: "all" | "selected"): Promise<void> {
  const { error } = await supabase.rpc("update_class_pass_selection_mode_safe", { p_class_id: classId, p_mode: mode });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

export async function deleteClass(classId: string): Promise<void> {
  const { error } = await supabase.rpc("delete_class_safe", { p_class_id: classId });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

/* ============================================================
   반복수업 그룹 일괄 수정/삭제
   - 그룹 전체에 같은 제목/시간/정원 적용 (날짜는 각자 유지)
   - 그룹 전체 삭제
   ============================================================ */

// 그룹 전체 수정 — "공통 속성"(수업명·수업 소개·정원)만 그룹 전체에 반영한다.
// 2026-10-01(QA 10) — 예전에는 편집 중인 수업의 시작/종료 시각을 그룹 전체에 덮어써서, 월 20:00 / 수 18:00처럼
// 요일마다 시간이 다른 그룹에서 월요일 수업의 이름만 바꿔도 수요일 시간이 월요일 시간으로 바뀌었다.
// 이제 기본값은 각 수업의 "기존 날짜·기존 시작/종료 시각"을 그대로 보내 시간을 건드리지 않는다.
// 정말 시간을 같이 바꾸고 싶을 때만 options.time을 명시적으로 넘긴다("시간도 함께 변경" 옵션, 기본 OFF).
// 반환값: 이 그룹에 속한 class id 전체 — 담당 강사 일괄 적용(setClassTrainersForGroup) 등
// 그룹 전체를 다시 대상으로 삼아야 하는 후속 작업에서 재사용한다(같은 조회를 두 번 하지 않도록).
export type GroupClassRow = { id: string; start_time: string; end_time: string };

// "모든 반복 수업에 적용"에서 그룹 전체에 반영할 공통 필드(사용자가 실제로 바꾼 것만 담긴다).
// 분류 — 그룹 전체: 수업명(title, 항상) · 수업 소개 · 정원 · 룸 · 수업 상품 허용 · 취소 허용 · 취소마감 · 예약마감 · 담당 강사(별도 RPC).
//        이 수업만: 날짜 · 시작/종료 시간(기본) · 예약/출석.
//        수강권 정책/허용 수강권(class_allowed_products, pass_selection_mode)은 2026-10-02부터 "사용자가 바꾼 경우에만" 그룹 전체에 적용된다(passPolicy).
//        recurring_group_id/center_id/id는 수정 대상이 아니다.
// "바뀐 것만" 보내는 이유: 요일별 개별 설정(perDay 반복 등록에서 요일마다 다를 수 있는 정원/룸/취소마감)을 한 수업의 값으로
// 통일해 버리지 않기 위해서다(시간을 덮어쓰던 QA 10과 같은 종류의 문제).
export type GroupFieldChanges = {
  description?: string | null;
  capacity?: number;
  roomId?: string | null;
  allowGoods?: boolean;
  allowCancel?: boolean;
  cancelDeadlineMin?: number | null;
  bookingDeadlineMin?: number | null;
  // 2026-10-02 — 예약 가능 수강권 설정(바뀐 경우에만). 'all'이면 허용 수강권 행을 비우고 모든 수강권을 허용한다.
  passPolicy?: PassPolicy;
};

export type PassPolicy = { mode: "all" | "selected"; productIds: string[] };

// 수강권 설정이 "바뀌었는지" 판정(순수 함수 — 테스트 대상). 선택 배열의 순서/중복은 의미가 없으므로 집합으로 비교한다.
// 'all'끼리는 허용 수강권 행이 비어 있어(전체) 항상 같은 설정이다.
export function passPolicyChanged(orig: PassPolicy, cur: PassPolicy): boolean {
  if (orig.mode !== cur.mode) return true;
  if (cur.mode === "all") return false;
  const a = new Set(orig.productIds);
  const b = new Set(cur.productIds);
  if (a.size !== b.size) return true;
  for (const id of a) if (!b.has(id)) return true;
  return false;
}

const normDesc = (s: string | null | undefined) => (s ?? "").trim();

// 편집 시작 시점의 값(orig)과 저장 시점의 값(cur)을 비교해 "바뀐 공통 필드"만 뽑는다(순수 함수 — 테스트 대상).
export function diffGroupFields(orig: ClassInput, cur: ClassInput): GroupFieldChanges {
  const out: GroupFieldChanges = {};
  if (normDesc(orig.description) !== normDesc(cur.description)) out.description = normDesc(cur.description);
  if (orig.capacity !== cur.capacity) out.capacity = cur.capacity;
  if ((orig.roomId ?? null) !== (cur.roomId ?? null)) out.roomId = cur.roomId ?? null;
  if (!!orig.allowGoods !== !!cur.allowGoods) out.allowGoods = !!cur.allowGoods;
  if ((orig.allowCancel ?? true) !== (cur.allowCancel ?? true)) out.allowCancel = cur.allowCancel ?? true;
  if ((orig.cancelDeadlineMin ?? null) !== (cur.cancelDeadlineMin ?? null)) out.cancelDeadlineMin = cur.cancelDeadlineMin ?? null;
  if ((orig.bookingDeadlineMin ?? null) !== (cur.bookingDeadlineMin ?? null)) out.bookingDeadlineMin = cur.bookingDeadlineMin ?? null;
  return out;
}

export type GroupUpdateOptions = {
  // "시간도 함께 변경"(기본 OFF): 모든 수업의 시각(time-of-day)만 바꾸고 각 수업의 날짜는 유지한다.
  // only(2026-10-02): 같은 날 여러 타임을 한 번에 등록한 그룹에서는 한 타임의 시각을 다른 타임에 덮어쓰면 같은 날 수업이
  // 서로 겹치게 되므로, 편집 중인 수업의 "원래 시각"과 같은 시각의 수업(같은 타임 시리즈)에만 적용한다.
  time?: { start: string; end: string; only?: { start: string; end: string } };
  // 지금 편집 중인 수업 자신의 날짜/시간 변경(전체 적용 ON이어도 이 수업의 변경은 반드시 저장돼야 한다). 다른 수업에는 영향 없음.
  own?: { id: string; date: string; start: string; end: string };
  changes?: GroupFieldChanges;
  description?: string | null;   // 하위 호환: changes.description과 같다
};

export type GroupUpdateRow = {
  id: string; start_time: string; end_time: string;
  description?: string; capacity?: number; room_id?: string | null; allow_goods?: boolean; allow_cancel?: boolean;
  cancel_deadline_min?: number | null; booking_deadline_min?: number | null;
  // 수강권 설정이 바뀐 경우에만 모든 행에 같은 값으로 실린다(서버가 같은 트랜잭션에서 수업 정책 + 허용 수강권을 교체).
  pass_selection_mode?: "all" | "selected"; allowed_product_ids?: string[];
};

// 같은 날(KST)에 그룹 수업이 2개 이상 있으면 "한 날 여러 타임" 그룹이다.
export function hasMultiSlotDates(rows: GroupClassRow[]): boolean {
  const seen = new Set<string>();
  for (const r of rows) {
    const t = new Date(r.start_time);
    if (Number.isNaN(t.getTime())) continue;   // 잘못된 값은 판정에서 제외(그룹 수정 자체를 막지 않는다)
    const d = KST_DATE.format(t);
    if (seen.has(d)) return true;
    seen.add(d);
  }
  return false;
}

// 순수 함수(테스트 대상): 그룹의 각 수업에 보낼 update payload를 만든다.
export function buildGroupUpdates(rows: GroupClassRow[], options?: GroupUpdateOptions): GroupUpdateRow[] {
  const changes: GroupFieldChanges = { ...(options?.changes ?? {}) };
  if (options?.description !== undefined && changes.description === undefined) changes.description = options.description;
  const kstDate = (iso: string) =>
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const kstTimeOfDay = (iso: string) => KST_TIME.format(new Date(iso)).replace(/^24:/, "00:");
  const multiSlot = hasMultiSlotDates(rows);
  return rows.map((r) => {
    let start_time = r.start_time;
    let end_time = r.end_time;
    const own = options?.own && options.own.id === r.id ? options.own : null;
    if (own) {
      start_time = toKstIso(own.date, own.start);
      end_time = toKstIso(classEndDate(own.date, own.start, own.end), own.end);
    } else if (options?.time && (!multiSlot || !options.time.only || kstTimeOfDay(r.start_time) === options.time.only.start && kstTimeOfDay(r.end_time) === options.time.only.end)) {
      const dateStr = kstDate(r.start_time);
      start_time = toKstIso(dateStr, options.time.start);
      end_time = toKstIso(classEndDate(dateStr, options.time.start, options.time.end), options.time.end);
    }
    const u: GroupUpdateRow = { id: r.id, start_time, end_time };
    // 서버는 키가 "있을 때만" 갱신한다(빈 문자열 소개 = 지우기, room_id null = 룸 없음).
    if (changes.description !== undefined) u.description = changes.description ?? "";
    if (changes.capacity !== undefined) u.capacity = changes.capacity;
    if (changes.roomId !== undefined) u.room_id = changes.roomId;
    if (changes.allowGoods !== undefined) u.allow_goods = changes.allowGoods;
    if (changes.allowCancel !== undefined) u.allow_cancel = changes.allowCancel;
    if (changes.cancelDeadlineMin !== undefined) u.cancel_deadline_min = changes.cancelDeadlineMin;
    if (changes.bookingDeadlineMin !== undefined) u.booking_deadline_min = changes.bookingDeadlineMin;
    if (changes.passPolicy !== undefined) {
      u.pass_selection_mode = changes.passPolicy.mode;
      u.allowed_product_ids = changes.passPolicy.mode === "selected" ? [...new Set(changes.passPolicy.productIds)] : [];
    }
    return u;
  });
}

// 반환값: 실제로 수정된 class id 전체 — 담당 강사 일괄 적용(setClassTrainersForGroup) 등 후속 작업에서 재사용한다.
// 그룹 행 수와 서버가 돌려준 id 수가 다르면(일부만 수정됨/0개) 조용히 성공시키지 않고 오류로 알린다.
// 같은 center + 같은 recurring_group_id 범위만 갱신되고(서버 RPC가 한 트랜잭션으로 처리), title로 그룹을 추론하지 않는다.
// capacity 인자는 하위 호환용이다 — 정원은 options.changes.capacity(바뀐 경우에만)로 전달한다.
export async function updateClassGroup(
  groupId: string, title: string, capacity: number, options?: GroupUpdateOptions
): Promise<string[]> {
  if (options?.time) assertValidClassTimeRange(options.time.start, options.time.end);
  if (options?.own) assertValidClassTimeRange(options.own.start, options.own.end);
  const { data: rows, error: fErr } = await supabase
    .from("classes")
    .select("id, start_time, end_time")
    .eq("recurring_group_id", groupId);
  if (fErr) throw new Error("반복 수업을 불러오지 못했어요: " + fErr.message);
  const groupRows = (rows ?? []) as GroupClassRow[];
  if (groupRows.length === 0) throw new Error("반복 수업 정보를 찾지 못했어요");

  const updates = buildGroupUpdates(groupRows, options);

  const { data, error } = await supabase.rpc("update_class_group_safe", {
    p_group_id: groupId, p_title: title, p_capacity: capacity, p_updates: updates,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  const ids = (data as string[]) ?? [];
  if (ids.length !== groupRows.length) {
    throw new Error(`반복 수업 ${groupRows.length}개 중 ${ids.length}개만 수정됐어요. 새로고침 후 다시 확인해주세요.`);
  }
  return ids;
}

// 그룹 전체 삭제
export async function deleteClassGroup(groupId: string): Promise<void> {
  const { error } = await supabase.rpc("delete_class_group_safe", { p_group_id: groupId });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

/* ============================================================
   반복 수업 등록
   - 선택한 요일들에 대해, 시작일~종료일 사이의 모든 해당 요일에 수업 생성
   - 예: 8/1~8/31, 월·수·금 → 그 기간의 모든 월/수/금에 수업
   ============================================================ */

export type RecurringInput = {
  title: string;
  description?: string | null;   // 수업 소개 — 생성되는 모든 수업에 동일하게 복제
  daysOfWeek: number[];   // [1,3,5] = 월수금 (0=일 ~ 6=토)
  fromDate: string;       // "2026-08-01"
  toDate: string;         // "2026-08-31"
  start: string;          // "19:00"
  end: string;            // "20:00"
  capacity: number;
  excludeDates?: Set<string>;   // 제외할 날짜 (휴무일 등)
  roomId?: string | null;
  cancelDeadlineMin?: number | null;
  bookingDeadlineMin?: number | null;
  passSelectionMode?: "all" | "selected"; // 기본값 'all'
  // 한 날 여러 타임(2026-10-02): 있으면 start/end 대신 이 슬롯들 전부를 선택된 모든 날짜에 만든다(날짜 수 × 슬롯 수).
  // 없으면 기존처럼 start/end 한 타임만 만든다.
  slots?: { start: string; end: string }[];
};

// 기간 내 해당 요일의 날짜들을 모두 구함
export function expandRecurringDates(fromDate: string, toDate: string, daysOfWeek: number[]): string[] {
  const dates: string[] = [];
  // 시간대 영향 없이 순수 날짜로 계산 (UTC 정오 기준)
  const [fy, fm, fd] = fromDate.split("-").map(Number);
  const [ty, tm, td] = toDate.split("-").map(Number);
  const cur = new Date(Date.UTC(fy, fm - 1, fd, 12, 0, 0));
  const end = new Date(Date.UTC(ty, tm - 1, td, 12, 0, 0));
  let guard = 0;
  while (cur <= end && guard < 400) {
    const dow = cur.getUTCDay();
    if (daysOfWeek.includes(dow)) {
      // YYYY-MM-DD (UTC 기준이지만 정오라 날짜 안 밀림)
      dates.push(cur.toISOString().slice(0, 10));
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }
  return dates;
}

export async function createRecurringClasses(centerId: string, input: RecurringInput): Promise<string[]> {
  const slots = input.slots && input.slots.length > 0 ? input.slots : [{ start: input.start, end: input.end }];
  for (const sl of slots) assertValidClassTimeRange(sl.start, sl.end);
  let dates = expandRecurringDates(input.fromDate, input.toDate, input.daysOfWeek);
  if (input.excludeDates) dates = dates.filter((d) => !input.excludeDates!.has(d));
  if (dates.length === 0) return [];

  // 이 반복 등록을 하나로 묶는 그룹 id — 여러 타임이어도 한 등록 작업의 모든 수업이 같은 그룹이다.
  const groupId = crypto.randomUUID();
  const rows = dates.flatMap((d) => slots.map((sl) => ({
    title: input.title,
    description: input.description?.trim() || null,
    start_time: toKstIso(d, sl.start),
    end_time: toKstIso(classEndDate(d, sl.start, sl.end), sl.end),
    capacity: input.capacity,
    room_id: input.roomId ?? null,
    cancel_deadline_min: input.cancelDeadlineMin ?? null,
    booking_deadline_min: input.bookingDeadlineMin ?? null,
    recurring_group_id: groupId,
    pass_selection_mode: input.passSelectionMode ?? "all",
  })));
  const { data, error } = await supabase.rpc("create_recurring_classes_safe", {
    p_center_id: centerId, p_rows: rows,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return (data as string[]) ?? [];
}

// 한 날짜에 여러 타임을 한 번에 등록한다(2026-10-02, 새 수업 등록 전용). 반환: 생성된 class id 전체(순서 = 슬롯 순서).
//  · 그룹 수업(+ 회원 취소 허용)이면 create_recurring_classes_safe에 모든 행을 한 번에 보내 한 트랜잭션으로 만든다
//    (일부만 저장되지 않음). 같은 등록 작업의 수업은 같은 recurring_group_id로 묶인다.
//  · 프라이빗/취소 불가 수업은 그 RPC가 class_format·allow_cancel을 다루지 못하므로 create_class_safe를 순서대로 호출하되,
//    중간에 실패하면 이미 만든 수업을 삭제(보상)하고 오류를 던진다 — 일부만 남지 않게 한다.
export async function createClassOnDateSlots(
  centerId: string, input: ClassInput, slots: { start: string; end: string }[]
): Promise<string[]> {
  for (const sl of slots) assertValidClassTimeRange(sl.start, sl.end);
  if (slots.length === 0) return [];
  const atomicEligible = (input.classFormat ?? "group") !== "private" && (input.allowCancel ?? true) !== false;
  if (atomicEligible) {
    const groupId = slots.length > 1 ? crypto.randomUUID() : null;
    const rows = slots.map((sl) => ({
      title: input.title,
      description: input.description?.trim() || null,
      start_time: toKstIso(input.date, sl.start),
      end_time: toKstIso(classEndDate(input.date, sl.start, sl.end), sl.end),
      capacity: input.capacity,
      room_id: input.roomId ?? null,
      cancel_deadline_min: input.cancelDeadlineMin ?? null,
      booking_deadline_min: input.bookingDeadlineMin ?? null,
      recurring_group_id: groupId,
      pass_selection_mode: input.passSelectionMode ?? "all",
      allow_goods: input.allowGoods,
    }));
    const { data, error } = await supabase.rpc("create_recurring_classes_safe", { p_center_id: centerId, p_rows: rows });
    if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
    return (data as string[]) ?? [];
  }
  const created: string[] = [];
  try {
    for (const sl of slots) {
      created.push(await createClass(centerId, { ...input, start: sl.start, end: sl.end }));
    }
  } catch (e) {
    for (const id of created) { try { await deleteClass(id); } catch { /* 보상 삭제는 best-effort */ } }
    throw e;
  }
  return created;
}

export type PerDayRecurringInput = {
  title: string;
  description?: string | null;   // 수업 소개 — 요일별 개별 시간이어도 모든 수업에 동일하게 복제
  fromDate: string;
  toDate: string;
  // 요일마다 시간·정원·룸·취소마감이 다를 수 있는 "요일별 개별 지정" 모드용 입력
  days: {
    dow: number;
    start: string;
    end: string;
    capacity: number;
    roomId?: string | null;
    cancelDeadlineMin?: number | null;
    // 이 요일의 여러 타임(2026-10-02). 있으면 start/end 대신 이 슬롯들을 이 요일의 모든 날짜에 만든다(요일마다 개수가 달라도 됨).
    slots?: { start: string; end: string }[];
  }[];
  excludeDates?: Set<string>;
  bookingDeadlineMin?: number | null;
  passSelectionMode?: "all" | "selected";
};

// 요일별 개별 지정(perDayMode) 반복 등록. 요일마다 create_recurring_classes_safe를 따로
// 호출하면 그 개수만큼 별도 트랜잭션이 생겨, 중간 요일에서 실패하면 이전 요일들만 반영된
// 채 남는다(원자성 없음). 모든 요일의 행을 한 번에 모아 RPC를 단 한 번만 호출해 하나의
// 트랜잭션으로 묶는다.
export async function createRecurringClassesPerDay(centerId: string, input: PerDayRecurringInput): Promise<string[]> {
  const groupId = crypto.randomUUID();
  const rows: Record<string, unknown>[] = [];
  for (const d of input.days) {
    const slots = d.slots && d.slots.length > 0 ? d.slots : [{ start: d.start, end: d.end }];
    for (const sl of slots) assertValidClassTimeRange(sl.start, sl.end);
    let dates = expandRecurringDates(input.fromDate, input.toDate, [d.dow]);
    if (input.excludeDates) dates = dates.filter((x) => !input.excludeDates!.has(x));
    for (const date of dates) {
      for (const sl of slots) {
        rows.push({
          title: input.title,
          description: input.description?.trim() || null,
          start_time: toKstIso(date, sl.start),
          end_time: toKstIso(classEndDate(date, sl.start, sl.end), sl.end),
          capacity: d.capacity,
          room_id: d.roomId ?? null,
          cancel_deadline_min: d.cancelDeadlineMin ?? null,
          booking_deadline_min: input.bookingDeadlineMin ?? null,
          recurring_group_id: groupId,
          pass_selection_mode: input.passSelectionMode ?? "all",
        });
      }
    }
  }
  if (rows.length === 0) return [];
  const { data, error } = await supabase.rpc("create_recurring_classes_safe", {
    p_center_id: centerId, p_rows: rows,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return (data as string[]) ?? [];
}

/* ============================================================
   수업 예약자 명단
   - 그 수업을 예약한 회원 목록 (확정/대기 구분)
   ============================================================ */

export type ClassAttendee = {
  reservationId: string;
  profileId: string;
  name: string;
  status: string;   // confirmed / waitlisted / attended / no_show
  waitlistOrder: number | null;
  reservationType: ReservationType;
  isCapacityOverride: boolean;
  // 예약 시 함께 사용한 대여상품(reservation_goods_usages, add_reservation_goods_usage.sql). 없으면 null.
  goodsLabel: string | null;
};

type GoodsUsageRow = { product_name_snapshot: string; size_snapshot: string | null; status: string };

// 관리자 예약자 목록에 이름 옆에 붙일 "대여상품 · 사이즈" 문구. 차감/대기(pending) 상태만 보여주고
// 복원(restored)·건너뜀(skipped)은 숨긴다. 사이즈를 알 수 없으면 "사이즈 미입력".
export function formatGoodsUsageLabel(usages: GoodsUsageRow[] | null | undefined): string | null {
  const active = (usages ?? []).filter((u) => u.status === "deducted" || u.status === "pending");
  if (active.length === 0) return null;
  return active
    .map((u) => `${u.product_name_snapshot} ${u.size_snapshot ? u.size_snapshot : "사이즈 미입력"}`)
    .join(", ");
}

export async function fetchClassAttendees(classId: string): Promise<ClassAttendee[]> {
  const base = "id, profile_id, status, waitlist_order, reservation_type, is_capacity_override, profiles(name)";
  const run = (select: string) => supabase
    .from("reservations")
    .select(select)
    .eq("class_id", classId)
    .in("status", ["confirmed", "waitlisted", "attended", "no_show", "cancelled"])
    .order("status")
    .order("waitlist_order", { ascending: true, nullsFirst: true });
  let { data, error } = await run(`${base}, reservation_goods_usages(product_name_snapshot, size_snapshot, status)`);
  if (error) {
    // add_reservation_goods_usage.sql 미실행 환경(테이블/관계 없음) 방어 — 명단 자체는 항상 보여준다.
    ({ data, error } = await run(base));
  }
  if (error) throw new Error("예약자 명단을 불러오지 못했어요: " + error.message);
  return ((data ?? []) as any[]).map((r: any) => ({
    reservationId: r.id,
    profileId: r.profile_id,
    name: r.profiles?.name ?? "(이름 없음)",
    status: r.status,
    waitlistOrder: r.waitlist_order,
    reservationType: (r.reservation_type ?? "MEMBER") as ReservationType,
    isCapacityOverride: r.is_capacity_override ?? false,
    goodsLabel: formatGoodsUsageLabel(r.reservation_goods_usages),
  }));
}

// 매니저 출결 처리 (출석/결석/노쇼/예약취소). 취소 시 횟수 복구.
export async function setAttendance(reservationId: string, status: "attended" | "no_show" | "confirmed" | "cancelled"): Promise<void> {
  const { error } = await supabase.rpc("manager_set_attendance", {
    p_reservation_id: reservationId, p_status: status,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

/* ============================================================
   수업별 예약 가능 수강권 (class_allowed_products)
   - 연결이 없으면 = 모든 수강권으로 예약 가능
   - 연결이 있으면 = 그 수강권들로만 예약 가능
   ============================================================ */

// 특정 수업에 지정된 수강권 id 목록
export async function fetchClassProducts(classId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("class_allowed_products")
    .select("product_id")
    .eq("class_id", classId);
  if (error) {
    throw new Error("수업 수강권을 불러오지 못했어요: " + error.message);
  }
  return (data ?? []).map((r: any) => r.product_id);
}

// 수업의 예약가능 수강권을 통째로 교체 (선택된 id 배열로)
export async function setClassProducts(classId: string, productIds: string[]): Promise<void> {
  // 기존 것 모두 삭제 후 새로 삽입
  const { error: delErr } = await supabase
    .from("class_allowed_products")
    .delete()
    .eq("class_id", classId);
  if (delErr) {
    throw new Error("수강권 설정에 실패했어요: " + delErr.message);
  }

  if (productIds.length > 0) {
    const rows = productIds.map((pid) => ({ class_id: classId, product_id: pid }));
    const { error } = await supabase.from("class_allowed_products").insert(rows);
    if (error) {
      throw new Error("수강권 설정에 실패했어요: " + error.message);
    }
  }
}

// 여러 수업에 같은 수강권 목록 지정 (반복 수업 등록용)
export async function setClassProductsBulk(classIds: string[], productIds: string[]): Promise<void> {
  if (classIds.length === 0 || productIds.length === 0) return;
  const rows: { class_id: string; product_id: string }[] = [];
  for (const cid of classIds) for (const pid of productIds) rows.push({ class_id: cid, product_id: pid });
  const { error } = await supabase.from("class_allowed_products").insert(rows);
  if (error) throw new Error("수강권 설정에 실패했어요: " + error.message);
}

/* ============================================================
   수업별 담당 강사 (class_trainers)
   - 강사 후보는 "스태프 & 권한"(manager_centers)의 해당 센터 active 스태프 전체를
     그대로 재사용한다(역할 구분 없음 — lib/roles.ts의 fetchStaff() 참고).
   - 최소 0명도 허용(강사 미지정 기존 수업과 동일하게, 강사 지정 자체는 필수 아님).
   ============================================================ */

// 특정 수업에 지정된 담당 강사 account_id 목록
export async function fetchClassTrainers(classId: string): Promise<string[]> {
  let { data, error } = await supabase
    .from("class_trainers")
    .select("account_id")
    .eq("class_id", classId)
    .order("sort_order", { ascending: true })   // 선택한 순서(2026-10-02) — 칩 선택 상태/미리보기가 저장 순서를 그대로 복원
    .order("id", { ascending: true });
  if (error?.code === "42703") {
    // fix_manager_product_class_ux_20261002.sql(sort_order) 미적용 환경 — 순서 없이라도 목록은 보여준다.
    ({ data, error } = await supabase.from("class_trainers").select("account_id").eq("class_id", classId));
  }
  if (error) throw new Error("담당 강사를 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => r.account_id);
}

// 수업의 담당 강사를 통째로 교체 (선택된 account_id 배열로)
// P1-5b: set_class_trainers_safe RPC를 거친다 — 기존 배정 기준 own/other 판정이
// 서버에서 이뤄지므로 직접 class_trainers를 건드리지 않는다.
export async function setClassTrainers(classId: string, accountIds: string[]): Promise<void> {
  const { error } = await supabase.rpc("set_class_trainers_safe", {
    p_class_id: classId, p_account_ids: accountIds,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

// 여러 수업에 같은 담당 강사 목록 지정 (반복 수업 등록용 — 새로 만든 수업이라 기존 지정이
// 없다는 전제라 삭제 없이 insert만 한다)
export async function setClassTrainersBulk(classIds: string[], accountIds: string[]): Promise<void> {
  if (classIds.length === 0 || accountIds.length === 0) return;
  const { error } = await supabase.rpc("set_class_trainers_bulk_safe", {
    p_class_ids: classIds, p_account_ids: accountIds,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

// 반복 그룹 "모든 수업에 적용" 토글용 — 그룹에 속한 기존 수업들의 담당 강사를 전부 같은
// 목록으로 교체한다(setClassTrainers의 그룹 버전, 기존 지정을 먼저 지우고 다시 넣음).
export async function setClassTrainersForGroup(classIds: string[], accountIds: string[]): Promise<void> {
  if (classIds.length === 0) return;
  const { error } = await supabase.rpc("set_class_trainers_for_group_safe", {
    p_class_ids: classIds, p_account_ids: accountIds,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

/* ============================================================
   예약조건 추가 시 "기존 수업에서 고르기" 용
   - 센터의 수업들을 요일/시간/제목으로 반환 (중복 제거)
   ============================================================ */

export type ExistingClassOption = {
  title: string;
  dayOfWeek: number;   // 0=일 ~ 6=토 (KST)
  startTime: string;   // "19:00"
};

export async function fetchExistingClassOptions(centerId: string): Promise<ExistingClassOption[]> {
  const { data, error } = await supabase
    .from("classes")
    .select("title, start_time")
    .eq("center_id", centerId)
    .order("start_time", { ascending: true });
  if (error) throw new Error("수업을 불러오지 못했어요: " + error.message);

  const seen = new Set<string>();
  const out: ExistingClassOption[] = [];
  for (const c of data ?? []) {
    const d = new Date((c as any).start_time);
    // KST 기준 요일/시간
    const kstDow = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Seoul" })).getDay();
    const kstTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
    const key = `${(c as any).title}|${kstDow}|${kstTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: (c as any).title, dayOfWeek: kstDow, startTime: kstTime });
  }
  return out;
}

// 센터 휴무일 날짜 집합 (수업 개설 차단용)
export async function fetchCenterHolidayDates(centerId: string): Promise<Set<string>> {
  const { data } = await supabase
    .from("center_holidays").select("holiday_date").eq("center_id", centerId);
  return new Set((data ?? []).map((h: any) => h.holiday_date));
}

/* ============================================================
   관리자 보강 예약
   - 수강권 예약조건(요일/시간)과 무관하게 회원을 수업에 넣기
   - 예: 화요일반 회원을 이번 주만 목요일반으로
   ============================================================ */

export type BookableMember = {
  profileId: string;
  name: string;
  phone: string | null;      // 마스킹은 화면에서 처리 (원본 그대로 반환)
  memberStatus: string;      // center_members.status: active/expired/dormant
  memberships: { id: string; name: string; remaining: number | null }[];
};

// 이 센터의 회원 + 보유 수강권 (보강 예약/관리자 직접배치용)
export async function fetchBookableMembers(centerId: string): Promise<BookableMember[]> {
  const { data: cms } = await supabase
    .from("center_members")
    .select("profile_id, status, profiles(name, accounts(phone))")
    .eq("center_id", centerId)
    .order("registered_at", { ascending: false })
    .limit(300);

  const profileIds = (cms ?? []).map((c: any) => c.profile_id);
  if (profileIds.length === 0) return [];

  const { data: mems } = await supabase
    .from("memberships")
    .select("id, profile_id, product_name, remaining_count")
    .eq("center_id", centerId)
    .eq("status", "active")
    .in("profile_id", profileIds);

  const byProfile: Record<string, { id: string; name: string; remaining: number | null }[]> = {};
  for (const m of mems ?? []) {
    (byProfile[(m as any).profile_id] ??= []).push({
      id: (m as any).id,
      name: (m as any).product_name,
      remaining: (m as any).remaining_count,
    });
  }

  return (cms ?? []).map((c: any) => ({
    profileId: c.profile_id,
    name: c.profiles?.name ?? "(이름 없음)",
    phone: c.profiles?.accounts?.phone ?? null,
    memberStatus: c.status ?? "active",
    memberships: byProfile[c.profile_id] ?? [],
  }));
}

// 전화번호 중간자리 마스킹 (010-1234-5678 -> 010-****-5678)
export function maskPhone(phone: string | null): string {
  if (!phone) return "연락처 없음";
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 11) return `${digits.slice(0, 3)}-****-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-***-${digits.slice(6)}`;
  return phone;
}

// 보강 예약 실행
export async function managerBookMember(
  classId: string, profileId: string, membershipId: string | null, deduct: boolean
): Promise<{ overCapacity: boolean; deducted: boolean }> {
  const { data, error } = await supabase.rpc("manager_book_member", {
    p_class_id: classId,
    p_profile_id: profileId,
    p_membership_id: membershipId,
    p_deduct: deduct,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return {
    overCapacity: (data as any)?.over_capacity ?? false,
    deducted: (data as any)?.deducted ?? false,
  };
}

/* ============================================================
   요일반 수강권 - 미배치 잔여 횟수
   - 자동예약으로 다 못 넣은 회원 목록
   - 관리자가 정원을 늘리거나 보강 예약으로 수동 배치
   ============================================================ */

export type UnplacedReason =
  | "outside_membership_period"   // 만료일(또는 시작일) 밖이라 더 배치할 수 없음
  | "no_class_in_period"          // 사용기간 안에 일치하는 수업이 없음
  | "capacity_full"               // 정원 부족
  | "condition_mismatch"          // 예약조건/요일·시간 불일치
  | "already_reserved"            // 이미 예약된 날짜
  | "booking_window"              // 휴무일/예약 가능 기간 밖
  | "not_weekday_pass" | "no_remaining" | "membership_inactive" | "unknown";

export type UnplacedPass = {
  membershipId: string;
  profileId: string;
  memberName: string;
  productName: string;
  totalCount: number | null;
  remainingCount: number;
  autoBookDays: number[];
  expiresAt: string | null;
  purchasedAt: string;
  boundDayOfWeek: number | null;
  boundStartTime: string | null;
  expired: boolean;        // 수강권 만료일이 이미 지남
  canRetry: boolean;       // 만료되지 않아 "다시 배치"를 누를 수 있음
  reason: UnplacedReason;
  placeableCount: number;  // 지금 다시 배치하면 들어갈 수 있는 횟수
};

const KST_MD_SHORT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
});

// 미배치 사유를 관리자에게 보여줄 한국어 문구(순수 함수 — 테스트 대상).
export function unplacedReasonText(u: Pick<UnplacedPass, "reason" | "remainingCount" | "expiresAt" | "expired">): string {
  const n = u.remainingCount;
  const exp = u.expiresAt ? ` · 수강권 만료일 ${u.expiresAt}` : "";
  switch (u.reason) {
    case "outside_membership_period":
      return u.expired
        ? `만료일 초과로 ${n}회 미배치${exp}`
        : `만료일 이후 수업만 남아 ${n}회 미배치${exp}`;
    case "no_class_in_period": return `만료일 안에 일치하는 수업이 없어 ${n}회 미배치${exp}`;
    case "capacity_full": return `정원이 가득 차 ${n}회 미배치 — 정원을 늘린 뒤 다시 배치해보세요`;
    case "condition_mismatch": return `예약 조건(요일·시간·수강권 지정)이 맞는 수업이 없어 ${n}회 미배치`;
    case "already_reserved": return `이미 예약된 날짜라 ${n}회 미배치`;
    case "booking_window": return `휴무일/예약 가능 기간 때문에 ${n}회 미배치`;
    default: return `${n}회 미배치`;
  }
}

export async function fetchUnplacedPasses(centerId: string): Promise<UnplacedPass[]> {
  const { data, error } = await supabase.rpc("unplaced_weekday_passes", { p_center_id: centerId });
  if (error) throw new Error("미배치 수강권을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    membershipId: r.membership_id,
    profileId: r.profile_id,
    memberName: r.member_name,
    productName: r.product_name,
    totalCount: r.total_count,
    remainingCount: r.remaining_count,
    autoBookDays: r.auto_book_days ?? [],
    expiresAt: r.expires_at,
    purchasedAt: KST_MD_SHORT.format(new Date(r.purchased_at)),
    boundDayOfWeek: r.bound_day_of_week ?? null,
    boundStartTime: r.bound_start_time ?? null,
    // add_...sql 적용 전(옛 RPC)에는 아래 필드가 없다 — 만료일로 직접 판정해 안전하게 대체.
    expired: r.expired ?? (!!r.expires_at && r.expires_at < todayKstYmd()),
    canRetry: r.can_retry ?? !(!!r.expires_at && r.expires_at < todayKstYmd()),
    reason: (r.reason_code ?? "unknown") as UnplacedReason,
    placeableCount: r.placeable_count ?? 0,
  }));
}

// 특정 수강권으로 다시 자동배치 시도 (정원을 늘린 뒤 눌러서 재시도)
export async function retryAutoBook(membershipId: string): Promise<number> {
  const { data, error } = await supabase.rpc("retry_auto_book_membership_safe", { p_membership_id: membershipId });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return (data as any)?.booked ?? 0;
}

/* ============================================================
   스케줄 복사 v2
   - 원본 달의 수업을 "그룹"으로 묶어 선택 (반복수업은 하나로)
   - 요일 기준 / 날짜 기준 두 가지 복사 방식
   ============================================================ */

export type CopyGroup = {
  key: string;              // 그룹 식별자
  title: string;
  dow: number;              // 요일 (0=일)
  start: string;            // "19:00"
  end: string;
  capacity: number;
  roomId: string | null;
  cancelDeadlineMin: number | null;
  classIds: string[];       // 이 그룹에 속한 원본 수업들
  dates: string[];          // 원본 날짜들
};

// 원본 달의 수업을 (수업명+요일+시작시간) 기준으로 묶기
export async function fetchCopyGroups(centerId: string, fromMonth: string): Promise<CopyGroup[]> {
  const [fy, fm] = fromMonth.split("-").map(Number);
  const fromStart = `${fromMonth}-01`;
  const fromEnd = new Date(Date.UTC(fy, fm, 0, 12, 0, 0)).toISOString().slice(0, 10);
  const classes = await fetchClasses(centerId, fromStart, fromEnd);

  const map: Record<string, CopyGroup> = {};
  for (const c of classes) {
    const d = new Date(`${c.date}T12:00:00Z`);
    const dow = d.getUTCDay();
    const key = `${c.title}|${dow}|${c.start}`;
    if (!map[key]) {
      map[key] = {
        key, title: c.title, dow, start: c.start, end: c.end,
        capacity: c.capacity, roomId: c.roomId,
        cancelDeadlineMin: c.cancelDeadlineMin ?? null,
        classIds: [], dates: [],
      };
    }
    map[key].classIds.push(c.id);
    map[key].dates.push(c.date);
  }
  return Object.values(map).sort((a, b) => a.dow - b.dow || a.start.localeCompare(b.start));
}

// 날짜 기준 복사용: 원본 달 수업을 날짜별로 (일자 유지)
export type CopyDateItem = {
  key: string;
  title: string;
  date: string;       // 원본 날짜 "2026-07-02"
  day: number;        // 2
  start: string;
  end: string;
  capacity: number;
  roomId: string | null;
  cancelDeadlineMin: number | null;
  classId: string;
};

export async function fetchCopyDateItems(centerId: string, fromMonth: string): Promise<CopyDateItem[]> {
  const [fy, fm] = fromMonth.split("-").map(Number);
  const fromStart = `${fromMonth}-01`;
  const fromEnd = new Date(Date.UTC(fy, fm, 0, 12, 0, 0)).toISOString().slice(0, 10);
  const classes = await fetchClasses(centerId, fromStart, fromEnd);
  return classes.map((c) => ({
    key: c.id,
    title: c.title,
    date: c.date,
    day: parseInt(c.date.slice(8), 10),
    start: c.start, end: c.end, capacity: c.capacity,
    roomId: c.roomId, cancelDeadlineMin: c.cancelDeadlineMin ?? null,
    classId: c.id,
  })).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

// 대상 달에서 (n번째 요일) 날짜들 구하기
function weekdayDatesInMonth(year: number, month: number, weekday: number): string[] {
  const out: string[] = [];
  const lastDay = new Date(Date.UTC(year, month, 0, 12, 0, 0)).getUTCDate();
  for (let day = 1; day <= lastDay; day++) {
    const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    if (d.getUTCDay() === weekday) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// 미리보기: 선택한 그룹이 대상 달에 어떻게 배치될지
export type CopyPlanItem = { date: string; title: string; start: string; end: string; capacity: number };

export async function planCopyByWeekday(
  centerId: string, toMonth: string, groups: CopyGroup[]
): Promise<CopyPlanItem[]> {
  const [ty, tm] = toMonth.split("-").map(Number);
  const holidays = await fetchCenterHolidayDates(centerId);
  const out: CopyPlanItem[] = [];
  for (const g of groups) {
    for (const date of weekdayDatesInMonth(ty, tm, g.dow)) {
      if (holidays.has(date)) continue;
      out.push({ date, title: g.title, start: g.start, end: g.end, capacity: g.capacity });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

export async function planCopyByDate(
  centerId: string, toMonth: string, items: CopyDateItem[]
): Promise<CopyPlanItem[]> {
  const [ty, tm] = toMonth.split("-").map(Number);
  const holidays = await fetchCenterHolidayDates(centerId);
  const lastDay = new Date(Date.UTC(ty, tm, 0, 12, 0, 0)).getUTCDate();
  const out: CopyPlanItem[] = [];
  for (const it of items) {
    if (it.day > lastDay) continue;             // 대상 달에 없는 날 (예: 31일)
    const date = `${toMonth}-${String(it.day).padStart(2, "0")}`;
    if (holidays.has(date)) continue;
    out.push({ date, title: it.title, start: it.start, end: it.end, capacity: it.capacity });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

// 실제 복사 실행 (요일 기준)
export async function copyByWeekday(
  centerId: string, toMonth: string, groups: CopyGroup[]
): Promise<CopyResult> {
  const [ty, tm] = toMonth.split("-").map(Number);
  const holidays = await fetchCenterHolidayDates(centerId);
  const groupId = crypto.randomUUID();
  const rows: any[] = [];
  const linkPlan: { idx: number; srcClassId: string }[] = [];

  for (const g of groups) {
    for (const date of weekdayDatesInMonth(ty, tm, g.dow)) {
      if (holidays.has(date)) continue;
      linkPlan.push({ idx: rows.length, srcClassId: g.classIds[0] });
      rows.push({
        center_id: centerId, title: g.title,
        start_time: toKstIso(date, g.start), end_time: toKstIso(classEndDate(date, g.start, g.end), g.end),
        capacity: g.capacity, room_id: g.roomId,
        cancel_deadline_min: g.cancelDeadlineMin,
        recurring_group_id: groupId, status: "open", allow_goods: true,
      });
    }
  }
  return await insertCopiedClasses(centerId, rows, linkPlan);
}

// 실제 복사 실행 (날짜 기준)
export async function copyByDate(
  centerId: string, toMonth: string, items: CopyDateItem[]
): Promise<CopyResult> {
  const [ty, tm] = toMonth.split("-").map(Number);
  const holidays = await fetchCenterHolidayDates(centerId);
  const lastDay = new Date(Date.UTC(ty, tm, 0, 12, 0, 0)).getUTCDate();
  const groupId = crypto.randomUUID();
  const rows: any[] = [];
  const linkPlan: { idx: number; srcClassId: string }[] = [];

  for (const it of items) {
    if (it.day > lastDay) continue;
    const date = `${toMonth}-${String(it.day).padStart(2, "0")}`;
    if (holidays.has(date)) continue;
    linkPlan.push({ idx: rows.length, srcClassId: it.classId });
    rows.push({
      center_id: centerId, title: it.title,
      start_time: toKstIso(date, it.start), end_time: toKstIso(classEndDate(date, it.start, it.end), it.end),
      capacity: it.capacity, room_id: it.roomId,
      cancel_deadline_min: it.cancelDeadlineMin,
      recurring_group_id: groupId, status: "open", allow_goods: true,
    });
  }
  return await insertCopiedClasses(centerId, rows, linkPlan);
}

// 특정 class의 수강권 허용 모드만 단독 조회. class_allowed_products 행 존재 여부만으로는
// 'all'/'selected'를 다시 판정할 수 없으므로(이 컬럼이 유일한 근거) 반드시 이 값을 직접
// 읽어야 한다. 스케줄 복사(원본 모드 그대로 옮기기)와 관리자 UI의 수정 시트 재진입 하이드레이트
// (목록의 캐시된 ManagedClass.passSelectionMode는 방금 저장 직후엔 아직 갱신 전일 수 있어
// 신뢰할 수 없다 — 반드시 이 함수로 다시 조회) 양쪽에서 재사용한다.
export async function fetchClassPassSelectionMode(classId: string): Promise<"all" | "selected"> {
  const { data, error } = await supabase.from("classes").select("pass_selection_mode").eq("id", classId).maybeSingle();
  if (error || !data) return "all";
  return ((data as any).pass_selection_mode ?? "all") as "all" | "selected";
}

// 공통: 삽입 + 수강권/강사 연결 복사
// P1-5b: create_recurring_classes_safe RPC를 거친다(rows에서 center_id는 빼고 별도
// 인자로 넘김) — own 권한(schedule.own.group.create) 판정이 서버에서 이뤄진다.
export type CopyResult = { count: number; failedCount: number };

async function insertCopiedClasses(
  centerId: string, rows: any[], linkPlan: { idx: number; srcClassId: string }[]
): Promise<CopyResult> {
  if (rows.length === 0) return { count: 0, failedCount: 0 };

  // 원본별 수강권 허용 모드를 먼저 조회해 각 row에 반영한다 — pass_selection_mode는
  // classes 테이블의 컬럼이라 insert 시점에 함께 넣어야 한다(나중에 update하면 그 사이
  // 잠깐 기본값 'all'로 노출되는 창이 생김).
  const modeCache: Record<string, "all" | "selected"> = {};
  for (const l of linkPlan) {
    if (!(l.srcClassId in modeCache)) modeCache[l.srcClassId] = await fetchClassPassSelectionMode(l.srcClassId);
  }
  for (const l of linkPlan) {
    rows[l.idx].pass_selection_mode = modeCache[l.srcClassId];
    delete rows[l.idx].center_id;
  }

  const { data, error } = await supabase.rpc("create_recurring_classes_safe", {
    p_center_id: centerId, p_rows: rows, p_is_copy: true,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));

  const newIds = (data as string[]) ?? [];
  // 원본별 수강권/강사 연결 캐시
  const productCache: Record<string, string[]> = {};
  const trainerCache: Record<string, string[]> = {};
  // UX 감사(2026-09-06) — 여기 실패는 예전엔 조용히 무시돼, 복사된 수업이 원본의 수강권
  // 제한·담당 강사를 못 받아도 매니저가 알 방법이 없었다. 몇 건이 실패했는지 세어서
  // 반환한다(수업 생성 자동 예약조건 등록의 failedRuleCount와 같은 패턴).
  let failedCount = 0;
  for (const l of linkPlan) {
    const newId = newIds[l.idx];
    if (!newId) continue;
    if (!(l.srcClassId in productCache)) {
      try { productCache[l.srcClassId] = await fetchClassProducts(l.srcClassId); }
      catch { productCache[l.srcClassId] = []; }
    }
    if (!(l.srcClassId in trainerCache)) {
      try { trainerCache[l.srcClassId] = await fetchClassTrainers(l.srcClassId); }
      catch { trainerCache[l.srcClassId] = []; }
    }
    // 'selected' 모드일 때만 실제로 저장된 product가 있고, 그 경우에만 복사한다 —
    // 'all' 모드는 class_allowed_products를 비워두는 게 정책이므로 여기서도 그대로 둔다.
    const products = productCache[l.srcClassId];
    if (modeCache[l.srcClassId] === "selected" && products.length > 0) {
      try { await setClassProducts(newId, products); } catch { failedCount += 1; }
    }
    const trainers = trainerCache[l.srcClassId];
    if (trainers.length > 0) {
      try { await setClassTrainers(newId, trainers); } catch { failedCount += 1; }
    }
  }
  return { count: newIds.length, failedCount };
}
