import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// send-phone-otp: 번호별 제한 유지 + IP/전역 한도 추가 + DEV 우회 회귀 없음(정적 계약; 실제 RPC 의미는 tests/sql/phone-otp-send-limits.test.mjs).
const src = readFileSync("supabase/functions/send-phone-otp/index.ts", "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const at = (needle: string) => { const i = code.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };

describe("send-phone-otp 남용 제한", () => {
  it("기존 번호별 제한(60초 쿨다운, 시간당 5회)이 그대로 있다", () => {
    expect(code).toContain("const RESEND_COOLDOWN_SECONDS = 60;"); expect(code).toContain("const HOURLY_SEND_CAP = 5;");
    expect(code).toContain("잠시 후 다시 시도해주세요"); expect(code).toContain("너무 많이 요청됐어요. 1시간 후 다시 시도해주세요");
  });
  it("IP/전역 한도 RPC는 번호별 확인 뒤, 코드 저장(create_phone_verification)·발송 앞에서 호출한다", () => {
    expect(at("consume_phone_otp_send_attempt")).toBeGreaterThan(at("sentLastHour >= HOURLY_SEND_CAP"));
    expect(at("consume_phone_otp_send_attempt")).toBeLessThan(at("create_phone_verification"));
    expect(at("consume_phone_otp_send_attempt")).toBeLessThan(at("sendViaAligo({"));
  });
  it("기본 한도: IP 시간당 10, 전역 일 500(환경변수로 조정 가능)", () => {
    expect(code).toContain('envInt("OTP_IP_HOURLY_CAP", 10)'); expect(code).toContain('envInt("OTP_GLOBAL_DAILY_CAP", 500)');
  });
  it("DEV 우회(PHONE_OTP_TEST_BYPASS_PREFIX) 번호는 한도 RPC를 건너뛰고 devCode 응답은 그대로", () => {
    expect(code).toContain('const isTestBypass = !!TEST_BYPASS_PREFIX && phone.startsWith(TEST_BYPASS_PREFIX);');
    const guard = code.slice(at("if (!isTestBypass) {"), at("if (isTestBypass) {"));
    expect(guard).toContain("consume_phone_otp_send_attempt");
    expect(code).toContain("return json({ sent: true, devCode: code });");
  });
  it("판정 결과 처리: ip_limit 429, global_limit 503, RPC 오류는 fail-closed(미적용 마이그레이션 코드만 fail-open)", () => {
    expect(code).toContain('verdict === "ip_limit"'); expect(code).toContain("429");
    expect(code).toContain('verdict === "global_limit"'); expect(code).toMatch(/limitErr\.code === "42883" \|\| limitErr\.code === "PGRST202"/);
    expect(code).toMatch(/return json\(\{ error: "인증번호를 보내지 못했어요[^"]*" \}, 503\)/);
  });
  it("IP는 SHA-256 해시만 RPC에 보내고 평문 IP/전화번호를 로그에 남기지 않는다", () => {
    expect(code).toContain("crypto.subtle.digest(\"SHA-256\""); expect(code).toContain("p_ip_hash: await hashIp(clientIp(req))");
    // 문자열 리터럴(메시지 문구) 밖의 식별자만 본다 — 로그 인자로 phone/IP/요청 객체/body를 넘기지 않는다.
    for (const line of code.split("\n").filter((l) => l.includes("console."))) expect(line.replace(/"[^"]*"/g, '""'), line).not.toMatch(/(?<!\.)\b(phone|clientIp|ip|req|body|code)\b/);
  });
  it("마이그레이션은 public 명시 + 테이블 ACL 전부 회수(service_role 포함) + RPC EXECUTE는 service_role만 + rollback/verify가 최종 상태와 맞는다", () => {
    const mig = readFileSync("add_phone_otp_send_limits_20261008.sql", "utf8").replace(/^\s*--.*$/gm, "");
    expect(mig).toContain("create table if not exists public.phone_otp_send_attempts (");
    expect(mig).toContain("create or replace function public.consume_phone_otp_send_attempt(");
    expect(mig).toMatch(/on public\.phone_otp_send_attempts \(ip_hash, created_at desc\)/);
    expect(mig).toContain("alter table public.phone_otp_send_attempts enable row level security;");
    expect(mig).toContain("revoke all on table public.phone_otp_send_attempts from public, anon, authenticated, service_role;");
    expect(mig).not.toMatch(/grant\s+(select|insert)[^;]*phone_otp_send_attempts/i);   // service_role은 RPC EXECUTE만(SECURITY DEFINER가 소유자 권한으로 접근)
    expect(mig).toMatch(/security definer\s+set search_path = ''/i);
    expect(mig).toContain("revoke all on function public.consume_phone_otp_send_attempt(text, int, int) from public, anon, authenticated;");
    expect(mig).toContain("grant execute on function public.consume_phone_otp_send_attempt(text, int, int) to service_role;");
    const rb = readFileSync("rollback_add_phone_otp_send_limits_20261008.sql", "utf8");
    expect(rb).toContain("drop function if exists public.consume_phone_otp_send_attempt(text, int, int);");
    expect(rb).toContain("drop table if exists public.phone_otp_send_attempts;");
    expect(readFileSync("verify_add_phone_otp_send_limits_20261008.sql", "utf8")).toContain("has_table_privilege(r.rolname, 'public.phone_otp_send_attempts', 'select')");
  });
});
