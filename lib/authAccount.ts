import { supabase } from "./supabaseClient";

export type EnsuredAccount = { id: string; phone: string | null; isSocial: boolean; wasCreated: boolean };

// 소셜 로그인(카카오/네이버/애플/구글)으로 처음 로그인한 사용자는 auth.users 행만 생기고
// 우리 앱의 accounts/profiles 행은 아무도 만들어주지 않는다 — 이메일 회원가입
// (app/login/page.tsx의 handleSignup)만 그 두 행을 명시적으로 만들었기 때문이다. 그 결과
// getMyAccountId() 등 거의 모든 화면이 "계정 정보를 찾을 수 없어요"로 막혀 소셜 신규 가입이
// 사실상 동작하지 않았다(코드 감사로 확인, P1). 로그인 직후 한 번 이 함수를 호출해 없으면
// 만들어준다 — 휴대폰 번호는 소셜 제공자가 안정적으로 주지 않고 이번 범위(휴대폰 인증 제외)
// 밖이라 null로 비워두고, 이름은 소셜 프로필 메타데이터에서 최대한 가져온다.
let bootstrapSuppressed = false;


// 애플은 "최초 인증"에서만 사용자 이름을 준다(그 이후 로그인엔 항상 없음) — 그 이름은
// user_metadata가 아니라 ASAuthorizationAppleIDCredential.fullName이라는 별도 필드로만
// 딱 한 번 오므로(ios/App/App/AppleSignInPlugin.swift), signInWithIdToken() 호출과
// SessionWatcher의 onAuthStateChange(SIGNED_IN) → ensureAccountForCurrentUser() 실행
// 사이의 타이밍에 의존하지 않도록(레이스 컨디션 — 둘 다 비동기라 어느 쪽이 먼저 끝날지
// 보장 안 됨) 위 마케팅 동의와 동일한 세션스토리지 스태시 패턴을 그대로 재사용한다.
const APPLE_FULL_NAME_STASH_KEY = "apple_first_auth_full_name";

// lib/appleAuth.ts의 signInWithAppleNative()가 성공 직후(= supabase 세션이 이미 생겨
// SessionWatcher의 SIGNED_IN 핸들러가 언제든 돌 수 있는 시점) 호출한다.
export function stashAppleFullName(name: string): void {
  sessionStorage.setItem(APPLE_FULL_NAME_STASH_KEY, name);
}

function consumeAppleFullName(): string | null {
  const v = sessionStorage.getItem(APPLE_FULL_NAME_STASH_KEY);
  if (v !== null) sessionStorage.removeItem(APPLE_FULL_NAME_STASH_KEY);
  return v;
}

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
// ⚠️ 카카오/네이버 로그인(supabase/functions/kakao-login, naver-login)은 실제 OAuth를 마친 뒤
// Supabase 매직링크(이메일 OTP)로 세션을 발급한다 — 그 결과 Supabase가 기록하는
// app_metadata.provider는 실제 인증 수단인 "email"이 되고, options.data로 넘긴
// provider:"kakao"/"naver"는 user_metadata에만 들어간다(app_metadata와 무관). app_metadata만
// 보면 카카오/네이버 가입자가 전부 isSocial=false로 판정돼 휴대폰 번호 모달이 영영 안 뜨는
// 버그가 있었다(실사용자 계정에서 확인, 2026-09-01) — user_metadata.provider도 같이 본다.
// user_metadata.provider는 두 로그인 함수가 계정 최초 생성 시점에만 세팅하고 이후 안 바뀐다.
// 이 순수 predicate만 따로 export해 단위 테스트로 검증한다(구글/애플은 app_metadata.provider
// 분기, 카카오/네이버는 user_metadata.provider 분기 — 아래 함수 본문 주석 참고).
export function isSocialProvider(user: {
  app_metadata?: { provider?: string };
  user_metadata?: { provider?: string };
}): boolean {
  if (user.user_metadata?.provider === "kakao" || user.user_metadata?.provider === "naver") return true;
  return user.app_metadata?.provider != null && user.app_metadata.provider !== "email";
}

// "현재 로그인 유저 → 내 accounts.id"를 구하는 단일 진실 소스. accounts.auth_id 직접 조회
// 대신 SQL의 my_account_id() RPC를 그대로 호출한다 — 계정 연동(account_auth_identities)으로
// 다른 계정에 합쳐진 경우에도 이 함수 하나만 고치면 전체 앱이 병합된 계정으로 정확히
// resolve된다(2026-09-09, 계정 연동 기능). 새로 코드를 짤 때는 이 함수를 쓰고, accounts를
// `.eq("auth_id", ...)`로 직접 조회하는 패턴은 추가하지 않는다.
export async function getMyAccountId(): Promise<string | null> {
  const { data, error } = await supabase.rpc("my_account_id");
  if (error) return null;
  return (data as string | null) ?? null;
}

// 실기기 QA(2026-09-14, 4차) — Apple 네이티브 신규 가입 실기기 테스트에서
// "프로필이 없어요" 오류가 발생했다. 원인 두 가지를 모두 고침:
// 1) 레이스 컨디션: app/login/page.tsx가 signInWithAppleNative() 성공 직후 곧바로
//    window.location.href = "/"로 전체 페이지 이동을 시작하는데, 이 함수(accounts/
//    profiles 두 번의 INSERT를 순차로 기다리는 비동기 함수)는 SessionWatcher의
//    onAuthStateChange 핸들러가 "따로" 호출한다 — 둘 다 비동기라 이동이 먼저 끝나
//    profiles INSERT가 실행되기도 전에 현재 탭의 JS 컨텍스트가 파괴될 수 있었다.
//    (구글/카카오/네이버는 브라우저 자체가 provider로 나갔다 돌아오는 리다이렉트라
//    "돌아온 새 페이지"에서 이 함수가 처음부터 다시 실행되므로 이 레이스가 없었다.)
//    app/login/page.tsx가 이제 애플 성공 직후 이 함수를 명시적으로 await한 뒤에만
//    이동한다 — 하지만 이 함수 자체도 아래 2)로 더 튼튼하게 만든다.
// 2) profiles INSERT 실패를 확인하지 않고 무시했다 — accounts는 만들어졌는데
//    profiles가 (RLS 문제 등으로) 실패해도 함수가 "성공"을 반환해, 이후
//    getMyAccountId()는 계정을 찾으므로 existingId 분기로 들어가 profiles를 다시
//    만들 기회 자체가 없었다(계정이 이미 있으니 "새로 만드는" 코드 경로에 다시는
//    안 옴). 아래 ensureProfileRow()를 "계정이 이미 있는" 분기에서도 매번 호출해
//    자가 치유(self-healing)되게 한다 — 다음 로그인/앱 재실행마다 프로필 존재를
//    확인하고 없으면 그 자리에서 복구한다.
async function ensureProfileRow(accountId: string, name: string): Promise<void> {
  const { data: existing, error: findErr } = await supabase
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .limit(1);
  if (findErr) return; // 조회 자체가 실패(RLS 등) — 이후 실제 화면에서 다시 드러남, 여기서 막지 않음
  if (existing && existing.length > 0) return; // 이미 있음 — 정상 경로, 아무것도 안 함
  const { error: insertErr } = await supabase.from("profiles").insert({ account_id: accountId, name, is_primary: true });
  // 23505 = unique_violation: 동시에 열린 다른 탭/effect가 먼저 만든 경우 — 정상이므로 무시.
  if (insertErr && insertErr.code !== "23505") {
    console.error("프로필 자동 복구 실패", insertErr);
  }
}

export async function ensureAccountForCurrentUser(): Promise<EnsuredAccount | null> {
  if (bootstrapSuppressed) return null;
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) return null;
  const isSocial = isSocialProvider(user);
  const meta = user.user_metadata ?? {};
  // 애플 최초 인증 이름(consumeAppleFullName 주석 참고)이 있으면 최우선 — user_metadata엔
  // 애초에 안 실리는 값이라 meta.full_name보다 먼저 확인해야 한다. 다른 provider는 이
  // 스태시가 항상 비어 있으므로(null) 기존 동작과 동일. existingId 분기(아래)에서도
  // ensureProfileRow가 이 이름을 쓸 수 있어야 해서 여기서 한 번만 계산한다 — 단,
  // consumeAppleFullName()은 호출 즉시 sessionStorage를 비우므로 정말로 필요한
  // (프로필을 새로 만드는) 경우에만 소비해야 다른 곳에서 한 번 더 못 쓰는 낭비가 없다.
  // existingId 분기에서 프로필이 이미 있으면 이름을 아예 안 쓰므로 무해하다.

  const existingId = await getMyAccountId();
  if (existingId) {
    const { data: existing, error: findErr } = await supabase
      .from("accounts")
      .select("id, phone, name")
      .eq("id", existingId)
      .maybeSingle();
    if (findErr) return null; // 조회 실패 시 조용히 넘어감(RLS 등) — 이후 실제 데이터 호출에서 다시 드러남
    if (existing) {
      await ensureProfileRow(existing.id, existing.name || consumeAppleFullName() || meta.full_name || meta.name || meta.nickname || "회원");
      return { id: existing.id, phone: existing.phone, isSocial, wasCreated: false };
    }
  }

  const name: string =
    consumeAppleFullName() || meta.full_name || meta.name || meta.nickname || (user.email ? user.email.split("@")[0] : "회원");

  // 마케팅 동의는 여기서는 항상 false로 시작한다 — 소셜 신규 가입의 실제 동의는 provider
  // 인증 "이후" SessionWatcher의 소셜 가입 완료 모달에서 받고 completeSocialProfile()이
  // 그 값으로 덮어쓴다(사전 스태시 방식 제거, 위 주석 참고).
  const { data: account, error: accErr } = await supabase
    .from("accounts")
    .insert({
      auth_id: user.id,
      name,
      is_member: true,
      marketing_consent: false,
      marketing_consent_at: null,
    })
    .select("id, phone")
    .single();
  if (accErr || !account) {
    // 23505 = unique_violation: 동시에 열린 다른 탭/effect가 먼저 만든 경우 — 정상이므로 무시.
    // (다음 SIGNED_IN/INITIAL_SESSION 호출에서 existing 분기로 다시 조회됨)
    return null;
  }

  await ensureProfileRow(account.id, name);
  return { id: account.id, phone: account.phone, isSocial, wasCreated: true };
}

// 소셜 가입 완료 모달(SessionWatcher)에서 호출 — phone은 필수, address는 선택(도로명주소+
// 상세주소를 합친 문자열 또는 null). 실기기 QA(2026-09-14, 4차) — 이 모달이 사실상 소셜
// 회원가입을 "마무리"하는 유일한 화면인데 필수 약관(이용약관/개인정보처리방침) 동의를 전혀
// 받지 않고 있었다 — 로그인 화면의 소셜 버튼은 "signup 모드"에서만 그 동의 체크박스를
// 보여주는데, 신규 사용자가 기본값인 "login 모드"에서 소셜 버튼을 눌러도 계정이 만들어지므로
// 그 경로를 타면 동의를 아예 안 거친다. 이 앱 전체에 약관/개인정보 동의를 DB에 개별 기록하는
// 컬럼이 없다(마케팅 동의만 accounts.marketing_consent로 기록됨, 기존 구조 확인 — 새 컬럼을
// 임의로 만들지 않는다) — 기존과 동일하게 "제출 전 체크 필수" UI 게이트만 추가하고, 마케팅
// 동의는 기존 이메일 가입과 동일한 컬럼에 기록한다.
export async function completeSocialProfile(
  accountId: string,
  phone: string,
  address: string | null,
  marketingConsent: boolean
): Promise<void> {
  const { error } = await supabase
    .from("accounts")
    .update({
      phone,
      address,
      marketing_consent: marketingConsent,
      marketing_consent_at: marketingConsent ? new Date().toISOString() : null,
    })
    .eq("id", accountId);
  if (error) {
    if (error.code === "23505") throw new Error("이미 다른 계정에 등록된 번호예요");
    throw new Error(error.message);
  }
}

// 토스페이먼츠 카드사 심사용 "심사관 전용 계정" 판별(2026-09-06,
// add_pg_checkout_reviewer_override.sql). 이 값은 운영자만 바꿀 수 있고(트리거로 보호,
// 본인이 스스로 켤 수 없음) — 로그인 안 했거나 계정 조회 실패 시 안전하게 false로
// 취급한다(전역 게이트가 꺼져 있으면 기본은 항상 직접결제만).
export async function fetchMyPgCheckoutOverride(): Promise<boolean> {
  const accountId = await getMyAccountId();
  if (!accountId) return false;
  const { data } = await supabase
    .from("accounts")
    .select("pg_checkout_override")
    .eq("id", accountId)
    .maybeSingle();
  return !!data?.pg_checkout_override;
}
