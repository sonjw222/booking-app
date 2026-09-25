/*
  캘린더 이벤트 공용 모델 — 월 필터, 선택 로직, 회원/관리자 매퍼, 휴무일 all-day, ICS.
*/
import { describe, expect, it } from "vitest";
import {
  addDays, calendarEventsToIcs, classToEvent, filterEventsByMonth, holidaysToEvents, pickSelected,
  reservationToEvent, selectAll, selectNone, toggleSelection, toNativePayload,
} from "../../lib/calendarEvents";
import { reservationsToIcs, type CalReservation } from "../../lib/mypage";
import type { ManagedClass } from "../../lib/classes";

const res = (id: string, date: string, time = "11:44"): CalReservation => ({
  id, title: "필라테스", centerName: "노는반", profileName: "", memo: null, status: "confirmed",
  date, time, startIso: `${date}T02:44:00+00:00`, endIso: `${date}T03:44:00+00:00`,
} as unknown as CalReservation);

const cls = (over: Partial<ManagedClass> = {}): ManagedClass => ({
  id: "k1", title: "피겨 기초", description: null, date: "2026-09-05", start: "11:00", end: "12:00",
  capacity: 8, reserved: 3, recurringGroupId: null, allowGoods: false, allowCancel: true, roomId: null,
  cancelDeadlineMin: null, bookingDeadlineMin: null, classFormat: "group", status: "open",
  passSelectionMode: "all", instructorNames: ["김코치"], ...over,
});

describe("표시 중인 월 필터", () => {
  const items = [res("a", "2026-08-31"), res("b", "2026-09-01"), res("c", "2026-09-30"), res("d", "2026-10-01")].map(reservationToEvent);
  it("9월 화면 → 9월 일정만(8월/10월 제외)", () => {
    expect(filterEventsByMonth(items, 2026, 9).map((e) => e.id)).toEqual(["res-b", "res-c"]);
  });
  it("월 이동 후 다시 계산 — 10월 화면 → 10월만", () => {
    expect(filterEventsByMonth(items, 2026, 10).map((e) => e.id)).toEqual(["res-d"]);
  });
  it("일정 없는 달은 빈 배열(empty state)", () => {
    expect(filterEventsByMonth(items, 2026, 11)).toEqual([]);
  });
  it("날짜/시간 순 정렬", () => {
    const list = [res("z", "2026-09-05", "15:00"), res("y", "2026-09-05", "09:00"), res("x", "2026-09-02")].map(reservationToEvent);
    expect(filterEventsByMonth(list, 2026, 9).map((e) => e.id)).toEqual(["res-x", "res-y", "res-z"]);
  });
});

describe("선택 로직(전체 선택/해제/개수)", () => {
  const items = ["a", "b", "c"].map((id) => reservationToEvent(res(id, "2026-09-05")));
  it("전체 선택 → 모두, 전체 해제 → 0", () => {
    expect(selectAll(items).size).toBe(3);
    expect(selectNone().size).toBe(0);
  });
  it("개별 토글, 선택된 개수, 원래 순서로 pick", () => {
    let sel = selectNone();
    sel = toggleSelection(sel, "res-c");
    sel = toggleSelection(sel, "res-a");
    expect(sel.size).toBe(2);
    expect(pickSelected(items, sel).map((e) => e.id)).toEqual(["res-a", "res-c"]);
    sel = toggleSelection(sel, "res-a");
    expect(pickSelected(items, sel).map((e) => e.id)).toEqual(["res-c"]);
  });
});

describe("회원 예약 → 이벤트/ICS", () => {
  it("제목·위치·시간(KST 11:44 = 02:44Z), 종료 없으면 1시간", () => {
    const e = reservationToEvent({ ...res("a", "2026-09-05"), endIso: "2026-09-05T02:44:00+00:00" });
    expect(e.title).toBe("필라테스 · 노는반");
    const p = toNativePayload(e);
    expect(p.startMs).toBe(Date.UTC(2026, 8, 5, 2, 44));
    expect(p.endMs - p.startMs).toBe(3600000);
    expect(p.location).toBe("노는반");
  });
  it("여러 일정 → 하나의 VCALENDAR 안에 여러 VEVENT + UID/DTSTART/DTEND/SUMMARY/LOCATION/DESCRIPTION", () => {
    const ics = reservationsToIcs([res("a", "2026-09-05"), res("b", "2026-09-06")]);
    expect((ics.match(/BEGIN:VCALENDAR/g) ?? []).length).toBe(1);
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect(ics).toContain("UID:res-a@woori-class");
    expect(ics).toContain("UID:res-b@woori-class");
    expect(ics).toContain("DTSTART:20260905T024400Z");
    expect(ics).toContain("DTEND:20260905T034400Z");
    expect(ics).toContain("SUMMARY:필라테스 · 노는반");
    expect(ics).toContain("LOCATION:노는반");
    expect(ics).toContain("DESCRIPTION:");
    expect(new Set(ics.match(/UID:[^\r\n]+/g)).size).toBe(2); // UID 중복 없음
  });
  it("세미콜론/쉼표/줄바꿈은 이스케이프", () => {
    const e = { ...reservationToEvent(res("a", "2026-09-05")), title: "a,b;c\nd" };
    expect(calendarEventsToIcs([e])).toContain(String.raw`SUMMARY:a\,b\;c\nd`);
  });
});

describe("관리자 수업 → 이벤트", () => {
  it("제목 '수업명 · 센터명', 위치=룸 주소 우선(없으면 센터명), 강사/룸/정원 메모, KST 11:00 = 02:00Z", () => {
    const e = classToEvent(cls(), { centerName: "어텐션 피겨팀", roomName: "A룸", roomAddress: "서울 어딘가 1" });
    expect(e.title).toBe("피겨 기초 · 어텐션 피겨팀");
    expect(e.location).toBe("서울 어딘가 1");
    expect(e.notes).toContain("강사: 김코치");
    expect(e.notes).toContain("룸: A룸");
    expect(e.kind).toBe("class");
    const p = toNativePayload(e);
    expect(p.startMs).toBe(Date.UTC(2026, 8, 5, 2, 0));
    expect(p.endMs).toBe(Date.UTC(2026, 8, 5, 3, 0));
    expect(classToEvent(cls(), { centerName: "어텐션 피겨팀" }).location).toBe("어텐션 피겨팀");
  });
  it("자정을 넘기는 수업(23:00→01:00)은 종료가 다음 날", () => {
    const p = toNativePayload(classToEvent(cls({ start: "23:00", end: "01:00" }), { centerName: "센터" }));
    expect(p.endMs - p.startMs).toBe(2 * 3600000);
  });
  it("센터 scope: 센터명이 title/centerName에 그대로 들어가 여러 센터 일정을 구분", () => {
    const a = classToEvent(cls({ id: "1" }), { centerName: "센터A" });
    const b = classToEvent(cls({ id: "2" }), { centerName: "센터B" });
    expect([a.centerName, b.centerName]).toEqual(["센터A", "센터B"]);
    expect(a.id).not.toBe(b.id);
  });
  it("현재 월 필터: 수업+휴무일이 함께 있어도 해당 월만", () => {
    const items = [
      classToEvent(cls({ id: "1", date: "2026-09-05" }), { centerName: "센터" }),
      classToEvent(cls({ id: "2", date: "2026-10-05" }), { centerName: "센터" }),
      ...holidaysToEvents(["2026-09-20", "2026-10-03"], "c", "센터"),
    ];
    expect(filterEventsByMonth(items, 2026, 9).map((e) => e.kind)).toEqual(["class", "holiday"]);
  });
});

describe("센터 휴무일 all-day", () => {
  it("하루 휴무 → 다음 날이 exclusive end", () => {
    const [h] = holidaysToEvents(["2026-09-10"], "c1", "어텐션 피겨팀");
    expect(h.title).toBe("어텐션 피겨팀 휴무일");
    expect(h.allDay).toBe(true);
    expect(h.startDay).toBe("2026-09-10");
    expect(h.endDayExclusive).toBe("2026-09-11");
  });
  it("연속 3일 → 하나의 기간(마지막 날 + 1일이 exclusive end)", () => {
    const list = holidaysToEvents(["2026-09-12", "2026-09-10", "2026-09-11", "2026-09-20"], "c1", "센터");
    expect(list).toHaveLength(2);
    expect(list[0].startDay).toBe("2026-09-10");
    expect(list[0].endDayExclusive).toBe("2026-09-13");
    expect(list[1].startDay).toBe("2026-09-20");
    expect(list[1].endDayExclusive).toBe("2026-09-21");
  });
  it("월말 경계/윤년 날짜 계산(UTC 산술)", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("ICS: VALUE=DATE, DTEND는 exclusive, UTC 'Z' 없음", () => {
    const ics = calendarEventsToIcs(holidaysToEvents(["2026-09-10", "2026-09-11"], "c1", "센터"));
    expect(ics).toContain("DTSTART;VALUE=DATE:20260910");
    expect(ics).toContain("DTEND;VALUE=DATE:20260912");
    expect(ics).toContain("SUMMARY:센터 휴무일");
  });
  it("UI 구분용 타입 + 다른 센터 휴무일은 서로 다른 UID", () => {
    const a = holidaysToEvents(["2026-09-10"], "c1", "A")[0];
    const b = holidaysToEvents(["2026-09-10"], "c2", "B")[0];
    expect(a.kind).toBe("holiday");
    expect(a.id).not.toBe(b.id);
  });
});
