/*
  통합 테스트 Production 차단 가드 단위 테스트 — 순수 함수 + loadEnv(실제 파일)를 stubEnv로만 검증한다.
  네트워크/Supabase 접근 없음(global fetch/WebSocket을 감시해 호출되면 실패), .env.test.local 값에 의존하지 않는다(모든 값은 이 파일의 placeholder).
*/
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KNOWN_PRODUCTION_PROJECT_REFS, assertIntegrationTargetIsNotProduction, productionRefInUrl, projectRefFromSupabaseKey,
} from "../integration/productionGuard";

const PROD = "bxntqggkfwnhcczsbqtj";
const PROD_URL = `https://${PROD}.supabase.co`;
const DEV_URL = "https://aaaaaaaaaaaaaaaaaaaa.supabase.co";
const jwt = (payload: object) => `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); expect(fetchSpy).not.toHaveBeenCalled(); });

describe("assertIntegrationTargetIsNotProduction (순수 함수)", () => {
  it("A. Production URL이면 hard fail(메시지에 project ref와 변수 이름만, URL/키 값은 없음)", () => {
    const run = () => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: PROD_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: "SECRET-ANON-VALUE" });
    expect(run).toThrow(/Production Supabase\(bxntqggkfwnhcczsbqtj\)/);
    expect(run).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    try { run(); } catch (e) { expect(String((e as Error).message)).not.toContain("SECRET-ANON-VALUE"); expect(String((e as Error).message)).not.toContain(PROD_URL); }
  });
  it("B. trailing slash / 경로 / 포트 / 대문자 / 공백 / userinfo / trailing dot / 스킴 없음 변형도 차단", () => {
    for (const v of [`${PROD_URL}/`, `${PROD_URL}//`, `${PROD_URL}/rest/v1/`, `${PROD_URL}:443`, `HTTPS://${PROD.toUpperCase()}.SUPABASE.CO`, `  ${PROD_URL}  `, `https://user:pw@${PROD}.supabase.co`,
      `https://${PROD}.supabase.co.`, `${PROD}.supabase.co`, `https://${PROD}.supabase.in`, `https://${PROD}.supabase.co?x=1#y`]) {
      expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: v }), v).toThrow(/Production Supabase/);
    }
  });
  it("C. PRODUCTION_SUPABASE_URL이 없어도 알려진 project ref만으로 차단 / SUPABASE_URL 변수도 확인", () => {
    expect(process.env.PRODUCTION_SUPABASE_URL ?? "").toBe("");
    expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: PROD_URL })).toThrow();
    expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: DEV_URL, SUPABASE_URL: PROD_URL })).toThrow(/SUPABASE_URL/);
  });
  it("파싱할 수 없는 값이어도 ref가 들어 있으면 차단(fail closed)", () => {
    for (const v of [`not a url ${PROD}`, `http://[${PROD}`, `${PROD}`]) expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: v }), v).toThrow();
  });
  it("커스텀 도메인/프록시여도 anon/service-role 키(JWT)의 ref claim이 Production이면 차단", () => {
    const k = jwt({ iss: "supabase", ref: PROD, role: "service_role" });
    expect(projectRefFromSupabaseKey(k)).toBe(PROD);
    for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"]) {
      expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test", [name]: k }), name).toThrow(new RegExp(name));
    }
    expect(projectRefFromSupabaseKey("garbage")).toBeNull();
    expect(projectRefFromSupabaseKey(jwt({ ref: "aaaaaaaaaaaaaaaaaaaa" }))).toBe("aaaaaaaaaaaaaaaaaaaa");
  });
  it("D. 개발 Supabase URL(placeholder)이면 통과 — 네트워크 요청 없음, 다른 ref의 키도 통과, 값이 비어 있어도 이 가드는 통과(필수 env는 loadEnv가 별도 검증)", () => {
    expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: DEV_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ ref: "aaaaaaaaaaaaaaaaaaaa" }), SUPABASE_SERVICE_ROLE_KEY: "placeholder" })).not.toThrow();
    expect(() => assertIntegrationTargetIsNotProduction({})).not.toThrow();
    expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: "" })).not.toThrow();
    expect(productionRefInUrl("https://bbbbbbbbbbbbbbbbbbbb.supabase.co")).toBeNull();
  });
  it("E. 기존 PRODUCTION_SUPABASE_URL 비교 방어선도 유지(다른 URL을 운영으로 등록해도 같으면 차단, trailing slash 무시, 다르면 통과)", () => {
    const other = "https://cccccccccccccccccccc.supabase.co";
    expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: other, PRODUCTION_SUPABASE_URL: other })).toThrow(/PRODUCTION_SUPABASE_URL/);
    expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: `${other}/`, PRODUCTION_SUPABASE_URL: other })).toThrow();
    expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: DEV_URL, PRODUCTION_SUPABASE_URL: other })).not.toThrow();
  });
  it("알려진 Production ref는 QA runner 가드와 같은 단일 출처", () => {
    expect(KNOWN_PRODUCTION_PROJECT_REFS).toEqual([PROD]);
  });
});

const REQUIRED_PLACEHOLDERS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon", TEST_USER_A_EMAIL: "a@example.test", TEST_USER_A_PASSWORD: "x", TEST_USER_B_EMAIL: "b@example.test", TEST_USER_B_PASSWORD: "x",
  TEST_CENTER_ID: "00000000-0000-4000-8000-000000000000", TEST_PRODUCT_ID: "00000000-0000-4000-8000-000000000001",
};
const stubAll = (url: string) => { vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url); for (const [k, v] of Object.entries(REQUIRED_PLACEHOLDERS)) vi.stubEnv(k, v); };

describe("tests/integration/loadEnv.ts (실제 파일 — test:integration / test:all / qa:business:*의 첫 단계)", () => {
  it("Production URL이면 import 자체가 throw — 필수 env가 모두 있어도, 일부만 있어도(필수 env 누락 오류보다 먼저) Production 오류", async () => {
    stubAll(PROD_URL);
    await expect(import("../integration/loadEnv")).rejects.toThrow(/Production Supabase\(bxntqggkfwnhcczsbqtj\)/);
    vi.resetModules(); vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `${PROD_URL}/`);                         // trailing slash + 다른 필수 env 없음
    for (const k of Object.keys(REQUIRED_PLACEHOLDERS)) vi.stubEnv(k, "");
    await expect(import("../integration/loadEnv")).rejects.toThrow(/Production Supabase/);
  });
  it("개발 URL(placeholder)이면 통과", async () => {
    stubAll(DEV_URL);
    await expect(import("../integration/loadEnv")).resolves.toBeDefined();
  });
  it("globalSetup은 loadEnv를 첫 import로 로드하고, integration config는 globalSetup+setupFiles 모두에서 loadEnv를 거치며, test:all은 test:integration을 호출한다(정적 계약)", () => {
    const root = path.resolve(__dirname, "../..");
    const gs = readFileSync(path.join(root, "tests/integration/globalSetup.ts"), "utf8");
    expect(gs.split("\n").find((l) => l.startsWith("import "))).toBe('import "./loadEnv";');
    const cfg = readFileSync(path.join(root, "vitest.integration.config.ts"), "utf8");
    expect(cfg).toContain('globalSetup: ["tests/integration/globalSetup.ts"]');
    expect(cfg).toContain('setupFiles: ["tests/integration/loadEnv.ts"]');
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;
    expect(pkg["test:integration"]).toContain("vitest.integration.config.ts");
    expect(pkg["test:all"]).toContain("npm run test:integration");
    for (const [name, cmd] of Object.entries<string>(pkg)) if (name.startsWith("qa:business:")) expect(cmd, name).toContain("vitest.integration.config.ts");   // 같은 가드를 탄다
  });
  it("Production QA runner는 영향받지 않는다: qa-production config/qaEnv는 integration loadEnv/가드를 import하지 않고 자체 QA 가드(QA_TARGET_PROJECT_REF+ACK)를 쓴다", () => {
    const root = path.resolve(__dirname, "../..");
    const qaCfg = readFileSync(path.join(root, "vitest.qa-production.config.ts"), "utf8");
    const qaEnv = readFileSync(path.join(root, "tests/qa/qaEnv.ts"), "utf8");
    expect(qaCfg).toContain('setupFiles: ["tests/qa/qaEnv.ts"]');
    expect(qaCfg).not.toMatch(/integration\/(loadEnv|productionGuard|globalSetup)/);
    expect(qaEnv).not.toMatch(/productionGuard|integration\/loadEnv/);
    expect(qaEnv).toContain("assertProductionQaAllowed");
    expect(readFileSync(path.join(root, "tests/integration/setup.ts"), "utf8")).not.toMatch(/productionGuard|assertIntegrationTargetIsNotProduction/);   // QA가 재사용하는 helper에는 가드를 넣지 않는다
  });
});

describe("tests/e2e/fixtures/env.ts (Playwright — playwright.config.ts가 가장 먼저 import)", () => {
  const E2E_ENV: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon", TEST_MANAGER_A_EMAIL: "m@example.test", TEST_MANAGER_A_PASSWORD: "x", TEST_USER_A_EMAIL: "a@example.test",
    TEST_USER_A_PASSWORD: "x", TEST_USER_B_EMAIL: "b@example.test", TEST_USER_B_PASSWORD: "x",
  };
  const stubE2e = (url: string, extra: Record<string, string> = {}) => { vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url); for (const [k, v] of Object.entries({ ...E2E_ENV, ...extra })) vi.stubEnv(k, v); };
  it("Production URL(변형 포함)이면 import(= Playwright config 로드) 자체가 throw — 브라우저/webServer 시작 전", async () => {
    for (const url of [PROD_URL, `${PROD_URL}/`, `HTTPS://${PROD.toUpperCase()}.supabase.co`]) {
      vi.resetModules(); vi.unstubAllEnvs(); stubE2e(url);
      await expect(import("../e2e/fixtures/env"), url).rejects.toThrow(/Production Supabase\(bxntqggkfwnhcczsbqtj\)/);
    }
  });
  it("Production 키(JWT ref)면 URL이 개발용 도메인이어도 차단", async () => {
    stubE2e("https://db.example.test", { SUPABASE_SERVICE_ROLE_KEY: jwt({ ref: PROD, role: "service_role" }) });
    await expect(import("../e2e/fixtures/env")).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
  it("대상 URL을 확인할 수 없으면(빈 값) 시작하지 않는다(webServer가 .env.local을 읽는 것 방지)", async () => {
    stubE2e("");
    await expect(import("../e2e/fixtures/env")).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
  it("개발 URL(placeholder)이면 통과하고 requireE2eEnv도 통과, malformed 값은 크래시 없이 처리(ref가 없으면 통과/있으면 차단)", async () => {
    stubE2e(DEV_URL);
    const mod = await import("../e2e/fixtures/env");
    expect(() => mod.requireE2eEnv()).not.toThrow();
    expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: "%%%not a url%%%" })).not.toThrow();
    expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_URL: "%%%" + PROD })).toThrow();
    expect(() => assertIntegrationTargetIsNotProduction({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "a.b" , SUPABASE_SERVICE_ROLE_KEY: "###.###.###" })).not.toThrow();
  });
  it("정책 drift 방지: integration loadEnv와 e2e env가 같은 helper 모듈/함수를 쓰고 playwright.config가 e2e env를 최상단에서 import", () => {
    const root = path.resolve(__dirname, "../..");
    const rd = (f: string) => readFileSync(path.join(root, f), "utf8");
    for (const f of ["tests/integration/loadEnv.ts", "tests/e2e/fixtures/env.ts"]) {
      const src = rd(f);
      expect(src, f).toMatch(/import \{ assertIntegrationTargetIsNotProduction \} from "[./]+(?:integration\/)?productionGuard"/);
      expect(src, f).toContain("assertIntegrationTargetIsNotProduction(process.env);");
      expect(src.indexOf("assertIntegrationTargetIsNotProduction(process.env)"), f).toBeLessThan(src.indexOf("REQUIRED"));   // 필수 env 검증보다 먼저
    }
    const cfg = rd("playwright.config.ts");
    expect(cfg.split("\n").find((l) => l.startsWith("import "))).toContain('import { defineConfig, devices }');
    expect(cfg.indexOf('import "./tests/e2e/fixtures/env"')).toBeGreaterThan(-1);
    expect(cfg.indexOf('import "./tests/e2e/fixtures/env"')).toBeLessThan(cfg.indexOf("defineConfig({"));
    // helper 자체는 순수(네트워크/Supabase client 없음)
    const helper = rd("tests/integration/productionGuard.ts");
    expect(helper).not.toMatch(/createClient|fetch\(|supabase-js/);
  });
});
