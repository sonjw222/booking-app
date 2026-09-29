/*
  이메일 회원가입 — OTP 발송 "전"에 이미 가입된 이메일인지 먼저 확인(2026-09-29).

  기존 흐름: 이메일/비밀번호 입력 → 휴대폰 OTP 인증 → 최종 가입 시점에야 "이미 가입된
  이메일"을 알게 됨(불필요한 알림톡/SMS 발송). 이 모듈은 "다음" 버튼을 누른 시점에 서버에
  먼저 물어봐서, 중복이면 OTP 단계로 아예 진입하지 않게 한다(lib/phoneVerification.ts의
  sendPhoneOtp는 이 확인을 통과한 뒤에만 호출됨).

  보안: 브라우저는 auth.users를 직접 조회할 수 없다(서비스 롤 필요) — 실제 판정은 Edge
  Function(supabase/functions/check-signup-email)이 서비스 롤로 대신 확인하고 boolean 결과만
  돌려준다(email enumeration 최소화 목적으로 "왜" 겹치는지는 알려주지 않음 — 이메일 자체
  가입인지 소셜 계정에 연결된 실제 이메일인지 구분하지 않고 항상 같은 문구). 이 Edge
  Function은 같은 패턴의 lib/phoneVerification.ts/send-phone-otp처럼 로그인 전(세션 없음)에
  호출되는 anon 허용 엔드포인트라, 남용 방지를 위해 함수 자체에 IP 기준 rate limit이 있다.

  실패 시 정책: 네트워크 오류/함수 미배포 등으로 확인 자체가 실패하면 "가입 가능"으로
  간주해 다음 단계로 넘어간다(fail-open) — 이 확인은 UX 개선용 사전 체크일 뿐, 실제
  중복 방지는 여전히 서버(accounts.auth_id/phone unique, auth.signUp의 already-registered
  오류)가 최종적으로 강제한다. 이 확인 하나가 죽었다고 회원가입 전체가 막히면 안 된다.
*/

import { supabase } from "./supabaseClient";

export type EmailAvailability = { available: boolean; reason?: string };

const GENERIC_DUPLICATE_MESSAGE = "이미 가입된 계정이에요. 기존에 사용한 로그인 방법으로 로그인해 주세요.";

export async function checkEmailAvailable(email: string): Promise<EmailAvailability> {
  const trimmed = email.trim();
  if (!trimmed) return { available: true };
  try {
    const { data, error } = await supabase.functions.invoke<{ available?: boolean; error?: string }>(
      "check-signup-email",
      { body: { email: trimmed } },
    );
    if (error) return { available: true }; // fail-open(위 주석 참고)
    if (data?.available === false) return { available: false, reason: GENERIC_DUPLICATE_MESSAGE };
    return { available: true };
  } catch {
    return { available: true }; // fail-open
  }
}
