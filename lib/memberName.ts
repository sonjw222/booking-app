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
