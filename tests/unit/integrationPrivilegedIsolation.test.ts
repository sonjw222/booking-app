// 일반 CI의 integration 경로가 (1) 공유 DEV 계정의 is_platform_admin 임시 승격, (2) 전역 기본 요금제 변경을 하지 않음을 정적으로 고정한다.
// 실행하지 않은 것을 PASS로 세지 않는다: 격리된 테스트는 제외(파일) 또는 SKIP(it.skipIf)로 보고된다.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(root, p), "utf8");
const walk = (dir: string): string[] =>
  readdirSync(path.join(root, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
const integrationFiles = walk("tests/integration").filter((f) => f.endsWith(".ts"));
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe("integration privileged isolation (static)", () => {
  it("일반 integration 설정은 전역 요금제를 바꾸는 subscription-plan-limits 파일을 제외한다", () => {
    const cfg = rd("vitest.integration.config.ts");
    expect(cfg).toContain("configDefaults.exclude");
    expect(cfg).toContain('"tests/integration/subscription-plan-limits.test.ts"');
    expect(rd("vitest.integration.privileged.config.ts")).toContain('"tests/integration/subscription-plan-limits.test.ts"');
  });
  it("공유 계정 승격/기본 요금제 변경 코드는 격리 파일·임시 계정 파일·itPrivileged 게이트 안에만 있다", () => {
    const TEMP_ACCOUNT_ONLY = new Set([
      "tests/integration/accounts-privilege-escalation.test.ts", // 실행마다 만든 임시 계정만 승격, afterAll에서 삭제
      "tests/integration/marketing-consent.test.ts",             // 임시 operator 계정 생성
      "tests/integration/review-reports.test.ts",                // 임시 운영자 계정 생성
    ]);
    const GATED: Record<string, number> = {
      "tests/integration/sec009-batch-a2-rls.test.ts": 2,
      "tests/integration/auto-book-membership-security.test.ts": 1,
    };
    const risky = /is_platform_admin: *true|set_default_subscription_plan|update\(\{ *is_default/;
    for (const f of integrationFiles) {
      const src = rd(f);
      if (!risky.test(src)) continue;
      if (f === "tests/integration/subscription-plan-limits.test.ts" || TEMP_ACCOUNT_ONLY.has(f)) continue;
      const expected = GATED[f];
      expect(expected, `${f}: 격리되지 않은 위험 코드`).toBeDefined();
      expect(count(src, /\bitPrivileged\(/g), f).toBe(expected);
      expect(count(src, /is_platform_admin: *true/g), f).toBe(expected);
      expect(src, f).toContain('from "./privilegedGate"');
    }
  });
  it("게이트는 환경변수 하나로만 열리고, 어떤 workflow·일반 npm 스크립트도 이를 켜거나 privileged 설정을 쓰지 않는다", () => {
    expect(rd("tests/integration/privilegedGate.ts")).toContain('process.env.ALLOW_PRIVILEGED_DEV_TESTS === "1"');
    for (const f of readdirSync(path.join(root, ".github/workflows"))) {
      expect(rd(".github/workflows/" + f), f).not.toMatch(/ALLOW_PRIVILEGED_DEV_TESTS|PRIVILEGED_DEV_TESTS_ACK|integration\.privileged|test:integration:privileged/);
    }
    const scripts = JSON.parse(rd("package.json")).scripts as Record<string, string>;
    for (const [name, cmd] of Object.entries(scripts)) {
      if (name === "test:integration:privileged") continue;
      expect(cmd, name).not.toMatch(/integration\.privileged|ALLOW_PRIVILEGED_DEV_TESTS/);
    }
    expect(scripts["test:integration:privileged"]).toContain("vitest.integration.privileged.config.ts");
  });
  it("수동 스위트는 읽기 전용 사전검사를 가장 먼저 실행하고, 사전검사는 쓰기·권한 변경·자동 복구를 하지 않는다", () => {
    const cfg = rd("vitest.integration.privileged.config.ts");
    expect(cfg).toMatch(/globalSetup: \["tests\/integration\/privilegedPreflight\.ts", /);
    const pre = rd("tests/integration/privilegedPreflight.ts");
    expect(pre).not.toMatch(/\.(insert|update|upsert|delete)\(|\.rpc\(|createUser|deleteUser|updateUserById/);
    expect(pre).toContain("BLOCKED");
    expect(pre).toContain("자동으로 변경하지 않는다");
  });
  it("보안·기능 검증 시나리오(테스트 제목)는 삭제되지 않고 그대로 보존된다", () => {
    const titles: Record<string, string[]> = {
      "tests/integration/sec009-batch-a2-rls.test.ts": ["플랫폼 운영자는 무관한 센터의 계약서도 조회할 수 있다", "플랫폼 운영자는 무관한 센터의 발송기록도 조회할 수 있다"],
      "tests/integration/auto-book-membership-security.test.ts": ["AUTO-SEC-K: platform admin은 centerA와 아무 매니저 관계가 없어도 허용된다"],
      "tests/integration/subscription-plan-limits.test.ts": ["플랫폼 운영자가 아니면 거부된다", "플랫폼 운영자면 성공하고, 정확히 하나의 플랜만 기본으로 남는다"],
    };
    for (const [f, list] of Object.entries(titles)) for (const t of list) expect(rd(f), f).toContain(t);
    // 복구 코드(원래 false 기준)도 그대로 — 이번 변경은 실행 경로 격리뿐이다.
    expect(rd("tests/integration/sec009-batch-a2-rls.test.ts")).toContain("is_platform_admin: false");
  });
});
