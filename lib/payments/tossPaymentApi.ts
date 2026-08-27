/*
  TossPaymentProvider가 쓰는 fetch 호출 모음
  - 실제 승인/취소는 시크릿 키가 필요해 브라우저에서 직접 못 하므로, 항상
    app/api/payments/* 서버 라우트를 거친다(mockPaymentApi.ts의 RPC 직접 호출과 대비됨).
*/

export type ConfirmRealPaymentResult = {
  already_done: boolean;
  membership_id?: string;
  amount?: number;
};

export async function confirmRealPaymentApi(
  paymentKey: string,
  orderId: string,
  amount: number
): Promise<{ membershipId: string | null; alreadyDone: boolean }> {
  const res = await fetch("/api/payments/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentKey, orderId, amount }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? "결제 승인에 실패했어요");
  return {
    membershipId: data.membership_id ?? null,
    alreadyDone: !!data.already_done,
  };
}

export async function cancelRealPaymentApi(orderId: string): Promise<void> {
  const res = await fetch("/api/payments/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? "결제를 취소하지 못했어요");
}
