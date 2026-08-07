/*
  매니저 - 휴무일 설정
  - 센터 휴무일 추가/삭제 (예약 화면이 이 날짜를 예약 불가로 처리)
*/

import { supabase } from "./supabaseClient";

export type Holiday = {
  id: string;
  date: string;      // "2026-07-20"
  reason: string | null;
};

// 특정 월 이후의 휴무일 목록
export async function fetchHolidays(centerId: string): Promise<Holiday[]> {
  const { data, error } = await supabase
    .from("center_holidays")
    .select("id, holiday_date, reason")
    .eq("center_id", centerId)
    .order("holiday_date", { ascending: true });
  if (error) throw new Error("휴무일을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((h: any) => ({
    id: h.id, date: h.holiday_date, reason: h.reason,
  }));
}

export type AddHolidayResult =
  | { needsConfirm: true; classCount: number; reservationCount: number }
  | { needsConfirm: false; deletedClasses: number; cancelledReservations: number };

export async function addHoliday(centerId: string, date: string, reason: string, force = false): Promise<AddHolidayResult> {
  const { data, error } = await supabase.rpc("add_holiday_safe", {
    p_center_id: centerId,
    p_date: date,
    p_reason: reason || null,
    p_force: force,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  const d = data as any;
  if (d.needs_confirm) {
    return { needsConfirm: true, classCount: d.class_count, reservationCount: d.reservation_count };
  }
  return { needsConfirm: false, deletedClasses: d.deleted_classes, cancelledReservations: d.cancelled_reservations };
}

// 휴무일 삭제 — 그날 휴무일 때문에 폐강(cancelled) 처리됐던 수업들을 다시 예약 가능(open)
// 상태로 되돌리는 것까지 하나의 RPC(remove_holiday_safe)로 원자적으로 처리한다. 예전에는
// center_holidays 행만 직접 지웠는데, 그 경우 add_holiday_safe()가 그때 함께 cancelled로
// 바꿔둔 classes.status는 아무도 되돌리지 않아 "휴무일을 지워도 수업은 계속 폐강 상태"로
// 남는 버그가 있었다.
export async function deleteHoliday(id: string): Promise<void> {
  const { error } = await supabase.rpc("remove_holiday_safe", { p_holiday_id: id });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}
