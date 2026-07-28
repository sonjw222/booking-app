/*
  예약 화면 ↔ 센터 상세/결제 화면을 오가는 흐름에서 쓰는 "복귀 URL" 규칙 한 곳에 모음
  - 세 화면(app/reservation, app/center/[id], app/checkout)이 각자 URL을 조립하면
    한쪽만 파라미터 이름을 바꿔도 복귀가 깨지므로, 이 한 함수만 기준으로 삼음
  - Supabase 의존 없는 순수 함수라 서버/클라이언트 어디서든 안전하게 import 가능
*/

export function reservationReturnUrl(opts: {
  classId: string;
  date: string; // "YYYY-MM-DD"
  center?: string | null;
  purchased?: boolean;
}): string {
  const params = new URLSearchParams();
  params.set("openClassId", opts.classId);
  params.set("openDate", opts.date);
  if (opts.center) params.set("center", opts.center);
  if (opts.purchased) params.set("purchased", "1");
  return `/reservation?${params.toString()}`;
}
