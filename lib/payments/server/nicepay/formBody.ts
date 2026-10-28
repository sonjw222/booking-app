/*
  NICEPAY returnUrl POST 본문 파서 — EUC-KR 호환.
  v3 결제창은 form 을 accept-charset="euc-kr" 로 제출하고(문서 기본 CharSet=EUC-KR), 모바일 결제창의 인증 응답도 EUC-KR 로 올 수 있다.
  request.formData() 는 본문을 UTF-8 로만 해석해 한글 필드(GoodsName/BuyerName/AuthResultMsg 등)가 깨진다 — 서명·금액 검증에 쓰는 필드는 ASCII 라 안전하지만,
  로그·진단과 향후 필드 사용을 위해 charset 을 존중해 해석한다. 우선순위: Content-Type 의 charset → (모두 ASCII 면 UTF-8) → 엄격한 UTF-8 이 성공하면 UTF-8 → 아니면 EUC-KR.
  application/x-www-form-urlencoded 만 직접 파싱한다. 그 밖(multipart 등)은 호출자가 formData() 로 처리한다.
*/
const MAX_BODY = 64 * 1024;

function percentDecodeToBytes(s: string): Uint8Array {
  const out: number[] = []; const t = s.replace(/\+/g, " ");
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 0x25 && i + 2 < t.length + 0 && /^[0-9a-fA-F]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else if (c < 0x80) out.push(c);
    else for (const b of new TextEncoder().encode(t[i])) out.push(b);   // 이미 디코드된 비ASCII 문자(비정상 입력) — UTF-8 바이트로
  }
  return Uint8Array.from(out);
}
function decodeBytes(bytes: Uint8Array, charset: string | null): string {
  const cs = (charset ?? "").toLowerCase();
  if (cs === "euc-kr" || cs === "euckr" || cs === "ks_c_5601-1987" || cs === "cp949") return new TextDecoder("euc-kr").decode(bytes);
  if (cs === "utf-8" || cs === "utf8") return new TextDecoder("utf-8").decode(bytes);
  if (bytes.every((b) => b < 0x80)) return new TextDecoder("utf-8").decode(bytes);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return new TextDecoder("euc-kr").decode(bytes); }
}

export function parseUrlencodedBody(raw: Uint8Array, charset: string | null): Record<string, string> {
  const text = new TextDecoder("latin1").decode(raw);   // 바이트를 그대로 보존(퍼센트 인코딩 외에는 ASCII)
  const out: Record<string, string> = {};
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    const k = decodeBytes(percentDecodeToBytes(i < 0 ? pair : pair.slice(0, i)), charset);
    const v = i < 0 ? "" : decodeBytes(percentDecodeToBytes(pair.slice(i + 1)), charset);
    if (k && !(k in out) && !["__proto__", "constructor", "prototype"].includes(k)) out[k] = v;   // 첫 값만(중복 필드로 서명 필드를 덮어쓰지 못하게)
  }
  return out;
}

export async function readNicepayForm(request: Request): Promise<Record<string, string>> {
  const ct = request.headers.get("content-type") ?? "";
  if (/application\/x-www-form-urlencoded/i.test(ct)) {
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.byteLength > MAX_BODY) return {};
    const m = /charset\s*=\s*"?([^";\s]+)/i.exec(ct);
    return parseUrlencodedBody(buf, m ? m[1] : null);
  }
  const out: Record<string, string> = {};
  try { (await request.formData()).forEach((v, k) => { if (typeof v === "string" && !(k in out)) out[k] = v; }); } catch { /* 빈 폼 */ }
  return out;
}
