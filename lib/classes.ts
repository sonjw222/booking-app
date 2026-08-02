/*
  수업 관리 데이터 함수 (매니저용)
  - 특정 센터의 수업 목록 조회 / 생성 / 수정 / 삭제
  - 매니저 RLS 정책(reservation_functions.sql)이 있어야 생성·수정이 동작
*/

import { supabase } from "./supabaseClient";
import type { ReservationType } from "./reservationTypes";

export type ManagedClass = {
  id: string;
  title: string;
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
};

const KST_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const KST_TIME = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });

// "2026-07-14" + "07:10" → ISO with +09:00 offset
function toKstIso(date: string, time: string) {
  return `${date}T${time}:00+09:00`;
}

export async function fetchClasses(centerId: string, fromDate: string, toDate: string): Promise<ManagedClass[]> {
  const { data: rows, error } = await supabase
    .from("classes")
    .select("id, title, start_time, end_time, capacity, recurring_group_id, allow_goods, room_id, cancel_deadline_min, booking_deadline_min, class_format, status")
    .eq("center_id", centerId)
    .gte("start_time", toKstIso(fromDate, "00:00"))
    .lte("start_time", toKstIso(toDate, "23:59"))
    .order("start_time");
  if (error) throw new Error("수업을 불러오지 못했어요: " + error.message);

  const ids = (rows ?? []).map((c) => c.id);
  const counts: Record<string, number> = {};
  if (ids.length > 0) {
    const { data: countRows } = await supabase
      .from("class_reservation_counts")
      .select("class_id, confirmed_count")
      .in("class_id", ids);
    for (const r of countRows ?? []) counts[r.class_id] = r.confirmed_count;
  }

  return (rows ?? []).map((c) => ({
    id: c.id,
    title: c.title,
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
  }));
}

export type ClassInput = {
  title: string;
  date: string;
  start: string;
  end: string;
  capacity: number;
  allowGoods: boolean;
  roomId?: string | null;
  cancelDeadlineMin?: number | null;   // 예약취소 마감 (분). null이면 센터 설정 사용
  bookingDeadlineMin?: number | null;  // 예약마감 (분). null이면 센터 설정 사용(CLASS-001)
  classFormat?: "group" | "private";   // CLASS-001 D-2, 기본값 group
};

export async function createClass(centerId: string, input: ClassInput): Promise<string> {
  const { data, error } = await supabase.from("classes").insert({
    center_id: centerId,
    title: input.title,
    start_time: toKstIso(input.date, input.start),
    end_time: toKstIso(input.date, input.end),
    capacity: input.capacity,
    allow_goods: input.allowGoods,
    room_id: input.roomId ?? null,
    cancel_deadline_min: input.cancelDeadlineMin ?? 0,
    booking_deadline_min: input.bookingDeadlineMin ?? null,
    class_format: input.classFormat ?? "group",
  }).select("id").single();
  if (error) throw new Error("수업 등록에 실패했어요: " + error.message);
  return data.id;
}

export async function updateClass(classId: string, input: ClassInput): Promise<void> {
  const { error } = await supabase
    .from("classes")
    .update({
      title: input.title,
      start_time: toKstIso(input.date, input.start),
      end_time: toKstIso(input.date, input.end),
      capacity: input.capacity,
      allow_goods: input.allowGoods,
      room_id: input.roomId ?? null,
      cancel_deadline_min: input.cancelDeadlineMin ?? 0,
      booking_deadline_min: input.bookingDeadlineMin ?? null,
      class_format: input.classFormat ?? "group",
    })
    .eq("id", classId);
  if (error) throw new Error("수업 수정에 실패했어요: " + error.message);
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
export async function updateClassGroup(
  groupId: string, title: string, start: string, end: string, capacity: number
): Promise<void> {
  // 그룹의 모든 수업을 가져와 각자의 날짜에 새 시간 적용
  const { data: rows, error: fErr } = await supabase
    .from("classes")
    .select("id, start_time")
    .eq("recurring_group_id", groupId);
  if (fErr) throw new Error("반복 수업을 불러오지 못했어요: " + fErr.message);

  for (const r of rows ?? []) {
    const dateStr = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date((r as any).start_time));
    const { error } = await supabase.from("classes").update({
      title,
      start_time: toKstIso(dateStr, start),
      end_time: toKstIso(dateStr, end),
      capacity,
    }).eq("id", (r as any).id);
    if (error) throw new Error("반복 수업 수정에 실패했어요: " + error.message);
  }
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
  let dates = expandRecurringDates(input.fromDate, input.toDate, input.daysOfWeek);
  if (input.excludeDates) dates = dates.filter((d) => !input.excludeDates!.has(d));
  if (dates.length === 0) return [];

  // 이 반복 등록을 하나로 묶는 그룹 id
  const groupId = crypto.randomUUID();
  const rows = dates.map((d) => ({
    center_id: centerId,
    title: input.title,
    start_time: toKstIso(d, input.start),
    end_time: toKstIso(d, input.end),
    capacity: input.capacity,
    room_id: input.roomId ?? null,
    cancel_deadline_min: input.cancelDeadlineMin ?? 0,
    booking_deadline_min: input.bookingDeadlineMin ?? null,
    recurring_group_id: groupId,
  }));
  const { data, error } = await supabase.from("classes").insert(rows).select("id");
  if (error) throw new Error("반복 수업 등록에 실패했어요: " + error.message);
  return (data ?? []).map((r: any) => r.id);
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
  if (error) throw new Error("수업 수강권을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => r.product_id);
}

// 수업의 예약가능 수강권을 통째로 교체 (선택된 id 배열로)
export async function setClassProducts(classId: string, productIds: string[]): Promise<void> {
  // 기존 것 모두 삭제 후 새로 삽입
  const { error: delErr } = await supabase
    .from("class_allowed_products")
    .delete()
    .eq("class_id", classId);
  if (delErr) throw new Error("수강권 설정에 실패했어요: " + delErr.message);

  if (productIds.length === 0) return;
  const rows = productIds.map((pid) => ({ class_id: classId, product_id: pid }));
  const { error } = await supabase.from("class_allowed_products").insert(rows);
  if (error) throw new Error("수강권 설정에 실패했어요: " + error.message);
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
   수업↔수강권 연결 시, 그 수강권 예약조건에 이 수업을 자동 추가
   - 수업의 요일/시간/수업명으로 조건을 만들어 각 수강권에 넣음
   - 이미 같은 조건이 있으면 중복 추가 안 함
   - "모든 수강권"이면 센터의 전체 수강권(pass)에 추가
   ============================================================ */

// 특정 상품들에 이 수업 조건(요일/시간/수업명) 자동 추가
export async function autoAddRulesForClass(
  productIds: string[],
  dayOfWeek: number,
  startTime: string,   // "19:00"
  classTitle: string
): Promise<void> {
  if (productIds.length === 0) return;
  for (const pid of productIds) {
    // 이미 같은 조건이 있는지 확인 (요일+시간+수업명)
    const { data: existing } = await supabase
      .from("membership_schedule_rules")
      .select("id")
      .eq("product_id", pid)
      .eq("day_of_week", dayOfWeek)
      .eq("start_time", startTime)
      .eq("class_title", classTitle)
      .maybeSingle();
    if (existing) continue;
    await supabase.from("membership_schedule_rules").insert({
      product_id: pid,
      day_of_week: dayOfWeek,
      start_time: startTime,
      class_title: classTitle,
    });
  }
}

// 센터의 모든 수강권(pass) id 목록 (예약가능 수강권 미지정 시 사용)
export async function fetchAllPassProductIds(centerId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("products")
    .select("id")
    .eq("center_id", centerId)
    .eq("is_active", true)
    .eq("product_kind", "pass");
  if (error) throw new Error("수강권 목록을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => r.id);
}

// 날짜 문자열 + 시간 문자열 → 요일(0~6)
export function dowFromDate(dateStr: string): number {
  // "2026-07-23" → 요일(0=일~6=토). 시간대 영향 없이 UTC 정오 기준으로 계산.
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
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
   스케줄 복사 (한 달 → 다른 달)
   - 원본 달의 수업들을 대상 달의 같은 "요일·순번"에 맞춰 복사
   - 예: 7월 첫째주 화요일 수업 → 8월 첫째주 화요일에 생성
   - 휴무일은 제외, 예약 정보는 복사하지 않음(빈 수업으로 생성)
   ============================================================ */

export type CopyPreviewItem = {
  title: string;
  fromDate: string;
  toDate: string;
  start: string;
  end: string;
  capacity: number;
};

// 해당 월의 (n번째, 요일) 위치를 계산 → 대상 월의 같은 위치 날짜 구하기
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): string | null {
  // month: 1~12, weekday: 0(일)~6(토), nth: 1~5
  const first = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
  const firstDow = first.getUTCDay();
  let day = 1 + ((weekday - firstDow + 7) % 7) + (nth - 1) * 7;
  const lastDay = new Date(Date.UTC(year, month, 0, 12, 0, 0)).getUTCDate();
  if (day > lastDay) return null;
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return d.toISOString().slice(0, 10);
}

// 원본 월 수업 → 대상 월로 매핑한 미리보기
export async function previewCopySchedule(
  centerId: string, fromMonth: string, toMonth: string
): Promise<CopyPreviewItem[]> {
  // fromMonth/toMonth: "2026-07"
  const [fy, fm] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  const fromStart = `${fromMonth}-01`;
  const fromEnd = new Date(Date.UTC(fy, fm, 0, 12, 0, 0)).toISOString().slice(0, 10);

  const classes = await fetchClasses(centerId, fromStart, fromEnd);
  const holidays = await fetchCenterHolidayDates(centerId);

  const out: CopyPreviewItem[] = [];
  for (const c of classes) {
    const d = new Date(`${c.date}T12:00:00Z`);
    const weekday = d.getUTCDay();
    const nth = Math.floor((d.getUTCDate() - 1) / 7) + 1;
    const target = nthWeekdayOfMonth(ty, tm, weekday, nth);
    if (!target) continue;              // 대상 월에 그 주차가 없으면 건너뜀
    if (holidays.has(target)) continue; // 휴무일 제외
    out.push({
      title: c.title, fromDate: c.date, toDate: target,
      start: c.start, end: c.end, capacity: c.capacity,
    });
  }
  return out.sort((a, b) => a.toDate.localeCompare(b.toDate) || a.start.localeCompare(b.start));
}

// 실제 복사 실행 (룸·취소시간·수강권 연결도 함께 복사)
export async function copySchedule(
  centerId: string, fromMonth: string, toMonth: string
): Promise<number> {
  const [fy, fm] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  const fromStart = `${fromMonth}-01`;
  const fromEnd = new Date(Date.UTC(fy, fm, 0, 12, 0, 0)).toISOString().slice(0, 10);

  const classes = await fetchClasses(centerId, fromStart, fromEnd);
  const holidays = await fetchCenterHolidayDates(centerId);
  if (classes.length === 0) return 0;

  // 원본 수업들의 수강권 연결 정보 미리 조회
  const linkByClass: Record<string, string[]> = {};
  for (const c of classes) {
    try { linkByClass[c.id] = await fetchClassProducts(c.id); } catch { linkByClass[c.id] = []; }
  }

  const groupId = crypto.randomUUID();
  const rows: any[] = [];
  const linksToApply: { idx: number; products: string[] }[] = [];

  for (const c of classes) {
    const d = new Date(`${c.date}T12:00:00Z`);
    const weekday = d.getUTCDay();
    const nth = Math.floor((d.getUTCDate() - 1) / 7) + 1;
    const target = nthWeekdayOfMonth(ty, tm, weekday, nth);
    if (!target || holidays.has(target)) continue;

    linksToApply.push({ idx: rows.length, products: linkByClass[c.id] ?? [] });
    rows.push({
      center_id: centerId,
      title: c.title,
      start_time: toKstIso(target, c.start),
      end_time: toKstIso(target, c.end),
      capacity: c.capacity,
      allow_goods: c.allowGoods,
      room_id: c.roomId,
      cancel_deadline_min: c.cancelDeadlineMin ?? 0,
      recurring_group_id: groupId,
      status: "open",
    });
  }
  if (rows.length === 0) return 0;

  const { data, error } = await supabase.from("classes").insert(rows).select("id");
  if (error) throw new Error("스케줄 복사에 실패했어요: " + error.message);

  // 수강권 연결 복사
  const newIds = (data ?? []).map((r: any) => r.id);
  for (const l of linksToApply) {
    const newId = newIds[l.idx];
    if (newId && l.products.length > 0) {
      try { await setClassProducts(newId, l.products); } catch { /* 무시 */ }
    }
  }
  return newIds.length;
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
        start_time: toKstIso(date, g.start), end_time: toKstIso(date, g.end),
        capacity: g.capacity, room_id: g.roomId,
        cancel_deadline_min: g.cancelDeadlineMin,
        recurring_group_id: groupId, status: "open", allow_goods: true,
      });
    }
  }
  return await insertCopiedClasses(rows, linkPlan);
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
      start_time: toKstIso(date, it.start), end_time: toKstIso(date, it.end),
      capacity: it.capacity, room_id: it.roomId,
      cancel_deadline_min: it.cancelDeadlineMin,
      recurring_group_id: groupId, status: "open", allow_goods: true,
    });
  }
  return await insertCopiedClasses(rows, linkPlan);
}

// 공통: 삽입 + 수강권 연결 복사
async function insertCopiedClasses(
  rows: any[], linkPlan: { idx: number; srcClassId: string }[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const { data, error } = await supabase.from("classes").insert(rows).select("id");
  if (error) throw new Error("스케줄 복사에 실패했어요: " + error.message);

  const newIds = (data ?? []).map((r: any) => r.id);
  // 원본별 수강권 연결 캐시
  const cache: Record<string, string[]> = {};
  for (const l of linkPlan) {
    const newId = newIds[l.idx];
    if (!newId) continue;
    if (!(l.srcClassId in cache)) {
      try { cache[l.srcClassId] = await fetchClassProducts(l.srcClassId); }
      catch { cache[l.srcClassId] = []; }
    }
    const products = cache[l.srcClassId];
    if (products.length > 0) {
      try { await setClassProducts(newId, products); } catch { /* 무시 */ }
    }
  }
  return newIds.length;
}
