import type { NextConfig } from "next";
import { PRIVATE_PATH_PREFIXES } from "./lib/siteMeta";

const nextConfig: NextConfig = {
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
