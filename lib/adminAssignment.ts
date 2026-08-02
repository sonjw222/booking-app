/*
  관리자 직접배치 / 무료 추가 배치 데이터 함수
  - add_admin_assignment.sql의 admin_assign_reservation / admin_cancel_reservation RPC를 감쌈
  - 관리자 예약 작업 로그(admin_action_logs) 조회
*/

import { supabase } from "./supabaseClient";
import type { AdminReasonCode, ReservationSource, ReservationType } from "./reservationTypes";

export type AssignmentType = Extract<ReservationType, "ADMIN_ASSIGNMENT" | "ADMIN_FREE">;

export type AssignReservationInput = {
  classId: string;
  profileId: string;
  assignmentType: AssignmentType;
  membershipId?: string | null;
  reasonCode?: AdminReasonCode | null;
  reasonDetail?: string | null;
  forceCapacity?: boolean;
};

export type AssignReservationResult =
  | { needsCapacityConfirm: true }
  | { needsCapacityConfirm: false; reservationId: string; overCapacity: boolean };

// 관리자 직접배치/무료 추가 배치 실행.
// 정원이 찬 수업이면 1차 호출에서 needsCapacityConfirm=true만 돌아오고 예약은 생성되지 않음 —
// 화면에서 "정원이 모두 찼습니다" 확인을 받은 뒤 forceCapacity:true로 다시 호출해야 함.
export async function assignReservation(input: AssignReservationInput): Promise<AssignReservationResult> {
  const { data, error } = await supabase.rpc("admin_assign_reservation", {
    p_class_id: input.classId,
    p_profile_id: input.profileId,
    p_assignment_type: input.assignmentType,
    p_membership_id: input.membershipId ?? null,
    p_reason_code: input.reasonCode ?? null,
    p_reason_detail: input.reasonDetail ?? null,
    p_force_capacity: input.forceCapacity ?? false,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  const result = data as any;
  if (result?.needs_capacity_confirm) {
    return { needsCapacityConfirm: true };
  }
  return {
    needsCapacityConfirm: false,
    reservationId: result.reservation_id,
    overCapacity: result.over_capacity ?? false,
  };
}

export async function cancelAdminReservation(reservationId: string, cancelReason?: string | null): Promise<{ restored: boolean }> {
  const { data, error } = await supabase.rpc("admin_cancel_reservation", {
    p_reservation_id: reservationId,
    p_cancel_reason: cancelReason ?? null,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return { restored: (data as any)?.restored ?? false };
}

export type AdminActionLog = {
  id: string;
  // 휴무일 강제 지정(add_holiday_safe) 등으로 원본 예약이 삭제되면 null이 될 수 있다
  // (admin_action_logs.reservation_id는 ON DELETE SET NULL — fix_holiday_membership_restore
  // 배치에서 변경, 로그 자체는 스냅샷 컬럼으로 계속 의미를 유지함).
  reservationId: string | null;
  actionType: "CREATE_ASSIGNMENT" | "CREATE_FREE" | "CANCEL_ASSIGNMENT" | "CANCEL_FREE";
  reservationType: ReservationType;
  reservationSource: ReservationSource;
  adminId: string;
  adminName: string;
  memberProfileId: string;
  memberName: string;
  // reservationId와 동일한 사유로 null 가능(fix_admin_action_logs_class_id_fk 배치에서 변경).
  classId: string | null;
  classTitle: string;
  classStart: string;
  reasonCode: AdminReasonCode | null;
  reasonDetail: string | null;
  capacityOverride: boolean;
  membershipConsumed: boolean;
  createdAt: string;
};

export type AdminActionLogFilters = {
  fromDate?: string;   // "2026-07-01"
  toDate?: string;     // "2026-07-31"
  memberProfileId?: string;
  adminId?: string;
  classId?: string;
  reservationType?: ReservationType;
  actionType?: AdminActionLog["actionType"];
  capacityOverrideOnly?: boolean;
  reasonCode?: AdminReasonCode;
};

// 관리자 배치/취소 로그 목록 (기본 조회 + 필터). 통계/엑셀은 이번 범위에 포함하지 않음.
export async function fetchAdminActionLogs(
  centerId: string,
  filters: AdminActionLogFilters = {}
): Promise<AdminActionLog[]> {
  let query = supabase
    .from("admin_action_logs")
    .select(
      "id, reservation_id, action_type, reservation_type, reservation_source, admin_id, member_profile_id, class_id, reason_code, reason_detail, capacity_override, membership_consumed, member_name_snapshot, class_title_snapshot, class_start_snapshot, created_at, accounts(name)"
    )
    .eq("center_id", centerId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (filters.fromDate) query = query.gte("created_at", `${filters.fromDate}T00:00:00+09:00`);
  if (filters.toDate) query = query.lte("created_at", `${filters.toDate}T23:59:59+09:00`);
  if (filters.memberProfileId) query = query.eq("member_profile_id", filters.memberProfileId);
  if (filters.adminId) query = query.eq("admin_id", filters.adminId);
  if (filters.classId) query = query.eq("class_id", filters.classId);
  if (filters.reservationType) query = query.eq("reservation_type", filters.reservationType);
  if (filters.actionType) query = query.eq("action_type", filters.actionType);
  if (filters.capacityOverrideOnly) query = query.eq("capacity_override", true);
  if (filters.reasonCode) query = query.eq("reason_code", filters.reasonCode);

  const { data, error } = await query;
  if (error) throw new Error("배치 로그를 불러오지 못했어요: " + error.message);

  return (data ?? []).map((r: any) => ({
    id: r.id,
    reservationId: r.reservation_id,
    actionType: r.action_type,
    reservationType: r.reservation_type,
    reservationSource: r.reservation_source,
    adminId: r.admin_id,
    adminName: r.accounts?.name ?? "(알 수 없음)",
    memberProfileId: r.member_profile_id,
    memberName: r.member_name_snapshot ?? "(이름 없음)",
    classId: r.class_id,
    classTitle: r.class_title_snapshot ?? "",
    classStart: r.class_start_snapshot,
    reasonCode: r.reason_code,
    reasonDetail: r.reason_detail,
    capacityOverride: r.capacity_override,
    membershipConsumed: r.membership_consumed,
    createdAt: r.created_at,
  }));
}
