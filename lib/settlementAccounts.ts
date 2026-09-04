/*
  센터 정산 계좌(수동 대량이체용) — 오너 셀프서비스 CRUD + 운영자 정산 요약 조회
  - DB 스키마/RLS: add_center_settlement_accounts.sql 참고
  - Toss 지급대행(center_payout_accounts, lib/payouts.ts)과는 완전히 별개 — 이 파일은
    계좌 전체번호를 다루므로 RLS가 오너 본인/운영자로만 좁게 잠겨 있다.
*/

import { supabase } from "./supabaseClient";

export type CenterSettlementAccount = {
  centerId: string;
  bankName: string | null;
  accountNumber: string | null;
  accountHolderName: string | null;
  updatedAt: string;
};

type SettlementAccountRow = {
  center_id: string;
  bank_name: string | null;
  account_number: string | null;
  account_holder_name: string | null;
  updated_at: string;
};

function rowToAccount(r: SettlementAccountRow): CenterSettlementAccount {
  return {
    centerId: r.center_id,
    bankName: r.bank_name,
    accountNumber: r.account_number,
    accountHolderName: r.account_holder_name,
    updatedAt: r.updated_at,
  };
}

// 오너 - 내 센터의 정산 계좌 조회
export async function fetchCenterSettlementAccount(centerId: string): Promise<CenterSettlementAccount | null> {
  const { data, error } = await supabase
    .from("center_settlement_accounts")
    .select("center_id, bank_name, account_number, account_holder_name, updated_at")
    .eq("center_id", centerId)
    .maybeSingle();
  if (error) throw new Error("정산 계좌 정보를 불러오지 못했어요: " + error.message);
  if (!data) return null;
  return rowToAccount(data as SettlementAccountRow);
}

// 오너 - 내 센터의 정산 계좌 등록/수정 (RLS: _is_owner_of_center로 직접 제한, RPC 불필요)
export async function saveCenterSettlementAccount(
  centerId: string,
  input: { bankName: string; accountNumber: string; accountHolderName: string }
): Promise<void> {
  const { error } = await supabase
    .from("center_settlement_accounts")
    .update({
      bank_name: input.bankName.trim() || null,
      account_number: input.accountNumber.trim() || null,
      account_holder_name: input.accountHolderName.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("center_id", centerId);
  if (error) throw new Error("정산 계좌 저장에 실패했어요: " + error.message);
}

// 운영자 - 기간별 센터별 정산 대상 요약 (은행 대량이체 파일 만들 때 참고용)
export type AdminSettlementRow = {
  centerId: string;
  centerName: string;
  bankName: string | null;
  accountNumber: string | null;
  accountHolderName: string | null;
  totalAmount: number;
};

type AdminSettlementRpcRow = {
  center_id: string;
  center_name: string;
  bank_name: string | null;
  account_number: string | null;
  account_holder_name: string | null;
  total_amount: number;
};

// startDate/endDate: "YYYY-MM-DD"
export async function fetchAdminSettlementSummary(startDate: string, endDate: string): Promise<AdminSettlementRow[]> {
  const { data, error } = await supabase.rpc("admin_center_settlement_summary", {
    p_start: startDate, p_end: endDate,
  });
  if (error) throw new Error("정산 요약을 불러오지 못했어요: " + error.message);
  return ((data as AdminSettlementRpcRow[]) ?? []).map((r) => ({
    centerId: r.center_id,
    centerName: r.center_name,
    bankName: r.bank_name,
    accountNumber: r.account_number,
    accountHolderName: r.account_holder_name,
    totalAmount: r.total_amount,
  }));
}

// 은행 대량이체 업로드용 CSV 문자열 생성 (은행마다 정확한 컬럼 형식은 다를 수 있어 참고용
// 범용 포맷 — 은행명/계좌번호/예금주/금액 순).
export function toSettlementCsv(rows: AdminSettlementRow[]): string {
  const header = "은행명,계좌번호,예금주,금액,센터명";
  const lines = rows.map((r) =>
    [r.bankName ?? "", r.accountNumber ?? "", r.accountHolderName ?? "", r.totalAmount, r.centerName]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  // 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM을 앞에 붙인다.
  return "﻿" + [header, ...lines].join("\n");
}
