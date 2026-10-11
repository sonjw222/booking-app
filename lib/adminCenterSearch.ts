/*
  운영자 센터 승인 화면의 클라이언트 검색 helper — Next.js Page 파일은 default/허용된 export 외를 내보낼 수 없어(빌드 타입 검사 실패)
  app/admin/centers/page.tsx에서 이 파일로 옮겼다. 동작은 그대로다.
*/
import type { PendingCenter } from "./admin";

// 호환 조회의 검색 및 SQL 검색과의 의미 비교용 helper. 전화/사업자번호는 구분 기호를 제거한다.
export function normalizeSearchText(s: string): string {
  return s.trim().toLowerCase();
}
export function digitsOnly(s: string): string {
  return s.replace(/[^0-9]/g, "");
}
export function centerMatchesKeyword(c: PendingCenter, keyword: string): boolean {
  const kw = normalizeSearchText(keyword);
  if (!kw) return true;
  const kwDigits = digitsOnly(keyword);
  const textFields = [c.name, c.ownerName, c.address];
  if (textFields.some((v) => v && normalizeSearchText(v).includes(kw))) return true;
  // 전화번호/사업자번호는 "-" 유무가 갈릴 수 있어 숫자만 비교(검색어에 숫자가 있을 때만).
  if (kwDigits.length > 0) {
    const numberFields = [c.phone, c.ownerPhone, c.businessNumber];
    if (numberFields.some((v) => v && digitsOnly(v).includes(kwDigits))) return true;
  }
  return false;
}
