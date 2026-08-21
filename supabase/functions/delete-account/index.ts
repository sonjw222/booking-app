// Supabase Edge Function: 계정 탈퇴 (실제 개인정보 삭제/익명화)
//
// 2026-08-19 정책 변경: 이전엔 accounts.deactivated_at만 채우고 auth를 100년 밴하는
// 소프트 삭제였다 — 로그인만 막힐 뿐 이름/전화번호/이메일 등 개인정보는 그대로 남아있었다.
// Apple/Google 계정 삭제 가이드라인은 단순 비활성화만으로는 부족하고 개인정보를 실제로
// 지우거나 식별 불가능하게 만들 것을 요구한다 — 이번 배치로 그렇게 바꾼다.
//
// 하는 일 (사용자 결정: 재가입 허용 — docs/TODO.md P1-18 참고):
//   1) accounts의 개인정보(name/phone/address)를 익명값으로 덮어쓴다
//   2) 그 계정의 모든 profiles(가족 프로필 포함)의 개인정보(name/nickname/phone/address/
//      avatar_url/memo/birth_date/label)도 익명값으로 덮어쓴다
//   3) accounts.deactivated_at을 채운다(탈퇴 시각 기록 — 이 값 자체는 개인정보 아님)
//   4) auth.users 행을 실제로 삭제한다(admin.deleteUser) — 밴이 아니라 삭제라 같은
//      이메일/전화번호/소셜 계정으로 나중에 재가입할 수 있다
//
// 지우지 않는 것(CLAUDE.md 규칙 3, 회계·법적 근거): reservations/orders/payments/
// memberships 등은 그대로 유지된다 — 전자상거래법상 결제·청약철회 기록 보관 의무,
// 매니저 쪽 매출/출석 통계 보존 목적. 이 기록들은 이제 익명화된 accounts/profiles를
// 통해 "탈퇴한 회원"으로만 보인다(실제 신원과는 연결 안 됨).
// center_members.app_email/memo 같은 센터가 직접 입력한 자체 CRM 데이터는 건드리지
// 않는다 — 그건 우리 플랫폼이 아니라 센터가 자체적으로 수집·보관하는 고객 정보라 범위 밖.
//
// 인증: Authorization 헤더의 호출자 JWT로 auth.uid()를 확인하고 "그 사용자 자신만"
// 탈퇴시킬 수 있다.
//
// 필요한 환경변수: SUPABASE_URL(자동 주입), SUPABASE_ANON_KEY(자동 주입),
// SUPABASE_SERVICE_ROLE_KEY(대부분의 프로젝트에 기본 secret으로 이미 있음)
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

const ANON_NAME = "탈퇴한 회원";

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

  const { data: account, error: findErr } = await admin
    .from("accounts")
    .select("id")
    .eq("auth_id", userId)
    .single();
  if (findErr || !account) return json({ error: "계정을 찾을 수 없어요" }, 404);

  // 1) 계정 개인정보 익명화 + 탈퇴 시각 기록
  const { error: accErr } = await admin
    .from("accounts")
    .update({ name: ANON_NAME, phone: null, address: null, deactivated_at: new Date().toISOString() })
    .eq("id", account.id);
  if (accErr) return json({ error: `탈퇴 처리 중 문제가 발생했어요: ${accErr.message}` }, 500);

  // 2) 이 계정의 모든 프로필(가족 프로필 포함) 개인정보 익명화
  const { error: profErr } = await admin
    .from("profiles")
    .update({
      name: ANON_NAME, nickname: null, phone: null, address: null,
      avatar_url: null, memo: null, birth_date: null, label: null,
    })
    .eq("account_id", account.id);
  if (profErr) return json({ error: `프로필 정리 중 문제가 발생했어요: ${profErr.message}` }, 500);

  // 3) auth.users 행 자체를 삭제 — 밴이 아니라 삭제라 이메일/전화번호/소셜 계정이 즉시
  //    풀려서 나중에 같은 수단으로 재가입할 수 있다. accounts.auth_id는 FK 제약이 없어
  //    안전하게 그대로 남는다(다시는 로그인 못 하는 값으로).
  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) return json({ error: `계정 삭제 중 문제가 발생했어요: ${delErr.message}` }, 500);

  return json({ ok: true });
});
