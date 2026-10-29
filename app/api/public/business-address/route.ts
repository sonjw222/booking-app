/* 사업장 소재지 공개 조회 — 홈·공개 상품 하단 표시용. 환경변수 NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER === "true" 일 때만 값을 돌려주고, 아니면 404(값 없음).
   주소를 클라이언트 번들에 싣지 않으려고 서버에서만 읽는다(lib/businessAddress.ts 는 이 라우트와 /legal/business·관리자 구독 화면(서버/기존 범위)만 import). */
import { BUSINESS_ADDRESS } from "../../../../lib/businessAddress";

export const dynamic = "force-dynamic";
export async function GET() {
  if (process.env.NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER !== "true") return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  return Response.json({ address: BUSINESS_ADDRESS }, { headers: { "Cache-Control": "public, max-age=300" } });
}
