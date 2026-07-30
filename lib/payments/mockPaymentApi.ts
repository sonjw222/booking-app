/*
  MockPaymentProvider가 쓰는 Supabase 호출 모음
  - add_payment_test_provider.sql의 confirm_test_payment / cancel_test_payment RPC를 감쌈
  - lib/orders.ts는 건드리지 않기 위해 별도 파일로 분리(주문 테이블 조회는 여기서 직접)
*/

import { supabase } from "../supabaseClient";
import type { PaymentStatus } from "./types";

type ConfirmTestPaymentRpcResult = {
  already_done: boolean;
  membership_id?: string;
  amount?: number;
};

type CancelTestPaymentRpcResult = {
  cancelled: boolean;
};

export async function confirmTestPaymentRpc(
  orderId: string,
  providerRef: string
): Promise<{ membershipId: string | null; alreadyDone: boolean }> {
  const { data, error } = await supabase.rpc("confirm_test_payment", {
    p_order_id: orderId,
    p_provider_ref: providerRef,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  const result = data as ConfirmTestPaymentRpcResult;
  return {
    membershipId: result.membership_id ?? null,
    alreadyDone: result.already_done,
  };
}

export async function cancelTestPaymentRpc(orderId: string): Promise<void> {
  const { data, error } = await supabase.rpc("cancel_test_payment", { p_order_id: orderId });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  const result = data as CancelTestPaymentRpcResult;
  if (!result.cancelled) throw new Error("주문을 취소하지 못했어요");
}

export async function fetchOrderPaymentStatus(orderId: string): Promise<PaymentStatus> {
  const { data, error } = await supabase.from("orders").select("status").eq("id", orderId).single();
  if (error) throw new Error("주문 상태를 확인하지 못했어요: " + error.message);
  const status = (data as { status: string }).status;
  if (status === "paid" || status === "cancelled") return status;
  if (status === "done") return "paid"; // Payment Layer 관점에서 done(수강권 발급 완료)도 "결제 성공"으로 취급
  return "pending";
}
