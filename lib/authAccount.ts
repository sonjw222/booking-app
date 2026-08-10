import { supabase } from "./supabaseClient";

// 소셜 로그인(카카오/네이버/애플/구글)으로 처음 로그인한 사용자는 auth.users 행만 생기고
// 우리 앱의 accounts/profiles 행은 아무도 만들어주지 않는다 — 이메일 회원가입
// (app/login/page.tsx의 handleSignup)만 그 두 행을 명시적으로 만들었기 때문이다. 그 결과
// getMyAccountId() 등 거의 모든 화면이 "계정 정보를 찾을 수 없어요"로 막혀 소셜 신규 가입이
// 사실상 동작하지 않았다(코드 감사로 확인, P1). 로그인 직후 한 번 이 함수를 호출해 없으면
// 만들어준다 — 휴대폰 번호는 소셜 제공자가 안정적으로 주지 않고 이번 범위(휴대폰 인증 제외)
// 밖이라 null로 비워두고, 이름은 소셜 프로필 메타데이터에서 최대한 가져온다.
export async function ensureAccountForCurrentUser(): Promise<void> {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) return;

  const { data: existing, error: findErr } = await supabase
    .from("accounts")
    .select("id")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (findErr) return; // 조회 실패 시 조용히 넘어감(RLS 등) — 이후 실제 데이터 호출에서 다시 드러남
  if (existing) return;

  const meta = user.user_metadata ?? {};
  const name: string =
    meta.full_name || meta.name || meta.nickname || (user.email ? user.email.split("@")[0] : "회원");

  const { data: account, error: accErr } = await supabase
    .from("accounts")
    .insert({ auth_id: user.id, name, is_member: true })
    .select("id")
    .single();
  if (accErr || !account) {
    // 23505 = unique_violation: 동시에 열린 다른 탭/effect가 먼저 만든 경우 — 정상이므로 무시.
    if (accErr?.code === "23505") return;
    return; // 그 외 실패도 조용히 넘어감 — 다음 실제 데이터 호출에서 명확한 에러로 다시 드러남
  }

  // P1-16 임시 진단(재현 확정용, 동작 변경 없음) — 이 insert의 error를 원래 코드는
  // 전혀 확인하지 않았다. 실패 원인을 확정하기 위해 잠깐 로그만 남긴다.
  const profileInsertRes = await supabase.from("profiles").insert({ account_id: account.id, name, is_primary: true });
  if (profileInsertRes.error) {
    console.error(`[P1-16 진단] profiles insert 실패: code=${profileInsertRes.error.code} message=${profileInsertRes.error.message} details=${profileInsertRes.error.details} hint=${profileInsertRes.error.hint} account_id=${account.id}`);
  }
}
