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
  reservationId: string | null;
  actionType: "CREATE_ASSIGNMENT" | "CREATE_FREE" | "CANCEL_ASSIGNMENT" | "CANCEL_FREE";
  reservationType: ReservationType | null;
  reservationSource: ReservationSource | null;
  adminId: string;
  adminName: string;
  memberProfileId: string | null;
  memberName: string;
  classId: string | null;
  classTitle: string;
  classStart: string | null;
  reasonCode: AdminReasonCode | null;
  reasonDetail: string | null;
  capacityOverride: boolean;
  membershipConsumed: boolean;
  createdAt: string;
  // 목록 조회 시 함께 가져오는 "지금 시점" 예약 상태 — 스냅샷(reservationType 등)과 달리
  // 되돌리기 가능 여부 판단에 필요한 살아있는 값. 예약 관련 액션이 아니면(향후 NOTICE_* 등) null.
  currentReservationStatus: string | null;
};

// "되돌리기"(관리자 배치 취소) 버튼을 활성화해도 되는지 판단하는 순수 함수.
// - 배치(CREATE_*) 로그만 되돌릴 수 있음(취소 로그 자체는 되돌릴 대상이 없음)
// - 그 예약이 아직 취소되지 않았어야 함(중복 취소 방지 — admin_cancel_reservation도 서버에서
//   막지만, 버튼 자체를 눌러도 소용없는 상태로 미리 비활성화해 사용자에게 명확히 안내)
// - 수업이 아직 시작 전이어야 함(§9 "관리자는 수업 시작 전까지 직접배치할 수 있다"와 대칭되는 정책)
export function isRevertEligible(log: Pick<AdminActionLog, "actionType" | "reservationId" | "currentReservationStatus" | "classStart">): boolean {
  if (log.actionType !== "CREATE_ASSIGNMENT" && log.actionType !== "CREATE_FREE") return false;
  if (!log.reservationId) return false;
  if (log.currentReservationStatus === "cancelled") return false;
  if (!log.classStart) return false;
  return new Date(log.classStart).getTime() > Date.now();
}

// 활동기록 화면의 "되돌리기" 버튼이 호출하는 함수. 새 RPC가 아니라 기존
// admin_cancel_reservation(=cancelAdminReservation)을 그대로 재사용한다 — 취소 로직과
// 되돌리기 로직을 별도로 만들면 두 경로가 어긋날 위험이 있어 완전히 동일한 함수로 통일.
export async function revertAdminActionLog(log: AdminActionLog, cancelReason?: string | null): Promise<{ restored: boolean }> {
  if (!isRevertEligible(log)) {
    throw new Error("되돌릴 수 없는 기록이에요");
  }
  return cancelAdminReservation(log.reservationId as string, cancelReason);
}

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
      "id, reservation_id, action_type, reservation_type, reservation_source, admin_id, member_profile_id, class_id, reason_code, reason_detail, capacity_override, membership_consumed, member_name_snapshot, class_title_snapshot, class_start_snapshot, created_at, accounts(name), reservations(status)"
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
    currentReservationStatus: r.reservations?.status ?? null,
  }));
}
