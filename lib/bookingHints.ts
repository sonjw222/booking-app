/* F10: 수업 카드에서 "지금 예약/대기를 받을 수 없는 이유"를 미리 알려 주는 안내. 서버(reserve_class / reserve_with_membership)가 같은 입력으로
   거절하는 경우만 다룬다 — 입력은 서버가 읽는 값(center_settings, 수업 정원, 수업의 개별 예약마감)과 같고, 판단할 수 없으면 null(안내 없음)이다.
   예약 오픈 시각·취소/예약 마감 시각·일일 제한·주간 대기 횟수처럼 계정/시각에 따라 달라지는 조건은 여기서 판단하지 않고 서버 판정에 맡긴다.
   서버 검증을 대체하지 않는다(안내가 없어도 서버가 거절할 수 있고, 안내가 있으면 버튼을 누를 필요가 없다는 뜻일 뿐이다). */
export type BookingHint = { kind: "no_waitlist" | "private_full" | "same_day_off"; label: string };

export function bookingHint(i: {
  full: boolean;
  classFormat: "group" | "private";
  waitlistWeeklyLimit: number | null | undefined;   // null/undefined = 설정을 읽지 못함(모름)
  allowSameDayBooking: boolean | null | undefined;
  bookingDeadlineMin: number | null | undefined;   // 수업 개별 예약마감이 있으면 당일 예약 토글을 건너뛴다(서버 동일)
  classDate: string;                                // YYYY-MM-DD (KST)
  todayKst: string;
}): BookingHint | null {
  if (i.full && i.classFormat === "private") return { kind: "private_full", label: "예약 마감 · 프라이빗은 대기 없음" };
  if (i.full && i.classFormat === "group" && i.waitlistWeeklyLimit === 0) return { kind: "no_waitlist", label: "마감 · 대기 불가" };
  if (!i.full && i.allowSameDayBooking === false && (i.bookingDeadlineMin ?? null) === null && i.classDate === i.todayKst) {
    return { kind: "same_day_off", label: "당일 예약 불가" };
  }
  return null;
}
