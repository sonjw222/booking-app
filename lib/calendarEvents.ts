/*
  캘린더 이벤트 공용 모델(2026-09-26, 회원 예약/관리자 수업·휴무일 공용).

  회원 "예약 캘린더"와 관리자 "수업" 화면이 같은 선택 시트(app/components/CalendarAddSheet.tsx),
  같은 네이티브 브리지(lib/calendarAdd.ts), 같은 ICS 직렬화기를 쓰도록 이 파일 하나로 통일했다 —
  화면마다 payload/ICS를 따로 만들지 않는다. 이 파일은 순수 함수만 담는다(Capacitor/Supabase 의존 없음).

  시간 처리
  - 시간이 있는 일정은 절대 시각(timestamptz ISO 문자열 → epoch ms)으로만 다룬다. 로컬 시간 문자열을
    조합하지 않아 KST/기기 시간대와 무관하게 9시간 밀리지 않는다. 종료가 없거나 시작 이하이면 1시간.
  - 하루 종일(휴무일) 일정은 "YYYY-MM-DD" 날짜로만 다룬다. iCalendar all-day의 DTEND는 exclusive
    (마지막 날의 다음 날)이므로 endDayExclusive로 저장한다 — 하루 휴무면 다음 날, 연속 3일이면 마지막 날+1.
*/
import type { CalReservation } from "./mypage";
import type { ManagedClass } from "./classes";
import { toKstIso } from "./kst";

export type CalendarEventKind = "reservation" | "class" | "holiday";

export interface CalendarEventItem {
  id: string;            // 화면 안에서 유일한 키 + ICS UID의 기반
  kind: CalendarEventKind;
  title: string;
  centerName: string;
  dateKey: string;       // 시작 날짜 "YYYY-MM-DD"(KST) — 월 필터/정렬/표시용
  timeLabel: string;     // "11:44" 또는 "하루 종일"
  allDay: boolean;
  // 시간이 있는 일정
  startIso?: string;
  endIso?: string;
  // 하루 종일 일정 — endDayExclusive는 마지막 날의 다음 날(iCalendar DTEND 규칙)
  startDay?: string;
  endDayExclusive?: string;
  location?: string;
  notes?: string;
}

export const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------- 날짜 유틸 (머신 TZ 무관: 전부 UTC 산술) ---------- */

function dayToUtcMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function utcMsToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDays(day: string, n: number): string {
  return utcMsToDay(dayToUtcMs(day) + n * DAY_MS);
}

/* ---------- 매퍼 ---------- */

export function reservationToEvent(r: CalReservation): CalendarEventItem {
  const notes = [
    r.profileName ? `예약자: ${r.profileName}` : "",
    r.memo ? `메모: ${r.memo}` : "",
    "모하빗에서 예약한 수업이에요.",
  ].filter(Boolean).join("\n");
  return {
    id: `res-${r.id}`,
    kind: "reservation",
    title: r.centerName ? `${r.title} · ${r.centerName}` : r.title,
    centerName: r.centerName,
    dateKey: r.date,
    timeLabel: r.time,
    allDay: false,
    startIso: r.startIso,
    endIso: r.endIso,
    location: r.centerName || undefined,
    notes,
  };
}

export interface ClassEventContext {
  centerName: string;
  roomName?: string | null;
  roomAddress?: string | null;
}

export function classToEvent(c: ManagedClass, ctx: ClassEventContext): CalendarEventItem {
  const startIso = new Date(toKstIso(c.date, c.start)).toISOString();
  let endMs = new Date(toKstIso(c.date, c.end)).getTime();
  const startMs = Date.parse(startIso);
  // 자정을 넘기는 심야 수업(23:00→01:00): 종료가 시작 이하이면 다음 날.
  if (endMs <= startMs) endMs += DAY_MS;
  const notes = [
    c.instructorNames.length > 0 ? `강사: ${c.instructorNames.join(", ")}` : "",
    ctx.roomName ? `룸: ${ctx.roomName}` : "",
    `정원 ${c.capacity}명 · 예약 ${c.reserved}명`,
    c.description ?? "",
  ].filter(Boolean).join("\n");
  return {
    id: `class-${c.id}`,
    kind: "class",
    title: ctx.centerName ? `${c.title} · ${ctx.centerName}` : c.title,
    centerName: ctx.centerName,
    dateKey: c.date,
    timeLabel: c.start,
    allDay: false,
    startIso,
    endIso: new Date(endMs).toISOString(),
    location: ctx.roomAddress || ctx.centerName || undefined,
    notes,
  };
}

/**
 * 휴무일 날짜들 → 하루 종일 이벤트. 연속된 날짜는 하나의 기간(all-day range)으로 합친다.
 * 예: 9/10, 9/11, 9/12 → 시작 9/10, endDayExclusive 9/13.
 */
export function holidaysToEvents(dates: string[], centerId: string, centerName: string): CalendarEventItem[] {
  const sorted = Array.from(new Set(dates)).sort();
  const out: CalendarEventItem[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && addDays(sorted[j], 1) === sorted[j + 1]) j++;
    const startDay = sorted[i];
    const endDayExclusive = addDays(sorted[j], 1);
    out.push({
      id: `holiday-${centerId}-${startDay}`,
      kind: "holiday",
      title: `${centerName} 휴무일`,
      centerName,
      dateKey: startDay,
      timeLabel: "하루 종일",
      allDay: true,
      startDay,
      endDayExclusive,
      location: centerName || undefined,
      notes: j > i ? `${startDay} ~ ${sorted[j]} 휴무` : undefined,
    });
    i = j + 1;
  }
  return out;
}

/* ---------- 필터 / 정렬 / 선택 ---------- */

export function monthPrefix(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** 표시 중인 달(year/month)에 시작하는 일정만, 날짜·시간 순. */
export function filterEventsByMonth(items: CalendarEventItem[], year: number, month: number): CalendarEventItem[] {
  const p = monthPrefix(year, month);
  return items
    .filter((e) => e.dateKey.startsWith(p))
    .sort((a, b) => (a.dateKey + (a.allDay ? "00:00" : a.timeLabel) + a.id).localeCompare(b.dateKey + (b.allDay ? "00:00" : b.timeLabel) + b.id));
}

export function selectAll(items: CalendarEventItem[]): Set<string> {
  return new Set(items.map((e) => e.id));
}
export function selectNone(): Set<string> {
  return new Set();
}
export function toggleSelection(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
/** 선택된 것만, 원래 목록 순서 유지. */
export function pickSelected(items: CalendarEventItem[], selected: Set<string>): CalendarEventItem[] {
  return items.filter((e) => selected.has(e.id));
}

/* ---------- 네이티브 payload ---------- */

export interface NativeCalendarPayload {
  title: string;
  allDay: boolean;
  startMs: number;          // 시간 일정: 절대 시각 / all-day: 시작일 UTC 자정
  endMs: number;            // 시간 일정: 절대 시각 / all-day: endDayExclusive UTC 자정
  startDay?: string;        // all-day 전용 (iOS는 기기 로컬 날짜로 변환)
  endDayExclusive?: string;
  location?: string;
  notes?: string;
}

export function toNativePayload(e: CalendarEventItem): NativeCalendarPayload {
  if (e.allDay) {
    if (!e.startDay || !e.endDayExclusive) throw new Error("휴무일 날짜가 올바르지 않아요");
    return {
      title: e.title, allDay: true,
      startMs: dayToUtcMs(e.startDay), endMs: dayToUtcMs(e.endDayExclusive),
      startDay: e.startDay, endDayExclusive: e.endDayExclusive,
      location: e.location, notes: e.notes,
    };
  }
  const startMs = Date.parse(e.startIso ?? "");
  let endMs = Date.parse(e.endIso ?? "");
  if (!Number.isFinite(startMs)) throw new Error("일정 시간이 올바르지 않아요");
  if (!Number.isFinite(endMs) || endMs <= startMs) endMs = startMs + DEFAULT_EVENT_DURATION_MS;
  return { title: e.title, allDay: false, startMs, endMs, location: e.location, notes: e.notes };
}

/* ---------- ICS 직렬화 ---------- */

function escapeIcs(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function icsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function icsDate(day: string): string {
  return day.replace(/-/g, "");
}

/** 여러 VEVENT를 하나의 VCALENDAR로. 시간 일정은 UTC(Z), 하루 종일은 VALUE=DATE(DTEND exclusive). */
export function calendarEventsToIcs(items: CalendarEventItem[], nowMs: number = Date.now()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//모하빗//예약//KR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  const stamp = icsUtc(nowMs);
  for (const e of items) {
    const p = toNativePayload(e);
    lines.push("BEGIN:VEVENT", `UID:${e.id}@woori-class`, `DTSTAMP:${stamp}`);
    if (p.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(e.startDay!)}`, `DTEND;VALUE=DATE:${icsDate(e.endDayExclusive!)}`);
    } else {
      lines.push(`DTSTART:${icsUtc(p.startMs)}`, `DTEND:${icsUtc(p.endMs)}`);
    }
    lines.push(`SUMMARY:${escapeIcs(e.title)}`);
    if (e.notes) lines.push(`DESCRIPTION:${escapeIcs(e.notes)}`);
    if (e.location) lines.push(`LOCATION:${escapeIcs(e.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
