/*
  결제 복귀(return) 토큰 — short-lived, order-bound signed return token (일회용 토큰이 아니다).
  외부 Safari로 열린 토스 successUrl/failUrl은 앱 WebView의 Supabase 로그인 세션을 공유하지 않으므로, 로그인 토큰을 URL에 싣는 대신
  결제 시작 시 서버가 "이 uid의 이 주문에 대한 복귀 처리" 권한만 담은 서명 토큰을 발급한다. Supabase access/refresh token이 아니다.
  형식: base64url(JSON{v,oid,uid,exp,p}) + "." + base64url(HMAC-SHA256(payload, PAYMENT_RETURN_TOKEN_SECRET)). TTL 15분.
  재사용(replay) 안전성은 DB 주문 상태 / 토스 멱등키 / confirm_real_payment 멱등성 / pending-only 취소 규칙이 맡는다.
  secret은 서버 환경변수에서만 읽고 어디에도 기록하지 않는다. 토큰 원문은 로그에 남기지 않는다.
*/
import { createHmac, timingSafeEqual } from "node:crypto";

export const RETURN_TOKEN_TTL_SEC = 15 * 60;
const PURPOSE = "payment_return";

type Payload = { v: 1; oid: string; uid: string; exp: number; p: typeof PURPOSE };
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (data: string, secret: string) => createHmac("sha256", secret).update(data).digest();

export function mintReturnToken(secret: string | undefined, input: { orderId: string; uid: string }, nowSec: number = Math.floor(Date.now() / 1000)): string {
  if (!secret) throw new Error("PAYMENT_RETURN_TOKEN_SECRET not set");
  const payload: Payload = { v: 1, oid: input.orderId, uid: input.uid, exp: nowSec + RETURN_TOKEN_TTL_SEC, p: PURPOSE };
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(sign(body, secret))}`;
}

export type VerifyResult = { ok: true; uid: string; orderId: string } | { ok: false; reason: "no_secret" | "malformed" | "bad_signature" | "expired" | "wrong_purpose" | "wrong_order" };

export function verifyReturnToken(secret: string | undefined, token: unknown, expectedOrderId: unknown, nowSec: number = Math.floor(Date.now() / 1000)): VerifyResult {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (typeof token !== "string" || typeof expectedOrderId !== "string" || !expectedOrderId) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const expected = sign(parts[0], secret);
  let given: Buffer;
  try { given = Buffer.from(parts[1], "base64url"); } catch { return { ok: false, reason: "malformed" }; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  let p: Partial<Payload>;
  try { p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
  if (p.v !== 1 || typeof p.oid !== "string" || typeof p.uid !== "string" || typeof p.exp !== "number") return { ok: false, reason: "malformed" };
  if (p.p !== PURPOSE) return { ok: false, reason: "wrong_purpose" };
  if (p.exp < nowSec) return { ok: false, reason: "expired" };
  if (p.oid !== expectedOrderId) return { ok: false, reason: "wrong_order" };
  return { ok: true, uid: p.uid, orderId: p.oid };
}
