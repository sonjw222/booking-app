/* post-release follow-ups(2026-10-03) 정적 계약 — 동작 검증은 tests/sql/*.test.mjs(PGlite) */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeSelectableSchedule } from "../../lib/passes";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const code = (s: string) => s.replace(/--.*$/gm, "");

describe("[Batch B] 관리자 지급: UI 후보 = 서버 검증 의미", () => {
  it("computeSelectableSchedule: '모든 요일' 규칙은 후보 아님, 시간 NULL 규칙은 시간 후보 아님(서버 helper와 동일)", () => {
    const s = computeSelectableSchedule([
      { id: "1", dayOfWeek: 1, startTime: "19:00", classTitle: null }, { id: "2", dayOfWeek: 1, startTime: "20:00", classTitle: null },
      { id: "3", dayOfWeek: 4, startTime: null, classTitle: null }, { id: "4", dayOfWeek: null, startTime: "19:00", classTitle: null },
    ]);
    expect(s.days).toEqual([1, 4]);
    expect(s.timesByDay).toEqual({ 1: ["19:00", "20:00"], 4: [] });
  });
  it("migration: helper는 내부 전용 + manager_grant_product가 호출, 기존 권한/소속/사이즈/횟수 검증은 유지", () => {
    const sql = code(read("fix_grant_schedule_and_kst_dates_20261003.sql"));
    expect(sql).toContain("perform public.validate_product_schedule_selection(v_product.id, v_bound_dow, v_bound_time);");
    expect(sql).toContain("revoke all on function public.validate_product_schedule_selection(uuid, integer, time without time zone) from public, anon, authenticated;");
    for (const keep of ["수강권/상품을 지급할 권한이 없어요", "이 센터의 회원이 아니에요", "이 센터의 상품이 아니에요", "사이즈를 선택해주세요", "지급 가능한 수량이 없어요"]) expect(sql).toContain(keep);
  });
  it("UI는 서버가 허용하는 후보(computeSelectableSchedule)만 보여준다", () => {
    const page = read("app/manager/members/page.tsx");
    expect(page).toContain("grantScheduleOptions.days.map");
    expect(read("lib/center.ts")).toContain("return computeSelectableSchedule(rules);");   // 구매/지급 후보 계산 공용
  });
});
