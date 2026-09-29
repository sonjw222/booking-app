/*
  supabase/functions/check-signup-email/index.ts + supabase/config.toml 정적 검토
  (2026-09-30 보안 보완). Edge Function은 Deno 런타임 전용(Deno.serve/Deno.env/jsr: import)이라
  Vitest(Node)에서 직접 import/실행할 수 없다 — 이 프로젝트의 기존 관례(다른 Edge Function도
  런타임 단위 테스트가 없음)와 동일하게 소스 텍스트를 정적으로 검토한다. Deno 자체 타입체크는
  `deno check --node-modules-dir=none supabase/functions/check-signup-email/index.ts`로 별도
  실행해 확인했다(최종 보고서 참고).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fn = readFileSync(join(__dirname, "../../supabase/functions/check-signup-email/index.ts"), "utf-8");
const config = readFileSync(join(__dirname, "../../supabase/config.toml"), "utf-8");

describe("check-signup-email — rate limit은 RPC 하나로 원자적으로 처리", () => {
  it("email_check_attempts 테이블을 직접 count/insert하지 않는다(원자성은 DB RPC가 담당)", () => {
    expect(fn).not.toMatch(/\.from\(["']email_check_attempts["']\)/);
  });

  it("consume_email_check_attempt RPC를 호출하고 그 결과(allowed)로만 429를 판단한다", () => {
    expect(fn).toContain('admin.rpc("consume_email_check_attempt", { p_ip_hash: ipHash })');
    expect(fn).toMatch(/if \(allowed !== true\) \{\s*return json\(\{ error: RATE_LIMIT_MESSAGE \}, 429\);/);
  });
});

describe("check-signup-email — raw DB 오류를 클라이언트에 노출하지 않는다", () => {
  it("rate-limit RPC 실패 시 원본 메시지 대신 일반 문구 + 500을 반환하고, 원본은 console.error에만 남긴다", () => {
    const block = fn.slice(fn.indexOf("consume_email_check_attempt"), fn.indexOf("if (allowed !== true)"));
    expect(block).toContain("console.error(");
    expect(block).toContain("return json({ error: GENERIC_ERROR_MESSAGE }, 500);");
    expect(block).not.toMatch(/error:\s*rateLimitErr\.message/);
  });

  it("email_signup_available RPC 실패도 동일하게 처리한다", () => {
    const block = fn.slice(fn.indexOf('admin.rpc("email_signup_available"'));
    expect(block).toContain("console.error(");
    expect(block).toContain("return json({ error: GENERIC_ERROR_MESSAGE }, 500);");
    expect(block).not.toMatch(/error:\s*rpcErr\.message/);
  });

  it("어디에서도 Supabase/Postgres error.message를 그대로 JSON 응답에 싣지 않는다", () => {
    expect(fn).not.toMatch(/json\(\{\s*error:\s*\w*[eE]rr\.message/);
  });

  it("일반 오류/속도 제한 문구가 요구된 정확한 한글 문장과 일치한다", () => {
    expect(fn).toContain('const GENERIC_ERROR_MESSAGE = "이메일 확인 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.";');
    expect(fn).toContain('const RATE_LIMIT_MESSAGE = "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.";');
  });
});

describe("check-signup-email — 클라이언트 IP 판별 우선순위", () => {
  const clientIpFn = fn.slice(fn.indexOf("function clientIp"), fn.indexOf("Deno.serve"));

  it("cf-connecting-ip → x-real-ip → x-forwarded-for(첫 값) → unknown 순서로 확인한다", () => {
    const cfIdx = clientIpFn.indexOf("cf-connecting-ip");
    const realIdx = clientIpFn.indexOf("x-real-ip");
    const fwdIdx = clientIpFn.indexOf("x-forwarded-for");
    const unknownIdx = clientIpFn.indexOf('"unknown"');
    expect(cfIdx).toBeGreaterThan(-1);
    expect(realIdx).toBeGreaterThan(cfIdx);
    expect(fwdIdx).toBeGreaterThan(realIdx);
    expect(unknownIdx).toBeGreaterThan(fwdIdx);
  });

  it("x-forwarded-for는 쉼표로 구분된 첫 번째 값(원 클라이언트)만 사용한다", () => {
    expect(clientIpFn).toContain('forwarded.split(",")[0].trim()');
  });

  it("IP는 해시로만 저장되고 원문은 DB에 전달되지 않는다", () => {
    expect(fn).toContain("await hashIp(clientIp(req))");
    expect(fn).toContain('crypto.subtle.digest("SHA-256"');
  });
});

describe("supabase/config.toml — check-signup-email만 verify_jwt=false", () => {
  it("check-signup-email에 verify_jwt = false가 정확히 설정돼 있다", () => {
    expect(config).toMatch(/\[functions\.check-signup-email\]\s*\nverify_jwt = false/);
  });

  it("다른 함수의 설정은 이 파일에 추가하지 않는다(함수 섹션이 정확히 1개)", () => {
    const functionSections = config.match(/^\[functions\./gm) ?? [];
    expect(functionSections).toHaveLength(1);
  });

  it("project_id 등 다른 인프라 값을 추측해서 넣지 않는다", () => {
    expect(config).not.toMatch(/^project_id/m);
  });
});
