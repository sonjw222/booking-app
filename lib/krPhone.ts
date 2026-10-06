/*
  한국 휴대폰 번호 정규화(서버 SQL kr_phone_digits와 같은 규칙) — 숫자만 남기고, 국제번호(82…)는 국내 형식(0…)으로("+82 10-…"과 "+82 010-…" 모두 01…).
  스태프 초대 검색처럼 "정확한 전체 번호"만 허용하는 화면이 서버 호출 전에 입력을 검사하는 데 쓴다(최종 판단은 서버 RPC).
*/
export function krPhoneDigits(input: string | null | undefined): string {
  const d = (input ?? "").replace(/[^0-9]/g, "");
  if (/^82/.test(d) && d.length >= 11 && d.length <= 13) {
    const rest = d.slice(2);
    return rest.startsWith("0") ? rest : "0" + rest;
  }
  return d;
}

// 완전한 휴대폰 번호(01X 로 시작하는 10~11자리)인가
export function isFullKrMobile(input: string | null | undefined): boolean {
  return /^01[0-9]{8,9}$/.test(krPhoneDigits(input));
}
