/*
  수업 등록 화면의 "N일 N시간 N분 전까지" 입력칸 ↔ 분(minutes) 변환.
  cancel_deadline_min/booking_deadline_min 둘 다 동일한 변환 규칙을 쓰므로 공용 함수로 뽑았다
  (CLASS-001). 세 칸이 모두 비어 있으면 null(= 운영설정 기본값 사용)을 반환한다.
*/

export function dhmToMinutes(dStr: string, hStr: string, mStr: string): number | null {
  if (!dStr && !hStr && !mStr) return null;
  const d = parseInt(dStr || "0", 10) || 0;
  const h = parseInt(hStr || "0", 10) || 0;
  const m = parseInt(mStr || "0", 10) || 0;
  return d * 1440 + h * 60 + m;
}

export function minutesToDhm(min: number | null): { d: string; h: string; m: string } {
  if (min == null || min <= 0) return { d: "", h: "", m: "" };
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return { d: String(d || ""), h: String(h || ""), m: String(m || "") };
}
