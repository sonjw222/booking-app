/*
  수업 관리 데이터 함수 (매니저용)
  - 특정 센터의 수업 목록 조회 / 생성 / 수정 / 삭제
  - 매니저 RLS 정책(reservation_functions.sql)이 있어야 생성·수정이 동작
*/

import { supabase } from "./supabaseClient";
import type { ReservationType } from "./reservationTypes";
import { toKstIso } from "./kst";

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
  roomId: string | null;
  cancelDeadlineMin: number;
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
      .select("id, title, description, start_time, end_time, capacity, recurring_group_id, allow_goods, room_id, cancel_deadline_min, booking_deadline_min, class_format, status, pass_selection_mode")
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
      for (const r of trainerRows ?? []) {
        const name = (r as any).name;
        if (!name) continue;
        (instructorNamesByClass[(r as any).class_id] ??= []).push(name);
      }
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
    roomId: c.room_id ?? null,
    cancelDeadlineMin: c.cancel_deadline_min ?? 0,
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
    p_cancel_deadline_min: input.cancelDeadlineMin ?? 0,
    p_booking_deadline_min: input.bookingDeadlineMin ?? null,
    p_class_format: input.classFormat ?? "group",
    p_pass_selection_mode: input.passSelectionMode ?? "all",
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return data as string;
}

export async function updateClass(classId: string, input: ClassInput): Promise<void> {
  assertValidClassTimeRange(input.start, input.end);
  const { error } = await supabase.rpc("update_class_safe", {
    p_class_id: classId,
    p_title: input.title,
    p_description: input.description ?? null,
    p_start_time: toKstIso(input.date, input.start),
    p_end_time: toKstIso(classEndDate(input.date, input.start, input.end), input.end),
    p_capacity: input.capacity,
    p_allow_goods: input.allowGoods,
    p_room_id: input.roomId ?? null,
    p_cancel_deadline_min: input.cancelDeadlineMin ?? 0,
    p_booking_deadline_min: input.bookingDeadlineMin ?? null,
    p_class_format: input.classFormat ?? "group",
    p_pass_selection_mode: input.passSelectionMode ?? "all",
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
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

// 그룹 전체 수정 (제목/시작·종료 시간/정원만. 날짜는 각 수업 유지)
// 반환값: 이 그룹에 속한 class id 전체 — 담당 강사 일괄 적용(setClassTrainersForGroup) 등
// 그룹 전체를 다시 대상으로 삼아야 하는 후속 작업에서 재사용한다(같은 조회를 두 번 하지
// 않도록).
export async function updateClassGroup(
  groupId: string, title: string, start: string, end: string, capacity: number
): Promise<string[]> {
  assertValidClassTimeRange(start, end);
  // 그룹의 모든 수업을 가져와 각자의 날짜에 새 시간 적용(날짜별 새 시각 계산은 클라이언트가
  // 하고, 실제 쓰기는 update_class_group_safe RPC 한 번으로 — own/other 판정을 서버에서
  // 한 번만 하면 되도록).
  const { data: rows, error: fErr } = await supabase
    .from("classes")
    .select("id, start_time")
    .eq("recurring_group_id", groupId);
  if (fErr) throw new Error("반복 수업을 불러오지 못했어요: " + fErr.message);

  const updates = (rows ?? []).map((r: any) => {
    const dateStr = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(r.start_time));
    return {
      id: r.id,
      start_time: toKstIso(dateStr, start),
      end_time: toKstIso(classEndDate(dateStr, start, end), end),
    };
  });

  const { data, error } = await supabase.rpc("update_class_group_safe", {
    p_group_id: groupId, p_title: title, p_capacity: capacity, p_updates: updates,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return (data as string[]) ?? [];
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
  assertValidClassTimeRange(input.start, input.end);
  let dates = expandRecurringDates(input.fromDate, input.toDate, input.daysOfWeek);
  if (input.excludeDates) dates = dates.filter((d) => !input.excludeDates!.has(d));
  if (dates.length === 0) return [];

  // 이 반복 등록을 하나로 묶는 그룹 id
  const groupId = crypto.randomUUID();
  const rows = dates.map((d) => ({
    title: input.title,
    start_time: toKstIso(d, input.start),
    end_time: toKstIso(classEndDate(d, input.start, input.end), input.end),
    capacity: input.capacity,
    room_id: input.roomId ?? null,
    cancel_deadline_min: input.cancelDeadlineMin ?? 0,
    booking_deadline_min: input.bookingDeadlineMin ?? null,
    recurring_group_id: groupId,
    pass_selection_mode: input.passSelectionMode ?? "all",
  }));
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
};

export async function fetchClassAttendees(classId: string): Promise<ClassAttendee[]> {
  const { data, error } = await supabase
    .from("reservations")
    .select("id, profile_id, status, waitlist_order, reservation_type, is_capacity_override, profiles(name)")
    .eq("class_id", classId)
    .in("status", ["confirmed", "waitlisted", "attended", "no_show", "cancelled"])
    .order("status")
    .order("waitlist_order", { ascending: true, nullsFirst: true });
  if (error) throw new Error("예약자 명단을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    reservationId: r.id,
    profileId: r.profile_id,
    name: r.profiles?.name ?? "(이름 없음)",
    status: r.status,
    waitlistOrder: r.waitlist_order,
    reservationType: (r.reservation_type ?? "MEMBER") as ReservationType,
    isCapacityOverride: r.is_capacity_override ?? false,
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
  const { data, error } = await supabase
    .from("class_trainers")
    .select("account_id")
    .eq("class_id", classId);
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
};

const KST_MD_SHORT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
});

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
  }));
}

// 특정 수강권으로 다시 자동배치 시도 (정원을 늘린 뒤 눌러서 재시도)
export async function retryAutoBook(membershipId: string): Promise<number> {
  const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: membershipId });
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
  cancelDeadlineMin: number;
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
        cancelDeadlineMin: c.cancelDeadlineMin ?? 0,
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
  cancelDeadlineMin: number;
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
    roomId: c.roomId, cancelDeadlineMin: c.cancelDeadlineMin ?? 0,
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
): Promise<number> {
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
): Promise<number> {
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
async function insertCopiedClasses(
  centerId: string, rows: any[], linkPlan: { idx: number; srcClassId: string }[]
): Promise<number> {
  if (rows.length === 0) return 0;

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
    p_center_id: centerId, p_rows: rows,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));

  const newIds = (data as string[]) ?? [];
  // 원본별 수강권/강사 연결 캐시
  const productCache: Record<string, string[]> = {};
  const trainerCache: Record<string, string[]> = {};
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
      try { await setClassProducts(newId, products); } catch { /* 무시 */ }
    }
    const trainers = trainerCache[l.srcClassId];
    if (trainers.length > 0) {
      try { await setClassTrainers(newId, trainers); } catch { /* 무시 */ }
    }
  }
  return newIds.length;
}
