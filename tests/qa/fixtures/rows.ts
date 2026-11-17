/*
  QA 시나리오가 admin 클라이언트(스키마 타입 없는 supabase-js)로 읽는 행의 좁은 타입.
  select("*")로 읽는 테이블은 실제로 검증에 쓰는 컬럼만 명시하고, 나머지 컬럼은 index signature(unknown)로 둔다.
*/

export interface OrderRow {
  id: string;
  status: string;
  amount: number;
  paid_at: string | null;
  selected_count: number | null;
  product_amount_snapshot: number | null;
  [column: string]: unknown;
}

export interface PaymentRow {
  id: string;
  total_amount: number;
  [column: string]: unknown;
}

export interface MembershipRow {
  id: string;
  status: string;
  total_count: number | null;
  remaining_count: number | null;
  product_id: string | null;
  profile_id: string;
  center_id: string;
}

/** 만료일 연장 QA가 읽는 수강권 행(expires_at 포함). */
export interface MembershipExpiryRow extends MembershipRow {
  expires_at: string | null;
  starts_at: string | null;
}

export interface MemberCouponRow {
  id: string;
  status: string;
  used_at: string | null;
  order_id: string | null;
  coupon_id: string;
}

export interface PointTxRow {
  id: string;
  amount: number;
  reason: string;
  order_id: string | null;
  reverses_id: string | null;
}
