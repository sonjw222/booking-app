import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// fix_center_insert_guard_20261008.sql의 정적 계약(실제 동작은 tests/sql/center-insert-guard.test.mjs — PGlite — 가 검증한다).
const read = (f: string) => readFileSync(f, "utf8");
const strip = (s: string) => s.replace(/^\s*--.*$/gm, "");
const forward = strip(read("fix_center_insert_guard_20261008.sql"));

describe("centers INSERT guard migration (정적)", () => {
  it("BEFORE INSERT 트리거 + SECURITY DEFINER/search_path 고정 함수", () => {
    expect(forward).toMatch(/create trigger trg_guard_center_insert\s+before insert on public\.centers\s+for each row execute function public\.guard_center_insert\(\)/i);
    expect(forward).toMatch(/security definer\s+set search_path = public/i);
  });
  it("JWT 없는 서버 작업과 플랫폼 운영자는 통과, 그 외는 pending/false로 강제", () => {
    expect(forward).toContain("if auth.uid() is null then");
    expect(forward).toContain("if is_platform_admin() then");
    expect(forward).toContain("new.status := 'pending';");
    expect(forward).toContain("new.is_internal := false;");
  });
  it("RLS/정책/데이터/UPDATE 가드는 건드리지 않는다", () => {
    expect(forward).not.toMatch(/\b(update|delete)\b[^;]*\bcenters\b|alter table|create policy|drop policy|row level security|trg_guard_center_status/i);
  });
  it("트리거 함수는 API 롤 EXECUTE를 회수하고, rollback은 트리거와 함수만 제거한다", () => {
    expect(forward).toMatch(/revoke all on function public\.guard_center_insert\(\) from public, anon, authenticated/i);
    const rb = strip(read("rollback_fix_center_insert_guard_20261008.sql"));
    expect(rb).toContain("drop trigger if exists trg_guard_center_insert on public.centers;");
    expect(rb).toContain("drop function if exists public.guard_center_insert();");
    expect(rb).not.toMatch(/create |alter table|policy/i);
  });
  it("verify SQL은 SELECT만", () => {
    expect(strip(read("verify_fix_center_insert_guard_20261008.sql"))).not.toMatch(/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);
  });
});
