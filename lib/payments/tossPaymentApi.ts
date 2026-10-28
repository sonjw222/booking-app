/*
  [레거시 — 과거 Toss 거래 보호용] 서버 라우트(app/api/payments/*) fetch 호출 모음.
  PG는 NICEPAY로 확정(2026-10-16)되어 신규 결제는 Toss를 쓰지 않는다. 남겨 둔 것: 과거 Toss 주문의 환불(refundMembershipApi)과
  복귀 토큰(requestReturnToken — NICEPAY 복귀 처리에서도 재사용할 공통 로직 후보). 승인/취소 클라이언트 래퍼(confirmRealPaymentApi 등)는 신규 경로가 없어 제거했다.
  실제 승인/취소는 시크릿 키가 필요해 브라우저에서 직접 못 하므로, 항상 app/api/payments/* 서버 라우트를 거친다.
*/

import { supabase } from "../supabaseClient";

// 서버 라우트는 로그인 세션을 Bearer 토큰으로 검증한다(토큰만 보내고 profileId/centerId는 보내지 않는다 — 서버가 주문/수강권으로 조회).
async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// 회원 전체 환불(실 PG 주문은 서버가 토스 취소 후 DB 환불). 브라우저가 refund_membership RPC를 직접 부르지 않는다.
export async function refundMembershipApi(membershipId: string): Promise<void> {
  const res = await fetch("/api/payments/refund", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ membershipId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? "환불에 실패했어요");
}

// 결제 시작 시 복귀 토큰 발급(앱 WebView의 로그인 세션으로만 호출 가능). Supabase 토큰이 아니라 이 주문 전용 서명 토큰을 받는다.
export async function requestReturnToken(orderId: string): Promise<string> {
  const res = await fetch("/api/payments/return-token", { method: "POST", headers: await authHeaders(), body: JSON.stringify({ orderId }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data?.returnToken !== "string") throw new Error(data?.error ?? "결제를 시작하지 못했어요");
  return data.returnToken;
}
