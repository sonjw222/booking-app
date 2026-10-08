import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redact, summarizeResult } from "../e2e/diagnosticsReporter";

const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJyZWYiOiJ4eCJ9.signaturepart";
describe("E2E diagnostics reporter", () => {
  it("JWT와 민감 환경변수 값(password/key/secret/token/email)을 출력 전에 가린다", () => {
    const env = { TEST_USER_A_PASSWORD: "S3cretPw!", SUPABASE_SERVICE_ROLE_KEY: fakeJwt, TEST_USER_A_EMAIL: "a@example.test", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SHORT_PASSWORD: "ab" };
    const out = redact(`fill S3cretPw! for a@example.test with ${fakeJwt} at https://x.supabase.co`, env);
    expect(out).not.toContain("S3cretPw!"); expect(out).not.toContain("a@example.test"); expect(out).not.toContain(fakeJwt);
    expect(out).toContain("https://x.supabase.co");   // 비민감 값은 유지
    expect(out).toContain("[REDACTED:TEST_USER_A_PASSWORD]"); expect(out).toContain("[JWT]");
  });
  it("실패/timeout만 한 줄 요약(+에러 앞부분), 통과/skip은 출력 없음, 에러가 길어도 900자 이내", () => {
    const test = { title: "t", location: { file: "/repo/tests/e2e/admin/attendance.spec.ts", line: 102, column: 1 }, outcome: () => "unexpected" as const };
    const base = { retry: 1, duration: 61_000, attachments: [{ name: "trace", contentType: "x" }], errors: [{ message: "Test timeout of 60000ms exceeded.\n".repeat(100), location: { file: "/repo/tests/e2e/admin/attendance.spec.ts", line: 112, column: 3 } }] };
    expect(summarizeResult(test as never, { ...base, status: "passed" } as never)).toBeNull();
    expect(summarizeResult(test as never, { ...base, status: "skipped" } as never)).toBeNull();
    const line = summarizeResult(test as never, { ...base, status: "timedOut" } as never)!;
    expect(line).toContain("[e2e-diag] TIMEDOUT retry=1 61s e2e/admin/attendance.spec.ts:102");
    expect(line).toContain("(attachments: trace)");
    expect(line.length).toBeLessThan(1300);
  });
  it("playwright.config가 reporter를 등록하고 CI에서 github reporter를 추가한다(기존 html/list 유지, trace/screenshot/video retain-on-failure 유지)", () => {
    const cfg = readFileSync(path.resolve(__dirname, "../../playwright.config.ts"), "utf8");
    for (const r of ['["html"', '["list"]', "./tests/e2e/diagnosticsReporter.ts", '[["github"]]']) expect(cfg).toContain(r);
    expect(cfg).toMatch(/trace: "retain-on-failure"/); expect(cfg).toMatch(/screenshot: "only-on-failure"/); expect(cfg).toMatch(/video: "retain-on-failure"/);
  });
});
