/*
  NICEPAY(나이스페이먼츠) 인증결제 서명(SignData/Signature) 계산 — 서버 전용 순수 함수. 네트워크·환경변수·DB 접근 없음.
  공식 문서(developers.nicepay.co.kr/docs/pg/auth/*, 2026-10-16 확인) 공식:
    결제창 요청 SignData      = hex(sha256(EdiDate + MID + Amt + MerchantKey))
    인증결과 Signature        = hex(sha256(AuthToken + MID + Amt + MerchantKey))
    승인 요청 SignData        = hex(sha256(AuthToken + MID + Amt + EdiDate + MerchantKey))
    승인 응답 Signature       = hex(sha256(TID + MID + Amt + MerchantKey))
    망취소 요청 SignData      = hex(sha256(AuthToken + MID + Amt + EdiDate + MerchantKey))
    취소 요청 SignData        = hex(sha256(MID + CancelAmt + EdiDate + MerchantKey))
    취소 응답 Signature       = hex(sha256(TID + MID + CancelAmt + MerchantKey))
  MerchantKey는 호출자가 서버 환경변수에서 읽어 인자로 넘긴다(이 파일은 저장·로그하지 않는다). Amt는 문서의 문자열 그대로(숫자만) 이어 붙인다.
  ⚠ 계약 후 기술지원 확인 필요: 12자리 0 패딩(000000001000) 여부 — 여기서는 호출자가 넘긴 문자열을 그대로 쓴다.
*/
import { createHash, timingSafeEqual } from "node:crypto";

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export const nicepaySign = {
  payRequest: (p: { ediDate: string; mid: string; amt: string }, key: string) => sha256Hex(p.ediDate + p.mid + p.amt + key),
  authResult: (p: { authToken: string; mid: string; amt: string }, key: string) => sha256Hex(p.authToken + p.mid + p.amt + key),
  approveRequest: (p: { authToken: string; mid: string; amt: string; ediDate: string }, key: string) => sha256Hex(p.authToken + p.mid + p.amt + p.ediDate + key),
  approveResponse: (p: { tid: string; mid: string; amt: string }, key: string) => sha256Hex(p.tid + p.mid + p.amt + key),
  netCancelRequest: (p: { authToken: string; mid: string; amt: string; ediDate: string }, key: string) => sha256Hex(p.authToken + p.mid + p.amt + p.ediDate + key),
  cancelRequest: (p: { mid: string; cancelAmt: string; ediDate: string }, key: string) => sha256Hex(p.mid + p.cancelAmt + p.ediDate + key),
  cancelResponse: (p: { tid: string; mid: string; cancelAmt: string }, key: string) => sha256Hex(p.tid + p.mid + p.cancelAmt + key),
};

/** 서명 비교(상수 시간). 길이가 다르거나 비어 있으면 false. */
export function signatureMatches(expectedHex: string, actual: unknown): boolean {
  if (typeof actual !== "string" || !actual || actual.length !== expectedHex.length) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "utf8"), Buffer.from(actual.toLowerCase(), "utf8"));
}

/** 숫자 금액 → 서명/요청에 쓰는 문자열(정수 원 단위, 숫자만). 정수가 아니거나 0 이하면 throw. */
export function amtString(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("결제 금액이 올바르지 않아요");
  return String(amount);
}

/** 응답의 Amt 문자열 → 숫자. 숫자 외 문자가 있거나 비정수면 null(앞의 0 패딩은 허용). */
export function parseAmt(raw: unknown): number | null {
  const s = typeof raw === "number" ? String(raw) : raw;
  if (typeof s !== "string" || !/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
