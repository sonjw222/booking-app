// Supabase Edge Function: 네이버 로그인
//
// 네이버는 Supabase Auth의 기본 제공 OAuth provider 목록에 없다(AUTH_SETUP.md 3-3절).
// 그래서 이 함수가 대신 표준 OAuth Authorization Code 흐름을 서버 쪽에서 완결한다:
//   1) 클라이언트(app/login/naver-callback/page.tsx)가 네이버에서 받은 authorization code를
//      이 함수로 전달
//   2) 이 함수가 client_secret으로 네이버 access token 교환 (client_secret은 여기서만
//      사용 — 브라우저에는 절대 노출되지 않음)
//   3) 네이버 프로필 조회
//   4) Supabase Admin API로 이 네이버 계정 전용 사용자를 찾거나 만들고, 클라이언트가
//      바로 세션으로 교환할 수 있는 token_hash를 발급해 돌려준다
//      (클라이언트는 supabase.auth.verifyOtp({ email, token_hash, type: "email" })로
//      실제 로그인 세션을 확보한다 — Supabase 매직링크 발급 메커니즘을 커스텀 OAuth
//      provider 용도로 재사용하는, 미지원 provider를 붙일 때 널리 쓰이는 방식이다)
//
// 정체성 기준(중요, DEC-004 참고, docs/08_Decision_Log.md):
//   네이버가 돌려주는 "실제 이메일"을 Supabase 사용자 식별자로 쓰지 않는다. 이 프로젝트는
//   서로 다른 로그인 수단(이메일/구글/카카오/네이버/애플)으로 만들어진 계정을 이메일이
//   같다는 이유만으로 자동 병합하지 않기로 이미 결정했다(계정 탈취/스푸핑 리스크) — 만약
//   네이버 이메일을 그대로 식별자로 쓰면, 이미 같은 이메일로 가입된 다른 계정에 뜻하지 않게
//   로그인돼버려 그 정책을 이 provider만 조용히 어기게 된다. 대신 네이버 고유 회원번호로
//   합성한 이메일(`naver-<네이버id>@<SYNTHETIC_EMAIL_DOMAIN>`)을 식별자로 써서, 같은 네이버
//   계정은 항상 같은 Supabase 사용자로, 다른 provider의 계정과는 항상 분리되게 한다.
//   실제 네이버 이메일/이름은 user_metadata에만 보조 정보로 남긴다.
//
// 필요한 Edge Function 환경변수(Supabase 대시보드 → Edge Functions → naver-login → Secrets,
// 또는 `supabase secrets set`):
//   NAVER_CLIENT_ID, NAVER_CLIENT_SECRET   — 네이버 개발자센터에서 발급
//   SUPABASE_SERVICE_ROLE_KEY               — Supabase 프로젝트 설정 → API (service_role)
//   SUPABASE_URL                            — Supabase가 Edge Function에 기본 주입
//   NAVER_SYNTHETIC_EMAIL_DOMAIN (선택)     — 기본값 naver.socialauth.invalid
//
// 배포: `supabase functions deploy naver-login` (자세한 절차는 AUTH_SETUP.md 3-3절 참고)

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NAVER_CLIENT_ID = Deno.env.get("NAVER_CLIENT_ID")!;
const NAVER_CLIENT_SECRET = Deno.env.get("NAVER_CLIENT_SECRET")!;
// 실제 존재하는 이메일과 절대 겹치지 않도록 예약 TLD(.invalid, RFC 2606)를 기본값으로 쓴다.
const SYNTHETIC_EMAIL_DOMAIN = Deno.env.get("NAVER_SYNTHETIC_EMAIL_DOMAIN") ?? "naver.socialauth.invalid";

const CORS_HEADERS: Record<string, string> = {
  // 로그인 화면(브라우저)에서 직접 호출하는 공개 엔드포인트라 자격 증명(쿠키)은 쓰지 않는다.
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

  // 1) authorization code → access token (client_secret 필요, 서버에서만)
  const tokenUrl = new URL("https://nid.naver.com/oauth2.0/token");
  tokenUrl.searchParams.set("grant_type", "authorization_code");
  tokenUrl.searchParams.set("client_id", NAVER_CLIENT_ID);
  tokenUrl.searchParams.set("client_secret", NAVER_CLIENT_SECRET);
  tokenUrl.searchParams.set("code", code);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);

  const tokenRes = await fetch(tokenUrl.toString());
  const tokenJson = await tokenRes.json().catch(() => ({}));
  const accessToken = tokenJson?.access_token as string | undefined;
  if (!tokenRes.ok || !accessToken) {
    const reason = tokenJson?.error_description ?? tokenJson?.error ?? `HTTP ${tokenRes.status}`;
    return json({ error: `네이버 토큰 교환 실패: ${reason}` }, 400);
  }

  // 2) 프로필 조회
  const profileRes = await fetch("https://openapi.naver.com/v1/nid/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const profileJson = await profileRes.json().catch(() => ({}));
  const profile = profileJson?.response;
  if (!profileRes.ok || profileJson?.resultcode !== "00" || !profile?.id) {
    return json({ error: "네이버 프로필 조회에 실패했어요" }, 400);
  }

  const naverId = String(profile.id);
  const naverEmail: string | null = profile.email ?? null;
  const naverName: string = profile.name || profile.nickname || "네이버 회원";
  const syntheticEmail = `naver-${naverId}@${SYNTHETIC_EMAIL_DOMAIN}`;

  // 3) 이 네이버 계정 전용 Supabase 사용자 확보 + 클라이언트가 세션으로 바꿀 token_hash 발급.
  //    generateLink는 사용자가 없으면 새로 만들고, 있으면 그 사용자 그대로 링크를 발급한다
  //    (매직링크 발급 메커니즘 재사용 — 위 파일 상단 설명 참고).
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: syntheticEmail,
    options: {
      // options.data는 사용자를 "새로 만들 때만" user_metadata로 반영된다(기존 사용자는 유지).
      data: { name: naverName, naver_email: naverEmail, provider: "naver" },
    },
  });
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkErr || !tokenHash) {
    return json({ error: `세션 발급에 실패했어요: ${linkErr?.message ?? "token_hash 없음"}` }, 500);
  }

  return json({ email: syntheticEmail, tokenHash });
});
