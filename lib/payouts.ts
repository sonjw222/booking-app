/*
  센터 정산계좌(Toss 지급대행) 조회 — 1단계(조회만, 등록/변경 없음)
  - DB 스키마/RLS: add_center_payout_accounts.sql 참고
  - 실제 계좌 등록(Toss 지급대행 셀러 등록 API 호출)은 NEXT_PUBLIC_PAYOUTS_ENABLED가
    정확히 "true"일 때만 동작한다. Toss 지급대행 계약이 개인사업자로 가능한지 등을
    고객센터에 문의 중이라(2026-09-02), 계약이 확정되기 전까지는 이 플래그를 켜지
    않는다. 그때까지 이 화면은 상태 조회만 제공한다(center_subscriptions의
    BILLING_ENABLED와 동일한 패턴).
*/

import { supabase } from "./supabaseClient";

export type PayoutAccountStatus =
  | "not_registered" | "approval_required" | "partially_approved"
  | "kyc_required" | "approved" | "rejected" | "suspended";

export type CenterPayoutAccount = {
  id: string;
  centerId: string;
  status: PayoutAccountStatus;
  rejectionReason: string | null;
  bankName: string | null;
  bankAccountLast4: string | null;
  accountHolderName: string | null;
  verifiedAt: string | null;
  updatedAt: string;
};

export const STATUS_LABEL: Record<PayoutAccountStatus, string> = {
  not_registered: "미등록",
  approval_required: "본인인증 대기",
  partially_approved: "본인인증 완료 (한도 있음)",
  kyc_required: "추가 서류 심사 필요",
  approved: "정산 가능",
  rejected: "반려됨",
  suspended: "일시중지",
};

// 계좌 등록·정산 자동화 기능 활성화 여부. 값이 정확히 "true"가 아니면 항상 꺼짐.
export const PAYOUTS_ENABLED = process.env.NEXT_PUBLIC_PAYOUTS_ENABLED === "true";

type CenterPayoutAccountRow = {
  id: string;
  center_id: string;
  status: PayoutAccountStatus;
  rejection_reason: string | null;
  bank_name: string | null;
  bank_account_last4: string | null;
  account_holder_name: string | null;
  verified_at: string | null;
  updated_at: string;
};

function rowToAccount(r: CenterPayoutAccountRow): CenterPayoutAccount {
  return {
    id: r.id,
    centerId: r.center_id,
    status: r.status,
    rejectionReason: r.rejection_reason,
    bankName: r.bank_name,
    bankAccountLast4: r.bank_account_last4,
    accountHolderName: r.account_holder_name,
    verifiedAt: r.verified_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLUMNS =
  "id, center_id, status, rejection_reason, bank_name, bank_account_last4, account_holder_name, verified_at, updated_at";

// 매니저 - 내 센터의 정산계좌 상태 조회.
// 신규 센터는 트리거가 행을 자동으로 만들지만, 트리거 적용 전에 만들어진 데이터 등
// 예외 상황을 방어적으로 처리하기 위해 행이 없으면 null을 반환한다.
export async function fetchCenterPayoutAccount(centerId: string): Promise<CenterPayoutAccount | null> {
  const { data, error } = await supabase
    .from("center_payout_accounts")
    .select(SELECT_COLUMNS)
    .eq("center_id", centerId)
    .maybeSingle();
  if (error) throw new Error("정산계좌 정보를 불러오지 못했어요: " + error.message);
  if (!data) return null;
  return rowToAccount(data as unknown as CenterPayoutAccountRow);
}
