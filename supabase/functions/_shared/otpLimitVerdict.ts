// send-phone-otp의 IP/전역 한도 RPC(consume_phone_otp_send_attempt) 결과 판정 — Deno/DB 의존성이 없는 순수 함수(vitest로 직접 검증).
// 이 한도는 보안 경계라 "명시적으로 ok일 때만" 진행한다(fail-closed). 예외는 마이그레이션 적용 전 전환기(함수 없음 42883 / PGRST202)뿐이다.
export type OtpLimitDecision =
  | { action: "proceed"; log?: string }
  | { action: "reject"; status: 429 | 503; error: string; log?: string };

export const OTP_LIMIT_MESSAGES = {
  ipLimit: "요청이 너무 많아요. 잠시 후 다시 시도해주세요",
  unavailable: "인증번호를 보내지 못했어요. 잠시 후 다시 시도해주세요",
  globalLimit: "지금은 인증번호를 보낼 수 없어요. 잠시 후 다시 시도해주세요",
};

export function decideOtpLimit(verdict: unknown, error: { code?: string } | null | undefined): OtpLimitDecision {
  if (error) {
    // 마이그레이션 적용 전(함수 없음)에는 기존 동작 유지(fail-open + 로그) — 번호별 제한은 그대로 적용 중이다.
    if (error.code === "42883" || error.code === "PGRST202") {
      return { action: "proceed", log: "rate-limit RPC 없음 — add_phone_otp_send_limits_20261008.sql 미적용(번호별 제한만 동작)" };
    }
    // 그 외 DB 오류는 거부(원본 오류 메시지는 응답에 싣지 않는다).
    return { action: "reject", status: 503, error: OTP_LIMIT_MESSAGES.unavailable, log: `rate-limit RPC 실패: ${String(error.code ?? "unknown")}` };
  }
  if (verdict === "ok") return { action: "proceed" };
  if (verdict === "ip_limit") return { action: "reject", status: 429, error: OTP_LIMIT_MESSAGES.ipLimit };
  if (verdict === "global_limit") return { action: "reject", status: 503, error: OTP_LIMIT_MESSAGES.globalLimit };
  // null/undefined/예상 밖 값: 판정이 불확실하므로 발송하지 않는다(verdict 값 자체는 민감정보가 아니라 길이를 제한해 로그에 남긴다 — phone/IP 해시/토큰/body는 남기지 않는다).
  return { action: "reject", status: 503, error: OTP_LIMIT_MESSAGES.unavailable, log: `rate-limit RPC 예상 밖 verdict: ${typeof verdict === "string" ? JSON.stringify(verdict.slice(0, 24)) : String(verdict)}` };
}
