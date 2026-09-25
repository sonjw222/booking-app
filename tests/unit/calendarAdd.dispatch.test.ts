/*
  2026-09-26 — "캘린더에 추가" 플랫폼 분기/페이로드/중복 실행 방지.
  네이티브 플러그인은 vi.mock으로 대체(실기기 동작은 별도 체크리스트).
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const { plugin, exportIcsMock } = vi.hoisted(() => ({ plugin: { addEvent: vi.fn(), shareIcs: vi.fn() }, exportIcsMock: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  registerPlugin: () => plugin,
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web", isPluginAvailable: () => false },
}));
vi.mock("../../lib/mypage", async (orig) => {
  const actual = await orig<typeof import("../../lib/mypage")>();
  return { ...actual, exportIcs: (...a: unknown[]) => exportIcsMock(...a) };
});

import {
  addReservationToCalendar, addReservationsAsFile, buildCalendarPayload, detectCalendarPlatform, isCalendarAddBusy,
} from "../../lib/calendarAdd";
import type { CalReservation } from "../../lib/mypage";

const r = {
  id: "r1", title: "필라테스", centerName: "노는반", profileName: "손", memo: "물통", status: "confirmed",
  date: "2026-09-05", time: "11:44", startIso: "2026-09-05T02:44:00+00:00", endIso: "2026-09-05T03:44:00+00:00",
} as unknown as CalReservation;

beforeEach(() => { plugin.addEvent.mockReset(); plugin.shareIcs.mockReset(); exportIcsMock.mockReset(); });

describe("detectCalendarPlatform", () => {
  it("네이티브 + 플러그인 등록 → ios/android, 플러그인 없는 구버전 앱/웹 → web(ICS fallback)", () => {
    expect(detectCalendarPlatform(true, "ios", true)).toBe("ios");
    expect(detectCalendarPlatform(true, "android", true)).toBe("android");
    expect(detectCalendarPlatform(true, "ios", false)).toBe("web");
    expect(detectCalendarPlatform(false, "web", false)).toBe("web");
  });
});

describe("buildCalendarPayload — 제목/시간/timezone/메모", () => {
  it("제목은 수업명 · 센터명, 위치는 센터명, 메모/예약자 포함", () => {
    const p = buildCalendarPayload(r);
    expect(p.title).toBe("필라테스 · 노는반");
    expect(p.location).toBe("노는반");
    expect(p.notes).toContain("메모: 물통");
    expect(p.notes).toContain("예약자: 손");
  });
  it("시간은 절대 시각(epoch ms) — 02:44Z = KST 11:44, 기기 시간대와 무관(9시간 밀림 없음)", () => {
    const p = buildCalendarPayload(r);
    expect(p.startMs).toBe(Date.UTC(2026, 8, 5, 2, 44));
    expect(p.endMs - p.startMs).toBe(60 * 60 * 1000);
    const kst = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(p.startMs));
    expect(kst).toBe(r.time);
  });
  it("종료 시각이 없거나 시작과 같으면 1시간으로(길이 0 일정 방지)", () => {
    const p = buildCalendarPayload({ ...r, endIso: r.startIso });
    expect(p.endMs - p.startMs).toBe(3600000);
  });
  it("시작 시각이 잘못되면 throw", () => {
    expect(() => buildCalendarPayload({ ...r, startIso: "bad" })).toThrow();
  });
});

describe("플랫폼 dispatch", () => {
  it("Android 기본 캘린더 → addEvent(chooser=false)", async () => {
    plugin.addEvent.mockResolvedValue({});
    const res = await addReservationToCalendar(r, "default", "android");
    expect(plugin.addEvent).toHaveBeenCalledWith(expect.objectContaining({ title: "필라테스 · 노는반", chooser: false }));
    expect(res.kind).toBe("opened");
  });
  it("Android 다른 앱 선택 → addEvent(chooser=true)", async () => {
    plugin.addEvent.mockResolvedValue({});
    await addReservationToCalendar(r, "chooser", "android");
    expect(plugin.addEvent).toHaveBeenCalledWith(expect.objectContaining({ chooser: true }));
  });
  it("iOS 기본 캘린더: 저장 → saved, 취소 → cancelled(가짜 성공 없음)", async () => {
    plugin.addEvent.mockResolvedValueOnce({ result: "saved" });
    expect((await addReservationToCalendar(r, "default", "ios")).kind).toBe("saved");
    plugin.addEvent.mockResolvedValueOnce({ result: "canceled" });
    expect((await addReservationToCalendar(r, "default", "ios")).kind).toBe("cancelled");
    expect(plugin.shareIcs).not.toHaveBeenCalled();
  });
  it("iOS 다른 앱 선택 → Share Sheet(.ics)만, 기본 캘린더 화면은 열지 않는다", async () => {
    plugin.shareIcs.mockResolvedValue({ completed: true });
    const res = await addReservationToCalendar(r, "chooser", "ios");
    expect(plugin.addEvent).not.toHaveBeenCalled();
    expect(plugin.shareIcs.mock.calls[0][0].ics).toContain("BEGIN:VEVENT");
    expect(res.kind).toBe("shared");
  });
  it("iOS 접근 거부/미지원이면 막히지 않고 Share Sheet(.ics)로 전환", async () => {
    plugin.addEvent.mockRejectedValue(new Error("캘린더 접근이 허용되지 않았어요"));
    plugin.shareIcs.mockResolvedValue({ completed: true });
    expect((await addReservationToCalendar(r, "default", "ios")).kind).toBe("shared");
  });
  it("웹/구버전 앱 → 기존 exportIcs(ICS 생성 코드 유지)", async () => {
    exportIcsMock.mockResolvedValue("downloaded");
    const res = await addReservationToCalendar(r, "default", "web");
    expect(exportIcsMock).toHaveBeenCalledTimes(1);
    expect(plugin.addEvent).not.toHaveBeenCalled();
    expect(res.kind).toBe("shared");
  });
  it("실패는 그대로 throw — 성공처럼 삼키지 않는다", async () => {
    plugin.addEvent.mockRejectedValue(new Error("일정을 추가할 수 있는 캘린더 앱이 없어요"));
    await expect(addReservationToCalendar(r, "default", "android")).rejects.toThrow("캘린더 앱이 없어요");
  });
  it("여러 건 파일 내보내기: iOS는 Share Sheet, 그 외는 exportIcs", async () => {
    plugin.shareIcs.mockResolvedValue({ completed: true });
    await addReservationsAsFile([r, { ...r, id: "r2" }], "a.ics", "ios");
    expect(plugin.shareIcs).toHaveBeenCalledTimes(1);
    exportIcsMock.mockResolvedValue("shared");
    await addReservationsAsFile([r], "a.ics", "android");
    expect(exportIcsMock).toHaveBeenCalledTimes(1);
  });
});

describe("중복 실행 방지(in-flight lock)", () => {
  it("같은 예약을 빠르게 두 번 누르면 두 번째는 거부되고 네이티브 화면은 한 번만 열린다", async () => {
    let release: (v: unknown) => void = () => {};
    plugin.addEvent.mockImplementation(() => new Promise((res) => { release = res; }));
    const first = addReservationToCalendar(r, "default", "android");
    expect(isCalendarAddBusy("one:r1")).toBe(true);
    await expect(addReservationToCalendar(r, "default", "android")).rejects.toThrow("이미");
    release({});
    await first;
    expect(plugin.addEvent).toHaveBeenCalledTimes(1);
    expect(isCalendarAddBusy("one:r1")).toBe(false);
  });
});
