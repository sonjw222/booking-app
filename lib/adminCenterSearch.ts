/*
  운영자 센터 승인 화면의 클라이언트 검색 helper — Next.js Page 파일은 default/허용된 export 외를 내보낼 수 없어(빌드 타입 검사 실패)
  app/admin/centers/page.tsx에서 이 파일로 옮겼다. 동작은 그대로다.
*/
import type { PendingCenter } from "./admin";

// 릴리스 폴리시 배치 8차(2026-09-18), 6번 — 센터 검색. fetchCenters(status)가 이미 그
// 탭(상태)의 센터 전체를 한 번에 불러오므로(페이지네이션 없음, 운영자 화면이라 규모가
// 작음) server round-trip 없이 client-side filtering으로 처리한다(디바운스/이전 결과
// 유지/전체 skeleton 재표시 같은 고민 자체가 필요 없음 — 이미 로드된 배열을 그냥
// 걸러서 보여줄 뿐이라 매 keystroke가 사실상 공짜).
// normalize: 대소문자 무시(사업자번호/전화 등 영문 포함 가능성 대비), 앞뒤 공백 제거,
// 전화번호는 "-" 유무 차이를 흡수하려고 숫자만 남긴 버전도 같이 비교한다.
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
