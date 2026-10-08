import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideOtpLimit, OTP_LIMIT_MESSAGES } from "../../supabase/functions/_shared/otpLimitVerdict";

// 보안 경계(rate limit)는 fail-closed: RPC가 error 없이 null/예상 밖 값을 돌려줘도 발송하지 않는다.
describe("decideOtpLimit", () => {
  it("1) verdict=ok → 발송 진행", () => expect(decideOtpLimit("ok", null)).toEqual({ action: "proceed" }));
  it("2) ip_limit → 429", () => expect(decideOtpLimit("ip_limit", null)).toEqual({ action: "reject", status: 429, error: OTP_LIMIT_MESSAGES.ipLimit }));
  it("3) global_limit → 503", () => expect(decideOtpLimit("global_limit", null)).toEqual({ action: "reject", status: 503, error: OTP_LIMIT_MESSAGES.globalLimit }));
  it("4) null/undefined → 503 reject(발송 안 함), 로그 남김", () => {
    for (const v of [null, undefined]) { const d = decideOtpLimit(v, null); expect(d.action).toBe("reject"); if (d.action === "reject") { expect(d.status).toBe(503); expect(d.log).toContain("예상 밖 verdict"); } }
  });
  it("5) 예상 밖 문자열/타입 → 503 reject(발송 안 함), 대소문자·공백 변형도 ok로 취급하지 않는다", () => {
    for (const v of ["OK", " ok", "ok ", "allowed", "", 1, true, {}, ["ok"]]) { const d = decideOtpLimit(v, null); expect(d.action, String(v)).toBe("reject"); if (d.action === "reject") expect(d.status).toBe(503); }
  });
  it("6) RPC 없음(42883 / PGRST202) → 기존 fail-open(전환기) + 로그", () => {
    for (const code of ["42883", "PGRST202"]) { const d = decideOtpLimit(null, { code }); expect(d.action).toBe("proceed"); expect(d.log).toContain("add_phone_otp_send_limits_20261008.sql 미적용"); }
  });
  it("7) 그 밖의 RPC error → 503 reject, 응답 문구에 원본 오류가 없다", () => {
    for (const e of [{ code: "XX000" }, { code: "57014" }, {}, { code: undefined }]) { const d = decideOtpLimit("ok", e); expect(d.action).toBe("reject"); if (d.action === "reject") { expect(d.status).toBe(503); expect(d.error).toBe(OTP_LIMIT_MESSAGES.unavailable); } }
  });
  it("로그에 phone/IP 해시/토큰/body가 들어가지 않는다(verdict는 길이 제한)", () => {
    const d = decideOtpLimit("x".repeat(200), null); if (d.action === "reject") expect((d.log ?? "").length).toBeLessThan(80);
  });
});

describe("send-phone-otp 배선(정적)", () => {
  const code = readFileSync("supabase/functions/send-phone-otp/index.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("판정은 decideOtpLimit 결과만 따르고, reject면 코드 저장·SMS 발송(create_phone_verification, sendViaAligo)보다 먼저 반환한다", () => {
    expect(code).toContain('import { decideOtpLimit } from "../_shared/otpLimitVerdict.ts";');
    const i = code.indexOf("decideOtpLimit(verdict, limitErr)");
    expect(i).toBeGreaterThan(-1);
    expect(code.slice(i)).toMatch(/if \(decision\.action === "reject"\) return json\(\{ error: decision\.error \}, decision\.status\);/);
    expect(i).toBeLessThan(code.indexOf('rpc("create_phone_verification"'));
    expect(i).toBeLessThan(code.indexOf("sendViaAligo({"));
  });
  it("DEV 우회(PHONE_OTP_TEST_BYPASS_PREFIX)와 번호별 제한은 그대로", () => {
    expect(code).toContain("const isTestBypass = !!TEST_BYPASS_PREFIX && phone.startsWith(TEST_BYPASS_PREFIX);");
    expect(code).toContain("if (!isTestBypass) {");
    expect(code).toContain("const HOURLY_SEND_CAP = 5;");
  });
});
