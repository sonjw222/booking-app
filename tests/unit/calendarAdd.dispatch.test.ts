/*
  캘린더 추가 플랫폼 분기(회원/관리자 공용 서비스) — 네이티브 플러그인은 vi.mock으로 대체.
  실기기 동작은 별도 체크리스트.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const { plugin, exportIcsStringMock } = vi.hoisted(() => ({
  plugin: { addEvent: vi.fn(), addEvents: vi.fn(), openIcs: vi.fn(), shareIcs: vi.fn() },
  exportIcsStringMock: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  registerPlugin: () => plugin,
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web", isPluginAvailable: () => false },
}));
vi.mock("../../lib/mypage", async (orig) => {
  const actual = await orig<typeof import("../../lib/mypage")>();
  return { ...actual, exportIcsString: (...a: unknown[]) => exportIcsStringMock(...a) };
});

import { addCalendarEvents, describeCalendarResult, detectCalendarPlatform, isCalendarAddBusy } from "../../lib/calendarAdd";
import { holidaysToEvents, reservationToEvent } from "../../lib/calendarEvents";
import type { CalReservation } from "../../lib/mypage";

const mk = (id: string, date = "2026-09-05"): CalReservation => ({
  id, title: "필라테스", centerName: "노는반", profileName: "손", memo: "물통", status: "confirmed",
  date, time: "11:44", startIso: `${date}T02:44:00+00:00`, endIso: `${date}T03:44:00+00:00`,
} as unknown as CalReservation);
const one = [reservationToEvent(mk("r1"))];
const many = [reservationToEvent(mk("r1")), reservationToEvent(mk("r2", "2026-09-06")), ...holidaysToEvents(["2026-09-10"], "c1", "노는반")];

beforeEach(() => { for (const f of Object.values(plugin)) f.mockReset(); exportIcsStringMock.mockReset(); });

describe("detectCalendarPlatform", () => {
  it("네이티브 + 플러그인 등록 → ios/android, 플러그인 없는 구버전 앱/웹 → web(ICS fallback)", () => {
    expect(detectCalendarPlatform(true, "ios", true)).toBe("ios");
    expect(detectCalendarPlatform(true, "android", true)).toBe("android");
    expect(detectCalendarPlatform(true, "ios", false)).toBe("web");
    expect(detectCalendarPlatform(false, "web", false)).toBe("web");
  });
});

describe("Android", () => {
  it("1건 기본 → addEvent(chooser=false), 1건 다른 앱 → addEvent(chooser=true)", async () => {
    plugin.addEvent.mockResolvedValue({});
    expect((await addCalendarEvents(one, "default", "android")).kind).toBe("opened");
    expect(plugin.addEvent).toHaveBeenLastCalledWith(expect.objectContaining({ title: "필라테스 · 노는반", chooser: false, allDay: false }));
    await addCalendarEvents(one, "chooser", "android");
    expect(plugin.addEvent).toHaveBeenLastCalledWith(expect.objectContaining({ chooser: true }));
  });
  it("여러 건은 여러 VEVENT의 .ics를 openIcs(default=chooser false / 다른 앱=chooser true)로", async () => {
    plugin.openIcs.mockResolvedValue({});
    await addCalendarEvents(many, "default", "android");
    const arg = plugin.openIcs.mock.calls[0][0];
    expect((arg.ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(3);
    expect(arg.chooser).toBe(false);
    await addCalendarEvents(many, "chooser", "android");
    expect(plugin.openIcs.mock.calls[1][0].chooser).toBe(true);
    expect(plugin.addEvent).not.toHaveBeenCalled();
  });
  it("하루 종일(휴무일) 1건은 allDay + UTC 자정 시작/종료(exclusive)", async () => {
    plugin.addEvent.mockResolvedValue({});
    await addCalendarEvents(holidaysToEvents(["2026-09-10", "2026-09-11"], "c1", "노는반"), "default", "android");
    const p = plugin.addEvent.mock.calls[0][0];
    expect(p.allDay).toBe(true);
    expect(p.startMs).toBe(Date.UTC(2026, 8, 10));
    expect(p.endMs).toBe(Date.UTC(2026, 8, 12)); // 9/10~9/11 → exclusive 9/12
  });
});

describe("iOS", () => {
  it("1건 기본: 편집 화면 저장 → saved(1), 취소 → cancelled", async () => {
    plugin.addEvent.mockResolvedValueOnce({ result: "saved" });
    expect(await addCalendarEvents(one, "default", "ios")).toEqual({ kind: "saved", saved: 1, failed: 0 });
    plugin.addEvent.mockResolvedValueOnce({ result: "canceled" });
    expect((await addCalendarEvents(one, "default", "ios")).kind).toBe("cancelled");
    expect(plugin.openIcs).not.toHaveBeenCalled();
  });
  it("여러 건 기본 → addEvents batch, 성공/실패 개수를 그대로 돌려준다", async () => {
    plugin.addEvents.mockResolvedValue({ saved: 2, failed: 1 });
    const res = await addCalendarEvents(many, "default", "ios");
    expect(plugin.addEvents.mock.calls[0][0].events).toHaveLength(3);
    expect(res).toEqual({ kind: "saved", saved: 2, failed: 1 });
    expect(plugin.addEvent).not.toHaveBeenCalled();
  });
  it("batch 전부 실패(saved=0)는 성공으로 처리하지 않고 throw", async () => {
    plugin.addEvents.mockResolvedValue({ saved: 0, failed: 3 });
    await expect(addCalendarEvents(many, "default", "ios")).rejects.toThrow("추가하지 못했어요");
  });
  it("권한 거부(DENIED) → 안내 메시지로 throw(가짜 성공/조용한 무시 없음)", async () => {
    plugin.addEvents.mockRejectedValue(Object.assign(new Error("denied"), { code: "DENIED" }));
    await expect(addCalendarEvents(many, "default", "ios")).rejects.toThrow("권한");
  });
  it("다른 앱 선택 → openIcs(.ics, Open In→Share)만 사용하고 기본 캘린더 화면/batch는 열지 않는다", async () => {
    plugin.openIcs.mockResolvedValue({ completed: true, method: "openIn" });
    expect((await addCalendarEvents(many, "chooser", "ios")).kind).toBe("shared");
    expect(plugin.addEvents).not.toHaveBeenCalled();
    expect(plugin.addEvent).not.toHaveBeenCalled();
    plugin.openIcs.mockResolvedValue({ completed: false });
    expect((await addCalendarEvents(one, "chooser", "ios")).kind).toBe("cancelled");
  });
  it("1건 기본 캘린더가 접근 거부면 막히지 않고 openIcs로 전환", async () => {
    plugin.addEvent.mockRejectedValue(new Error("캘린더 접근이 허용되지 않았어요"));
    plugin.openIcs.mockResolvedValue({ completed: true });
    expect((await addCalendarEvents(one, "default", "ios")).kind).toBe("shared");
  });
});

describe("웹/구버전 앱", () => {
  it("ICS 직렬화 → exportIcsString(기존 ICS fallback)", async () => {
    exportIcsStringMock.mockResolvedValue("downloaded");
    const res = await addCalendarEvents(many, "default", "web");
    expect(res.kind).toBe("shared");
    expect(exportIcsStringMock.mock.calls[0][0]).toContain("BEGIN:VCALENDAR");
    expect(plugin.addEvent).not.toHaveBeenCalled();
  });
});

describe("결과 문구 / 실패 / 중복 실행", () => {
  it("문구는 실제 확인된 저장 결과에만 — 전부/일부/그 외", () => {
    expect(describeCalendarResult({ kind: "saved", saved: 5, failed: 0 })).toBe("5개의 일정이 캘린더에 추가됐어요");
    expect(describeCalendarResult({ kind: "saved", saved: 3, failed: 2 })).toBe("3개의 일정을 추가했고 2개는 추가하지 못했어요");
    expect(describeCalendarResult({ kind: "opened" })).toBeNull();
    expect(describeCalendarResult({ kind: "cancelled" })).toBeNull();
  });
  it("실패는 그대로 throw, 빈 선택은 거부", async () => {
    plugin.addEvent.mockRejectedValue(new Error("일정을 추가할 수 있는 캘린더 앱이 없어요"));
    await expect(addCalendarEvents(one, "default", "android")).rejects.toThrow("캘린더 앱이 없어요");
    await expect(addCalendarEvents([], "default", "android")).rejects.toThrow("선택");
  });
  it("빠르게 두 번 누르면 두 번째는 거부되고 네이티브 화면은 한 번만 열린다", async () => {
    let release: (v: unknown) => void = () => {};
    plugin.addEvent.mockImplementation(() => new Promise((res) => { release = res; }));
    const first = addCalendarEvents(one, "default", "android");
    expect(isCalendarAddBusy()).toBe(true);
    await expect(addCalendarEvents(many, "default", "android")).rejects.toThrow("이미");
    release({});
    await first;
    expect(plugin.addEvent).toHaveBeenCalledTimes(1);
    expect(plugin.openIcs).not.toHaveBeenCalled();
    expect(isCalendarAddBusy()).toBe(false);
  });
});
