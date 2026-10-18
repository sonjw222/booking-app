// @vitest-environment node
/* E2E DB 쓰기 경로 전체에 격리 DB 가드가 걸려 있는지 오프라인으로 확인한다(네트워크·DB 접속 없음).
   공유 DEV/Production ref는 선언·ACK와 무관하게 항상 거부, 훅은 admin client·계정 생성 직전에 동작, globalSetup은 기본 거부. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  ALWAYS_DENIED_PROJECT_REFS, SHARED_DEV_PROJECT_REF, ISOLATED_DB_ACK_PHRASE, IsolatedTestDbGuardError, assertIsolatedTestDb,
} from "../e2e/fixtures/isolatedTestDbGuard";
import { e2eRunAllowed } from "../e2e/globalSetup";

const PROD = "bxntqggkfwnhcczsbqtj";
const DEV = "jdglfvwdnkjnraqdxuuj";
const FAKE = "abcdefghij0123456789";
const jwt = (ref: string) => `h.${Buffer.from(JSON.stringify({ ref })).toString("base64url")}.s`;
const full = (ref: string, over: Record<string, string> = {}): Record<string, string> => ({
  ISOLATED_TEST_DB_PROJECT_REF: ref, ISOLATED_TEST_DB_ACK: ISOLATED_DB_ACK_PHRASE, NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`, ...over,
});
const blocked = (env: Record<string, string | undefined>) => { try { assertIsolatedTestDb(env); } catch (e) { expect(e).toBeInstanceOf(IsolatedTestDbGuardError); return (e as Error).message; } throw new Error("가드가 통과함"); };

describe("공유 DEV·Production ref는 어떤 선언·ACK로도 거부", () => {
  it("고정 거부 목록에 두 ref가 모두 있다", () => {
    expect(SHARED_DEV_PROJECT_REF).toBe(DEV);
    expect(ALWAYS_DENIED_PROJECT_REFS).toEqual(expect.arrayContaining([PROD, DEV]));
  });
  for (const [name, ref] of [["공유 DEV", DEV], ["Production", PROD]] as const) {
    it(`${name}: 선언+ACK+URL 일치 모두 맞춰도 거부`, () => expect(blocked(full(ref))).toMatch(/Production 또는 공유 DEV/));
    it(`${name}: SHARED_DEV_PROJECT_REFS가 비어 있어도 거부`, () => blocked(full(ref, { SHARED_DEV_PROJECT_REFS: "" })));
    it(`${name}: 다른 ref를 선언하고 URL만 ${name}이면 거부`, () => blocked(full(FAKE, { NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co` })));
    it(`${name}: 선언은 격리 ref, 키(service/anon)만 ${name} 것이어도 거부`, () => {
      blocked(full(FAKE, { SUPABASE_SERVICE_ROLE_KEY: jwt(ref) }));
      blocked(full(FAKE, { NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt(ref) }));
    });
    it(`${name}: URL 변형(대문자·끝 점·경로·userinfo·하위 도메인)도 거부`, () => {
      for (const u of [`https://${ref.toUpperCase()}.supabase.co`, `https://${ref}.supabase.co.`, `https://${ref}.supabase.co/rest/v1`, `https://u:p@${ref}.supabase.co`, `https://x.${ref}.supabase.co`, `https://evil.example/?h=${ref}.supabase.co`]) {
        blocked(full(FAKE, { NEXT_PUBLIC_SUPABASE_URL: u }));
      }
    });
    it(`${name}: SUPABASE_URL 쪽에 있어도 거부`, () => blocked(full(FAKE, { SUPABASE_URL: `https://${ref}.supabase.co` })));
    it(`${name}: 대문자·공백으로 선언해도 거부`, () => blocked(full(` ${ref.toUpperCase()} `)));
  }
  it("설정이 없거나 불확실하면 거부(fail closed)", () => {
    blocked({});
    blocked({ ISOLATED_TEST_DB_ACK: ISOLATED_DB_ACK_PHRASE });
    blocked(full(FAKE, { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }));
  });
  it("ACK만으로는 허용되지 않는다", () => blocked({ ISOLATED_TEST_DB_ACK: ISOLATED_DB_ACK_PHRASE, NEXT_PUBLIC_SUPABASE_URL: `https://${DEV}.supabase.co` }));
  it("정상 격리 설정은 통과하고 오류 메시지에 값이 노출되지 않는다", () => {
    expect(() => assertIsolatedTestDb(full(FAKE))).not.toThrow();
    expect(blocked(full(DEV, { SUPABASE_SERVICE_ROLE_KEY: jwt("secretsecretsecret12") }))).not.toContain("secretsecretsecret12");
  });
});

describe("globalSetup — 기본 거부", () => {
  it("격리 DB가 아니면 중단, 격리 DB면 허용", () => {
    expect(e2eRunAllowed({}).ok).toBe(false);
    expect(e2eRunAllowed(full(DEV)).ok).toBe(false);
    expect(e2eRunAllowed(full(PROD)).ok).toBe(false);
    expect(e2eRunAllowed(full(FAKE)).ok).toBe(true);
  });
  it("읽기 전용 페이지네이션 러너(RUN_ADMIN_PAGINATION=1)만 격리 DB 없이 통과하며, 그래도 admin client·계정 생성은 훅이 막는다", () => {
    expect(e2eRunAllowed({ RUN_ADMIN_PAGINATION: "1" }).ok).toBe(true);
    expect(e2eRunAllowed({ RUN_ADMIN_PAGINATION: "true" }).ok).toBe(false);
  });
  it("playwright.config.ts가 globalSetup을 등록하고 env.ts가 훅을 설치한다", () => {
    expect(readFileSync("playwright.config.ts", "utf8")).toMatch(/globalSetup:\s*"\.\/tests\/e2e\/globalSetup\.ts"/);
    expect(readFileSync("tests/e2e/fixtures/env.ts", "utf8")).toMatch(/import "\.\/installWriteGate"/);
    expect(readFileSync("tests/e2e/fixtures/testData.ts", "utf8")).toMatch(/import "\.\/installWriteGate"/);
  });
});

describe("integration/setup.ts 훅 — admin client·계정 생성 직전", () => {
  const src = readFileSync("tests/integration/setup.ts", "utf8");
  it("getFixtureAdminClient는 캐시 확인보다 먼저 훅을 호출한다", () => {
    const body = src.slice(src.indexOf("export function getFixtureAdminClient"));
    expect(body.indexOf("assertFixtureWriteAllowed(")).toBeGreaterThan(-1);
    expect(body.indexOf("assertFixtureWriteAllowed(")).toBeLessThan(body.indexOf("if (adminClient) return adminClient"));
    expect(body.indexOf("assertFixtureWriteAllowed(")).toBeLessThan(body.indexOf("createClient("));
  });
  it("signUp·accounts INSERT·profiles INSERT 직전에 훅을 호출한다", () => {
    for (const [hook, op] of [["테스트 계정 signUp", "auth.signUp("], ["accounts INSERT", '.from("accounts")\n        .insert'], ["profiles INSERT", '.from("profiles")\n        .insert']] as const) {
      const h = src.indexOf(`assertFixtureWriteAllowed("${hook}")`); const o = src.indexOf(op, h);
      expect(h, hook).toBeGreaterThan(-1); expect(o, op).toBeGreaterThan(h); expect(o - h).toBeLessThan(200);
    }
  });
  it("훅이 설치되지 않은 integration 프로세스에서는 동작이 바뀌지 않는다(함수형 훅이 있을 때만 호출)", () => {
    expect(src).toContain('typeof gate === "function"');
  });
});

describe("훅 동작(실제 setup.ts 로드, 네트워크 없음)", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); delete (globalThis as Record<symbol, unknown>)[Symbol.for("mwhabit.fixtureWriteGate")]; });
  const stub = (env: Record<string, string>) => { for (const [k, v] of Object.entries({ TEST_CENTER_ID: "c", TEST_PRODUCT_ID: "p", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "x", ...env })) vi.stubEnv(k, v); };

  it("훅 설치 + 공유 DEV 설정이면 getFixtureAdminClient가 client를 만들기 전에 BLOCKED로 던진다", async () => {
    stub(full(DEV));
    await import("../e2e/fixtures/installWriteGate");
    const setup = await import("../integration/setup");
    expect(() => setup.getFixtureAdminClient()).toThrow(/BLOCKED/);
  });
  it("훅 설치 + 설정 없음이어도 던진다(캐시 우회 없음)", async () => {
    stub({ NEXT_PUBLIC_SUPABASE_URL: `https://${FAKE}.supabase.co` });
    await import("../e2e/fixtures/installWriteGate");
    const setup = await import("../integration/setup");
    expect(() => setup.getFixtureAdminClient()).toThrow(/BLOCKED/);
  });
  it("훅이 없으면(integration 프로세스) 가드 오류가 아니라 기존 service_role 검증 오류가 난다 = 기존 동작 유지", async () => {
    stub(full(FAKE));
    const setup = await import("../integration/setup");
    expect(() => setup.getFixtureAdminClient()).toThrow(/service_role/);
  });
});

describe("모든 E2E 쓰기 진입점이 훅을 거친다(정적)", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });
  const e2e = files("tests/e2e");
  it("E2E에서 SUPABASE_SERVICE_ROLE_KEY로 직접 client를 만드는 코드가 없다(getFixtureAdminClient 단일 진입점)", () => {
    const offenders = e2e.filter((f) => /SERVICE_ROLE_KEY/.test(readFileSync(f, "utf8")) && !f.endsWith("isolatedTestDbGuard.ts") && !f.endsWith("globalSetup.ts"));
    expect(offenders).toEqual([]);
  });
  it("admin 쓰기를 하는 spec은 모두 env.ts 훅이 설치되는 playwright.config 아래에서만 실행된다(별도 playwright 설정 없음)", () => {
    const configs = readdirSync(".").filter((n) => /^playwright.*\.config\.[cm]?[jt]s$/.test(n));
    // #230(UX)이 추가한 두 설정은 공유 DEV를 쓰지 않는 UI 검증 전용이다 — 허용 목록에 명시하고, 아래 테스트가 그 전제(e2e 스펙 미실행·실제 Supabase 미접속)를 확인한다.
    expect(configs.sort()).toEqual(["playwright.config.ts", "playwright.mock.config.ts", "playwright.real.config.ts"]);
  });
  it("UI 전용 설정(mock/real)은 tests/e2e를 실행하지 않고 실제 Supabase 프로젝트를 가리키지 않는다(가짜 ref 또는 로컬 127.0.0.1만)", () => {
    for (const [file, dir] of [["playwright.mock.config.ts", "./tests/ui-mock"], ["playwright.real.config.ts", "./tests/ui-real"]] as const) {
      const cfg = readFileSync(file, "utf8");
      expect(cfg).toContain(`testDir: "${dir}"`);
      expect(cfg).not.toContain("tests/e2e");
      for (const m of cfg.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        const host = m[1].toLowerCase();
        if (host.endsWith(".supabase.co")) expect(host).toBe("abcdefghij0123456789.supabase.co");
      }
      for (const ref of ALWAYS_DENIED_PROJECT_REFS) expect(cfg).not.toContain(ref);
    }
  });
});

describe("RUN_ADMIN_PAGINATION 면제는 페이지네이션 스펙 하나로 고정된다 (환경변수만으로 다른 스펙 실행 불가)", () => {
  const cfg = readFileSync("playwright.config.ts", "utf8");
  it("면제 모드에서는 chromium 프로젝트 testMatch가 admin-center-pagination.spec.ts뿐이다", () => {
    expect(cfg).toContain('process.env.RUN_ADMIN_PAGINATION === "1"');
    expect(cfg).toMatch(/ADMIN_PAGINATION_ONLY \? \{ testMatch: ADMIN_PAGINATION_SPEC \}/);
    expect(cfg).toMatch(/admin-center-pagination\\\.spec\\\.ts\$/);
  });
});
