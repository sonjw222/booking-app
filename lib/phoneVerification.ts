/*
  회원가입 휴대폰 인증(OTP) — 카카오 알림톡(승인 전엔 자동 SMS 대체발송)으로 인증번호를
  보내 전화번호 소유만 확인한다(실명 확인 아님).
  - 발송: supabase/functions/send-phone-otp (로그인 전 호출이라 세션 불필요, anon 키로 호출)
  - 검증: add_phone_verification.sql의 verify_phone_otp() RPC(순수 SQL, anon 허용)
  - 실제 가입 시점 강제는 accounts INSERT 정책/UPDATE 트리거(fix_accounts_require_
    phone_verification.sql)가 서버에서 한다 — 이 모듈은 그 전 단계 UX일 뿐이고, 이 모듈을
    거치지 않고 바로 가입을 시도해도 서버가 막는다.
*/

import { supabase } from "./supabaseClient";

export type SendPhoneOtpResult = { ok: boolean; error?: string; devCode?: string; retryAfterSeconds?: number };
export type VerifyPhoneOtpResult = { ok: boolean; error?: string };

export async function sendPhoneOtp(phone: string): Promise<SendPhoneOtpResult> {
  const { data, error } = await supabase.functions.invoke<{
    sent?: boolean;
    error?: string;
    devCode?: string;
    retryAfterSeconds?: number;
  }>("send-phone-otp", { body: { phone } });

  if (error) return { ok: false, error: error.message ?? "인증번호 발송에 실패했어요" };
  if (!data?.sent) {
    return { ok: false, error: data?.error ?? "인증번호 발송에 실패했어요", retryAfterSeconds: data?.retryAfterSeconds };
  }
  return { ok: true, devCode: data.devCode };
}

export async function verifyPhoneOtp(phone: string, code: string): Promise<VerifyPhoneOtpResult> {
  const { data, error } = await supabase.rpc("verify_phone_otp", { p_phone: phone, p_code: code });
  if (error) return { ok: false, error: error.message };
  return data === true ? { ok: true } : { ok: false, error: "인증번호가 일치하지 않아요" };
}
