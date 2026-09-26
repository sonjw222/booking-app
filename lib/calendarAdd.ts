/*
  "캘린더에 추가" 플랫폼 분기(회원 예약 / 관리자 수업·휴무일 공용). 이벤트 모델은 lib/calendarEvents.ts.

  2026-09-26(1차): 앱에서 OS 표준 일정 추가 UI를 띄운다(사용자가 최종 저장). 2차(같은 날 실기기 QA 후):
  여러 일정 한 번에 추가, 다른 캘린더 앱 선택 개선.

  iOS 앱
   · 기본 캘린더 — 1건: EKEventEditViewController(EventKitUI 표준 일정 화면, 사용자가 저장 확정)
                    여러 건: 사용자가 시트에서 "기본 캘린더에 추가"를 누른 뒤 OS 권한을 한 번 승인받아 batch 저장
                    (iOS 17+ write-only 접근 — 기존 캘린더 내용을 읽지 않음, iOS 15/16은 기존 event access).
   · 다른 앱 선택 — .ics를 UIDocumentInteractionController "Open In" 메뉴로: 이 파일 형식을 열 수 있다고 OS에
                    등록된 설치 앱만 표시된다. 표시할 앱이 없으면 시스템 Share Sheet로 자동 전환.
                    앱 이름/URL scheme은 하드코딩·추측하지 않는다(네이버 캘린더 등이 목록에 나오는지는 그 앱이
                    iOS에 .ics 처리기로 등록했는지에 달려 있다 — OS 정책).
  Android 앱
   · 1건: CalendarContract ACTION_INSERT(기본) / Intent.createChooser(다른 앱 선택)
   · 여러 건: .ics(여러 VEVENT)를 FileProvider로 ACTION_VIEW(기본) / createChooser(다른 앱 선택)
              — 캘린더 권한(WRITE_CALENDAR) 없이도 설치된 캘린더 앱이 가져오기 화면을 연다.
  웹/구버전 앱(플러그인 없음): 기존 exportIcsString(Web Share → .ics 다운로드).

  실패는 throw — 호출 쪽이 실제 실패 메시지를 보여준다(가짜 성공 금지).
*/
import { Capacitor, registerPlugin } from "@capacitor/core";
import { exportIcsString } from "./mypage";
import { calendarEventsToIcs, toNativePayload, type CalendarEventItem, type NativeCalendarPayload } from "./calendarEvents";

interface CalendarEventPlugin {
  addEvent(opts: NativeCalendarPayload & { chooser?: boolean }): Promise<{ result?: "saved" | "canceled" | "deleted" }>;
  addEvents(opts: { events: NativeCalendarPayload[] }): Promise<{ saved: number; failed: number }>;
  openIcs(opts: { ics: string; filename: string; chooser?: boolean }): Promise<{ completed?: boolean; method?: string }>;
  shareIcs(opts: { ics: string; filename: string }): Promise<{ completed?: boolean }>;
}

const CalendarEvent = registerPlugin<CalendarEventPlugin>("CalendarEvent");

export type CalendarPlatform = "ios" | "android" | "web";
/** 앱에서 CalendarEvent 플러그인이 실제로 등록돼 있는지(구버전 앱 바이너리는 없음 → ICS fallback). */
export function detectCalendarPlatform(native = Capacitor.isNativePlatform(), platform = Capacitor.getPlatform(), pluginAvailable = Capacitor.isPluginAvailable("CalendarEvent")): CalendarPlatform {
  if (!native || !pluginAvailable) return "web";
  return platform === "ios" ? "ios" : platform === "android" ? "android" : "web";
}

export type CalendarAddMode = "default" | "chooser";

export type CalendarAddResult =
  | { kind: "saved"; saved: number; failed: number }  // iOS: 실제로 저장된 개수(편집 화면 저장 또는 batch)
  | { kind: "opened" }                                // 시스템 캘린더 화면/chooser를 열었음(Android는 저장 여부를 알 수 없음)
  | { kind: "shared" }                                // Open In/공유 시트/파일 저장으로 전달됨
  | { kind: "cancelled" };                            // 사용자가 닫음

/** 사용자에게 보여줄 결과 문구. 실제로 확인된 결과에만 문구를 반환한다(그 외는 null — 시스템 화면이 안내). */
export function describeCalendarResult(result: CalendarAddResult): string | null {
  if (result.kind !== "saved") return null;
  const { saved, failed } = result;
  if (saved > 0 && failed === 0) return `${saved}개의 일정이 캘린더에 추가됐어요`;
  if (saved > 0 && failed > 0) return `${saved}개의 일정을 추가했고 ${failed}개는 추가하지 못했어요`;
  return null; // saved 0 → addCalendarEvents가 이미 throw
}

/* ---------- 중복 실행 방지 ---------- */
const CALENDAR_KEY = "calendar-add";
const inFlight = new Set<string>();
/** 이미 캘린더 추가 화면/저장이 진행 중이면 true — 빠르게 여러 번 눌러도 시스템 UI가 중복으로 뜨지 않게 한다. */
export function isCalendarAddBusy(key: string = CALENDAR_KEY): boolean { return inFlight.has(key); }

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code?: unknown }).code) : undefined;
}
function isCancel(e: unknown): boolean {
  return /cancel/i.test(e instanceof Error ? e.message : String(e));
}
function errMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

const IOS_DENIED_MESSAGE = "캘린더 추가 권한이 허용되지 않았어요. 설정에서 캘린더를 허용하거나 '다른 캘린더 앱 선택'을 이용해주세요";

function icsFilename(items: CalendarEventItem[]): string {
  return items.length === 1 ? `${items[0].title}.ics` : "모하빗_일정.ics";
}

/**
 * 일정(1건 이상)을 캘린더에 추가.
 *  mode="default": 기본 캘린더 / mode="chooser": 다른 캘린더 앱 선택.
 * 실패하면 throw, 사용자가 취소하면 { kind: "cancelled" }.
 */
export async function addCalendarEvents(items: CalendarEventItem[], mode: CalendarAddMode, platform: CalendarPlatform = detectCalendarPlatform()): Promise<CalendarAddResult> {
  if (items.length === 0) throw new Error("추가할 일정을 선택해주세요");
  if (inFlight.has(CALENDAR_KEY)) throw new Error("이미 일정 추가 화면을 여는 중이에요");
  inFlight.add(CALENDAR_KEY);
  try {
    const filename = icsFilename(items);
    if (platform === "web") {
      const res = await exportIcsString(calendarEventsToIcs(items), filename);
      return res === "cancelled" ? { kind: "cancelled" } : { kind: "shared" };
    }
    if (platform === "android") return await addAndroid(items, mode, filename);
    return await addIos(items, mode, filename);
  } catch (e) {
    throw new Error(errMessage(e, "캘린더에 추가하지 못했어요"));
  } finally {
    inFlight.delete(CALENDAR_KEY);
  }
}

async function addAndroid(items: CalendarEventItem[], mode: CalendarAddMode, filename: string): Promise<CalendarAddResult> {
  const chooser = mode === "chooser";
  if (items.length === 1) {
    await CalendarEvent.addEvent({ ...toNativePayload(items[0]), chooser });
    return { kind: "opened" };
  }
  // 여러 건 — 시스템 일정 추가 인텐트는 한 번에 하나만 받으므로 .ics(여러 VEVENT)를 캘린더 앱에서 연다.
  await CalendarEvent.openIcs({ ics: calendarEventsToIcs(items), filename, chooser });
  return { kind: "opened" };
}

async function addIos(items: CalendarEventItem[], mode: CalendarAddMode, filename: string): Promise<CalendarAddResult> {
  const openIcs = async (): Promise<CalendarAddResult> => {
    const { completed } = await CalendarEvent.openIcs({ ics: calendarEventsToIcs(items), filename });
    return completed === false ? { kind: "cancelled" } : { kind: "shared" };
  };
  if (mode === "chooser") return openIcs();

  if (items.length === 1) {
    try {
      const { result } = await CalendarEvent.addEvent(toNativePayload(items[0]));
      return result === "saved" ? { kind: "saved", saved: 1, failed: 0 } : { kind: "cancelled" };
    } catch (e) {
      if (isCancel(e)) return { kind: "cancelled" };
      // 접근 거부/미지원 등 → 막히지 않게 "다른 앱으로 열기(.ics)"로 자동 전환
      return openIcs();
    }
  }

  // 여러 건 batch — 사용자가 "기본 캘린더에 추가"를 누른 뒤 OS 권한을 한 번 승인받아 저장.
  try {
    const { saved, failed } = await CalendarEvent.addEvents({ events: items.map(toNativePayload) });
    if (saved === 0) throw new Error(`일정을 캘린더에 추가하지 못했어요${failed > 0 ? ` (${failed}건 실패)` : ""}`);
    return { kind: "saved", saved, failed };
  } catch (e) {
    const code = errCode(e);
    if (code === "DENIED" || code === "UNAVAILABLE") throw new Error(IOS_DENIED_MESSAGE);
    if (isCancel(e)) return { kind: "cancelled" };
    throw e;
  }
}
