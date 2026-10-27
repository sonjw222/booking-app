/*
  CI live-test workflow 정적 contract(실제 CI/네트워크 실행 없음): live E2E/Integration 이 일회용 격리 Supabase 스택만 쓰고(Secrets·공유 DEV·Production 경로 없음, 가드 OK 전에는 테스트 미시작),
  spec 정확히 한 구간, fail-fast, artifact always upload, Unit/Build 독립(cascade skip 방지), fork/push 게이트, 외부 action 허용 목록을 검증한다.
*/
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const wf = readFileSync(path.join(root, ".github/workflows/test.yml"), "utf8");
const jobsBody = wf.slice(wf.indexOf("\njobs:\n") + 6);
const heads = [...jobsBody.matchAll(/^  ([a-z0-9-]+):\s*$/gm)];
const J: Record<string, string> = {};
heads.forEach((m, i) => { J[m[1]] = jobsBody.slice(m.index!, i + 1 < heads.length ? heads[i + 1].index : undefined); });
const code = (b: string) => b.replace(/^\s*#.*$/gm, "");
const action = readFileSync(path.join(root, ".github/actions/isolated-supabase/action.yml"), "utf8");
const LIVE = ["e2e-1-auth-attendance", "e2e-2-admin-config", "e2e-3-class-reservation-checkout", "e2e-4-settings-readiness", "integration", "acl-fixture-repeat"];
const e2e = Object.keys(J).filter((k) => k.startsWith("e2e-"));
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const specs = walk(path.join(root, "tests/e2e")).filter((f) => f.endsWith(".spec.ts")).map((f) => path.relative(root, f).split(path.sep).join("/"));
const pwLine = (b: string) => code(b).split("\n").find((l) => /run: npx playwright test /.test(l))!;
const filters = (b: string) => pwLine(b).split("npx playwright test ")[1].trim().split(/\s+/).filter((t) => !t.startsWith("--") && !t.startsWith("auth"));
const num = (b: string, re: RegExp) => Number(code(b).match(re)![1]);

describe("live-test workflow 구조", () => {
  it("E2E 는 4개 checkpoint 독립 job(실행마다 자기 격리 스택이라 needs 체인·matrix 없음)이고 모두 격리 스택 action 을 쓴다", () => {
    expect(e2e).toHaveLength(4);
    expect(code(wf)).not.toMatch(/^\s+strategy:/m);
    for (const id of e2e) { expect(code(J[id]), id).not.toMatch(/^    needs:/m); expect(code(J[id]), id).toContain("uses: ./.github/actions/isolated-supabase"); }
  });
  it("모든 E2E spec이 정확히 한 checkpoint에 포함된다(누락/중복 없음) — 새 spec은 구간 배정 전까지 이 테스트가 실패", () => {
    expect(specs.length).toBeGreaterThan(20);
    for (const spec of specs) {
      const hits = e2e.filter((id) => filters(J[id]).some((f) => new RegExp(f).test(spec)));
      expect(hits, `${spec}: ${hits.join(",") || "어느 구간에도 없음"}`).toHaveLength(1);
    }
    for (const id of e2e) expect(pwLine(J[id])).toContain("auth\\.setup\\.ts");   // 각 구간이 로그인 storageState setup을 포함
  });
  it("fail-fast: --max-failures=1 + 재시도 정책은 playwright.config의 CI retries 1 유지, step timeout < job timeout ≤ 20분(artifact upload 여유)", () => {
    for (const id of e2e) {
      expect(pwLine(J[id]), id).toContain("--max-failures=1");
      const step = num(J[id], /name: Playwright [^\n]+\n\s+timeout-minutes: (\d+)/), job = num(J[id], /^    timeout-minutes: (\d+)/m);
      expect(step, id).toBeLessThan(job); expect(job, id).toBeLessThanOrEqual(20);
    }
    expect(readFileSync(path.join(root, "playwright.config.ts"), "utf8")).toMatch(/retries: process\.env\.CI \? 1 : 0/);
  });
  it("artifact: 구간 이름이 들어간 고유 이름의 report/test-results를 if: always()로 올린다(테스트 실패해도 업로드)", () => {
    const names: string[] = [];
    for (const id of e2e) {
      const b = code(J[id]);
      const ups = [...b.matchAll(/- uses: actions\/upload-artifact@v4\n\s+if: always\(\)\n\s+with:\n\s+name: ([a-z-]+)/g)].map((m) => m[1]);
      expect(ups, id).toHaveLength(2);
      expect(ups[0]).toMatch(/^playwright-report-/); expect(ups[1]).toMatch(/^playwright-test-results-/);
      names.push(...ups);
    }
    expect(new Set(names).size).toBe(8);
  });
  it("artifact는 report/test-results만(auth storageState·.env 제외), retention 3일 이하 — PUBLIC repo에서 trace의 bearer token 노출 기간 최소화", () => {
    for (const id of e2e) {
      const paths = [...code(J[id]).matchAll(/^\s+path: (.+)$/gm)].map((m) => m[1].trim());
      expect(paths.sort(), id).toEqual(["playwright-report/", "test-results/"]);
      for (const m of code(J[id]).matchAll(/retention-days: (\d+)/g)) expect(Number(m[1]), id).toBeLessThanOrEqual(3);
    }
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toContain("/playwright/.auth/");
    expect(code(readFileSync(path.join(root, ".github/workflows/mobile-ui-qa.yml"), "utf8"))).toMatch(/^permissions:\n  contents: read\n/m);
  });
  it("Unit/Build는 E2E와 독립(needs/if cascade 없음)이고 Build는 secrets가 아닌 placeholder env만 쓴다", () => {
    for (const id of ["unit", "build"]) { expect(code(J[id]), id).not.toMatch(/^    needs:/m); expect(code(J[id]), id).not.toMatch(/^    if:/m); expect(J[id], id).not.toContain("secrets."); }
    expect(J.build).toContain("https://build-placeholder.supabase.co");
    expect(J.build).toContain('NEXT_PUBLIC_PG_CHECKOUT_ENABLED: "false"');
  });
  it("격리: 이 workflow 와 격리 action 은 GitHub Secrets 를 전혀 읽지 않는다 → 공유 DEV·Production·호스팅 프로젝트로 가는 경로가 없다", () => {
    expect(code(wf)).not.toContain("secrets.");
    expect(code(action)).not.toContain("secrets.");
    for (const id of LIVE) expect(code(J[id]), id).not.toMatch(/NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|TEST_(USER|MANAGER|STAFF)_[AB]_/);   // live job 의 대상은 스택이 내보낸 값(GITHUB_ENV)으로만 정해진다(Build 의 placeholder URL 은 live 가 아님)
    for (const bad of ["jdglfvwdnkjnraqdxuuj", "bxntqggkfwnhcczsbqtj"]) { expect(wf).not.toContain(bad); expect(action).not.toContain(bad); }
    expect(code(wf)).not.toMatch(/live-env-preflight|shared-live-supabase-tests/);
  });
  it("live job(E2E 4 + Integration + ACL 반복)은 가드 OK 이전에 어떤 테스트도 시작하지 않는다: 격리 스택 단계가 npm ci/테스트보다 앞, 실패는 skip 이 아니라 job 실패", () => {
    for (const id of LIVE) {
      const b = code(J[id]); const iso = b.indexOf("uses: ./.github/actions/isolated-supabase");
      expect(iso, id).toBeGreaterThan(-1);
      for (const marker of ["npm ci", "npx playwright", "npm run test:integration", "npx vitest"]) { const at = b.indexOf(marker); if (at >= 0) expect(at, `${id}: ${marker} 가 격리 스택보다 앞`).toBeGreaterThan(iso); }
      expect(b, id).not.toMatch(/continue-on-error|\|\| true/);
      expect(b, id).toMatch(/name: Stop the isolated stack[^\n]*\n\s+if: always\(\)\n\s+run: supabase stop --no-backup --workdir isolated-supabase/);   // 어떤 결과든 스택을 내린다(남는 데이터 없음)
    }
    // action: 스택 기동 → 값 내보내기 → 가드 → fixture 순서, 가드는 ALLOW_BLOCKED 없이(BLOCKED/PARTIAL/FAILED 면 즉시 실패)
    const order = ["supabase start --workdir isolated-supabase", "scripts/isolated/stackEnv.mjs", "scripts/ci/isolatedTargetGuard.mjs", "scripts/isolated/bootstrapEphemeral.mjs"].map((m) => code(action).indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true); expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(code(action)).not.toContain("ISOLATED_GATE_ALLOW_BLOCKED");
    expect(code(action)).toContain("version: 2.116.0");   // CLI 버전 고정
  });
  it("공유 DEV 로 자동 대체하는 경로가 없다: 시크릿 fallback 식(||, secrets.*, vars.*)·대상 URL 직접 지정 없음, 격리 환경은 가드 통과 시에만 만들어진다", () => {
    expect(code(wf)).not.toMatch(/\$\{\{[^}]*\|\|[^}]*(secrets|vars)\./);
    expect(code(wf)).not.toMatch(/vars\./); expect(code(action)).not.toMatch(/vars\./);
    const guard = readFileSync(path.join(root, "scripts/isolated/bootstrapEphemeral.mjs"), "utf8");
    expect(guard).toContain('g.status !== "OK" || g.kind !== "ephemeral-local-stack"');   // fixture 단계도 가드를 한 번 더 확인
  });
  it("실행 조건 유지: live job 은 push 제외·fork PR 제외(같은 저장소 PR·수동 실행), Integration/E2E 가 서로 기다리지 않는다", () => {
    for (const id of LIVE.filter((x) => x !== "acl-fixture-repeat")) {
      expect(code(J[id]), id).toContain("github.event_name != 'push'");
      expect(code(J[id]), id).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    }
    expect(code(J["acl-fixture-repeat"])).toMatch(/^    needs: integration\s*$/m);
    expect(code(J["acl-fixture-repeat"])).toContain("github.head_ref == 'test/acl-fixture-restore-20261012'");
    expect(J["acl-fixture-repeat"]).toContain("for iteration in 1 2 3");
    expect(code(wf)).toMatch(/concurrency:\n  group: test-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  });
  it("최소 권한·외부 action 허용 목록: permissions contents: read, pull_request_target 없음, 외부 action 은 actions/* 와 로컬 action, 그리고 격리 action 안의 supabase/setup-cli 뿐", () => {
    expect(code(wf)).toMatch(/^permissions:\n  contents: read\n/m);
    expect(code(wf)).not.toMatch(/pull_request_target/);
    for (const m of code(wf).matchAll(/uses: ([^@\s]+)@/g)) expect(m[1], m[0]).toMatch(/^actions\//);
    for (const m of code(wf).matchAll(/uses: (\.\/[^\s]+)/g)) expect(m[1]).toBe("./.github/actions/isolated-supabase");
    const ext = [...code(action).matchAll(/uses: ([^@\s]+)@/g)].map((m) => m[1]); expect(ext).toEqual(["supabase/setup-cli"]);
  });
  it("Production guard(테스트 코드)는 이중 방어로 유지: Playwright/Integration 이 시작 전에 Production 대상을 거부한다", () => {
    expect(readFileSync(path.join(root, "tests/e2e/fixtures/env.ts"), "utf8")).toContain("assertIntegrationTargetIsNotProduction(process.env);");
    expect(readFileSync(path.join(root, "tests/integration/loadEnv.ts"), "utf8")).toContain("assertIntegrationTargetIsNotProduction(process.env);");
  });
});
