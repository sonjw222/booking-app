import { supabase } from "./supabaseClient";

export type EnsuredAccount = { id: string; phone: string | null; isSocial: boolean };

// 소셜 로그인(카카오/네이버/애플/구글)으로 처음 로그인한 사용자는 auth.users 행만 생기고
// 우리 앱의 accounts/profiles 행은 아무도 만들어주지 않는다 — 이메일 회원가입
// (app/login/page.tsx의 handleSignup)만 그 두 행을 명시적으로 만들었기 때문이다. 그 결과
// getMyAccountId() 등 거의 모든 화면이 "계정 정보를 찾을 수 없어요"로 막혀 소셜 신규 가입이
// 사실상 동작하지 않았다(코드 감사로 확인, P1). 로그인 직후 한 번 이 함수를 호출해 없으면
// 만들어준다 — 휴대폰 번호는 소셜 제공자가 안정적으로 주지 않고 이번 범위(휴대폰 인증 제외)
// 밖이라 null로 비워두고, 이름은 소셜 프로필 메타데이터에서 최대한 가져온다.
let bootstrapSuppressed = false;

// 회원가입 화면(app/login/page.tsx의 handleSignup)이 signUp() 직후 accounts/profiles(+매니저면
// centers)를 자기 손으로 한 번에 만드는 동안에는 이 함수를 끈다. SessionWatcher가 앱 전체에서
// SIGNED_IN 이벤트마다 이 함수를 호출하는데, signUp()도 SIGNED_IN을 발생시키므로 두 insert가
// 동시에 accounts.auth_id(unique)를 놓고 경합해 handleSignup 쪽이 종종 "계정 생성 중 문제가
// 발생했어요"로 실패했다(실제로는 SessionWatcher가 먼저 "빈" 계정을 만들어버린 것 — 전화번호/
// 매니저 여부/센터가 전부 빠진 반쪽짜리 가입으로 남음). 신규 가입은 handleSignup이 전담하고,
// 이미 세션이 있는 상태로 재방문/소셜 로그인일 때만 이 함수가 필요하므로 signUp 구간만 끄면 된다.
export function setBootstrapSuppressed(v: boolean) {
  bootstrapSuppressed = v;
}

// 반환값(phone/isSocial 포함)은 SessionWatcher가 "휴대폰 번호 입력 모달"을 띄울지 판단하는 데
// 쓴다 — 이번에 새로 만든 계정인지 여부가 아니라 phone이 실제로 비어 있는지로 판단해야, 모달을
// 안 채우고 새로고침하는 식으로 우회할 수 없다(계정이 이미 있어도 phone이 null이면 매번
// 다시 뜸). isSocial(= Supabase Auth의 provider가 email이 아님)로 대상을 소셜 계정만으로
// 좁힌다 — 이메일 가입은 폼에서 이미 phone을 필수로 받으므로 원칙적으로 null일 일이 없지만,
// 이 기능이 생기기 전에 만들어진 기존 이메일 계정(테스트 계정 포함)은 phone이 비어 있을 수
// 있고, 그런 계정까지 이 모달로 막으면 안 된다(실제로 E2E 테스트 계정 전체가 이 문제로
// 막혔던 사고 — 2026-08-14).
function isSocialProvider(user: { app_metadata?: { provider?: string } }): boolean {
  return user.app_metadata?.provider != null && user.app_metadata.provider !== "email";
}

export async function ensureAccountForCurrentUser(): Promise<EnsuredAccount | null> {
  if (bootstrapSuppressed) return null;
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) return null;
  const isSocial = isSocialProvider(user);

  const { data: existing, error: findErr } = await supabase
    .from("accounts")
    .select("id, phone")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (findErr) return null; // 조회 실패 시 조용히 넘어감(RLS 등) — 이후 실제 데이터 호출에서 다시 드러남
  if (existing) return { id: existing.id, phone: existing.phone, isSocial };

  const meta = user.user_metadata ?? {};
  const name: string =
    meta.full_name || meta.name || meta.nickname || (user.email ? user.email.split("@")[0] : "회원");

  const { data: account, error: accErr } = await supabase
    .from("accounts")
    .insert({ auth_id: user.id, name, is_member: true })
    .select("id, phone")
    .single();
  if (accErr || !account) {
    // 23505 = unique_violation: 동시에 열린 다른 탭/effect가 먼저 만든 경우 — 정상이므로 무시.
    // (다음 SIGNED_IN/INITIAL_SESSION 호출에서 existing 분기로 다시 조회됨)
    return null;
  }

  await supabase.from("profiles").insert({ account_id: account.id, name, is_primary: true });
  return { id: account.id, phone: account.phone, isSocial };
}

// 소셜 가입 직후 "휴대폰 번호 입력" 모달(SessionWatcher)에서 호출 — phone은 필수, address는
// 선택(도로명주소+상세주소를 합친 문자열 또는 null).
export async function completeSocialProfile(accountId: string, phone: string, address: string | null): Promise<void> {
  const { error } = await supabase.from("accounts").update({ phone, address }).eq("id", accountId);
  if (error) {
    if (error.code === "23505") throw new Error("이미 다른 계정에 등록된 번호예요");
    throw new Error(error.message);
  }
}
