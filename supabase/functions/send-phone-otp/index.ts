// Supabase Edge Function: 회원가입용 휴대폰 인증번호(OTP) 발송
//
// send-alimtalk와 달리 로그인 전(계정이 아직 없는 상태)에 호출돼야 해서 세션/센터
// 기반 권한 체크가 없다 — anon 키만으로 누구나 호출 가능한, 이 프로젝트에서 의도적으로
// 공개된 첫 엔드포인트다. 그래서 여기서는 "권한 확인" 대신 "속도 제한"이 실질적인
// 보안 경계다:
//   - 같은 번호로 재전송은 60초에 한 번만
//   - 같은 번호로 1시간에 5번까지만
//   - 같은 클라이언트(IP 해시)에서 1시간에 10번까지만, 프로젝트 전체 24시간 500번까지만 (2026-10-08 보안 감사 P2 —
//     서로 다른 번호를 순회해 SMS 비용을 소모시키는 남용 방지. DB RPC consume_phone_otp_send_attempt가 원자적으로 판정,
//     add_phone_otp_send_limits_20261008.sql). PHONE_OTP_TEST_BYPASS_PREFIX 번호는 실제 발송이 없어 이 한도를 소비하지 않는다.
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
//   ALIGO_PROXY_URL              — Oracle 고정-IP Aligo 프록시 URL
//   ALIGO_PROXY_TOKEN            — 프록시 서버 인증용 Bearer token
//   ALIGO_OTP_TEMPLATE_CODE      — 승인된 카카오 "인증번호 안내" 템플릿 코드
//   PHONE_OTP_TEST_BYPASS_PREFIX — CI/QA 전용, 운영에서는 등록하지 않음(선택)
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
// IP/전역 한도 기본값(선택 환경변수로 조정: OTP_IP_HOURLY_CAP, OTP_GLOBAL_DAILY_CAP). NAT 뒤의 가족/센터 와이파이를 고려해 IP 한도는 번호별 한도의 2배로 둔다.
function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(Deno.env.get(name) ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const IP_HOURLY_CAP = envInt("OTP_IP_HOURLY_CAP", 10);
const GLOBAL_DAILY_CAP = envInt("OTP_GLOBAL_DAILY_CAP", 500);

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

// 클라이언트 IP는 평문으로 저장하지 않는다(SHA-256 해시만) — check-signup-email과 같은 방식.
async function hashIp(ip: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// 우선순위: cf-connecting-ip → x-real-ip → x-forwarded-for 첫 값 → "unknown"(판별 불가 클라이언트는 같은 버킷을 공유해 더 쉽게 제한에 걸릴 뿐 관대해지지 않는다)
function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
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

  // IP/전역 한도(번호별 확인을 통과한 뒤, 코드 저장·발송 전에 원자적으로 소비). 실제 SMS를 보내지 않는 DEV 우회 번호는 건너뛴다.
  if (!isTestBypass) {
    const { data: verdict, error: limitErr } = await admin.rpc("consume_phone_otp_send_attempt", {
      p_ip_hash: await hashIp(clientIp(req)),
      p_ip_hourly_cap: IP_HOURLY_CAP,
      p_global_daily_cap: GLOBAL_DAILY_CAP,
    });
    if (limitErr) {
      // 마이그레이션 적용 전(함수 없음: 42883 / PostgREST PGRST202)에는 기존 동작 유지(fail-open + 로그) — 번호별 제한은 그대로 적용 중이다.
      // 그 외 DB 오류는 거부한다(fail-closed, 원본 오류는 응답에 싣지 않는다).
      if (limitErr.code === "42883" || limitErr.code === "PGRST202") {
        console.error("[send-phone-otp] rate-limit RPC 없음 — add_phone_otp_send_limits_20261008.sql 미적용(번호별 제한만 동작)");
      } else {
        console.error("[send-phone-otp] rate-limit RPC 실패:", limitErr.code);
        return json({ error: "인증번호를 보내지 못했어요. 잠시 후 다시 시도해주세요" }, 503);
      }
    } else if (verdict === "ip_limit") {
      return json({ error: "요청이 너무 많아요. 잠시 후 다시 시도해주세요" }, 429);
    } else if (verdict === "global_limit") {
      return json({ error: "지금은 인증번호를 보낼 수 없어요. 잠시 후 다시 시도해주세요" }, 503);
    }
  }

  const { error: createErr } = await admin.rpc("create_phone_verification", { p_phone: phone, p_code: code });
  if (createErr) return json({ error: createErr.message }, 500);

  if (isTestBypass) {
    // CI/QA 전용 — 실제 발송 없이 코드를 그대로 돌려준다. PHONE_OTP_TEST_BYPASS_PREFIX가
    // 등록돼 있지 않으면(운영 기본값) 이 분기 자체에 도달할 수 없다.
    return json({ sent: true, devCode: code });
  }

  const result = await sendViaAligo({
    to: phone,
    content: `인증번호는 [[code]]입니다.`.replace("[[code]]", code),
    templateCode: ALIGO_OTP_TEMPLATE_CODE || undefined,
    templateVariables: { code },
  });

  return json({ sent: result.status === "sent" }, result.status === "sent" ? 200 : 502);
});
