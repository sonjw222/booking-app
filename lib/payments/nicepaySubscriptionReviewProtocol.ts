// Browser-safe protocol. No credentials, billing keys or billing approval path.
export const SUBSCRIPTION_REVIEW_CENTER = "3868ee7b-552a-43bf-90e5-0b697ec88aea";
export const SUBSCRIPTION_REVIEW_PATH = "/api/billing/nicepay/registration-review";
export const SUBSCRIPTION_RETURN_PATH = `${SUBSCRIPTION_REVIEW_PATH}/return`;
export const SUBSCRIPTION_RESULT_PATH = `${SUBSCRIPTION_REVIEW_PATH}/result`;
export const SUBSCRIPTION_REVIEW_PAGE = "/manager/subscription/nicepay-review";
export const AUTHENTICATION_AMOUNT = "1000";
export const SUBSCRIPTION_MONTHLY_PRICE = 39000;
export const REGISTRATION_MOID = /^sub-reg-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const REGISTRATION_FIELDS = ["MID", "Moid", "Amt", "GoodsName", "EdiDate", "SignData", "PayMethod", "BillAuthYN", "CharSet", "ReturnURL", "ReqReserved"] as const;
export type RegistrationParams = Record<typeof REGISTRATION_FIELDS[number], string>;
export const AUTH_RESPONSE_FIELDS = ["MID", "Moid", "Amt", "PayMethod", "BillAuthYN", "AuthResultCode", "AuthToken", "TxTid", "Signature", "ReqReserved"] as const;

export function validateRegistrationParams(raw: unknown, origin: string): RegistrationParams | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (Object.keys(p).length !== REGISTRATION_FIELDS.length || REGISTRATION_FIELDS.some(k => typeof p[k] !== "string")) return null;
  if (!/^[a-zA-Z0-9]{10}$/.test(String(p.MID)) || !REGISTRATION_MOID.test(String(p.Moid))) return null;
  if (p.Amt !== AUTHENTICATION_AMOUNT || p.PayMethod !== "CARD" || p.BillAuthYN !== "Y" || p.CharSet !== "utf-8") return null;
  if (!/^\d{14}$/.test(String(p.EdiDate)) || !/^[0-9a-f]{64}$/.test(String(p.SignData))) return null;
  if (p.GoodsName !== "모하빗 센터 이용권" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(String(p.ReqReserved)) || String(p.ReqReserved).length > 500) return null;
  try {
    const u = new URL(String(p.ReturnURL));
    if (String(p.ReturnURL).length > 500) return null;
    if (u.origin !== origin || u.pathname !== SUBSCRIPTION_RETURN_PATH || u.hash || u.username || u.password) return null;
    if (u.protocol !== "https:" && !/^http:\/\/localhost(:\d+)?$/.test(origin)) return null;
    if ([...u.searchParams.keys()].join() !== "rt" || u.searchParams.get("rt") !== p.ReqReserved) return null;
  } catch { return null; }
  return p as RegistrationParams;
}
