import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 결제 복귀 콜백 페이지만 Referrer를 보내지 않는다(쿼리의 복귀 토큰/결제키가 외부로 새지 않게). 앱 전체 정책은 바꾸지 않는다.
  async headers() {
    return [
      { source: "/checkout/success", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/checkout/fail", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;
