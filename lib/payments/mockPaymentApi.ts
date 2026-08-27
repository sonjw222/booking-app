/*
  MockPaymentProvider가 쓰는 Supabase 호출 모음
  - add_payment_test_provider.sql의 confirm_test_payment / cancel_test_payment RPC를 감쌈
  - lib/orders.ts는 건드리지 않기 위해 별도 파일로 분리(주문 테이블 조회는 여기서 직접)
*/

import type { PaymentStatus } from "./types";

type ConfirmTestPaymentRpcResult = {
  already_done: boolean;
  membership_id?: string;
  amount?: number;
};

type CancelTestPaymentRpcResult = {
  cancelled: boolean;
};

// ../supabaseClient를 정적 import하면 그 모듈 최상단의 createClient() 호출이 이 파일을
// import하는 순간 바로 실행된다 — PaymentProviderFactory.test.ts처럼 "Supabase 접속이
// 필요 없는" 단위 테스트까지 supabase-js(→ realtime-js의 native WebSocket 요구)에 발이
// 묶이는 원인이었다(P2-10). 이 파일의 함수들은 실제로 호출될 때만 클라이언트가 필요하므로
// 지연 import로 바꿔 로드 시점과 사용 시점을 분리한다.
async function getSupabase() {
  const { supabase } = await import("../supabaseClient");
  return supabase;
}

export async function confirmTestPaymentRpc(
  orderId: string,
  providerRef: string
): Promise<{ membershipId: string | null; alreadyDone: boolean }> {
  const supabase = await getSupabase();
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
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc("cancel_test_payment", { p_order_id: orderId });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  const result = data as CancelTestPaymentRpcResult;
  if (!result.cancelled) throw new Error("주문을 취소하지 못했어요");
}

export async function fetchOrderPaymentStatus(orderId: string): Promise<PaymentStatus> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from("orders").select("status").eq("id", orderId).single();
  if (error) throw new Error("주문 상태를 확인하지 못했어요: " + error.message);
  const status = (data as { status: string }).status;
  if (status === "paid" || status === "cancelled") return status;
  if (status === "done") return "paid"; // Payment Layer 관점에서 done(수강권 발급 완료)도 "결제 성공"으로 취급
  return "pending";
}
