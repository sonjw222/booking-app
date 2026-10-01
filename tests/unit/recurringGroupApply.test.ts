/*
  "모든 반복 수업에 적용" — 실제 호출 경로 전체(UI → diff → payload → RPC 규칙)를 검증한다(2026-10-01 재조사).
  원인: update_class_group_safe가 title/capacity/시간만 반영(소개·룸·마감·취소/상품 허용은 어떤 경우에도 그룹에 미반영),
  정원은 편집 중인 수업 값을 그룹 전체에 강제, 전체 적용 ON이면 편집 중인 수업 자신의 시간/날짜 변경까지 버려졌다.
  DB가 없는 환경이라 서버 RPC의 갱신 규칙은 SQL 계약 검사 + 같은 규칙을 옮긴 순수 모델로 확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const selectEq = vi.fn();
vi.mock("../../lib/supabaseClient", () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: () => ({ select: () => ({ eq: (...a: unknown[]) => selectEq(...a) }) }) },
}));

import { buildGroupUpdates, diffGroupFields, updateClassGroup, type ClassInput, type GroupUpdateRow } from "../../lib/classes";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const noComments = (s: string) => s.replace(/--.*$/gm, "");

type Cls = { id: string; center: string; group: string | null; title: string; description: string | null; capacity: number;
  room: string | null; allowGoods: boolean; allowCancel: boolean; cancelMin: number | null; bookMin: number | null; start: string; end: string };

// KST 월 20:00(=11:00Z) / 수 18:00(=09:00Z)
const mon = (d: string, id: string, extra: Partial<Cls> = {}): Cls => ({ id, center: "c1", group: "g1", title: "A", description: null, capacity: 8, room: "r1", allowGoods: true, allowCancel: true, cancelMin: 60, bookMin: null, start: `${d}T11:00:00.000Z`, end: `${d}T12:00:00.000Z`, ...extra });
const wed = (d: string, id: string, extra: Partial<Cls> = {}): Cls => ({ ...mon(d, id), start: `${d}T09:00:00.000Z`, end: `${d}T10:00:00.000Z`, ...extra });
const group = (): Cls[] => [mon("2026-10-05", "m1"), wed("2026-10-07", "w1"), mon("2026-10-12", "m2"), wed("2026-10-14", "w2")];

// SQL update_class_group_safe의 갱신 규칙을 그대로 옮긴 모델: 같은 center + 같은 group, 키가 있을 때만 갱신, 반환=갱신된 id
function rpcModel(all: Cls[], groupId: string, centerId: string, title: string, updates: GroupUpdateRow[]): string[] {
  const ids: string[] = [];
  for (const u of updates) {
    const c = all.find((x) => x.id === u.id);
    if (!c || c.group !== groupId || c.center !== centerId) continue;
    c.title = title; c.start = u.start_time; c.end = u.end_time;
    if ("capacity" in u) c.capacity = u.capacity!;
    if ("description" in u) c.description = (u.description ?? "").trim() || null;
    if ("room_id" in u) c.room = u.room_id ?? null;
    if ("allow_goods" in u) c.allowGoods = u.allow_goods!;
    if ("allow_cancel" in u) c.allowCancel = u.allow_cancel!;
    if ("cancel_deadline_min" in u) c.cancelMin = u.cancel_deadline_min ?? null;
    if ("booking_deadline_min" in u) c.bookMin = u.booking_deadline_min ?? null;
    ids.push(c.id);
  }
  return ids;
}
const toRows = (g: Cls[]) => g.map((c) => ({ id: c.id, start_time: c.start, end_time: c.end }));
const origOf = (c: Cls): ClassInput => ({ title: c.title, description: c.description ?? "", date: "2026-10-05", start: "20:00", end: "21:00", capacity: c.capacity, allowGoods: c.allowGoods, allowCancel: c.allowCancel, roomId: c.room, cancelDeadlineMin: c.cancelMin, bookingDeadlineMin: c.bookMin, classFormat: "group" });

describe("[A~E] 공통 필드는 그룹 전체에, 시간은 각자 유지", () => {
  it("A. title A→B: 4개 모두 B, 월 20:00 / 수 18:00 유지", () => {
    const g = group();
    const ids = rpcModel(g, "g1", "c1", "B", buildGroupUpdates(toRows(g), { changes: {} }));
    expect(ids).toHaveLength(4);
    expect(g.every((c) => c.title === "B")).toBe(true);
    expect(g[1].start).toBe("2026-10-07T09:00:00.000Z");   // 수 18:00
    expect(g[0].start).toBe("2026-10-05T11:00:00.000Z");   // 월 20:00
  });
  it("B. 소개 변경 → 그룹 전체(원래 NULL이던 수업 포함, 사용자가 명시적으로 전체 수정한 경우)", () => {
    const g = group(); g[2].description = "옛 소개";
    const changes = diffGroupFields(origOf(g[0]), { ...origOf(g[0]), description: "새 소개" });
    rpcModel(g, "g1", "c1", "A", buildGroupUpdates(toRows(g), { changes }));
    expect(g.map((c) => c.description)).toEqual(["새 소개", "새 소개", "새 소개", "새 소개"]);
  });
  it("C. 정원 변경 → 그룹 전체, 정원을 안 바꿨으면 요일별 정원은 덮어쓰지 않는다", () => {
    const g = group(); g[1].capacity = 6; g[3].capacity = 6;
    rpcModel(g, "g1", "c1", "B", buildGroupUpdates(toRows(g), { changes: diffGroupFields(origOf(g[0]), { ...origOf(g[0]), title: "B" }) }));
    expect(g.map((c) => c.capacity)).toEqual([8, 6, 8, 6]);
    rpcModel(g, "g1", "c1", "B", buildGroupUpdates(toRows(g), { changes: diffGroupFields(origOf(g[0]), { ...origOf(g[0]), capacity: 10 }) }));
    expect(g.map((c) => c.capacity)).toEqual([10, 10, 10, 10]);
  });
  it("E. 룸 변경(+ 룸 해제) → 그룹 전체; 취소/예약마감·취소 허용·상품 허용도 바뀐 것만 전체 적용", () => {
    const g = group();
    const o = origOf(g[0]);
    rpcModel(g, "g1", "c1", "A", buildGroupUpdates(toRows(g), { changes: diffGroupFields(o, { ...o, roomId: "r2", allowGoods: false, allowCancel: false, cancelDeadlineMin: 120, bookingDeadlineMin: 30 }) }));
    expect(g.every((c) => c.room === "r2" && !c.allowGoods && !c.allowCancel && c.cancelMin === 120 && c.bookMin === 30)).toBe(true);
    rpcModel(g, "g1", "c1", "A", buildGroupUpdates(toRows(g), { changes: diffGroupFields({ ...o, roomId: "r2" }, { ...o, roomId: null }) }));
    expect(g.every((c) => c.room === null)).toBe(true);
  });
  it("바뀌지 않은 필드는 payload에 키 자체가 없다(서버가 기존 값 유지)", () => {
    const o = origOf(group()[0]);
    expect(diffGroupFields(o, { ...o })).toEqual({});
    const [u] = buildGroupUpdates([{ id: "m1", start_time: "x", end_time: "y" }], { changes: {} });
    expect(Object.keys(u).sort()).toEqual(["end_time", "id", "start_time"]);
  });
});

describe("[F][G][H][I] 범위", () => {
  it("F. 전체 적용 OFF → updateClass 경로(그룹 RPC 호출 안 함) — 화면 분기 계약", () => {
    const page = read("app/manager/classes/page.tsx");
    expect(page).toContain("if (applyToGroup && editGroupId) {");
    expect(page).toContain("const result = await updateClass(editId,");
  });
  it("G. recurring_group_id가 NULL이면 토글 자체가 없다(editGroupId 필요) — 그룹으로 추측하지 않는다", () => {
    const page = read("app/manager/classes/page.tsx");
    expect(page).toContain("{editId && editGroupId && (");
    expect(page).toContain("setEditGroupId(c.recurringGroupId);");
    expect(read("lib/classes.ts")).toContain("recurringGroupId: c.recurring_group_id ?? null");
    expect(read("lib/classes.ts")).not.toMatch(/group.*title.*같은/);
  });
  it("H/I. 다른 그룹·다른 센터 수업은 같은 id가 payload에 섞여도 수정되지 않는다(서버 where 절)", () => {
    const g = group();
    const other: Cls[] = [mon("2026-10-05", "o1", { group: "g2" }), mon("2026-10-05", "o2", { center: "c2" })];
    const all = [...g, ...other];
    const updates = buildGroupUpdates(toRows(all), { changes: { description: "X" } });
    const ids = rpcModel(all, "g1", "c1", "B", updates);
    expect(ids.sort()).toEqual(["m1", "m2", "w1", "w2"]);
    expect(other.every((c) => c.title === "A" && c.description === null)).toBe(true);
    const sql = noComments(read("fix_recurring_class_description_and_group_update.sql"));
    expect(sql).toContain("and c.recurring_group_id = p_group_id");
    expect(sql).toContain("and c.center_id = v_center_id");
  });
});

describe("[J][K] 시간 정책", () => {
  it("J. '시간도 함께 변경' OFF: 서로 다른 요일 시간 유지(제목만 바꿔도 수요일 18:00)", () => {
    const g = group();
    rpcModel(g, "g1", "c1", "B", buildGroupUpdates(toRows(g), { changes: {} }));
    expect(g.map((c) => c.start.slice(11, 16))).toEqual(["11:00", "09:00", "11:00", "09:00"]);
  });
  it("K. ON: 모든 수업의 시각(time-of-day)만 바뀌고 각 수업의 날짜는 유지", () => {
    const g = group();
    rpcModel(g, "g1", "c1", "A", buildGroupUpdates(toRows(g), { time: { start: "19:00", end: "20:00" }, changes: {} }));
    expect(g.map((c) => c.start)).toEqual([
      "2026-10-05T19:00:00+09:00", "2026-10-07T19:00:00+09:00", "2026-10-12T19:00:00+09:00", "2026-10-14T19:00:00+09:00",
    ]);   // 모두 19:00 KST, 날짜 5/7/12/14 유지
  });
  it("전체 적용 ON이어도 편집 중인 수업 자신의 시간/날짜 변경은 저장된다(다른 수업은 그대로) — 예전엔 조용히 버려졌다", () => {
    const g = group();
    rpcModel(g, "g1", "c1", "A", buildGroupUpdates(toRows(g), { changes: {}, own: { id: "m1", date: "2026-10-05", start: "21:00", end: "22:00" } }));
    expect(g[0].start).toBe("2026-10-05T21:00:00+09:00");   // 21:00 KST
    expect(g[1].start).toBe("2026-10-07T09:00:00.000Z");   // 수요일 유지
    const page = read("app/manager/classes/page.tsx");
    expect(page).toContain("const ownChanged = !!orig && (orig.date !== form.date || orig.start !== form.start || orig.end !== form.end);");
    expect(page).toContain("own: ownChanged || applyTimeToGroup ?");
  });
});

describe("[D][L] 담당 강사 · 수정 개수 검증 · 피드백", () => {
  beforeEach(() => { rpcMock.mockReset(); selectEq.mockReset(); });
  it("D. 전체 적용이면 담당 강사도 같은 반환 id 목록 전체에 적용된다", () => {
    const page = read("app/manager/classes/page.tsx");
    expect(page).toContain("await setClassTrainersForGroup(groupIds, selectedTrainers);");
    expect(read("lib/classes.ts")).toContain('rpc("set_class_trainers_for_group_safe"');
  });
  it("L. 그룹 10개 → 10개 수정되고 반환 id 수 = 그룹 행 수, 성공 토스트에 개수 표시", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, start_time: `2026-10-${String(5 + i).padStart(2, "0")}T11:00:00.000Z`, end_time: `2026-10-${String(5 + i).padStart(2, "0")}T12:00:00.000Z` }));
    selectEq.mockResolvedValue({ data: rows, error: null });
    rpcMock.mockResolvedValue({ data: rows.map((r) => r.id), error: null });
    const ids = await updateClassGroup("g1", "B", 8, { changes: { description: "d" } });
    expect(ids).toHaveLength(10);
    expect(read("app/manager/classes/page.tsx")).toContain("`반복 수업 ${groupAppliedCount}개를 수정했어요`");
  });
  it("일부만(또는 0개) 수정되면 조용히 성공시키지 않고 오류", async () => {
    const rows = [{ id: "a", start_time: "2026-10-05T11:00:00.000Z", end_time: "2026-10-05T12:00:00.000Z" }, { id: "b", start_time: "2026-10-07T09:00:00.000Z", end_time: "2026-10-07T10:00:00.000Z" }];
    selectEq.mockResolvedValue({ data: rows, error: null });
    rpcMock.mockResolvedValue({ data: ["a"], error: null });
    await expect(updateClassGroup("g1", "B", 8)).rejects.toThrow("2개 중 1개만 수정됐어요");
    rpcMock.mockResolvedValue({ data: [], error: null });
    await expect(updateClassGroup("g1", "B", 8)).rejects.toThrow("2개 중 0개만 수정됐어요");
  });
  it("그룹 행이 없으면 명확한 오류", async () => {
    selectEq.mockResolvedValue({ data: [], error: null });
    await expect(updateClassGroup("g1", "B", 8)).rejects.toThrow("반복 수업 정보를 찾지 못했어요");
  });
});

describe("SQL 계약 · 안내 문구", () => {
  const sql = noComments(read("fix_recurring_class_description_and_group_update.sql"));
  it("한 문장(=한 트랜잭션)으로 갱신, 키가 있을 때만(소개/정원/룸/마감/허용), 룸 센터 일치·정원 하한 검증", () => {
    for (const k of ["description", "capacity", "room_id", "allow_goods", "allow_cancel", "cancel_deadline_min", "booking_deadline_min"]) {
      expect(sql).toContain(`when u ? '${k}'`);
    }
    expect(sql).toContain("r.center_id = v_center_id");
    expect(sql).toContain("보다 적게 정원을 줄일 수 없어요");
    expect(sql).not.toContain("capacity = p_capacity");   // 정원을 그룹 전체에 강제하지 않는다
  });
  it("helper 문구가 실제 동작과 일치(공통 설정 적용 / 날짜·시간·수강권 정책은 수업별 유지)", () => {
    const page = read("app/manager/classes/page.tsx");
    expect(page).toContain("수업명·소개·정원·룸·담당 강사 등 바꾼 공통 설정이 반복 수업 전체에 적용돼요. 날짜·시간·수강권 정책은 수업별로 유지돼요.");
    expect(page).toContain("await updateClassPassSelectionMode(editId, passMode);");   // 수강권 정책은 이 수업만(명시적 제외)
  });
  it("반복 생성/스케줄 복사 4경로(공통시간·요일별 개별시간·요일 복사·날짜 복사) 모두 한 작업의 모든 occurrence에 같은 recurring_group_id를 준다", () => {
    const lib = read("lib/classes.ts");
    expect((lib.match(/const groupId = crypto\.randomUUID\(\);/g) ?? []).length).toBe(4);
    // 4경로 + 2026-10-02 한 날 여러 타임 단일 날짜 등록(createClassOnDateSlots) = 5곳이 같은 그룹 id 변수를 쓴다
    expect((lib.match(/recurring_group_id: groupId,/g) ?? []).length).toBe(5);
  });
});
