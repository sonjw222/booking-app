// 관리자 페이지네이션 검증 경로가 DB 쓰기·권한 승격·테스트 데이터 생성/삭제를 자동 실행하지 않음을 정적으로 고정한다.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(root, p), "utf8");
const workflows = readdirSync(path.join(root, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f));

describe("admin pagination CI safety (static)", () => {
  it("권한 승격/센터 fixture 스크립트가 존재하지 않는다", () => {
    expect(existsSync(path.join(root, "scripts/ci/adminPaginationFixture.mjs"))).toBe(false);
    expect(readdirSync(path.join(root, "scripts/ci")).filter((f) => /fixture/i.test(f))).toEqual([]);
  });
  it("어떤 workflow도 fixture 스크립트·관리자 페이지네이션 전용 실행·플래그를 참조하지 않는다", () => {
    for (const f of workflows) {
      const w = rd(".github/workflows/" + f);
      expect(w, f).not.toMatch(/adminPaginationFixture|admin-pagination-fixture|RUN_ADMIN_PAGINATION|E2E_ADMIN_CENTER_PAGINATION_FLAG|NEXT_PUBLIC_ADMIN_CENTER_PAGINATION|admin-center-pagination\.spec/);
    }
  });
  it("workflow와 scripts/ci·scripts/e2e는 is_platform_admin을 쓰지 않는다", () => {
    const files = [...workflows.map((f) => ".github/workflows/" + f)];
    for (const dir of ["scripts/ci", "scripts/e2e"]) for (const f of readdirSync(path.join(root, dir))) files.push(`${dir}/${f}`);
    for (const f of files) expect(rd(f), f).not.toMatch(/is_platform_admin/);
  });
  it("spec은 service role·쓰기 API·승인/반려 호출을 쓰지 않는다(읽기 전용)", () => {
    const spec = rd("tests/e2e/production-readiness/admin-center-pagination.spec.ts");
    expect(spec).not.toMatch(/SERVICE_ROLE|createClient|\.insert\(|\.update\(|\.delete\(|\.upsert\(|MANAGER_B/);
    // 승인/반려/되돌리기 버튼은 존재하지 않음을 단언만 할 수 있고 클릭할 수 없다.
    expect(spec).not.toMatch(/name: "(승인|반려|승인 취소\(반려\)|대기로 되돌리기|반려하기)"[^\n]*\.click\(/)
  });
  it("수동 러너는 service role을 읽지 않고 ON/OFF를 별도 env로 실행하며, 전용 모드에서 서버 재사용을 끈다", () => {
    const runner = rd("scripts/e2e/adminPaginationReadonly.mjs");
    expect(runner).not.toMatch(/SERVICE_ROLE|createClient|supabase-js/);
    expect(runner).toContain('["on", "true"], ["off", "false"]');
    expect(rd("playwright.config.ts")).toMatch(/reuseExistingServer: !process\.env\.CI && process\.env\.RUN_ADMIN_PAGINATION !== "1"/);
  });
});
