/* 수강권이 어떻게 생겼는지(무료 지급 / 유료 구매 / 알 수 없음) — 결제 기록(payments)에서만 판정한다(UX-16).
   - 관리자가 "서비스(무상 지급)"로 지급하면 payments에 sale_type='service', 금액 0으로 남는다(lib/sales.ts issueMembership).
   - 구매 내역 화면이 예전에는 "같은 센터·같은 상품명의 완료 주문"을 못 찾으면 금액을 0으로 두고 "무료"라고 표시했다. 주문을 못 찾은 것과 무료는 다르다.
   - 결제 기록이 없으면 unknown — 무료라고 추정하지 않는다.
   회원 본인은 자기 결제 행을 읽을 수 있다(payments RLS: profile_id in my_profile_ids()). 이 모듈은 읽기 전용이고 환불·회수 권한을 만들지 않는다. */
import { supabase } from "./supabaseClient";

export type MembershipOrigin = "free_grant" | "paid" | "unknown";
export type PaymentFact = { membership_id: string; sale_type: string | null; total_amount: number | null };

export function classifyOrigin(rows: Pick<PaymentFact, "sale_type" | "total_amount">[]): MembershipOrigin {
  const grants = rows.filter((r) => r.sale_type !== "refund");
  if (grants.length === 0) return "unknown";
  if (grants.some((r) => (r.total_amount ?? 0) > 0)) return "paid";
  return grants.some((r) => r.sale_type === "service") ? "free_grant" : "unknown";
}

export function originsFromPayments(ids: string[], rows: PaymentFact[]): Record<string, MembershipOrigin> {
  const by: Record<string, PaymentFact[]> = {};
  for (const r of rows) (by[r.membership_id] ??= []).push(r);
  const out: Record<string, MembershipOrigin> = {};
  for (const id of ids) out[id] = classifyOrigin(by[id] ?? []);
  return out;
}

/** 조회에 실패하면 전부 unknown — 환불 버튼을 숨기지도, 무료라고 단정하지도 않는다(기존 동작 유지). */
export async function fetchMembershipOrigins(ids: string[]): Promise<Record<string, MembershipOrigin>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return {};
  const rows: PaymentFact[] = [];
  try {
    for (let i = 0; i < unique.length; i += 150) {
      const { data, error } = await supabase.from("payments").select("membership_id, sale_type, total_amount").in("membership_id", unique.slice(i, i + 150));
      if (error) throw error;
      rows.push(...((data ?? []) as PaymentFact[]));
    }
  } catch { return originsFromPayments(unique, []); }
  return originsFromPayments(unique, rows);
}

export const FREE_GRANT_LABEL = "무료 지급";
export const FREE_GRANT_REFUND_NOTE = "무료로 지급된 수강권은 환불 대상이 아니에요. 문의는 센터로 해주세요.";
