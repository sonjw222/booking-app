import { supabase } from './supabaseClient';
import { computeEffectiveCancelDeadline } from './cancelDeadline';

export type CancelNoticePolicy = {
  startsAt: string; createdAt: string; deadline: string; allowCancel: boolean;
  deductLate: boolean; sameDayHours: number; sameDayMinutes: number;
};
const kstDay = (value: number) => new Date(value + 9 * 3600000).toISOString().slice(0, 10);
// Read-only estimate; cancel_reservation rechecks all rules when the user confirms.
export function cancellationNotice(p: CancelNoticePolicy, now = Date.now()): string {
  const start = Date.parse(p.startsAt), created = Date.parse(p.createdAt), deadline = Date.parse(p.deadline);
  if (![start, created, deadline, now].every(Number.isFinite)) throw new Error('취소 조건을 확인하지 못했어요. 다시 시도해주세요.');
  if (now >= start) return '수업이 시작되어 취소할 수 없어요.';
  const grace = Math.min(created + 600000, start);
  if (!p.allowCancel && now > grace) return '이 수업은 예약 취소가 불가능해요.';
  let effective = computeEffectiveCancelDeadline(new Date(deadline), new Date(created), new Date(start)).getTime();
  if (kstDay(created) === kstDay(start) && kstDay(deadline) < kstDay(now)) {
    effective = Math.max(effective, start - (p.sameDayHours * 60 + p.sameDayMinutes) * 60000);
  }
  if (now <= effective) return now <= grace ? '예약 후 10분 유예 또는 취소 마감 내 무료 취소예요. 수강권은 차감되지 않아요.' : '취소 마감 전 무료 취소예요. 수강권은 차감되지 않아요.';
  return p.deductLate ? '취소 마감이 지나 수강권 차감이 유지돼요(사용한 횟수가 복원되지 않아요).' : '취소 마감이 지나 취소할 수 없어요.';
}

type ReservationPolicyRow = { created_at: string; classes: { center_id: string; start_time: string; class_format: string; cancel_deadline_min: number | null; allow_cancel: boolean | null } };
export async function fetchCancellationNotice(reservationId: string): Promise<string> {
  const { data, error } = await supabase.from('reservations')
    .select('created_at,classes!inner(center_id,start_time,class_format,cancel_deadline_min,allow_cancel)')
    .eq('id', reservationId).single();
  if (error || !data) throw new Error('취소 조건을 확인하지 못했어요. 다시 시도해주세요.');
  const row = data as unknown as ReservationPolicyRow, cls = row.classes;
  const settings = await supabase.from('center_settings')
    .select('deduct_on_late_cancel,same_day_change_hours,same_day_change_minutes')
    .eq('center_id', cls.center_id).maybeSingle();
  if (settings.error || !settings.data) throw new Error('취소 조건을 확인하지 못했어요. 다시 시도해주세요.');
  let deadline: string;
  if (cls.cancel_deadline_min !== null) deadline = new Date(Date.parse(cls.start_time) - cls.cancel_deadline_min * 60000).toISOString();
  else {
    const result = await supabase.rpc('calc_deadline', { p_center_id: cls.center_id, p_class_format: cls.class_format, p_start_time: cls.start_time, p_kind: 'cancel' });
    if (result.error) throw new Error('취소 조건을 확인하지 못했어요. 다시 시도해주세요.');
    deadline = result.data ?? cls.start_time;
  }
  return cancellationNotice({ startsAt: cls.start_time, createdAt: row.created_at, deadline,
    allowCancel: cls.allow_cancel !== false, deductLate: settings.data?.deduct_on_late_cancel ?? false,
    sameDayHours: settings.data?.same_day_change_hours ?? 0, sameDayMinutes: settings.data?.same_day_change_minutes ?? 0 });
}
