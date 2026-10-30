/*
  NICEPAY v3 결제창 GoodsName(결제상품명) 정리 — 서버 전용 순수 함수.
  공식 문서(developers.nicepay.co.kr/docs/pg/auth/payment-window, 2026-10-30 확인): GoodsName 은 **최대 40 byte, euc-kr** 이다.
  v3 결제창 form 은 accept-charset="euc-kr" 로 제출되므로 EUC-KR 에 없는 문자(이모지·일부 기호·희귀 한글)는 브라우저가 "&#NNNNN;" 로 바꿔 40 byte 를 넘기거나 깨질 수 있다.
  그래서 ① KS X 1001(EUC-KR 2바이트 영역)·ASCII 로 표현 가능한 문자만 남기고 ② 폼/마크업을 깨는 문자(<>"'&\)는 공백으로 바꾸고 ③ EUC-KR 바이트 길이 40 이하로 문자 단위로 자른다(문자를 반으로 쪼개지 않는다).
  표시용 값일 뿐이다 — 서명·금액·주문 결정에는 쓰이지 않는다(금액·상품은 항상 서버가 DB 주문에서 읽는다).
*/
export const NICEPAY_GOODS_NAME_MAX_BYTES = 40;

let ksSet: Set<string> | null = null;
function ksx1001Chars(): Set<string> {
  if (ksSet) return ksSet;
  const dec = new TextDecoder("euc-kr"), set = new Set<string>();
  for (let lead = 0xa1; lead <= 0xfe; lead++) for (let trail = 0xa1; trail <= 0xfe; trail++) {
    const ch = dec.decode(Uint8Array.of(lead, trail));
    if (ch.length >= 1 && !ch.includes("�") && Array.from(ch).length === 1) set.add(ch);
  }
  return (ksSet = set);
}

const isAscii = (ch: string) => ch >= " " && ch <= "~";
/** EUC-KR 바이트 길이(ASCII=1, KS X 1001 문자=2). 표현할 수 없는 문자는 Infinity. */
export function eucKrByteLength(s: string): number {
  let n = 0; const ks = ksx1001Chars();
  for (const ch of s) { if (isAscii(ch)) n += 1; else if (ks.has(ch)) n += 2; else return Infinity; }
  return n;
}

export function toNicepayGoodsName(raw: unknown, fallback = "모하빗 수강권", maxBytes = NICEPAY_GOODS_NAME_MAX_BYTES): string {
  const ks = ksx1001Chars();
  const clean = (typeof raw === "string" ? raw : "").normalize("NFC")
    .replace(/[<>"'&\\]/g, " ")
    .replace(/[\[\]]/g, " ")  // NICEPAY: 대괄호는 별도 문의 대상이므로 사용하지 않음
    .replace(/\s+/g, " ").trim();
  let out = "", bytes = 0;
  for (const ch0 of clean) {
    const ch = isAscii(ch0) || ks.has(ch0) ? ch0 : " ";   // EUC-KR 로 표현할 수 없는 문자는 공백
    const w = isAscii(ch) ? 1 : 2;
    if (bytes + w > maxBytes) break;
    if (ch === " " && (out === "" || out.endsWith(" "))) continue;   // 앞·연속 공백 제거
    out += ch; bytes += w;
  }
  out = out.trimEnd();
  return out || fallback;
}
