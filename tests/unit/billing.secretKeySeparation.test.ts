/*
  센터 플랫폼 구독(자동결제)의 Toss 시크릿 키를 일반 회원 결제와 분리(2026-10-01).
  - 회원 결제 app/api/payments/confirm → TOSS_SECRET_KEY 그대로
  - 센터 자동결제 app/api/billing/confirm, app/api/billing/charge-due → TOSS_BILLING_SECRET_KEY
  키는 모듈 로드 시점에 읽히므로 vi.resetModules + vi.stubEnv로 경로별 설정 유무를 재현한다.
  실제 토스/Supabase 호출은 하지 않는다(키 검사는 두 서비스 접근보다 앞선다).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => { throw new Error("키 검사 단계에서는 DB에 접근하면 안 돼요"); },
}));

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
// 설명 주석이 forbidden-pattern 검사에 오탐하지 않도록 코드만 본다.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const BILLING_MSG = "결제 서버 설정이 없어요(TOSS_BILLING_SECRET_KEY)";

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("센터 자동결제 route — TOSS_BILLING_SECRET_KEY만 쓴다", () => {
  it("billing/confirm: 회원 결제 키(TOSS_SECRET_KEY)만 있고 빌링 키가 없으면 500 + 정확한 메시지", async () => {
    vi.stubEnv("TOSS_SECRET_KEY", "checkout-key-only");
    vi.stubEnv("TOSS_BILLING_SECRET_KEY", "");
    const { POST } = await import("../../app/api/billing/confirm/route");
    const res = await POST(new Request("http://localhost/api/billing/confirm", { method: "POST", body: JSON.stringify({ authKey: "a", customerKey: "center-c1", centerId: "c1" }) }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(BILLING_MSG);
  });

  it("billing/charge-due: 빌링 키가 없으면(회원 결제 키가 있어도) cron 인증 통과 후 500 + 정확한 메시지", async () => {
    vi.stubEnv("TOSS_SECRET_KEY", "checkout-key-only");
    vi.stubEnv("TOSS_BILLING_SECRET_KEY", "");
    const { POST } = await import("../../app/api/billing/charge-due/route");
    const res = await POST(new Request("http://localhost/api/billing/charge-due", {
      method: "POST", headers: { "x-cron-secret": "unit-test-placeholder-cron-secret" },
    }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(BILLING_MSG);
  });

  it("billing/charge-due: cron 인증이 키 검사보다 먼저다(인증 실패는 401, 키 상태 노출 없음)", async () => {
    vi.stubEnv("TOSS_BILLING_SECRET_KEY", "");
    const { POST } = await import("../../app/api/billing/charge-due/route");
    const res = await POST(new Request("http://localhost/api/billing/charge-due", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("두 route의 Basic 인증 헤더는 TOSS_BILLING_SECRET_KEY로 만들고 TOSS_SECRET_KEY는 코드에서 읽지 않는다", () => {
    for (const p of ["app/api/billing/confirm/route.ts", "app/api/billing/charge-due/route.ts"]) {
      const code = stripComments(read(p));
      expect(code).toContain("const TOSS_BILLING_SECRET_KEY = process.env.TOSS_BILLING_SECRET_KEY;");
      expect(code).toContain("Buffer.from(`${TOSS_BILLING_SECRET_KEY}:`).toString(\"base64\")");
      expect(code).toContain(`결제 서버 설정이 없어요(TOSS_BILLING_SECRET_KEY)`);
      expect(code).not.toMatch(/(?<!BILLING_)SECRET_KEY\b.*process\.env/);
      expect(code).not.toContain("process.env.TOSS_SECRET_KEY");
      expect(code).not.toContain("(TOSS_SECRET_KEY)");
    }
  });
});

describe("일반 회원 결제 route — TOSS_SECRET_KEY 그대로(변경 없음)", () => {
  it("payments/confirm: TOSS_SECRET_KEY가 없으면 기존 메시지로 500", async () => {
    vi.stubEnv("TOSS_SECRET_KEY", "");
    vi.stubEnv("TOSS_BILLING_SECRET_KEY", "billing-key-only");
    const { POST } = await import("../../app/api/payments/confirm/route");
    const res = await POST(new Request("http://localhost/api/payments/confirm", { method: "POST", body: "{}" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("결제 서버 설정이 없어요(TOSS_SECRET_KEY)");
  });

  it("payments/confirm 소스는 빌링 키를 전혀 참조하지 않는다", () => {
    expect(read("app/api/payments/confirm/route.ts")).not.toContain("TOSS_BILLING_SECRET_KEY");
    expect(read("app/api/payments/cancel/route.ts")).not.toContain("TOSS_BILLING_SECRET_KEY");
  });
});

describe("환경 설정 문서/테스트 환경", () => {
  it("vitest 환경에 두 키가 모두 placeholder로 있다(실제 키 아님)", () => {
    const cfg = read("vitest.config.ts");
    expect(cfg).toContain('TOSS_SECRET_KEY: "unit-test-placeholder-toss-secret"');
    expect(cfg).toContain('TOSS_BILLING_SECRET_KEY: "unit-test-placeholder-toss-billing-secret"');
  });

  it(".env.local.example에 TOSS_BILLING_SECRET_KEY가 NEXT_PUBLIC_ 접두사 없이 빈 값으로 안내된다", () => {
    const ex = read(".env.local.example");
    expect(ex).toMatch(/^TOSS_BILLING_SECRET_KEY=$/m);
    expect(ex).not.toContain("NEXT_PUBLIC_TOSS_BILLING_SECRET_KEY");
  });
});
