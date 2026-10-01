/*
  결제수단 노출 정책(체크아웃/장바구니 공용, 2026-10-01 토스 전자결제 심사 대응)
  - 온라인 PG 수단(카드/카카오페이/토스페이/계좌이체)은 NEXT_PUBLIC_PG_CHECKOUT_ENABLED === "true"일 때만
    일반 회원에게 보인다(심사관 계정의 accounts.pg_checkout_override는 호출부가 pgEnabled에 반영).
  - PG가 꺼져 있으면 센터의 pay_methods 설정과 무관하게 항상 직접결제("direct")만 보인다 —
    센터 설정 때문에 선택지가 0개가 되거나 숨겨진 PG 수단이 기본 선택되는 일이 없게 한다.
  - PG가 켜져 있어도 센터 설정으로 걸러서 비면 직접결제로 안전하게 대체한다.
*/
export const PG_PAY_METHOD_IDS = ["card", "kakao", "toss", "transfer"] as const;
export const DIRECT_PAY_METHOD_ID = "direct";

export function visiblePayMethodIds(opts: { pgEnabled: boolean; allowed: string[] | null; all: string[] }): string[] {
  if (!opts.pgEnabled) return [DIRECT_PAY_METHOD_ID];
  const byCenter = !opts.allowed || opts.allowed.length === 0
    ? opts.all
    : opts.all.filter((id) => opts.allowed!.includes(id));
  return byCenter.length > 0 ? byCenter : [DIRECT_PAY_METHOD_ID];
}

// 현재 선택값이 보이는 목록 안에 없으면 첫 번째 보이는 수단으로 되돌린다(숨겨진 PG 수단이 선택된 채 결제되는 것 방지).
export function resolveSelectedPayMethod(selected: string, visible: string[]): string {
  return visible.includes(selected) ? selected : (visible[0] ?? DIRECT_PAY_METHOD_ID);
}
