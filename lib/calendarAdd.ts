/*
  "캘린더에 추가" 플랫폼 분기(2026-09-26).

  기존엔 blob + <a download>로 .ics만 내려받았다(lib/mypage.ts exportIcs) — iOS/Android 앱에서는
  "파일 내보내기"에 그쳐 실제 캘린더에 들어가지 않았다. 지금은 앱(Capacitor)에서 OS 표준 일정 추가
  UI를 직접 띄운다(사용자가 최종 저장을 눌러 확정 — 몰래 저장하지 않음).

  플랫폼별 경로
  - iOS 앱   · 기본 캘린더: EKEventEditViewController(EventKitUI) — ios/App/App/WebViewThemePlugin.swift
                            안의 CalendarEventPlugin.addEvent
              · 다른 앱 선택: .ics 파일을 시스템 Share Sheet(UIActivityViewController)로 — iOS는
                Android처럼 설치된 캘린더 앱을 열거/선택하는 공통 API가 없어 설치된 앱 목록은
                OS에 맡긴다(앱 이름/URL scheme 하드코딩·추측 없음).
  - Android 앱 · 기본 캘린더: CalendarContract ACTION_INSERT — CalendarEventPlugin.java
              · 다른 앱 선택: 같은 인텐트를 Intent.createChooser로 감싸 시스템 chooser 표시
  - 웹/구버전 앱(플러그인 없음) · 기존 exportIcs(Web Share → .ics 다운로드) — ICS 생성 코드는 그대로
    fallback으로 유지.

  시간은 항상 절대 시각(epoch ms, startIso/endIso는 timestamptz ISO 문자열)으로 넘긴다 — 로컬
  시간 문자열을 조합하지 않으므로 KST/기기 시간대와 무관하게 9시간 밀리지 않는다.
*/
import { Capacitor, registerPlugin } from "@capacitor/core";
import { exportIcs, reservationsToIcs, type CalReservation, type IcsExportResult } from "./mypage";

export interface CalendarEventPayload {
  title: string;
  startMs: number;
  endMs: number;
  location?: string;
  notes?: string;
}

interface CalendarEventPlugin {
  addEvent(opts: CalendarEventPayload & { chooser?: boolean }): Promise<{ result?: "saved" | "canceled" | "deleted" | "launched" }>;
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

// 종료 시각이 없거나 시작과 같으면(수업 end_time null) 길이 0 일정이 되지 않게 1시간으로.
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

export function buildCalendarPayload(r: CalReservation): CalendarEventPayload {
  const startMs = Date.parse(r.startIso);
  let endMs = Date.parse(r.endIso);
  if (!Number.isFinite(startMs)) throw new Error("일정 시간이 올바르지 않아요");
  if (!Number.isFinite(endMs) || endMs <= startMs) endMs = startMs + DEFAULT_DURATION_MS;
  const notes = [
    r.profileName ? `예약자: ${r.profileName}` : "",
    r.memo ? `메모: ${r.memo}` : "",
    "모하빗에서 예약한 수업이에요.",
  ].filter(Boolean).join("\n");
  return {
    title: r.centerName ? `${r.title} · ${r.centerName}` : r.title,
    startMs,
    endMs,
    location: r.centerName || undefined,
    notes,
  };
}

/** 사용자가 취소한 경우와 실패를 구분하기 위한 결과. */
export type CalendarAddResult =
  | { kind: "saved" }          // iOS: 사용자가 이벤트 편집 화면에서 저장함(실제 확인됨)
  | { kind: "opened" }         // 시스템 캘린더 화면/chooser를 열었음(Android는 저장 여부를 알 수 없음)
  | { kind: "shared" }         // 공유 시트를 통해 전달됨 / 파일 저장
  | { kind: "cancelled" };     // 사용자가 닫음

const inFlight = new Set<string>();
/** 같은 키로 이미 진행 중이면 true — 빠르게 여러 번 눌러도 시스템 UI가 중복으로 뜨지 않게 한다. */
export function isCalendarAddBusy(key: string): boolean { return inFlight.has(key); }

function isCancel(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /cancel/i.test(m);
}

function errMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * 예약 하나를 캘린더에 추가. mode="default"는 기본 캘린더, "chooser"는 다른 캘린더 앱 선택.
 * 실패하면 throw — 호출 쪽이 실제 실패 메시지를 보여준다(가짜 성공 금지).
 */
export async function addReservationToCalendar(r: CalReservation, mode: CalendarAddMode, platform: CalendarPlatform = detectCalendarPlatform()): Promise<CalendarAddResult> {
  const key = `one:${r.id}`;
  if (inFlight.has(key)) throw new Error("이미 일정 추가 화면을 여는 중이에요");
  inFlight.add(key);
  try {
    const payload = buildCalendarPayload(r);
    if (platform === "web") {
      const res = await exportIcs([r], `${r.title}.ics`);
      return res === "cancelled" ? { kind: "cancelled" } : { kind: "shared" };
    }
    if (platform === "android") {
      await CalendarEvent.addEvent({ ...payload, chooser: mode === "chooser" });
      return { kind: "opened" };
    }
    // iOS
    if (mode === "chooser") return await shareIcsNative([r], `${r.title}.ics`);
    try {
      const { result } = await CalendarEvent.addEvent(payload);
      return result === "saved" ? { kind: "saved" } : { kind: "cancelled" };
    } catch (e) {
      if (isCancel(e)) return { kind: "cancelled" };
      // 접근 거부/미지원 등 → 사용자가 막히지 않게 시스템 Share Sheet(.ics)로 자동 전환(실패를 숨기지 않고
      // 호출 쪽이 "share" 결과를 그대로 안내한다).
      return await shareIcsNative([r], `${r.title}.ics`);
    }
  } catch (e) {
    throw new Error(errMessage(e, "캘린더에 추가하지 못했어요"));
  } finally {
    inFlight.delete(key);
  }
}

/** 여러 예약을 .ics 하나로 묶어 시스템 공유(iOS Share Sheet). Android/웹은 기존 exportIcs. */
export async function addReservationsAsFile(items: CalReservation[], filename: string, platform: CalendarPlatform = detectCalendarPlatform()): Promise<CalendarAddResult> {
  const key = "many";
  if (inFlight.has(key)) throw new Error("이미 내보내는 중이에요");
  inFlight.add(key);
  try {
    if (platform === "ios") return await shareIcsNative(items, filename);
    const res = await exportIcs(items, filename);
    return res === "cancelled" ? { kind: "cancelled" } : { kind: "shared" };
  } catch (e) {
    throw new Error(errMessage(e, "캘린더 파일을 내보내지 못했어요"));
  } finally {
    inFlight.delete(key);
  }
}

async function shareIcsNative(items: CalReservation[], filename: string): Promise<CalendarAddResult> {
  const { completed } = await CalendarEvent.shareIcs({ ics: reservationsToIcs(items), filename });
  return completed === false ? { kind: "cancelled" } : { kind: "shared" };
}

export type { IcsExportResult };
