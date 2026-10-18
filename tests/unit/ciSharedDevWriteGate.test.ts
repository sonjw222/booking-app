// 공유 DEV DB에 service role로 쓰는 live job(E2E 4구간·Integration·acl-fixture-repeat·preflight)이 어떤 이벤트·입력·needs 결과에서도
// 실행되지 않음을 workflow의 `if` 식 자체를 가능한 모든 조합으로 평가해 고정하는 정적 회귀 테스트(네트워크/CI 실행 없음).
// 한계(이 테스트가 보장하지 않는 것): GitHub가 실제로 job을 skip하는지 / `if` 외의 경로(로컬 .env.test.local이 공유 DEV를 가리키는 수동 로컬 실행) /
// 격리 DB가 준비된 뒤의 안전성. 재활성화는 `false &&`를 지우는 리뷰된 변경이어야 하며 그때 이 테스트도 의도적으로 갱신해야 한다.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(root, p), "utf8");
const code = (b: string) => b.replace(/^\s*#.*$/gm, "");
const wf = rd(".github/workflows/test.yml");
const jobsBody = wf.slice(wf.indexOf("\njobs:\n") + 6);
const heads = [...jobsBody.matchAll(/^  ([a-z0-9-]+):\s*$/gm)];
const J: Record<string, string> = {};
heads.forEach((m, i) => { J[m[1]] = code(jobsBody.slice(m.index!, i + 1 < heads.length ? heads[i + 1].index : undefined)); });

const LIVE = ["live-env-preflight", "e2e-1-auth-attendance", "e2e-2-admin-config", "e2e-3-class-reservation-checkout", "e2e-4-settings-readiness", "integration", "acl-fixture-repeat"];
const SAFE = ["unit", "lint", "sql", "build"];
const ifOf = (b: string) => (b.match(/^    if: ([\s\S]*?)^    [a-z-]+:/m)?.[1] ?? "")
  .replace(/\s+#[^\n']*$/gm, "").replace(/\s+/g, " ").trim().replace(/^> /, "").replace(/^\$\{\{ (.*) \}\}$/, "$1").trim();
const needsOf = (b: string) => (b.match(/^    needs: (.+)$/m)?.[1] ?? "").split(/[,\s\[\]]+/).filter(Boolean);

type Ctx = { event: string; ack: string; fork: string; headRef: string; cancelled: boolean; needs: string };
// GitHub expression → JS(이 workflow가 쓰는 부분집합: && || ! == != 문자열 리터럴, github.*, needs.*.result, cancelled()/always()/success()/failure()).
function evalIf(expr: string, c: Ctx): boolean {
  if (expr === "") return true; // if 없음 = success() 기본(needs 성공 시)
  const js = expr
    .replace(/github\.event\.inputs\.[a-z_]+|inputs\.[a-z_]+/g, JSON.stringify(c.ack))
    .replace(/github\.event\.pull_request\.head\.repo\.full_name/g, JSON.stringify(c.fork))
    .replace(/github\.event_name/g, JSON.stringify(c.event))
    .replace(/github\.head_ref/g, JSON.stringify(c.headRef))
    .replace(/github\.repository/g, JSON.stringify("owner/repo"))
    .replace(/needs\.[a-z0-9-]+\.result/g, JSON.stringify(c.needs))
    .replace(/!cancelled\(\)/g, String(!c.cancelled))
    .replace(/\balways\(\)/g, "true")
    .replace(/\bsuccess\(\)/g, "true")
    .replace(/\bfailure\(\)/g, "false");
  if (/[A-Za-z_]\w*\s*\(/.test(js.replace(/"[^"]*"|'[^']*'/g, ""))) throw new Error("평가기가 모르는 함수/컨텍스트: " + expr);
  return Boolean(new Function(`return (${js});`)());
}
const ctxs: Ctx[] = [];
for (const event of ["pull_request", "push", "workflow_dispatch", "schedule"])
  for (const ack of ["", "I-ACK-WRITES-TO-SHARED-DEV", "yes", "true"])
    for (const fork of ["owner/repo", "someone/fork"])
      for (const headRef of ["feature/x", "test/acl-fixture-restore-20261012", "main"])
        for (const cancelled of [false, true])
          for (const needs of ["success", "failure", "skipped", "cancelled"]) ctxs.push({ event, ack, fork, headRef, cancelled, needs });

describe("공유 DEV 쓰기 live job 차단 (정적)", () => {
  it("live job 목록이 실제 workflow와 일치한다(secrets/Playwright/integration을 쓰는 job은 정확히 이 7개)", () => {
    const live = Object.keys(J).filter((id) => /secrets\.|playwright test|test:integration|vitest\.integration|ci:dev:/.test(J[id]));
    expect(live.sort()).toEqual([...LIVE].sort());
    for (const id of LIVE) expect(J[id], id).toBeDefined();
  });
  it("각 live job은 독립적으로 `false &&`로 시작한다 — needs 사슬·ACK·always()에 의존하지 않는다", () => {
    for (const id of LIVE) {
      const cond = ifOf(J[id]);
      expect(cond.startsWith("false &&"), `${id}: if가 'false &&'로 시작하지 않음 → ${cond}`).toBe(true);
      expect(cond, id).not.toMatch(/always\(\)/);
      expect(cond, id).not.toMatch(/inputs\.|shared_dev_write_ack|I-ACK/);
    }
  });
  it("모든 이벤트·ACK 값·fork/브랜치·취소 여부·needs 결과 조합에서 live job의 if는 true가 되지 않는다(pull_request·workflow_dispatch·ACK·always 우회 모두 포함)", () => {
    expect(ctxs.length).toBeGreaterThan(500);
    for (const id of LIVE) {
      const cond = ifOf(J[id]);
      const hit = ctxs.find((c) => evalIf(cond, c));
      expect(hit, `${id}가 실행 가능한 조합: ${JSON.stringify(hit)}`).toBeUndefined();
    }
  });
  it("workflow_dispatch에는 ACK 같은 입력이 없고(ACK만으로 켜는 경로 없음), on 트리거에 live를 켜는 입력이 정의되지 않는다", () => {
    const on = wf.slice(wf.indexOf("\non:\n"), wf.indexOf("\nconcurrency:"));
    expect(code(on)).not.toMatch(/inputs:|shared_dev_write_ack|I-ACK/);
    expect(code(wf)).not.toMatch(/github\.event\.inputs|\binputs\./);
  });
  it("안전한 일반 CI job(unit/lint/sql/build)은 if/needs/secrets 없이 pull_request·push·dispatch 모두에서 실행된다(비활성화되지 않음)", () => {
    for (const id of SAFE) {
      expect(J[id], id).toBeDefined();
      expect(J[id], id).not.toMatch(/secrets\.|playwright test|test:integration|vitest\.integration/);
      expect(needsOf(J[id]), id).toEqual([]);
      for (const c of ctxs.filter((x) => !x.cancelled && x.needs === "success")) expect(evalIf(ifOf(J[id]), c), id).toBe(true);
    }
    expect(J.unit).toContain("npm run test");
    expect(J.lint).toContain("npm run lint");
    expect(J.sql).toContain("npm run test:sql");
    expect(J.build).toContain("npm run build");
    expect(J.build).toContain("https://build-placeholder.supabase.co");
  });
  it("다른 workflow는 secrets/live 실행을 쓰지 않는다(mobile-ui-qa는 ACK 있는 의도적 Production QA — 이 감사 범위 밖)", () => {
    for (const f of readdirSync(path.join(root, ".github/workflows")).filter((n) => n !== "test.yml" && n !== "mobile-ui-qa.yml")) {
      expect(rd(".github/workflows/" + f), f).not.toMatch(/secrets\.|playwright test|test:integration/);
    }
  });
  it("재도입 금지: 관리자 페이지네이션 fixture, 자동 관리자 승격, 기본 요금제 자동 변경이 workflow/scripts에 없다", () => {
    expect(existsSync(path.join(root, "scripts/ci/adminPaginationFixture.mjs"))).toBe(false);
    const files = readdirSync(path.join(root, ".github/workflows")).map((f) => ".github/workflows/" + f);
    for (const d of ["scripts/ci", "scripts/e2e"]) for (const f of readdirSync(path.join(root, d))) files.push(`${d}/${f}`);
    for (const f of files) expect(rd(f), f).not.toMatch(/adminPaginationFixture|is_platform_admin|set_default_subscription_plan|is_default|ALLOW_PRIVILEGED_DEV_TESTS|test:integration:privileged/);
  });
  it("공유 계정 관리자 승격·기본 요금제 변경 테스트는 일반 integration 설정에서 제외되거나 itPrivileged 게이트 안에 있다", () => {
    expect(rd("vitest.integration.config.ts")).toContain('"tests/integration/subscription-plan-limits.test.ts"');
    expect(rd("tests/integration/privilegedGate.ts")).toContain('process.env.ALLOW_PRIVILEGED_DEV_TESTS === "1"');
  });
});
