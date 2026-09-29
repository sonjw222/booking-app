// Supabase Edge Function: 이메일 회원가입 사전 중복 확인
//
// send-phone-otp와 같은 이유로 로그인 전(계정이 아직 없는 상태)에 호출돼야 해서 세션이
// 필요 없다 — anon 키만으로 누구나 호출 가능한 공개 엔드포인트다(supabase/config.toml의
// [functions.check-signup-email] verify_jwt = false 참고 — 로그인 전이라 유효한 사용자
// JWT 자체가 없을 수 있음). 그래서 "권한 확인" 대신 "속도 제한"이 실질적인 보안 경계다
// (send-phone-otp 상단 주석과 동일한 설계 원칙):
//   - 같은 클라이언트(IP 기준)에서 10분에 20번까지만 확인 가능
//   (이메일 하나당 제한이 아니라 IP 기준인 이유: 공격자가 서로 다른 이메일을 계속 바꿔가며
//    가입 여부를 스캔하는 enumeration 시도를 막으려면 "특정 이메일 반복 조회"가 아니라
//    "한 클라이언트의 반복 조회 자체"를 제한해야 한다)
//
// 2026-09-30 보안 보완(코드 리뷰 반영):
//   1) rate limit을 "조회 → 삽입" 2단계(이 함수가 각각 별도 쿼리로 처리)에서 DB RPC 하나
//      (consume_email_check_attempt, advisory lock으로 원자적)로 옮겼다 — 이전 방식은
//      동시에 들어온 여러 요청이 모두 "아직 한도 안 됐다"를 보고 각자 insert해 실제로는
//      한도를 넘길 수 있었다(check-then-act race). 이제 이 함수는 email_check_attempts
//      테이블을 직접 count/insert하지 않고 이 RPC 하나만 호출한다.
//   2) Postgres/RPC 원본 오류 메시지를 절대 클라이언트 응답에 그대로 싣지 않는다 —
//      console.error로만 남기고, 사용자에게는 항상 안전한 한글 문구만 돌려준다(raw DB
//      오류로 인한 내부 스키마/제약조건 이름 노출 방지).
//   3) 클라이언트 IP 판별 우선순위를 cf-connecting-ip → x-real-ip → x-forwarded-for(첫
//      값) → "unknown" 순으로 조정.
//
// 흐름: 속도 제한(RPC) 통과 → email_signup_available(email) RPC 호출(service_role, add_email_
// signup_precheck.sql) → 결과(boolean)만 반환. 그 이메일이 실제로 "이메일 가입"으로
// 겹치는지 "소셜 계정의 실제 이메일"(예: 네이버 raw_user_meta_data.naver_email)과 겹치는지는
// 구분해서 알려주지 않는다 — 클라이언트(lib/emailSignupCheck.ts)가 항상 같은 일반 문구로
// 안내한다(DEC-004: 계정 자동 병합 없음, 이 엔드포인트는 "중복 신규가입 방지"만 한다).
//
// 필요한 환경변수(`supabase secrets set`으로 등록, SUPABASE_URL/SERVICE_ROLE_KEY는 기본 주입):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Supabase가 기본 주입
//
// 필요한 DB 마이그레이션: add_email_signup_precheck.sql (email_signup_available(),
// consume_email_check_attempt() RPC + email_check_attempts 레이트리밋 테이블) — 이 함수는
// 그 RPC들이 존재해야 정상 동작한다(없으면 500을 반환하고, 클라이언트는 fail-open으로
// 다음 단계를 진행한다 — lib/emailSignupCheck.ts 참고).
//
// 배포: `supabase functions deploy check-signup-email`

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const GENERIC_ERROR_MESSAGE = "이메일 확인 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.";
const RATE_LIMIT_MESSAGE = "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.";

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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 클라이언트 IP를 평문으로 저장하지 않는다(email_check_attempts.ip_hash) — SHA-256 해시만
// 남겨 "같은 클라이언트인지" 비교만 가능하게 하고 실제 IP는 복원할 수 없게 한다.
async function hashIp(ip: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 우선순위: cf-connecting-ip(신뢰 가능한 엣지가 붙어있는 경우) → x-real-ip →
// x-forwarded-for의 첫 값(가장 왼쪽 = 원 클라이언트) → 판별 불가 시 "unknown"
// ("unknown" 클라이언트들은 서로 같은 rate limit 버킷을 공유하게 되므로 보수적으로 더 쉽게
// 제한에 걸릴 뿐, 더 관대해지는 방향의 실패는 아니다).
function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "요청 본문을 읽을 수 없어요" }, 400);
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !EMAIL_PATTERN.test(email)) {
    return json({ error: "올바른 이메일을 입력해주세요" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const ipHash = await hashIp(clientIp(req));

  // 속도 제한 — DB RPC 하나로 원자적으로 확인+기록(동시 요청 race 방지, add_email_signup_
  // precheck.sql의 consume_email_check_attempt 참고). 이 함수는 email_check_attempts를
  // 직접 만지지 않는다.
  const { data: allowed, error: rateLimitErr } = await admin.rpc("consume_email_check_attempt", { p_ip_hash: ipHash });
  if (rateLimitErr) {
    console.error("[check-signup-email] rate-limit RPC 실패:", rateLimitErr);
    return json({ error: GENERIC_ERROR_MESSAGE }, 500);
  }
  if (allowed !== true) {
    return json({ error: RATE_LIMIT_MESSAGE }, 429);
  }

  const { data: available, error: rpcErr } = await admin.rpc("email_signup_available", { p_email: email });
  if (rpcErr) {
    console.error("[check-signup-email] email_signup_available RPC 실패:", rpcErr);
    return json({ error: GENERIC_ERROR_MESSAGE }, 500);
  }

  return json({ available: available === true });
});
