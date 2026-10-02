/*
  회원 이름 표시 규칙(2026-10-03) — 관리자 화면에는 가입 때 사용자가 입력/확인한 실제 이름만 보여준다.
  소셜 가입(특히 Apple: 이름 미제공)에서 이름이 없으면 이메일 앞부분/랜덤 handle이 이름으로 저장돼 "92wr87mcz5" 같은 값이 관리자에게 보였다.
  실명을 만들어내지 않는다 — 합성 handle로 보이는 값은 "이름 미등록"으로 표시하고(전화번호와 함께 구분 가능), 실제 이름은 사용자가 가입 마무리에서 입력한다.
*/
export const UNNAMED_MEMBER_LABEL = "이름 미등록";

// 합성 handle 판별: 소문자 영문+숫자만이고 숫자를 포함하며 8~24자(이메일 local part/랜덤 id 형태). 한글/공백/대문자가 있으면 실제 이름으로 본다.
export function isSyntheticMemberName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  if (!n) return true;
  if (n === "회원" || n === "(이름 없음)") return true;
  return /^(?=.*\d)[a-z0-9]{8,24}$/.test(n);
}

export function displayMemberName(name: string | null | undefined): string {
  return isSyntheticMemberName(name) ? UNNAMED_MEMBER_LABEL : (name as string).trim();
}

/*
  소셜 가입 마무리(SessionWatcher) gate 판정. 소셜 계정만 대상이며 이메일 계정에는 gate가 생기지 않는다.
  - "full": 전화번호가 없음 → 기존 전화 인증 흐름(이름 포함)
  - "name": 전화번호는 있지만 대표 이름(accounts.name 또는 primary profile 이름)이 합성/미등록 → 이름만 받는다(저장된 전화번호는 건드리지 않는다)
  - null: 필요 없음
*/
export type SocialCompletionNeed = "full" | "name" | null;
export function socialCompletionNeed(a: { isSocial: boolean; phone: string | null; name: string | null; profileName?: string | null } | null | undefined): SocialCompletionNeed {
  if (!a || !a.isSocial) return null;
  if (!a.phone) return "full";
  if (isSyntheticMemberName(a.name) || isSyntheticMemberName(a.profileName === undefined ? a.name : a.profileName)) return "name";
  return null;
}
