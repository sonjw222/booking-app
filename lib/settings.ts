/*
  매니저 - 센터 운영 설정 (17항목)
  - center_settings 를 읽고 저장
  - 행이 없으면 기본값으로 새로 만들어 편집
*/

import { supabase } from "./supabaseClient";

// DB 컬럼과 1:1 매핑되는 설정 타입 (카멜케이스)
export type CenterSettings = {
  // 01. 예약·취소 가능 시간
  privateBookDaysBefore: number;
  privateBookTime: string;      // "22:00"
  groupBookDaysBefore: number;
  groupBookTime: string;
  privateCancelDaysBefore: number;
  privateCancelTime: string;
  groupCancelDaysBefore: number;
  groupCancelTime: string;
  // 02. 당일 예약 변경 가능 시간
  allowSameDayBooking: boolean;
  sameDayChangeHours: number;
  sameDayChangeMinutes: number;
  // 03. 수업 폐강 시간
  autocancelHours: number;
  autocancelMinutes: number;
  // 04. 예약대기 자동 예약 시간
  waitlistAutoHours: number;
  waitlistAutoMinutes: number;
  // 05. 예약 대기 가능 횟수
  waitlistWeeklyLimit: number;
  // 06. 일일 예약 가능 횟수
  dailyBookLimitEnabled: boolean;
  dailyBookLimit: number | null;
  // 07. 예약 가능 기한
  privateOpenDaysBefore: number;
  privateOpenTime: string;
  groupOpenDaysBefore: number;
  groupOpenTime: string;
  // 08. 프라이빗 예약 시간 단위
  privateSlotUnit: string;
  // 09. 프라이빗 동시 최대 개수
  privateMaxConcurrentEnabled: boolean;
  privateMaxConcurrent: number | null;
  // 10. 인원 표시
  showGroupReservedCount: boolean;
  showGroupWaitlistCount: boolean;
  // 11~17
  useInquiryBoard: boolean;
  showAllClasses: boolean;
  useLocker: boolean;
  deductOnLateCancel: boolean;
  autoUnpaidInput: boolean;
  useLounge: boolean;
  showPointHistory: boolean;
  // 18. 수업매출 캘린더: 정기권(기간제) 매출 배분 방식
  unlimitedPassRevenueMode: "usage_split" | "purchase_date_full";
};

export const DEFAULT_SETTINGS: CenterSettings = {
  privateBookDaysBefore: 1, privateBookTime: "22:00",
  groupBookDaysBefore: 1, groupBookTime: "22:00",
  privateCancelDaysBefore: 1, privateCancelTime: "22:00",
  groupCancelDaysBefore: 1, groupCancelTime: "22:00",
  allowSameDayBooking: true,
  sameDayChangeHours: 24, sameDayChangeMinutes: 0,
  autocancelHours: 0, autocancelMinutes: 0,
  waitlistAutoHours: 0, waitlistAutoMinutes: 0,
  waitlistWeeklyLimit: 0,
  dailyBookLimitEnabled: false, dailyBookLimit: null,
  privateOpenDaysBefore: 60, privateOpenTime: "15:00",
  groupOpenDaysBefore: 60, groupOpenTime: "15:00",
  privateSlotUnit: "30min",
  privateMaxConcurrentEnabled: false, privateMaxConcurrent: null,
  showGroupReservedCount: true, showGroupWaitlistCount: true,
  useInquiryBoard: true, showAllClasses: true, useLocker: false,
  deductOnLateCancel: false, autoUnpaidInput: false,
  useLounge: true, showPointHistory: true,
  unlimitedPassRevenueMode: "usage_split",
};

export function rowToSettings(r: any): CenterSettings {
  return {
    privateBookDaysBefore: r.private_book_days_before,
    privateBookTime: (r.private_book_time ?? "22:00").slice(0, 5),
    groupBookDaysBefore: r.group_book_days_before,
    groupBookTime: (r.group_book_time ?? "22:00").slice(0, 5),
    privateCancelDaysBefore: r.private_cancel_days_before,
    privateCancelTime: (r.private_cancel_time ?? "22:00").slice(0, 5),
    groupCancelDaysBefore: r.group_cancel_days_before,
    groupCancelTime: (r.group_cancel_time ?? "22:00").slice(0, 5),
    allowSameDayBooking: r.allow_same_day_booking ?? true,
    sameDayChangeHours: r.same_day_change_hours,
    sameDayChangeMinutes: r.same_day_change_minutes,
    autocancelHours: r.autocancel_hours,
    autocancelMinutes: r.autocancel_minutes,
    waitlistAutoHours: r.waitlist_auto_hours,
    waitlistAutoMinutes: r.waitlist_auto_minutes,
    waitlistWeeklyLimit: r.waitlist_weekly_limit,
    dailyBookLimitEnabled: r.daily_book_limit_enabled,
    dailyBookLimit: r.daily_book_limit,
    privateOpenDaysBefore: r.private_open_days_before,
    privateOpenTime: (r.private_open_time ?? "15:00").slice(0, 5),
    groupOpenDaysBefore: r.group_open_days_before,
    groupOpenTime: (r.group_open_time ?? "15:00").slice(0, 5),
    privateSlotUnit: r.private_slot_unit,
    privateMaxConcurrentEnabled: r.private_max_concurrent_enabled,
    privateMaxConcurrent: r.private_max_concurrent,
    showGroupReservedCount: r.show_group_reserved_count,
    showGroupWaitlistCount: r.show_group_waitlist_count,
    useInquiryBoard: r.use_inquiry_board,
    showAllClasses: r.show_all_classes,
    useLocker: r.use_locker,
    deductOnLateCancel: r.deduct_on_late_cancel,
    autoUnpaidInput: r.auto_unpaid_input,
    useLounge: r.use_lounge,
    showPointHistory: r.show_point_history,
    unlimitedPassRevenueMode: r.unlimited_pass_revenue_mode ?? "usage_split",
  };
}

export function settingsToRow(centerId: string, s: CenterSettings) {
  return {
    center_id: centerId,
    private_book_days_before: s.privateBookDaysBefore,
    private_book_time: s.privateBookTime,
    group_book_days_before: s.groupBookDaysBefore,
    group_book_time: s.groupBookTime,
    private_cancel_days_before: s.privateCancelDaysBefore,
    private_cancel_time: s.privateCancelTime,
    group_cancel_days_before: s.groupCancelDaysBefore,
    group_cancel_time: s.groupCancelTime,
    allow_same_day_booking: s.allowSameDayBooking,
    same_day_change_hours: s.sameDayChangeHours,
    same_day_change_minutes: s.sameDayChangeMinutes,
    autocancel_hours: s.autocancelHours,
    autocancel_minutes: s.autocancelMinutes,
    waitlist_auto_hours: s.waitlistAutoHours,
    waitlist_auto_minutes: s.waitlistAutoMinutes,
    waitlist_weekly_limit: s.waitlistWeeklyLimit,
    daily_book_limit_enabled: s.dailyBookLimitEnabled,
    daily_book_limit: s.dailyBookLimit,
    private_open_days_before: s.privateOpenDaysBefore,
    private_open_time: s.privateOpenTime,
    group_open_days_before: s.groupOpenDaysBefore,
    group_open_time: s.groupOpenTime,
    private_slot_unit: s.privateSlotUnit,
    private_max_concurrent_enabled: s.privateMaxConcurrentEnabled,
    private_max_concurrent: s.privateMaxConcurrent,
    show_group_reserved_count: s.showGroupReservedCount,
    show_group_waitlist_count: s.showGroupWaitlistCount,
    use_inquiry_board: s.useInquiryBoard,
    show_all_classes: s.showAllClasses,
    use_locker: s.useLocker,
    deduct_on_late_cancel: s.deductOnLateCancel,
    auto_unpaid_input: s.autoUnpaidInput,
    use_lounge: s.useLounge,
    show_point_history: s.showPointHistory,
    unlimited_pass_revenue_mode: s.unlimitedPassRevenueMode,
    updated_at: new Date().toISOString(),
  };
}

// 설정 불러오기 (없으면 기본값 반환)
export async function fetchSettings(centerId: string): Promise<CenterSettings> {
  const { data, error } = await supabase
    .from("center_settings")
    .select("*")
    .eq("center_id", centerId)
    .maybeSingle();
  if (error) throw new Error("설정을 불러오지 못했어요: " + error.message);
  if (!data) return { ...DEFAULT_SETTINGS };
  return rowToSettings(data);
}

// 설정 저장 (있으면 갱신, 없으면 삽입 = upsert)
export async function saveSettings(centerId: string, s: CenterSettings): Promise<void> {
  const { error } = await supabase
    .from("center_settings")
    .upsert(settingsToRow(centerId, s), { onConflict: "center_id" });
  if (error) throw new Error("설정 저장에 실패했어요: " + error.message);
}
