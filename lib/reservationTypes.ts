/*
  예약 타입/출처/관리자 배치 사유 상수 — 단일 기준(single source of truth)
  - DB CHECK 제약(add_admin_assignment.sql)과 반드시 같은 값을 사용해야 함
  - 화면(관리자 UI, 회원 예약 내역, 테스트)이 모두 이 파일의 값만 참조하도록 함
*/

export const RESERVATION_TYPES = ["MEMBER", "ADMIN_ASSIGNMENT", "ADMIN_FREE"] as const;
export type ReservationType = (typeof RESERVATION_TYPES)[number];

export const RESERVATION_SOURCES = ["USER", "ADMIN", "SYSTEM"] as const;
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

export const ADMIN_REASON_CODES = [
  "MEMBER_REQUEST",
  "MAKEUP_CLASS",
  "TRIAL",
  "EVENT",
  "SERVICE_COMPENSATION",
  "CENTER_OPERATION",
  "VIP_INVITATION",
  "ERROR_CORRECTION",
  "OTHER",
] as const;
export type AdminReasonCode = (typeof ADMIN_REASON_CODES)[number];

export const ADMIN_REASON_LABELS: Record<AdminReasonCode, string> = {
  MEMBER_REQUEST: "회원 요청",
  MAKEUP_CLASS: "보강 수업",
  TRIAL: "체험 수업",
  EVENT: "이벤트",
  SERVICE_COMPENSATION: "서비스 보상",
  CENTER_OPERATION: "센터 운영",
  VIP_INVITATION: "VIP 초청",
  ERROR_CORRECTION: "예약 오류 수정",
  OTHER: "기타",
};

export const RESERVATION_TYPE_LABELS: Record<ReservationType, string> = {
  MEMBER: "회원 일반 예약",
  ADMIN_ASSIGNMENT: "관리자 직접배치",
  ADMIN_FREE: "무료 추가 배치",
};

const REASON_DETAIL_MAX_LEN = 200;

// 사유 상세: 앞뒤 공백 정리, 빈 문자열이면 null, 200자 초과 시 잘라냄 (서버 CHECK와 동일 규칙)
export function normalizeReasonDetail(detail: string | null | undefined): string | null {
  const trimmed = (detail ?? "").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > REASON_DETAIL_MAX_LEN ? trimmed.slice(0, REASON_DETAIL_MAX_LEN) : trimmed;
}

export function isReasonDetailRequired(reasonCode: AdminReasonCode | null): boolean {
  return reasonCode === "OTHER";
}

// 회원 본인 화면에 표시할 배지 — ADMIN_ASSIGNMENT/ADMIN_FREE를 구분하지 않고
// 항상 "관리자 배치 예약"으로만 노출 (무료배치 여부는 회원에게 공개하지 않음)
export function memberFacingBadge(type: ReservationType): string | null {
  return type === "ADMIN_ASSIGNMENT" || type === "ADMIN_FREE" ? "관리자 배치 예약" : null;
}

// 관리자 화면용 상세 배지 (타입 + 정원초과 + 취소 여부)
export function adminBadges(params: {
  type: ReservationType;
  isCapacityOverride: boolean;
  status: string;
}): string[] {
  const badges: string[] = [];
  if (params.type === "ADMIN_ASSIGNMENT") badges.push("관리자 배치");
  if (params.type === "ADMIN_FREE") badges.push("무료 추가 배치");
  if (params.isCapacityOverride) badges.push("정원 초과 배치");
  if (params.status === "cancelled") badges.push("취소됨");
  return badges;
}
