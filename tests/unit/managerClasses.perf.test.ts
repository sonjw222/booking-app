/*
  PERF-020~024 — 관리자 수업 화면: 요청 가드, 일정 충돌 검사 일괄 조회, 캘린더 집계.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const calls: { table: string; op: string; arg?: unknown }[] = [];
let classRows: Record<string, unknown>[] = [];
let trainerRows: { class_id: string; account_id: string }[] = [];

vi.mock("../../lib/supabaseClient", () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = (...a: unknown[]) => { calls.push({ table, op: "select", arg: a[0] }); return b; };
    b.eq = chain; b.gte = chain; b.lte = chain; b.order = chain; b.range = chain; b.neq = chain;
    b.in = (_c: string, ids: string[]) => { calls.push({ table, op: "in", arg: ids }); return b; };
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: table === "class_trainers" ? trainerRows : classRows, error: null });
    return b;
  };
  return { supabase: { from: (t: string) => builder(t), rpc: vi.fn() } };
});

import {
  fetchClassTrainersBatch, createLatestGuard, countClassesByDay, classesOnDate,
} from "../../lib/classes";

beforeEach(() => { calls.length = 0; trainerRows = []; });

describe("fetchClassTrainersBatch (PERF-023)", () => {
  it("수업 N개의 강사를 class_trainers 1회 조회로 묶어 반환", async () => {
    trainerRows = [
      { class_id: "a", account_id: "t1" }, { class_id: "a", account_id: "t2" }, { class_id: "b", account_id: "t3" },
    ];
    const out = await fetchClassTrainersBatch(["a", "b", "c"]);
    expect(out).toEqual({ a: ["t1", "t2"], b: ["t3"] });
    expect(calls.filter((c) => c.table === "class_trainers" && c.op === "in")).toHaveLength(1);
  });
  it("빈 입력은 쿼리 없이 빈 객체", async () => {
    expect(await fetchClassTrainersBatch([])).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe("createLatestGuard (PERF-022)", () => {
  it("나중에 시작한 요청만 latest, 늦게 도착한 이전 응답은 무시", () => {
    const g = createLatestGuard();
    const first = g.next();
    const second = g.next();
    expect(g.isLatest(first)).toBe(false);
    expect(g.isLatest(second)).toBe(true);
  });
  it("invalidate(센터 전환)하면 진행 중이던 요청 모두 무효", () => {
    const g = createLatestGuard();
    const t = g.next();
    g.invalidate();
    expect(g.isLatest(t)).toBe(false);
  });
});

describe("캘린더 집계 (PERF-024)", () => {
  const make = (n: number) => Array.from({ length: n }, (_, i) => ({
    date: `2026-10-${String((i % 31) + 1).padStart(2, "0")}`,
    start: `${String(i % 24).padStart(2, "0")}:00`,
  }));
  it("일별 개수/선택일 정렬이 정확", () => {
    const cls = [
      { date: "2026-10-05", start: "10:00" }, { date: "2026-10-05", start: "09:00" }, { date: "2026-10-06", start: "08:00" },
    ];
    expect(countClassesByDay(cls)).toEqual({ 5: 2, 6: 1 });
    expect(classesOnDate(cls, "2026-10-05").map((c) => c.start)).toEqual(["09:00", "10:00"]);
  });
  it("1,000개 가상 데이터에서도 O(n) — 수 ms 이내(로컬 마이크로 벤치)", () => {
    const cls = make(1000);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) { countClassesByDay(cls); classesOnDate(cls, "2026-10-05"); }
    const per = (performance.now() - t0) / 100;
    expect(per).toBeLessThan(5);
  });
});

describe("page 배선 계약 (PERF-020/021/023)", () => {
  const page = readFileSync(join(__dirname, "../../app/manager/classes/page.tsx"), "utf-8");
  it("센터 select onChange가 loadClasses를 직접 부르지 않는다(effect 단일화)", () => {
    const i = page.indexOf('aria-label="센터 선택"');
    expect(page.slice(i, i + 600)).not.toContain("loadClasses(");
  });
  it("월 이동 effect는 수업만, 센터 단위 데이터는 [activeCenterId] effect", () => {
    expect(page).toContain("loadMonthClasses(activeCenterId, year, month)");
    expect(page).toContain("}, [activeCenterId]);");
  });
  it("충돌 검사는 디바운스 + 서버 저장 검증을 막는 용도가 아님", () => {
    expect(page).toContain("}, 300);");
    expect(page).toContain("clearTimeout(timer)");
  });
});
