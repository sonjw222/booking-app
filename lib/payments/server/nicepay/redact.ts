/*
  NICEPAY 요청/응답/웹훅을 로그에 남기기 전에 개인정보·키·서명을 제거한다(허용 목록 방식: 아래 SAFE_KEYS에 있는 필드만 통과, 나머지는 버림).
  카드번호(CardNo, 마스킹이어도), 구매자 이름/이메일/전화, AuthToken, Signature/SignData, 암호화 카드 데이터, 키, BID(빌링키)는 어떤 경우에도 로그에 들어가지 않는다.
  TID/Moid는 뒤 6자리만 남긴다(maskKey와 동일 규칙).
*/
const SAFE_KEYS = new Set([
  "ResultCode", "ResultMsg", "ErrorCD", "AuthResultCode", "PayMethod", "Amt", "CancelAmt", "RemainAmt", "StateCd",
  "CardCode", "CardCl", "CardQuota", "AuthDate", "CancelDate",
]);
const MASK_KEYS = new Set(["TID", "TxTid", "Moid", "MOID", "CancelMOID"]);
export const maskId = (v: string) => (v.length > 6 ? `…${v.slice(-6)}` : "…");

export function redactNicepayForLog(raw: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    if (SAFE_KEYS.has(k)) out[k] = typeof v === "string" ? v.slice(0, 100) : v;
    else if (MASK_KEYS.has(k)) out[k] = maskId(String(v));
  }
  return out;
}
