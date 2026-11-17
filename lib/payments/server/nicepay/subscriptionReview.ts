// NICEPAY card billing 2.0.4, sections 4, 5, 11. Pure, read-only review flow.
// Deliberately no fetch, billing gateway, DB write, first-charge or cron dependency.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AUTHENTICATION_AMOUNT, REGISTRATION_MOID, SUBSCRIPTION_MONTHLY_PRICE, SUBSCRIPTION_RETURN_PATH, SUBSCRIPTION_REVIEW_CENTER } from "../../nicepaySubscriptionReviewProtocol";
import { nicepaySign } from "./signature";

export const SUBSCRIPTION_REVIEW_UID = "7ffcf57d-b6d1-4562-a260-33be15f66ee5";
export const SUBSCRIPTION_REVIEW_EMAIL = "niceqa@mwhabit.com";
// Separate server-side gate. Intentionally cannot be enabled with an environment variable.
// This phase contains NO real cardbill_regist.jsp transport, even after valid authentication.
export const NICEPAY_BID_ISSUANCE_ENABLED: boolean = false;
export const SUBSCRIPTION_REVIEW_TTL = 600;
export type ReviewSettings = { origin: string; hostedEnabled: boolean };
export type RegistrationCredentials = { readonly kind: "nicepay-subscription-registration"; mid: string; merchantKey: string; stateSecret: string };
export type SubscriptionReviewPort = {
  authenticatedUid(token: string): Promise<string | null>;
  // Must recheck pinned reviewer, active owner, internal QA center and inert subscription.
  eligibleOwner(uid: string): Promise<boolean>;
};

export function subscriptionReviewSettings(env: Record<string, string | undefined>): ReviewSettings | null {
  // Explicit OFF is required. No billing_review_override exception is used here.
  if (env.NICEPAY_SUBSCRIPTION_REVIEW_ENABLED !== "true" ||
    ["NICEPAY_CHECKOUT_ENABLED", "NEXT_PUBLIC_PG_CHECKOUT_ENABLED", "NEXT_PUBLIC_BILLING_ENABLED"].some(k => env[k] !== "false") ||
    ["NICEPAY_BID_ISSUANCE_ENABLED", "NICEPAY_BILLING_ENABLED"].some(k => env[k] === "true")) return null;
  try {
    const u = new URL(env.NICEPAY_SUBSCRIPTION_REVIEW_ORIGIN ?? "");
    if (u.href !== `${u.origin}/` || u.username || u.password ||
      (u.protocol !== "https:" && !/^http:\/\/localhost(:\d+)?$/.test(u.origin))) return null;
    return { origin: u.origin, hostedEnabled: env.NICEPAY_SUBSCRIPTION_HOSTED_REVIEW_ENABLED === "true" };
  } catch { return null; }
}
export function registrationCredentials(env: Record<string, string | undefined>): RegistrationCredentials | null {
  const mid = env.NICEPAY_SUBSCRIPTION_MID, merchantKey = env.NICEPAY_SUBSCRIPTION_MERCHANT_KEY, stateSecret = env.NICEPAY_SUBSCRIPTION_REVIEW_STATE_SECRET;
  if (!mid || !/^[a-zA-Z0-9]{10}$/.test(mid) || !merchantKey || !/^[A-Za-z0-9+/]{86}==$/.test(merchantKey) || !stateSecret || stateSecret.length < 32) return null;
  // Billing credentials must be provisioned separately; never fall back to member-payment keys.
  if (mid === env.NICEPAY_MID || merchantKey === env.NICEPAY_MERCHANT_KEY) return null;
  return { kind: "nicepay-subscription-registration", mid, merchantKey, stateSecret };
}

type Attempt = { p: "np-sub-review-v1"; u: string; c: string; m: string; i: number; e: number };
const mac = (s: string, secret: string) => createHmac("sha256", secret).update(s).digest();
export function verifyRegistrationAttempt(raw: unknown, creds: RegistrationCredentials, now: number): Attempt | null {
  if (typeof raw !== "string" || raw.length > 500 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const [body, signature] = raw.split(".");
  const expected = mac(body, creds.stateSecret), actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const a = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Attempt;
    if (a.p !== "np-sub-review-v1" || a.u !== SUBSCRIPTION_REVIEW_UID || a.c !== SUBSCRIPTION_REVIEW_CENTER || !REGISTRATION_MOID.test(a.m)) return null;
    if (!Number.isSafeInteger(a.i) || a.i > now || a.e !== a.i + SUBSCRIPTION_REVIEW_TTL || now >= a.e) return null;
    return a;
  } catch { return null; }
}
export async function authorizeSubscriptionReview(token: string | null, center: unknown, port: SubscriptionReviewPort): Promise<boolean> {
  if (!token || center !== SUBSCRIPTION_REVIEW_CENTER) return false;
  try { return await port.authenticatedUid(token) === SUBSCRIPTION_REVIEW_UID && await port.eligibleOwner(SUBSCRIPTION_REVIEW_UID); }
  catch { return false; }
}
export function prepareRegistration(settings: ReviewSettings, creds: RegistrationCredentials, now = new Date()) {
  if (!settings.hostedEnabled) return null;
  const i = Math.floor(now.getTime() / 1000);
  const a: Attempt = { p: "np-sub-review-v1", u: SUBSCRIPTION_REVIEW_UID, c: SUBSCRIPTION_REVIEW_CENTER, m: `sub-reg-${randomUUID()}`, i, e: i + SUBSCRIPTION_REVIEW_TTL };
  const body = Buffer.from(JSON.stringify(a)).toString("base64url"), rt = `${body}.${mac(body, creds.stateSecret).toString("base64url")}`;
  const ediDate = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const returnUrl = `${settings.origin}${SUBSCRIPTION_RETURN_PATH}?rt=${encodeURIComponent(rt)}`;
  if (Buffer.byteLength(returnUrl, "utf8") > 500) return null;
  return {
    MID: creds.mid, Moid: a.m, Amt: AUTHENTICATION_AMOUNT, GoodsName: "모하빗 센터 이용권", EdiDate: ediDate,
    SignData: nicepaySign.payRequest({ ediDate, mid: creds.mid, amt: AUTHENTICATION_AMOUNT }, creds.merchantKey),
    PayMethod: "CARD", BillAuthYN: "Y", CharSet: "utf-8", ReqReserved: rt,
    ReturnURL: returnUrl,
  };
}
export type RegistrationOutcome = "auth-verified-no-bid" | "authentication-failed" | "invalid";
export async function verifyRegistrationReturn(form: Record<string, string>, rt: unknown, creds: RegistrationCredentials, port: SubscriptionReviewPort, now = Math.floor(Date.now() / 1000)): Promise<RegistrationOutcome> {
  const a = verifyRegistrationAttempt(rt, creds, now);
  if (!a || form.ReqReserved !== rt || form.Moid !== a.m || form.MID !== creds.mid || form.Amt !== AUTHENTICATION_AMOUNT || form.PayMethod !== "CARD" || form.BillAuthYN !== "Y") return "invalid";
  if (!/^\d{4}$/.test(form.AuthResultCode ?? "") || !/^[A-Za-z0-9]{40}$/.test(form.AuthToken ?? "") || !/^[0-9a-f]{64}$/i.test(form.Signature ?? "")) return "invalid";
  const expected = nicepaySign.authResult({ authToken: form.AuthToken, mid: creds.mid, amt: AUTHENTICATION_AMOUNT }, creds.merchantKey);
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(form.Signature, "hex"))) return "invalid";
  // TxTid is not included in the documented Signature. Validate format/MID mapping only;
  // never treat it as proof of a BID or payment. A real issuer needs atomic attempt consumption.
  if (form.AuthResultCode === "0000" && (!/^[A-Za-z0-9]{10}\d{20}$/.test(form.TxTid ?? "") || !form.TxTid.startsWith(creds.mid))) return "invalid";
  try { if (!(await port.eligibleOwner(a.u))) return "invalid"; } catch { return "invalid"; }
  return form.AuthResultCode === "0000" ? "auth-verified-no-bid" : "authentication-failed";
}
/** Offline specification preparation only, never connected to an HTTP transport. PDF 5.3/11.3. */
export function registrationIssueSignData(txTid: string, ediDate: string, creds: RegistrationCredentials): string {
  if (!/^[A-Za-z0-9]{10}\d{20}$/.test(txTid) || !txTid.startsWith(creds.mid) || !/^\d{14}$/.test(ediDate)) throw new Error("invalid_registration_reference");
  return createHash("sha256").update(txTid + creds.mid + ediDate + creds.merchantKey, "utf8").digest("hex");
}
export function assertBidIssuanceAllowed(): never {
  // Always throw: an accidental env change cannot issue a BID. No live adapter is shipped.
  throw new Error("nicepay_bid_issuance_disabled");
}
export const REVIEW_CAPABILITIES = { provider: "nicepay", monthlyPrice: SUBSCRIPTION_MONTHLY_PRICE, bidIssuanceEnabled: NICEPAY_BID_ISSUANCE_ENABLED, chargingEnabled: false } as const;
