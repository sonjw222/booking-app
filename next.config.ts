import type { NextConfig } from "next";
import { PRIVATE_PATH_PREFIXES } from "./lib/siteMeta";

const nextConfig: NextConfig = {
  // 홈·공개 상품 하단 사업장 소재지 표시 플래그의 기본값을 빌드 시점에 항상 인라인한다(값이 없으면 "false"). 인라인돼야 꺼진 빌드에서 해당 분기가 제거되어 번들에 주소 문자열이 실리지 않는다.
  // 켜는 방법: Vercel 환경변수 NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER=true(사용자 승인 후). 값이 정확히 "true" 가 아니면 꺼짐.
  env: { NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER: process.env.NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER === "true" ? "true" : "false" },
  // 결제 복귀 콜백 페이지만 Referrer를 보내지 않는다(쿼리의 복귀 토큰/결제키가 외부로 새지 않게). 앱 전체 정책은 바꾸지 않는다.
  async headers() {
    return [
      // 로그인·개인·관리자·결제·API 경로는 색인하지 않는다(robots.txt만으로는 색인 차단이 보장되지 않아 헤더로 함께 보낸다 — 접근 통제는 인증/RLS가 담당).
      ...PRIVATE_PATH_PREFIXES.flatMap((p) => [
        { source: p, headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
        { source: `${p}/:path*`, headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      ]),
      { source: "/checkout/success", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/checkout/fail", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;
