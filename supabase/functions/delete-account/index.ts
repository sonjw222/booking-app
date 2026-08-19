// Supabase Edge Function: 계정 탈퇴(소프트 삭제)
//
// 로그인한 사용자가 스스로를 탈퇴 처리한다. accounts/profiles/reservations/orders 등
// 기존 데이터는 전혀 지우지 않는다(회계·환불 근거, 매니저 쪽 매출/출석 통계 보존 —
// add_account_deactivation.sql 상단 설명, CLAUDE.md 규칙 3). 대신 두 가지만 한다:
//   1) accounts.deactivated_at을 채운다
//   2) Supabase Auth 쪽에서 이 사용자를 밴(banned_until)해 이후 로그인/토큰 갱신을 막는다
// 클라이언트(app/settings/account/page.tsx)는 이 함수 호출이 성공하면 곧바로
// supabase.auth.signOut()으로 로컬 세션도 지운다 — access token은 만료 전까지 이론상
// 유효할 수 있어(짧은 수명, 서버 stateless 검증) 밴만으로는 즉시 반영이 안 될 수 있기 때문.
//
// 인증: Authorization 헤더의 호출자 JWT로 auth.uid()를 확인하고 "그 사용자 자신만"
// 탈퇴시킬 수 있다 — 다른 사용자를 지정해 탈퇴시키는 admin 기능이 아니다(그런 기능이
// 필요해지면 별도 관리자 전용 함수로 분리해야 함).
//
// 필요한 환경변수: SUPABASE_URL(자동 주입), SUPABASE_ANON_KEY(자동 주입),
// SUPABASE_SERVICE_ROLE_KEY(대부분의 프로젝트에 기본 secret으로 이미 있음 — 없으면
// `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...`)
// 배포: `supabase functions deploy delete-account`

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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

  const authHeader = req.headers.get("Authorization") ?? "";
  // 호출자 본인 확인: anon key + 호출자의 JWT로 만든 client는 auth.getUser()가 그 JWT의
  // 주인만 돌려준다(다른 사용자로 위장 불가) — service_role은 아래에서 실제 쓰기에만 쓴다.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "로그인이 필요해요" }, 401);
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error: accErr } = await admin
    .from("accounts")
    .update({ deactivated_at: new Date().toISOString() })
    .eq("auth_id", userId);
  if (accErr) return json({ error: `탈퇴 처리 중 문제가 발생했어요: ${accErr.message}` }, 500);

  // Admin API에 "영구 밴"이라는 별도 값이 없어 충분히 긴 기간(100년)으로 흉내낸다.
  const { error: banErr } = await admin.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
  if (banErr) return json({ error: `로그인 차단 중 문제가 발생했어요: ${banErr.message}` }, 500);

  return json({ ok: true });
});
