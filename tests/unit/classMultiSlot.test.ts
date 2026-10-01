/*
  수업 등록 "한 날 여러 타임"(2026-10-02) — 슬롯 순수 로직, 생성 payload(단일 날짜/반복/요일별), 그룹 정책, 화면 연결.
  DB 변경 없음: 여러 class row를 create_recurring_classes_safe 한 번(=한 트랜잭션)으로 만든다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
vi.mock("../../lib/supabaseClient", () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

import {
  addSlot, allSlots, countClasses, countPerDayClasses, makeSlot, nextSlotTimes, removeSlot, updateSlot, validateSlots, MAX_TIME_SLOTS,
} from "../../lib/classTimeSlots";
import {
  buildGroupUpdates, createClassOnDateSlots, createRecurringClasses, createRecurringClassesPerDay, expandRecurringDates,
  hasMultiSlotDates, type ClassInput,
} from "../../lib/classes";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const page = read("app/manager/classes/page.tsx");

const base: ClassInput = { title: "정규반", description: "소개", date: "2026-10-10", start: "10:00", end: "11:00", capacity: 8, allowGoods: true, allowCancel: true, roomId: "r1", cancelDeadlineMin: 60, bookingDeadlineMin: null, classFormat: "group" };
const rowsOf = () => rpcMock.mock.calls[0][1].p_rows as any[];
const hhmm = (iso: string) => iso.slice(11, 16);

beforeEach(() => { rpcMock.mockReset(); rpcMock.mockImplementation(async (_n: string, args: any) => ({ data: (args.p_rows ?? []).map((_: unknown, i: number) => `id${i}`), error: null })); });

describe("[1~4] 슬롯 상태: 기본 1개, 추가, 삭제, 마지막 유지", () => {
  const first = { start: "10:00", end: "11:00" };
  it("기본은 첫 슬롯 1개(추가 슬롯 없음)", () => {
    expect(allSlots(first, [])).toEqual([first]);
    expect(allSlots(first, undefined)).toHaveLength(1);
  });
  it("시간 추가: 직전 슬롯 종료 시각부터 1시간, 계속 추가해도 독립 슬롯", () => {
    let extra = addSlot([], first);
    expect(extra.map((s) => [s.start, s.end])).toEqual([["11:00", "12:00"]]);
    extra = addSlot(extra, first);
    expect(extra.map((s) => s.start)).toEqual(["11:00", "12:00"]);
    extra = updateSlot(extra, extra[0].id, { start: "13:00", end: "14:00" });
    expect(extra[0]).toMatchObject({ start: "13:00", end: "14:00" });
    expect(extra[1].start).toBe("12:00");
    expect(nextSlotTimes({ start: "22:00", end: "23:30" })).toEqual({ start: "22:00", end: "23:00" });
    expect(nextSlotTimes(undefined)).toEqual({ start: "10:00", end: "11:00" });
  });
  it("삭제는 추가 슬롯만 지우고 첫(기본) 슬롯은 항상 남는다", () => {
    const extra = addSlot(addSlot([], first), first);
    const left = removeSlot(extra, extra[0].id);
    expect(left).toHaveLength(1);
    expect(allSlots(first, removeSlot(left, left[0].id))).toEqual([first]);
  });
  it("최대 타임 수를 넘겨 추가하지 않는다", () => {
    let extra: ReturnType<typeof addSlot> = [];
    for (let i = 0; i < 30; i++) extra = addSlot(extra, first);
    expect(extra.length + 1).toBe(MAX_TIME_SLOTS);
  });
});

describe("[9][10] 슬롯 검증", () => {
  it("각 슬롯에 기존 시간 범위 검증(11:00~10:00 거부, 자정 넘김 6시간 이내 허용)", () => {
    expect(validateSlots([{ start: "10:00", end: "11:00" }, { start: "15:00", end: "14:00" }])).toContain("시간 2");
    expect(validateSlots([{ start: "23:00", end: "01:00" }])).toBeNull();
    expect(validateSlots([{ start: "10:00", end: "" }])).toContain("입력");
  });
  it("완전히 같은 슬롯은 막고 일부 겹침(10:00~11:00 + 10:30~11:30)은 기존 충돌 정책대로 허용", () => {
    expect(validateSlots([{ start: "10:00", end: "11:00" }, { start: "10:00", end: "11:00" }])).toContain("두 번");
    expect(validateSlots([{ start: "10:00", end: "11:00" }, { start: "10:30", end: "11:30" }])).toBeNull();
    expect(validateSlots([{ start: "10:00", end: "11:00" }, { start: "10:00", end: "11:00" }], "화요일")).toContain("화요일");
  });
});

describe("[5] 단일 날짜 + 슬롯 2개 → 수업 2개(한 트랜잭션)", () => {
  it("한 번의 RPC로 같은 날짜에 row 2개, 같은 그룹 id, 공통 설정 복제", async () => {
    const ids = await createClassOnDateSlots("c1", base, [{ start: "10:00", end: "11:00" }, { start: "15:00", end: "16:00" }]);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][0]).toBe("create_recurring_classes_safe");
    const rows = rowsOf();
    expect(rows).toHaveLength(2);
    expect(ids).toHaveLength(2);
    expect(rows.map((r) => hhmm(r.start_time))).toEqual(["10:00", "15:00"]);
    expect(new Set(rows.map((r) => r.start_time.slice(0, 10))).size).toBe(1);
    expect(new Set(rows.map((r) => r.recurring_group_id)).size).toBe(1);
    expect(rows.every((r) => r.title === "정규반" && r.description === "소개" && r.capacity === 8 && r.room_id === "r1" && r.allow_goods === true)).toBe(true);
  });
  it("프라이빗/취소 불가 수업은 순차 생성 + 중간 실패 시 이미 만든 수업을 삭제(일부만 남지 않음)", async () => {
    let created = 0;
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "create_class_safe") { created += 1; return created === 2 ? { data: null, error: { message: "P0001: boom" } } : { data: `c${created}`, error: null }; }
      return { data: null, error: null };   // delete_class_safe
    });
    await expect(createClassOnDateSlots("c1", { ...base, classFormat: "private" }, [{ start: "10:00", end: "11:00" }, { start: "12:00", end: "13:00" }])).rejects.toThrow("boom");
    expect(rpcMock.mock.calls.filter((c) => c[0] === "delete_class_safe").map((c) => c[1].p_class_id)).toEqual(["c1"]);
  });
});

describe("[6][8][11] 반복 등록: 날짜 × 슬롯, 휴무일, 단일 타임 회귀", () => {
  const rep = { title: "정규반", daysOfWeek: [2, 4], fromDate: "2026-10-05", toDate: "2026-10-18", start: "10:00", end: "11:00", capacity: 8 };
  it("반복 날짜 5개 + 슬롯 2개 → 10개(전부 같은 recurring_group_id)", async () => {
    const dates = expandRecurringDates("2026-10-05", "2026-11-01", [2]).slice(0, 4).concat(expandRecurringDates("2026-10-05", "2026-11-01", [4]).slice(0, 1));
    expect(dates).toHaveLength(5);
    await createRecurringClasses("c1", { ...rep, daysOfWeek: [2, 4], fromDate: "2026-10-05", toDate: "2026-10-09", slots: [{ start: "10:00", end: "11:00" }, { start: "14:00", end: "15:00" }] });
    // 10/5~10/9 중 화·목 = 10/6, 10/8 → 2날짜 × 2슬롯 = 4
    expect(rowsOf()).toHaveLength(4);
    const big = await (async () => { rpcMock.mockClear(); await createRecurringClasses("c1", { ...rep, daysOfWeek: [1, 2, 3, 4, 5], fromDate: "2026-10-05", toDate: "2026-10-09", slots: [{ start: "10:00", end: "11:00" }, { start: "14:00", end: "15:00" }] }); return rowsOf(); })();
    expect(big).toHaveLength(10);   // 평일 5일 × 2
    expect(new Set(big.map((r) => r.recurring_group_id)).size).toBe(1);
  });
  it("휴무일 제외 후 생성 수 = (남은 날짜) × 슬롯", async () => {
    await createRecurringClasses("c1", { ...rep, fromDate: "2026-10-05", toDate: "2026-10-18", excludeDates: new Set(["2026-10-06"]), slots: [{ start: "10:00", end: "11:00" }, { start: "14:00", end: "15:00" }] });
    // 화 10/6(휴무)·10/13, 목 10/8·10/15 → 3날짜 × 2
    expect(rowsOf()).toHaveLength(6);
    expect(countClasses(3, 2)).toBe(6);
  });
  it("[11][12] 슬롯을 안 주면 기존 단일 타임 반복과 완전히 동일(날짜 수만큼, 같은 시각)", async () => {
    await createRecurringClasses("c1", rep);
    const rows = rowsOf();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => hhmm(r.start_time) === "10:00" && hhmm(r.end_time) === "11:00")).toBe(true);
    expect(new Set(rows.map((r) => r.recurring_group_id)).size).toBe(1);
  });
  it("슬롯 하나라도 범위가 잘못되면 호출 전에 거부(아무것도 생성하지 않음)", async () => {
    await expect(createRecurringClasses("c1", { ...rep, slots: [{ start: "10:00", end: "11:00" }, { start: "15:00", end: "14:00" }] })).rejects.toThrow("종료시간");
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("[4-요일별][7][13] 요일별로 다르게 + 다중 타임", () => {
  const perDay = (days: any[]) => ({ title: "정규반", fromDate: "2026-10-05", toDate: "2026-10-18", days });
  it("화 2타임 · 목 1타임: 요일마다 개수가 달라도 정확히 생성, 요일별 정원/룸 우선, 전체가 한 그룹", async () => {
    await createRecurringClassesPerDay("c1", perDay([
      { dow: 2, start: "10:00", end: "11:00", capacity: 8, roomId: "r1", slots: [{ start: "10:00", end: "11:00" }, { start: "14:00", end: "15:00" }] },
      { dow: 4, start: "18:00", end: "19:00", capacity: 6, roomId: "r2" },
    ]));
    const rows = rowsOf();
    // 화 2날짜 × 2 + 목 2날짜 × 1
    expect(rows).toHaveLength(6);
    const tue = rows.filter((r) => r.capacity === 8);
    const thu = rows.filter((r) => r.capacity === 6);
    expect(tue.map((r) => hhmm(r.start_time)).sort()).toEqual(["10:00", "10:00", "14:00", "14:00"].map((t) => t));
    expect(thu.map((r) => hhmm(r.start_time))).toEqual(["18:00", "18:00"]);
    expect(thu.every((r) => r.room_id === "r2")).toBe(true);
    expect(new Set(rows.map((r) => r.recurring_group_id)).size).toBe(1);
    expect(countPerDayClasses([{ dateCount: 2, slotCount: 2 }, { dateCount: 2, slotCount: 1 }])).toBe(6);
  });
  it("[13] 슬롯 없는 기존 요일별 단일 시간 데이터는 그대로 동작", async () => {
    await createRecurringClassesPerDay("c1", perDay([{ dow: 2, start: "20:00", end: "21:00", capacity: 8 }, { dow: 4, start: "18:00", end: "19:30", capacity: 6 }]));
    expect(rowsOf()).toHaveLength(4);
    expect(rowsOf().map((r) => hhmm(r.start_time)).sort()).toEqual(["18:00", "18:00", "20:00", "20:00"]);
  });
});

describe("[14][17][18] 그룹 정책과 '모든 반복 수업에 적용' 안전성", () => {
  // 같은 날 2타임 그룹: 화 10:00 / 화 14:00 (KST) ×2주
  const kst = (d: string, t: string) => new Date(`${d}T${t}:00+09:00`).toISOString();
  const rows = [
    { id: "a1", start_time: kst("2026-10-06", "10:00"), end_time: kst("2026-10-06", "11:00") },
    { id: "b1", start_time: kst("2026-10-06", "14:00"), end_time: kst("2026-10-06", "15:00") },
    { id: "a2", start_time: kst("2026-10-13", "10:00"), end_time: kst("2026-10-13", "11:00") },
    { id: "b2", start_time: kst("2026-10-13", "14:00"), end_time: kst("2026-10-13", "15:00") },
  ];
  it("같은 날 여러 타임 그룹은 multi-slot으로 인식", () => {
    expect(hasMultiSlotDates(rows)).toBe(true);
    expect(hasMultiSlotDates([rows[0], rows[2]])).toBe(false);
  });
  it("공통 필드(제목/소개 등) 전체 적용은 모든 타임에 반영되고 각 타임의 시간은 유지", () => {
    const u = buildGroupUpdates(rows, { changes: { description: "새 소개" } });
    expect(u.every((x) => x.description === "새 소개")).toBe(true);
    expect(u.map((x, i) => x.start_time === rows[i].start_time)).toEqual([true, true, true, true]);
  });
  it("'시간도 함께 변경' ON이어도 같은 날 다른 타임의 시간을 덮어쓰지 않는다(편집한 타임 시리즈만 변경)", () => {
    const u = buildGroupUpdates(rows, { time: { start: "09:00", end: "10:00", only: { start: "10:00", end: "11:00" } }, changes: {} });
    const t = (i: number) => hhmm(u[i].start_time);
    expect([u[0].start_time, u[2].start_time]).toEqual(["2026-10-06T09:00:00+09:00", "2026-10-13T09:00:00+09:00"]);   // 10:00 타임만 → 09:00
    expect(u[1].start_time).toBe(rows[1].start_time);   // 14:00 타임 유지
    expect(u[3].start_time).toBe(rows[3].start_time);
    expect(t(1)).toBe("05:00");   // (UTC 표기) 14:00 KST 그대로
  });
  it("단일 타임 그룹(월 20:00/수 18:00)의 기존 '시간도 함께 변경' 동작은 그대로(모든 수업 시각 변경)", () => {
    const single = [
      { id: "m1", start_time: kst("2026-10-05", "20:00"), end_time: kst("2026-10-05", "21:00") },
      { id: "w1", start_time: kst("2026-10-07", "18:00"), end_time: kst("2026-10-07", "19:00") },
    ];
    const u = buildGroupUpdates(single, { time: { start: "19:00", end: "20:00", only: { start: "20:00", end: "21:00" } }, changes: {} });
    expect(u.map((x) => x.start_time)).toEqual(["2026-10-05T19:00:00+09:00", "2026-10-07T19:00:00+09:00"]);
  });
  it("한 등록 작업의 모든 수업(모든 요일·모든 타임)이 하나의 recurring_group_id를 갖는다(위 생성 테스트에서 확인)", () => {
    expect(read("lib/classes.ts")).toContain("recurring_group_id: groupId");
  });
  it("화면은 편집 중인 수업의 원래 시각을 only로 넘긴다", () => {
    expect(page).toContain("only: orig ? { start: orig.start, end: orig.end } : undefined");
  });
});

describe("[15][16] 화면 연결: 모든 생성 수업에 강사/수강권, 개수 미리보기, 수정 화면 불변", () => {
  it("반복 등록은 반환된 모든 id에 수강권/강사를 bulk 적용(기존 코드 재사용)", () => {
    expect(page).toContain("await setClassProductsBulk(ids, resolved.productIds)");
    expect(page).toContain("await setClassTrainersBulk(ids, selectedTrainers)");
  });
  it("단일 날짜 다중 타임도 생성된 모든 id에 bulk 적용", () => {
    expect(page).toContain("await setClassProductsBulk(newIds, resolved.productIds)");
    expect(page).toContain("await setClassTrainersBulk(newIds, selectedTrainers)");
  });
  it("미리보기 = 날짜 수 × 타임 수(요일별은 요일마다), 저장 토스트는 실제 생성 개수", () => {
    expect(page).toContain("countClasses(expandRecurringDates(repFrom, repTo, repDays).length, 1 + extraSlots.length)");
    expect(page).toContain("총 {previewClassCount}개 수업이 만들어져요");
    expect(page).toContain("`${groupCreatedCount}개의 수업을 등록했어요`");
    expect(page).toContain("`${ids.length}개의 수업을 등록했어요");
  });
  it("[11] 시간 추가 UI는 새 등록에서만(editId 없을 때) 보이고, 추가 타임이 없으면 기존 createClass 경로 그대로", () => {
    expect(page).toContain("{!editId && !(perDayMode && repeat) && (");
    expect(page).toContain("} else if (singleSlots.length > 1) {");
    expect(page).toContain("const newId = await createClass(activeCenterId,");
    expect(page).toContain("slots: extraSlots.length > 0 ? commonSlots : undefined,");
  });
  it("스타일: 기존 AmPmTimeInput 재사용, '시간 추가'는 보조 버튼, overflow 방지", () => {
    const css = read("app/globals.css");
    expect(css).toContain(".time-slot-add {");
    expect(css).toMatch(/\.time-slot-extra \{[^}]*max-width: 100%; box-sizing: border-box/);
    expect(page).toContain("<AmPmTimeInput value={sl.start}");
  });
});
