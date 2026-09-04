// Supabase Edge Function: 회원가입용 휴대폰 인증번호(OTP) 발송
//
// send-alimtalk와 달리 로그인 전(계정이 아직 없는 상태)에 호출돼야 해서 세션/센터
// 기반 권한 체크가 없다 — anon 키만으로 누구나 호출 가능한, 이 프로젝트에서 의도적으로
// 공개된 첫 엔드포인트다. 그래서 여기서는 "권한 확인" 대신 "속도 제한"이 실질적인
// 보안 경계다:
//   - 같은 번호로 재전송은 60초에 한 번만
//   - 같은 번호로 1시간에 5번까지만
//   (시도 횟수 제한 자체는 add_phone_verification.sql의 verify_phone_otp()가 담당)
//
// 흐름: 속도 제한 통과 → 6자리 코드 생성 → create_phone_verification(phone, code) RPC로
// DB에 해시 저장(service_role) → sendViaAligo()로 실제 발송. templateCode(카카오 알림톡
// "인증번호 안내" 템플릿, 카카오 사전심사 필요)가 아직 시크릿에 없으면 sendViaAligo()가
// 자동으로 일반 SMS로 보낸다 — 그래서 템플릿 승인 전에도 이 기능 자체는 먼저 배포할 수
// 있고, 승인되면 시크릿만 추가하면 된다(코드 변경/재배포 불필요).
//
// CI/E2E 대응: 실제 SMS를 받을 수 없는 자동화 테스트를 위해 PHONE_OTP_TEST_BYPASS_PREFIX
// 시크릿(예: "0100000")을 등록해두면, 그 접두사로 시작하는 번호만 Aligo 호출을 건너뛰고
// 코드를 응답에 그대로 실어 보낸다(devCode) — 이 프로젝트는 개발/운영이 같은 Supabase
// 프로젝트를 쓰므로 전역 test-mode 플래그가 아니라 예약된 번호 접두사로 한정해 안전하게
// 둔다. 시크릿을 등록하지 않으면(기본값) 이 우회는 완전히 비활성화된다.
//
// 필요한 환경변수(`supabase secrets set`으로 등록):
//   ALIGO_USER_ID, ALIGO_API_KEY, ALIGO_SENDER_KEY, ALIGO_SENDER_PHONE — send-alimtalk와 공용
//   ALIGO_OTP_TEMPLATE_CODE       — 카카오 "인증번호 안내" 템플릿 승인 후 등록(선택, 없으면 SMS로 발송)
//   PHONE_OTP_TEST_BYPASS_PREFIX  — CI/QA 전용, 운영에서는 등록하지 않음(선택)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Supabase가 기본 주입
//
// 배포: `supabase functions deploy send-phone-otp`

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendViaAligo } from "../_shared/aligo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALIGO_OTP_TEMPLATE_CODE = Deno.env.get("ALIGO_OTP_TEMPLATE_CODE") ?? "";
const TEST_BYPASS_PREFIX = Deno.env.get("PHONE_OTP_TEST_BYPASS_PREFIX") ?? "";

const RESEND_COOLDOWN_SECONDS = 60;
const HOURLY_SEND_CAP = 5;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function generateCode(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 1_000_000).padStart(6, "0");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { phone?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "요청 본문을 읽을 수 없어요" }, 400);
  }

  const phone = (body.phone ?? "").trim();
  if (!phone) return json({ error: "휴대폰 번호를 입력해주세요" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 속도 제한 — 이 엔드포인트는 anon 호출이라 이게 곧 보안 경계다.
  const { data: recentRows, error: recentErr } = await admin
    .from("phone_verifications")
    .select("created_at")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(HOURLY_SEND_CAP);
  if (recentErr) return json({ error: recentErr.message }, 500);

  const now = Date.now();
  if (recentRows && recentRows.length > 0) {
    const lastSentMs = new Date(recentRows[0].created_at).getTime();
    const secondsSinceLast = (now - lastSentMs) / 1000;
    if (secondsSinceLast < RESEND_COOLDOWN_SECONDS) {
      return json(
        { error: "잠시 후 다시 시도해주세요", retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLast) },
        429,
      );
    }
  }
  const oneHourAgo = now - 60 * 60 * 1000;
  const sentLastHour = (recentRows ?? []).filter((r) => new Date(r.created_at).getTime() > oneHourAgo).length;
  if (sentLastHour >= HOURLY_SEND_CAP) {
    return json({ error: "너무 많이 요청됐어요. 1시간 후 다시 시도해주세요" }, 429);
  }

  const code = generateCode();
  const isTestBypass = !!TEST_BYPASS_PREFIX && phone.startsWith(TEST_BYPASS_PREFIX);

  const { error: createErr } = await admin.rpc("create_phone_verification", { p_phone: phone, p_code: code });
  if (createErr) return json({ error: createErr.message }, 500);

  if (isTestBypass) {
    // CI/QA 전용 — 실제 발송 없이 코드를 그대로 돌려준다. PHONE_OTP_TEST_BYPASS_PREFIX가
    // 등록돼 있지 않으면(운영 기본값) 이 분기 자체에 도달할 수 없다.
    return json({ sent: true, devCode: code });
  }

  const result = await sendViaAligo({
    to: phone,
    content: `인증번호는 [[code]]입니다`.replace("[[code]]", code),
    templateCode: ALIGO_OTP_TEMPLATE_CODE || undefined,
    templateVariables: { code },
  });

  return json({ sent: result.status === "sent" }, result.status === "sent" ? 200 : 502);
});
