/*
  live Supabase 진입점 감사(2026-10-07) — 어떤 npm script/config/workflow가 live DB에 닿는지, 각각 어떤 guard를 타는지 정적으로 고정한다.
  분류: A unit(네트워크 없음) / B 비-production live(guard 필수) / C 의도적 Production QA(별도 승인 구조) / D build only.
*/
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const rd = (f: string) => readFileSync(path.join(root, f), "utf8");
const scripts: Record<string, string> = JSON.parse(rd("package.json")).scripts;

describe("live-test 진입점", () => {
  it("A. unit(test, test:unit)은 unit config만, 그 config는 tests/unit만 포함하고 placeholder env를 주입한다", () => {
    expect(scripts.test).toBe("vitest run --config vitest.config.ts");
    expect(scripts["test:unit"]).toBe(scripts.test);
    const cfg = rd("vitest.config.ts");
    expect(cfg).toContain('include: ["tests/unit/**/*.test.ts"]');
    expect(cfg).toContain("unit-test-placeholder.supabase.co");
  });
  it("B. test:integration / test:e2e / qa:business:*는 모두 loadEnv/playwright config(= productionGuard)를 타고, test:all은 integration을 포함한다(이름과 달리 live 포함)", () => {
    expect(scripts["test:integration"]).toContain("vitest.integration.config.ts");
    expect(scripts["test:e2e"]).toBe("playwright test");
    for (const [k, v] of Object.entries(scripts)) if (k.startsWith("qa:business:")) expect(v, k).toContain("vitest.integration.config.ts");
    expect(scripts["test:all"]).toMatch(/^echo "\[test:all\] unit \+ LIVE integration[^"]*" && npm run test && npm run test:integration$/);   // live 포함 경고를 먼저 출력
    expect(scripts["test:live:integration"]).toBe(scripts["test:integration"]); expect(scripts["test:live:e2e"]).toBe(scripts["test:e2e"]);   // 이름만 live를 드러낸 별칭
    const ic = rd("vitest.integration.config.ts");
    expect(ic).toContain('globalSetup: ["tests/integration/globalSetup.ts"]'); expect(ic).toContain('setupFiles: ["tests/integration/loadEnv.ts"]');
    expect(ic).toContain('include: ["tests/integration/**/*.test.ts"]');
    expect(rd("tests/integration/globalSetup.ts").split("\n").find((l) => l.startsWith("import "))).toBe('import "./loadEnv";');
    expect(rd("tests/integration/loadEnv.ts")).toContain("assertIntegrationTargetIsNotProduction(process.env);");
    expect(rd("tests/e2e/fixtures/env.ts")).toContain("assertIntegrationTargetIsNotProduction(process.env);");
    expect(rd("playwright.config.ts")).toContain('import "./tests/e2e/fixtures/env";');
  });
  it("C. qa:production:*는 별도 config(tests/qa만)와 qaEnv의 자체 승인 가드를 쓰고, integration/unit/all과 섞이지 않는다", () => {
    for (const [k, v] of Object.entries(scripts)) if (k.startsWith("qa:production:")) expect(v, k).toContain("vitest.qa-production.config.ts");
    const qa = rd("vitest.qa-production.config.ts");
    expect(qa).toContain('include: ["tests/qa/**/*.qa.test.ts"]'); expect(qa).toContain('setupFiles: ["tests/qa/qaEnv.ts"]');
    expect(rd("vitest.integration.config.ts")).not.toContain("tests/qa"); expect(rd("vitest.config.ts")).not.toContain("tests/qa");
    expect(scripts["test:all"]).not.toContain("qa:production");
    const guard = rd("tests/qa/guard.ts");   // 정확한 Production ref + QA_TARGET_PROJECT_REF 일치 + ACK + service role 요구
    for (const need of ["PRODUCTION_PROJECT_REF", "QA_TARGET_PROJECT_REF", 'QA_PRODUCTION_ACK !== "1"', "SUPABASE_SERVICE_ROLE_KEY"]) expect(guard, need).toContain(need);
    expect(rd("tests/qa/qaEnv.ts")).toContain("assertProductionQaAllowed(process.env);");
    expect(rd("tests/qa/qaEnv.ts")).not.toMatch(/integration\/(loadEnv|productionGuard)/);   // 일반 guard가 QA를 막지도, QA가 일반 guard를 우회하지도 않음
  });
  it("D. build/dev는 live 테스트가 아니다 / 수동 모바일 QA workflow는 workflow_dispatch 전용(그리고 최소 권한)", () => {
    expect(scripts.build).toBe("next build");
    const m = rd(".github/workflows/mobile-ui-qa.yml");
    const onBlock = m.slice(m.indexOf("\non:"), m.indexOf("\npermissions:"));   // 트리거 블록만 검사(본문 스크립트의 'push:' 문자열과 구분)
    expect(onBlock).toMatch(/on:\n  workflow_dispatch:/); expect(onBlock).not.toMatch(/pull_request|push/);
    expect(m).toMatch(/permissions:\n  contents: read/);
  });
  it("E→C. mobile-ui-qa는 server.url=Production을 여는 의도적 Production QA라 ACK 입력 없이는 어떤 job도 시작되지 않는다", () => {
    expect(rd("capacitor.config.ts")).toContain('url: "https://mwhabit.com"');
    const m = rd(".github/workflows/mobile-ui-qa.yml");
    expect(m).toMatch(/production_qa_ack:\n\s+description:[^\n]*\n\s+required: true/);
    expect(m).toContain('[ "$ACK" != "I-ACK-THIS-RUNS-AGAINST-PRODUCTION" ]');
    expect(m).toContain("ACK: ${{ inputs.production_qa_ack }}");   // 입력은 env로 전달(스크립트 인젝션 방지)
    expect(m.match(/\n    needs: production-qa-ack/g)?.length).toBe(2);   // android + ios
    expect(m).toMatch(/retention-days: 3/); expect(m).not.toMatch(/retention-days: 14/);
  });
  it("workflow 전수 목록: 이 두 개뿐이며 각각 분류가 있다(새 workflow가 생기면 이 테스트가 분류를 요구한다)", async () => {
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(path.join(root, ".github/workflows")).sort()).toEqual(["mobile-ui-qa.yml", "test.yml"]);   // test.yml=B(비-production live, preflight+guard), mobile-ui-qa.yml=C(ACK)
  });
});
