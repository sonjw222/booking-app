// Supabase Edge Function: 카카오 로그인
//
// Supabase의 기본 제공 Kakao provider는 서버 쪽에서 account_email 스코프를 무조건 같이
// 요청하는데, 이 프로젝트의 카카오 앱은 이메일 항목이 "권한없음"(사업자 인증 필요,
// AUTH_SETUP.md 3-1절) 상태라 "Invalid scope: account_email"로 거부된다. Supabase 기본
// 연동을 아예 쓰지 않고, 네이버 로그인(supabase/functions/naver-login)과 완전히 같은 방식
// (Authorization Code 흐름을 이 함수가 서버에서 직접 완결)으로 우회한다 — 우리가 스코프를
// 직접 통제하므로 profile_nickname만 요청하면 이메일 문제 자체가 발생하지 않는다.
//   1) 클라이언트(app/login/kakao-callback/page.tsx)가 카카오에서 받은 authorization code를
//      이 함수로 전달
//   2) 이 함수가 client_secret으로 카카오 access token 교환 (client_secret은 여기서만
//      사용 — 브라우저에는 절대 노출되지 않음)
//   3) 카카오 프로필 조회
//   4) Supabase Admin API로 이 카카오 계정 전용 사용자를 찾거나 만들고, 클라이언트가
//      바로 세션으로 교환할 수 있는 token_hash를 발급해 돌려준다
//      (클라이언트는 supabase.auth.verifyOtp({ token_hash, type: "email" })로 세션 확보)
//
// 정체성 기준(DEC-004, docs/08_Decision_Log.md — naver-login과 동일한 이유):
//   카카오 실제 이메일을 요청하지 않으므로(위 설명) 애초에 이메일 기반 식별이 불가능하고,
//   설령 나중에 사업자 인증 후 이메일 스코프를 추가하더라도 다른 provider와의 자동 병합을
//   피하기 위해 카카오 고유 회원번호로 합성한 이메일을 식별자로 계속 쓴다.
//
// 필요한 Edge Function 환경변수:
//   KAKAO_CLIENT_ID, KAKAO_CLIENT_SECRET   — 카카오 개발자센터 "플랫폼 키"에서 발급
//   SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL — Supabase가 기본 제공(secrets에 이미 존재)
//   KAKAO_SYNTHETIC_EMAIL_DOMAIN (선택)     — 기본값 kakao.socialauth.invalid
//
// 배포: `supabase functions deploy kakao-login` (자세한 절차는 AUTH_SETUP.md 3-1절 참고)

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KAKAO_CLIENT_ID = Deno.env.get("KAKAO_CLIENT_ID")!;
const KAKAO_CLIENT_SECRET = Deno.env.get("KAKAO_CLIENT_SECRET")!;
const SYNTHETIC_EMAIL_DOMAIN = Deno.env.get("KAKAO_SYNTHETIC_EMAIL_DOMAIN") ?? "kakao.socialauth.invalid";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { code?: string; redirectUri?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "요청 본문을 읽을 수 없어요" }, 400);
  }
  const code = body.code?.trim();
  const redirectUri = body.redirectUri?.trim();
  if (!code || !redirectUri) return json({ error: "code, redirectUri가 필요해요" }, 400);

  // 1) authorization code → access token
  const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: KAKAO_CLIENT_ID,
      client_secret: KAKAO_CLIENT_SECRET,
      redirect_uri: redirectUri,
      code,
    }),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  const accessToken = tokenJson?.access_token as string | undefined;
  if (!tokenRes.ok || !accessToken) {
    const reason = tokenJson?.error_description ?? tokenJson?.error ?? `HTTP ${tokenRes.status}`;
    return json({ error: `카카오 토큰 교환 실패: ${reason}` }, 400);
  }

  // 2) 프로필 조회
  const profileRes = await fetch("https://kapi.kakao.com/v2/user/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const profileJson = await profileRes.json().catch(() => ({}));
  const kakaoId = profileJson?.id;
  if (!profileRes.ok || !kakaoId) {
    return json({ error: "카카오 프로필 조회에 실패했어요" }, 400);
  }

  const nickname: string =
    profileJson?.kakao_account?.profile?.nickname || profileJson?.properties?.nickname || "카카오 회원";
  const syntheticEmail = `kakao-${kakaoId}@${SYNTHETIC_EMAIL_DOMAIN}`;

  // 3) 이 카카오 계정 전용 Supabase 사용자 확보 + token_hash 발급 (naver-login과 동일한 방식)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: syntheticEmail,
    options: {
      data: { name: nickname, provider: "kakao" },
    },
  });
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkErr || !tokenHash) {
    return json({ error: `세션 발급에 실패했어요: ${linkErr?.message ?? "token_hash 없음"}` }, 500);
  }

  return json({ email: syntheticEmail, tokenHash });
});
