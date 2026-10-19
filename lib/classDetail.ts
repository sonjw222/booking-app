/*
  센터 > 수업 탭 > 수업 상세 화면 데이터 (/center/[id]/class/[classId])
  - 실제 DB에 있는 값만 보여준다: 수업명 · 소개 · 종목 · 형태 · 시간 · 장소 · 정원/잔여 · 담당 강사 · 사용 가능한 수강권 · 예약 마감.
    값이 없는 항목은 화면에서 행 자체를 만들지 않는다(빈 값을 지어내지 않음).
  - 읽기 전용 조회다. 예약/구매/재고/권한 판단은 기존 화면·서버 함수가 그대로 맡는다.
*/
import { supabase } from "./supabaseClient";
import { appendTrainerNames } from "./instructorDisplay";

export type ClassDetail = {
  id: string;
  centerId: string;
  centerName: string;
  centerCategories: string[];
  title: string;
  description: string | null;
  classFormat: "group" | "private";
  status: "open" | "closed" | "cancelled";
  startIso: string;
  endIso: string;
  date: string;          // KST "YYYY-MM-DD"
  place: string | null;  // 룸 이름 > 장소 텍스트
  capacity: number;
  reserved: number;
  /** 강사: 조회 결과가 "없음"인지 "권한 없음/실패로 모름"인지 구분한다. */
  trainers: TrainersInfo;
  passSelectionMode: "all" | "selected";
  /** 이용 가능한 수강권 — 모드 all 일 때만 "모든 수강권 가능". selected 인데 목록을 확인할 수 없으면 절대 "모두 가능"으로 표시하지 않는다. */
  allowedPasses: AllowedPasses;
  bookingDeadlineMin: number | null;
  /** 취소 조건(수업 설정 값만) — 센터 기본값을 추측하지 않는다. allowCancel=false면 예약 후 취소 불가. */
  allowCancel: boolean;
  cancelDeadlineMin: number | null;
  /** 예약 인원 집계를 읽었는지(실패하면 잔여 자리를 말하지 않는다) */
  reservedKnown: boolean;
};

export type AllowedPasses =
  | { kind: "all" }
  | { kind: "list"; names: string[]; productIds: string[] }
  | { kind: "login_required" }      // 비로그인: 운영 RLS(class_allowed_products)가 anon 에게 행을 숨긴다 — 비어 보여도 "없음"이 아니다
  | { kind: "unavailable" }         // 조회 오류
  | { kind: "unknown_empty" };      // 로그인했는데 selected 모드인데도 읽힌 목록이 비어 있음 — 확인 불가(모두 가능이라고 말하지 않는다)
export type TrainersInfo =
  | { kind: "list"; names: string[] }
  | { kind: "none" }                // RPC 가 정상 응답했고 배정 강사가 없음
  | { kind: "login_required" }      // 비로그인: class_trainer_names 는 anon 에 EXECUTE 없음(권한 오류)
  | { kind: "unavailable" };

export type UpcomingSession = { id: string; date: string; whenText: string; reserved: number; capacity: number };

const KST_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const KST_DAY = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short" });
const KST_TIME = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });

/** "10월 20일 (월) 19:00 – 20:00" */
export function formatClassWhen(startIso: string, endIso: string): string {
  const s = new Date(startIso), e = new Date(endIso);
  return `${KST_DAY.format(s)} ${KST_TIME.format(s)} – ${KST_TIME.format(e)}`;
}

/** 예약 마감(수업 시작 N분 전) 문구. 0/미설정이면 null — 센터 기본 설정은 여기서 추측하지 않는다. */
export function formatBookingDeadline(min: number | null | undefined): string | null {
  if (!min || min <= 0) return null;
  if (min % 1440 === 0) return `수업 시작 ${min / 1440}일 전까지 예약`;
  if (min >= 60) { const h = Math.floor(min / 60), m = min % 60; return m ? `수업 시작 ${h}시간 ${m}분 전까지 예약` : `수업 시작 ${h}시간 전까지 예약`; }
  return `수업 시작 ${min}분 전까지 예약`;
}

/** 취소 조건 문구 — 수업에 설정된 값만 말한다. 값이 없으면 null(센터 기본 정책은 예약 후 취소 화면에서 서버가 안내). */
export function formatCancelPolicy(d: { allowCancel: boolean; cancelDeadlineMin: number | null }): string | null {
  if (!d.allowCancel) return "예약 후에는 취소할 수 없는 수업이에요";
  const min = d.cancelDeadlineMin;
  if (!min || min <= 0) return null;
  const base = formatBookingDeadline(min);
  return base ? base.replace("까지 예약", "까지 취소 가능") : null;
}

export function remainingSpots(capacity: number, reserved: number): number { return Math.max(0, capacity - reserved); }

/** 이 수업을 지금 예약 대상으로 열 수 있는지 — 안내용 판단일 뿐 최종 판정은 서버. */
export function classBookability(d: Pick<ClassDetail, "status" | "startIso">, now = Date.now()): "open" | "closed" | "cancelled" | "past" {
  if (d.status === "cancelled") return "cancelled";
  if (new Date(d.startIso).getTime() <= now) return "past";
  if (d.status === "closed") return "closed";
  return "open";
}

type Embedded<T> = T | T[] | null;
type ClassRow = {
  id: string; center_id: string; title: string; description: string | null; class_format: string | null; place: string | null;
  start_time: string; end_time: string; capacity: number; status: ClassDetail["status"] | null; booking_deadline_min: number | null;
  pass_selection_mode: string | null;
  allow_cancel: boolean | null; cancel_deadline_min: number | null;
  rooms: Embedded<{ name: string | null }>;
  centers: Embedded<{ name: string; categories: string[] | null; status: string }>;
};
const one = <T,>(v: Embedded<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export async function fetchCenterClassDetail(centerId: string, classId: string): Promise<ClassDetail | null> {
  const { data, error } = await supabase
    .from("classes")
    .select("id, center_id, title, description, class_format, place, start_time, end_time, capacity, status, booking_deadline_min, pass_selection_mode, allow_cancel, cancel_deadline_min, rooms(name), centers(name, categories, status)")
    .eq("id", classId)
    .eq("center_id", centerId)
    .maybeSingle();
  if (error) throw new Error("수업 정보를 불러오지 못했어요: " + error.message);
  if (!data) return null;
  const row = data as unknown as ClassRow;
  const center = one(row.centers);
  if (!center || center.status !== "approved") return null;
  const room = one(row.rooms);

  // 로그인 여부(로컬 세션 확인, 네트워크 없음) — 비로그인은 운영 RLS/권한 때문에 일부 값이 "비어 보이거나 호출 불가"가 정상이다.
  const { data: sessionData } = await supabase.auth.getSession();
  const loggedIn = !!sessionData.session;
  const selected = row.pass_selection_mode === "selected";
  const [countRes, trainerRes, passRes] = await Promise.all([
    supabase.from("class_reservation_counts").select("class_id, confirmed_count").eq("class_id", classId),
    supabase.rpc("class_trainer_names", { p_class_ids: [classId] }),
    selected
      ? supabase.from("class_allowed_products").select("products(id, name)").eq("class_id", classId)
      : Promise.resolve({ data: [] as { products: Embedded<{ id: string; name: string | null }> }[], error: null }),
  ]);
  // 강사: 오류(권한/네트워크)를 "강사 없음"으로 단정하지 않는다.
  let trainers: TrainersInfo;
  if (trainerRes.error) trainers = loggedIn ? { kind: "unavailable" } : { kind: "login_required" };
  else {
    const map: Record<string, string[]> = {};
    appendTrainerNames(map, trainerRes.data as { class_id: string; name?: string | null }[] | null);
    trainers = (map[classId] ?? []).length > 0 ? { kind: "list", names: map[classId] } : { kind: "none" };
  }
  // 허용 수강권
  let allowedPasses: AllowedPasses;
  if (!selected) allowedPasses = { kind: "all" };
  else if (!loggedIn) allowedPasses = { kind: "login_required" };      // RLS 가 행을 숨기므로 빈 결과는 "없음"이 아니다
  else if (passRes.error) allowedPasses = { kind: "unavailable" };
  else {
    const products = ((passRes.data ?? []) as unknown as { products: Embedded<{ id: string; name: string | null }> }[])
      .map((l) => one(l.products)).filter((p): p is { id: string; name: string | null } => !!p && !!p.name);
    const names = Array.from(new Set(products.map((p) => p.name as string)));
    const productIds = Array.from(new Set(products.map((p) => p.id)));
    allowedPasses = names.length > 0 ? { kind: "list", names, productIds } : { kind: "unknown_empty" };
  }

  return {
    id: row.id, centerId: row.center_id, centerName: center.name, centerCategories: center.categories ?? [],
    title: row.title, description: row.description?.trim() ? row.description : null,
    classFormat: row.class_format === "private" ? "private" : "group",
    status: row.status ?? "open",
    startIso: row.start_time, endIso: row.end_time, date: KST_DATE.format(new Date(row.start_time)),
    place: (room?.name?.trim() || row.place?.trim() || null),
    capacity: row.capacity,
    reserved: (countRes.data?.[0] as { confirmed_count?: number } | undefined)?.confirmed_count ?? 0,
    reservedKnown: !countRes.error,
    trainers, passSelectionMode: selected ? "selected" : "all", allowedPasses,
    bookingDeadlineMin: row.booking_deadline_min ?? null,
    allowCancel: row.allow_cancel !== false,
    cancelDeadlineMin: row.cancel_deadline_min ?? null,
  };
}

/** 같은 수업명의 다가오는 일정(이 수업 제외, 최대 5개) — 다른 날짜를 고르고 싶을 때 같은 화면 구조로 이동. */
export async function fetchUpcomingSessions(centerId: string, title: string, excludeClassId: string): Promise<UpcomingSession[]> {
  const { data, error } = await supabase
    .from("classes").select("id, start_time, end_time, capacity")
    .eq("center_id", centerId).eq("title", title).eq("status", "open")
    .gte("start_time", new Date().toISOString()).neq("id", excludeClassId)
    .order("start_time", { ascending: true }).limit(5);
  if (error || !data || data.length === 0) return [];
  type Row = { id: string; start_time: string; end_time: string; capacity: number };
  const rowsTyped = data as Row[];
  const ids = rowsTyped.map((r) => r.id);
  const { data: cnt } = await supabase.from("class_reservation_counts").select("class_id, confirmed_count").in("class_id", ids);
  const counts: Record<string, number> = {};
  for (const c of (cnt ?? []) as { class_id: string; confirmed_count: number }[]) counts[c.class_id] = c.confirmed_count;
  return rowsTyped.map((r) => ({
    id: r.id, date: KST_DATE.format(new Date(r.start_time)), whenText: formatClassWhen(r.start_time, r.end_time),
    reserved: counts[r.id] ?? 0, capacity: r.capacity,
  }));
}
