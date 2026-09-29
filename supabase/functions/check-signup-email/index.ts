// Supabase Edge Function: 이메일 회원가입 사전 중복 확인
//
// send-phone-otp와 같은 이유로 로그인 전(계정이 아직 없는 상태)에 호출돼야 해서 세션이
// 필요 없다 — anon 키만으로 누구나 호출 가능한 공개 엔드포인트다. 그래서 "권한 확인" 대신
// "속도 제한"이 실질적인 보안 경계다(send-phone-otp 상단 주석과 동일한 설계 원칙):
//   - 같은 클라이언트(IP 기준)에서 10분에 20번까지만 확인 가능
//   (이메일 하나당 제한이 아니라 IP 기준인 이유: 공격자가 서로 다른 이메일을 계속 바꿔가며
//    가입 여부를 스캔하는 enumeration 시도를 막으려면 "특정 이메일 반복 조회"가 아니라
//    "한 클라이언트의 반복 조회 자체"를 제한해야 한다)
//
// 흐름: 속도 제한 통과 → email_signup_available(email) RPC 호출(service_role, add_email_
// signup_precheck.sql) → 결과(boolean)만 반환. 그 이메일이 실제로 "이메일 가입"으로
// 겹치는지 "소셜 계정의 실제 이메일"(예: 네이버 raw_user_meta_data.naver_email)과 겹치는지는
// 구분해서 알려주지 않는다 — 클라이언트(lib/emailSignupCheck.ts)가 항상 같은 일반 문구로
// 안내한다(DEC-004: 계정 자동 병합 없음, 이 엔드포인트는 "중복 신규가입 방지"만 한다).
//
// 필요한 환경변수(`supabase secrets set`으로 등록, SUPABASE_URL/SERVICE_ROLE_KEY는 기본 주입):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Supabase가 기본 주입
//
// 필요한 DB 마이그레이션: add_email_signup_precheck.sql (email_signup_available() RPC +
// email_check_attempts 레이트리밋 테이블) — 이 함수는 그 RPC가 존재해야 정상 동작한다.
//
// 배포: `supabase functions deploy check-signup-email`

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const RATE_LIMIT_WINDOW_MINUTES = 10;
const RATE_LIMIT_MAX_REQUESTS = 20;

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

function clientIp(req: Request): string {
  // Supabase Edge Functions(Deno Deploy 기반)는 이 헤더를 신뢰할 수 있게 설정한다.
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") ?? "unknown";
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

  // 속도 제한 — 이 엔드포인트는 anon 호출이라 이게 곧 보안 경계다(send-phone-otp와 동일 원칙).
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { count, error: countErr } = await admin
    .from("email_check_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("created_at", windowStart);
  if (countErr) return json({ error: countErr.message }, 500);
  if ((count ?? 0) >= RATE_LIMIT_MAX_REQUESTS) {
    return json({ error: "너무 많이 요청됐어요. 잠시 후 다시 시도해주세요" }, 429);
  }

  await admin.from("email_check_attempts").insert({ ip_hash: ipHash });

  const { data: available, error: rpcErr } = await admin.rpc("email_signup_available", { p_email: email });
  if (rpcErr) return json({ error: rpcErr.message }, 500);

  return json({ available: available === true });
});
