/* NICEPAY 인증결제(결제창 → returnUrl POST → 서버 승인) 서버 측 타입. 필드명은 공식 문서 그대로. 알 수 없는 필드가 추가될 수 있어 index signature로 허용한다. */
export type NicepayAuthResult = {
  AuthResultCode?: string; AuthResultMsg?: string; AuthToken?: string; PayMethod?: string; MID?: string; Moid?: string;
  Signature?: string; Amt?: string; ReqReserved?: string; TxTid?: string; NextAppURL?: string; NetCancelURL?: string;
  [k: string]: unknown;
};
export type NicepayApproveResponse = {
  ResultCode?: string; ResultMsg?: string; Amt?: string; MID?: string; Moid?: string; Signature?: string; TID?: string;
  AuthCode?: string; AuthDate?: string; PayMethod?: string; [k: string]: unknown;
};
export type NicepayCancelResponse = {
  ResultCode?: string; ResultMsg?: string; ErrorCD?: string; CancelAmt?: string; MID?: string; Moid?: string; Signature?: string;
  TID?: string; CancelDate?: string; RemainAmt?: string; [k: string]: unknown;
};
export type NicepayResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string | null; message: string };

// 문서상 성공 코드: 카드 승인 3001 / 계좌이체 4000 / 가상계좌 발급 4100 / 휴대폰 A000. 취소 2001·2211. 망취소 2001. 이번 범위는 카드(3001)만 허용한다.
export const NICEPAY_APPROVE_OK_CARD = "3001";
export const NICEPAY_CANCEL_OK = ["2001", "2211"];
export const NICEPAY_AUTH_OK = "0000";
// NextAppURL / NetCancelURL이 가리킬 수 있는 호스트(공식 문서의 방화벽 안내 도메인). 이 밖의 URL로는 AuthToken·서명을 절대 보내지 않는다(SSRF/키 유출 방지).
export const NICEPAY_ALLOWED_API_HOSTS = ["dc1-api.nicepay.co.kr", "dc2-api.nicepay.co.kr", "pg-api.nicepay.co.kr", "webapi.nicepay.co.kr"] as const;

export function isAllowedNicepayUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && (u.port === "" || u.port === "443") && (NICEPAY_ALLOWED_API_HOSTS as readonly string[]).includes(u.hostname.toLowerCase());
  } catch { return false; }
}
