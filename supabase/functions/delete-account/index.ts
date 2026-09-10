// Supabase Edge Function: 계정 탈퇴 (실제 개인정보 삭제/익명화)
//
// 2026-08-19 정책 변경: 이전엔 accounts.deactivated_at만 채우고 auth를 100년 밴하는
// 소프트 삭제였다 — 로그인만 막힐 뿐 이름/전화번호/이메일 등 개인정보는 그대로 남아있었다.
// Apple/Google 계정 삭제 가이드라인은 단순 비활성화만으로는 부족하고 개인정보를 실제로
// 지우거나 식별 불가능하게 만들 것을 요구한다 — 이번 배치로 그렇게 바꾼다.
//
// 2026-09-10 Privacy Emergency Fix Batch (P0-1/P0-2): accounts 행 자체를 지우지 않고
// 익명화만 하기 때문에 native_push_tokens/push_subscriptions의 FK cascade가 절대
// 발동하지 않아 탈퇴 후에도 기기 토큰이 남아 계속 푸시가 나갈 수 있었고, avatar_url도
// 컬럼만 비우고 Storage object는 그대로 남아 orphan 공개 파일이 됐다 — 아래 1)/2)로 수정.
//
// 하는 일 (사용자 결정: 재가입 허용 — docs/TODO.md P1-18 참고):
//   1) 이 계정의 native_push_tokens/push_subscriptions를 전부 삭제한다(P0-1) —
//      accounts 행이 살아있으므로 FK cascade에 의존하지 않고 명시적으로 지운다.
//   2) 이 계정(가족 프로필 포함)의 avatar Storage object를 실제로 지운다(P0-2) —
//      아래 4)에서 profiles.avatar_url 컬럼을 null로 덮어쓰기 *전에* 실행한다.
//      순서가 바뀌면 재시도 시 어떤 파일을 지워야 하는지 알 방법이 없어진다.
//   3) accounts의 개인정보(name/phone/address)를 익명값으로 덮어쓰고 deactivated_at을
//      채운다(탈퇴 시각 기록 — 이 값 자체는 개인정보 아님)
//   4) 그 계정의 모든 profiles(가족 프로필 포함)의 개인정보(name/nickname/phone/address/
//      avatar_url/memo/birth_date/label)도 익명값으로 덮어쓴다
//   5) auth.users 행을 실제로 삭제한다(admin.deleteUser) — 밴이 아니라 삭제라 같은
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
// idempotency: 같은 요청이 중간 실패 후 재시도돼도 안전하도록 모든 단계가 멱등하게
// 작성돼 있다(DELETE는 이미 없어도 0행 성공, UPDATE는 같은 값으로 다시 덮어써도 무해).
// 단, Storage 삭제가 실패한 뒤 profiles.avatar_url이 이미 null로 덮여버리면 그 특정
// object는 재시도로도 다시 찾아낼 방법이 없다 — best-effort로 로그만 남기고 계속
// 진행한다(사용자 개인정보 삭제 자체를 이 실패로 막지 않는 게 더 안전하다고 판단, 아래
// deleteAvatarObjects 참고). 반대로 native_push_tokens/push_subscriptions DELETE는
// 실패를 조용히 넘기지 않고 전체 탈퇴를 막는다(재시도가 값싸고 안전하기 때문).
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

// Postgres "relation does not exist" — native_push_tokens는 add_native_push_tokens.sql이
// 아직 이 프로젝트의 운영 DB에 적용되지 않았으면 존재하지 않는다(2026-09-10 확인, 이
// 배치가 비활성 사용자 발송 차단을 위해 send-web-push도 같은 방식으로 방어한다). 그
// 마이그레이션이 적용되기 전까지는 "지울 토큰이 원래 없다"와 동치이므로 조용히 넘어가고,
// 그 외의 실패(권한 오류 등 진짜 문제)는 그대로 호출자에게 알린다.
const UNDEFINED_TABLE = "42P01";

// account_id 기준으로 토큰/구독을 전부 지운다. 실패를 삼키지 않는다(요구사항 2번) —
// 테이블이 아직 없는 경우만 예외로 취급한다.
// deno-lint-ignore no-explicit-any
async function deleteAllTokensFor(
  admin: any,
  table: "native_push_tokens" | "push_subscriptions",
  accountId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await admin.from(table).delete().eq("account_id", accountId);
  if (!error) return { ok: true };
  if ((error as { code?: string }).code === UNDEFINED_TABLE) {
    console.warn(`[delete-account] ${table} 테이블이 아직 없어 건너뜀 (마이그레이션 미적용)`);
    return { ok: true };
  }
  return { ok: false, message: error.message };
}

// profiles.avatar_url에 저장된 값에서 "avatars" 버킷 안의 object key만 뽑아낸다.
//   - 이미 순수 object key("uuid.jpg")로 저장된 게 표준 형태(lib/profiles.ts uploadAvatar).
//   - "http..."로 시작하면 getPublicUrl()이 만든 전체 URL(레거시/시딩 데이터 가능성) —
//     "/storage/v1/object/public/avatars/" 마커 뒤의 경로만 이 버킷 소유로 인정한다.
//     다른 호스트/버킷을 가리키는 외부 URL(테스트 fixture의 https://example.com/... 포함)은
//     우리가 지울 수 있는 object가 아니므로 null을 반환해 건너뛴다 — 소유를 확실히 판별
//     못하는 파일은 임의로 지우지 않는다(작업 지시 4번).
function avatarObjectKey(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("http")) return raw;
  const marker = "/storage/v1/object/public/avatars/";
  const idx = raw.indexOf(marker);
  if (idx === -1) return null;
  try {
    return decodeURIComponent(raw.slice(idx + marker.length));
  } catch {
    return null;
  }
}

// 이 계정 소유 profiles(가족 포함)의 avatar object를 Storage에서 실제로 지운다.
// best-effort — 실패해도 전체 탈퇴를 막지 않는다(파일 위 주석 "idempotency" 참고).
// avatar_url 컬럼은 이 함수 호출 *뒤에* profiles UPDATE로 null이 된다 — 순서가
// 바뀌면 재시도 시 지울 대상을 다시 찾을 방법이 없어진다.
// deno-lint-ignore no-explicit-any
async function deleteAvatarObjects(admin: any, accountId: string): Promise<void> {
  const { data: profs, error } = await admin
    .from("profiles")
    .select("avatar_url")
    .eq("account_id", accountId)
    .not("avatar_url", "is", null);
  if (error) {
    console.error(`[delete-account] avatar 조회 실패, Storage 정리 건너뜀: ${error.message}`);
    return;
  }
  const rows = (profs ?? []) as Array<{ avatar_url: string | null }>;
  const keys: string[] = [...new Set(
    rows.map((p) => avatarObjectKey(p.avatar_url)).filter((k): k is string => !!k),
  )];
  if (keys.length === 0) return;

  const { error: removeErr } = await admin.storage.from("avatars").remove(keys);
  if (removeErr) {
    // 로그만 남긴다 — orphan cleanup 대상(추후 별도 배치)으로만 취급, 탈퇴 자체는 계속.
    console.error(`[delete-account] avatar object 삭제 실패(orphan 가능성, 수동 확인 필요): ${keys.join(", ")} — ${removeErr.message}`);
  }
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

  // 계정 연동(account_auth_identities) fallback을 의도적으로 안 쓴다 — 병합으로 흡수된
  // 계정(B)으로 로그인해 탈퇴를 누르면 "지금 이 로그인으로 실제 만들어진 accounts 행"(B의
  // 흡수된 stub)만 지워야 한다. fallback을 넣으면 B로 로그인한 채 남은(A) 계정 전체를
  // 삭제해버리는 사고가 난다.
  const { data: account, error: findErr } = await admin
    .from("accounts")
    .select("id")
    .eq("auth_id", userId)
    .single();
  if (findErr || !account) return json({ error: "계정을 찾을 수 없어요" }, 404);

  // 1) 이 계정의 기기 푸시 토큰/구독을 전부 삭제한다(P0-1). accounts 행이 삭제가 아니라
  //    익명화만 되므로 FK cascade(on delete cascade)가 절대 발동하지 않아 명시적으로
  //    지워야 한다 — 안 지우면 탈퇴 후에도 계속 푸시가 나갈 수 있다. 실패는 조용히
  //    넘기지 않고 탈퇴 자체를 막는다(재시도가 값싸고 안전함).
  const nativeResult = await deleteAllTokensFor(admin, "native_push_tokens", account.id);
  if (!nativeResult.ok) {
    return json({ error: `푸시 토큰 정리 중 문제가 발생했어요: ${nativeResult.message}` }, 500);
  }
  const webPushResult = await deleteAllTokensFor(admin, "push_subscriptions", account.id);
  if (!webPushResult.ok) {
    return json({ error: `푸시 구독 정리 중 문제가 발생했어요: ${webPushResult.message}` }, 500);
  }

  // 2) 이 계정(과 가족 프로필)이 올린 avatar Storage object를 실제로 지운다(P0-2).
  //    아래 3)에서 profiles.avatar_url을 null로 덮어쓰기 *전에* 실행해야 한다 — 순서가
  //    바뀌면 재시도 시 어떤 파일을 지워야 하는지 더 이상 알 수 없다. best-effort이며
  //    실패해도 계속 진행한다(파일 상단 idempotency 주석 참고).
  await deleteAvatarObjects(admin, account.id);

  // 3) 계정 개인정보 익명화 + 탈퇴 시각 기록
  const { error: accErr } = await admin
    .from("accounts")
    .update({ name: ANON_NAME, phone: null, address: null, deactivated_at: new Date().toISOString() })
    .eq("id", account.id);
  if (accErr) return json({ error: `탈퇴 처리 중 문제가 발생했어요: ${accErr.message}` }, 500);

  // 4) 이 계정의 모든 프로필(가족 프로필 포함) 개인정보 익명화
  const { error: profErr } = await admin
    .from("profiles")
    .update({
      name: ANON_NAME, nickname: null, phone: null, address: null,
      avatar_url: null, memo: null, birth_date: null, label: null,
    })
    .eq("account_id", account.id);
  if (profErr) return json({ error: `프로필 정리 중 문제가 발생했어요: ${profErr.message}` }, 500);

  // 5) auth.users 행 자체를 삭제 — 밴이 아니라 삭제라 이메일/전화번호/소셜 계정이 즉시
  //    풀려서 나중에 같은 수단으로 재가입할 수 있다. accounts.auth_id는 FK 제약이 없어
  //    안전하게 그대로 남는다(다시는 로그인 못 하는 값으로).
  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) return json({ error: `계정 삭제 중 문제가 발생했어요: ${delErr.message}` }, 500);

  return json({ ok: true });
});
