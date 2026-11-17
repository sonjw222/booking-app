// Existing-app review window only. No order writes, approval ports, or PG fetch dependency.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { nicepaySign, signatureMatches } from "./signature";

export const REVIEW_UID = "7ffcf57d-b6d1-4562-a260-33be15f66ee5";
export const REVIEW_CENTER = "1c02c063-8da4-43b5-b88a-514434371c46";
export const REVIEW_EMAIL = "niceqa@mwhabit.com";
export const REVIEW_ORIGIN = "https://mwhabit.com";
export const REVIEW_MID = "nicepay00m";
export const REVIEW_RETURN_PATH = "/api/payments/nicepay/review-window/return";
const TTL = 600;
const ediDateOf = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 19).replace(/[-:T]/g, "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ReviewConfig = { merchantKey: string; secret: string };
export function reviewWindowConfig(env: Record<string, string | undefined>): ReviewConfig | null {
  if (env.NICEPAY_REVIEW_WINDOW_ENABLED !== "true" || env.NICEPAY_CHECKOUT_ENABLED !== "false" || env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED !== "false") return null;
  const merchantKey = env.NICEPAY_REVIEW_TEST_MERCHANT_KEY?.trim();
  const secret = env.NICEPAY_REVIEW_WINDOW_SECRET;
  if (!merchantKey || !/^[A-Za-z0-9+/]{86}==$/.test(merchantKey) || !secret || secret.length < 32) return null;
  return { merchantKey, secret };
}
/* centerId: 이 상품이 속한 센터. 생략하면 심사 센터(REVIEW_CENTER). 심사관에게 허용된 실제 센터 상품(nicepay_review_center_grants)도 인증창 확인 대상이 될 수 있다 — 승인·주문·이용권 발급은 어느 경우에도 없다. */
export type Target = { productId: string; name: string; amount: number; centerId?: string };
export type ReviewReadPort = {
  authenticatedUid(token: string): Promise<string | null>;
  // Must recheck the pinned auth UID/email, account flag, center and live product on each request.
  target(uid: string, productId: string): Promise<Target | null>;
};
type Attempt = { purpose: "nicepay-review-window-v1"; uid: string; center: string; product: string; moid: string; amount: number; iat: number; exp: number; outcome?: Outcome };
export type Outcome = "closed" | "verified-not-approved" | "invalid";
const mac = (s: string, key: string) => createHmac("sha256", key).update(s).digest();
function signAttempt(a: Attempt, c: ReviewConfig): string {
  const body = Buffer.from(JSON.stringify(a)).toString("base64url");
  return `${body}.${mac(body, c.secret).toString("base64url")}`;
}
export function verifyReviewAttempt(raw: unknown, c: ReviewConfig, now: number): Attempt | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const expected = mac(parts[0], c.secret), given = Buffer.from(parts[1], "base64url");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const a = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as Attempt;
    if (a.purpose !== "nicepay-review-window-v1" || a.uid !== REVIEW_UID || typeof a.center !== "string" || !UUID.test(a.center) || !UUID.test(a.product) || !UUID.test(a.moid)) return null;
    if (!Number.isSafeInteger(a.amount) || a.amount <= 0 || !Number.isSafeInteger(a.iat) || a.iat > now || a.exp !== a.iat + TTL || now >= a.exp) return null;
    if (a.outcome !== undefined && !["closed", "verified-not-approved", "invalid"].includes(a.outcome)) return null;
    return a;
  } catch { return null; }
}
export async function prepareReviewWindow(input: { token: string | null; productId: unknown; open: boolean }, c: ReviewConfig, port: ReviewReadPort, now = new Date()) {
  if (!input.token) return null;
  const uid = await port.authenticatedUid(input.token);
  if (uid !== REVIEW_UID || typeof input.productId !== "string" || !UUID.test(input.productId)) return null;
  const t = await port.target(uid, input.productId);
  if (!t || t.productId !== input.productId || !Number.isSafeInteger(t.amount) || t.amount <= 0 || !t.name.trim()) return null;
  if (!input.open) return { allowed: true as const };
  const iat = Math.floor(now.getTime() / 1000);
  const a: Attempt = { purpose: "nicepay-review-window-v1", uid, center: t.centerId ?? REVIEW_CENTER, product: t.productId, moid: randomUUID(), amount: t.amount, iat, exp: iat + TTL };
  const rt = signAttempt(a, c), ediDate = ediDateOf(now), amt = String(t.amount);
  return { allowed: true as const, params: {
    MID: REVIEW_MID, Moid: a.moid, Amt: amt, GoodsName: Array.from(t.name.trim()).slice(0, 20).join(""), EdiDate: ediDate,
    SignData: nicepaySign.payRequest({ ediDate, mid: REVIEW_MID, amt }, c.merchantKey),
    ReturnURL: `${REVIEW_ORIGIN}${REVIEW_RETURN_PATH}?rt=${encodeURIComponent(rt)}`, PayMethod: "CARD" as const, CharSet: "utf-8",
  } };
}
export async function finishReviewWindow(form: Record<string, unknown>, rt: unknown, c: ReviewConfig, port: ReviewReadPort, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const invalid = `${REVIEW_ORIGIN}/api/payments/nicepay/review-window/result`;
  const a = verifyReviewAttempt(rt, c, now);
  if (!a || a.outcome !== undefined || form.Moid !== a.moid) return invalid;
  const target = await port.target(a.uid, a.product);
  if (!target || target.productId !== a.product || target.amount !== a.amount || (target.centerId ?? REVIEW_CENTER) !== a.center) return invalid;
  let outcome: Outcome = "closed";
  if (form.AuthResultCode === "0000") {
    if (form.MID !== REVIEW_MID || form.Amt !== String(a.amount) || typeof form.AuthToken !== "string" || !form.AuthToken || typeof form.TxTid !== "string" || !form.TxTid) return invalid;
    const expected = nicepaySign.authResult({ authToken: form.AuthToken, mid: REVIEW_MID, amt: String(a.amount) }, c.merchantKey);
    if (!signatureMatches(expected, form.Signature)) return invalid;
    outcome = "verified-not-approved";
  }
  // Signed result is informational only. Replays perform reads again and can never approve or issue a pass.
  return `${REVIEW_ORIGIN}/api/payments/nicepay/review-window/result?rt=${encodeURIComponent(signAttempt({ ...a, outcome }, c))}`;
}
