/*
  CI live-test workflow 정적 contract(실제 CI/네트워크 실행 없음): E2E checkpoint 순차 체인, spec 정확히 한 구간, fail-fast, artifact always upload,
  Unit/Build 독립(cascade skip 방지), Integration live-test serialization, fork/push 게이트, Production guard 입력(env) 전달을 검증한다.
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
const e2e = Object.keys(J).filter((k) => k.startsWith("e2e-"));
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const specs = walk(path.join(root, "tests/e2e")).filter((f) => f.endsWith(".spec.ts")).map((f) => path.relative(root, f).split(path.sep).join("/"));
const pwLine = (b: string) => code(b).split("\n").find((l) => /run: npx playwright test /.test(l))!;
const filters = (b: string) => pwLine(b).split("npx playwright test ")[1].trim().split(/\s+/).filter((t) => !t.startsWith("--") && !t.startsWith("auth"));
const num = (b: string, re: RegExp) => Number(code(b).match(re)![1]);

describe("live-test workflow 구조", () => {
  it("E2E는 4개 checkpoint가 needs 체인으로 순차 실행(matrix/strategy/병렬 없음), 앞 구간 실패에도 계속하되 skipped(push/fork)면 건너뜀", () => {
    expect(e2e).toHaveLength(4);
    expect(code(wf)).not.toMatch(/^\s+strategy:/m);
    expect(code(J[e2e[0]])).not.toMatch(/^    needs:/m);
    for (let i = 1; i < e2e.length; i++) {
      const b = code(J[e2e[i]]);
      expect(b, e2e[i]).toMatch(new RegExp(`^    needs: ${e2e[i - 1]}\\s*$`, "m"));
      expect(b, e2e[i]).toContain(`!cancelled() && needs.${e2e[i - 1]}.result != 'skipped'`);
    }
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
  it("Unit/Build는 E2E와 독립(needs/if cascade 없음)이고 Build는 secrets가 아닌 placeholder env만 쓴다", () => {
    for (const id of ["unit", "build"]) { expect(code(J[id]), id).not.toMatch(/^    needs:/m); expect(code(J[id]), id).not.toMatch(/^    if:/m); expect(J[id], id).not.toContain("secrets."); }
    expect(J.build).toContain("https://build-placeholder.supabase.co");
    expect(J.build).toContain('NEXT_PUBLIC_PG_CHECKOUT_ENABLED: "false"');
  });
  it("live Supabase를 쓰는 job은 모두 한 체인에 직렬화: secrets를 쓰는 job = e2e 4개 + integration, integration은 마지막 E2E 뒤, 저장소 전역 concurrency 유지", () => {
    const live = Object.keys(J).filter((k) => J[k].includes("secrets."));
    expect(live.sort()).toEqual([...e2e, "integration"].sort());
    expect(code(J.integration)).toMatch(new RegExp(`^    needs: ${e2e[e2e.length - 1]}\\s*$`, "m"));
    expect(code(J.integration)).toContain(`!cancelled() && needs.${e2e[e2e.length - 1]}.result != 'skipped'`);
    expect(wf).toMatch(/concurrency:\n  group: shared-live-supabase-tests\n  cancel-in-progress: false/);
    expect(code(wf)).not.toMatch(/continue-on-error/);
  });
  it("push/fork 게이트 유지: 첫 E2E 구간만 직접 게이트(push 제외, fork PR 제외), 나머지 live job은 그 skipped를 상속", () => {
    const first = code(J[e2e[0]]);
    expect(first).toContain("github.event_name != 'push'");
    expect(first).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });
  it("Production guard 입력: live job step이 NEXT_PUBLIC_SUPABASE_URL/키를 secrets에서 env로 전달(가드는 Playwright config / vitest globalSetup에서 이 값을 검사)", () => {
    for (const id of [...e2e, "integration"]) {
      for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) expect(J[id], `${id} ${k}`).toContain(`${k}: \${{ secrets.${k} }}`);
    }
    expect(readFileSync(path.join(root, "tests/e2e/fixtures/env.ts"), "utf8")).toContain("assertIntegrationTargetIsNotProduction(process.env);");
    expect(readFileSync(path.join(root, "tests/integration/loadEnv.ts"), "utf8")).toContain("assertIntegrationTargetIsNotProduction(process.env);");
  });
});
