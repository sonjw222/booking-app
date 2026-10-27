/* 감사용 응답 요약값: 서버가 검증한 NICEPAY 응답의 핵심 필드(거래번호·주문번호·금액·MID·결과코드·일시)만 이어 붙여 sha256 hex(64자)로 만든다. 원문·개인정보·서명은 포함하지 않는다. */
import { createHash } from "node:crypto";

export function responseDigest(fields: Array<string | number | null | undefined>): string {
  return createHash("sha256").update(fields.map((f) => (f === null || f === undefined ? "" : String(f))).join("|"), "utf8").digest("hex");
}
