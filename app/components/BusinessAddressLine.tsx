"use client";

/* 홈·공개 상품 하단의 "사업장 소재지" 한 줄. 환경변수 NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER 가 정확히 "true" 일 때만 서버(/api/public/business-address)에서 값을 받아 표시한다.
   꺼진 빌드(기본, next.config.ts 가 "false" 로 인라인)에서는 요청도, 주소 문자열도 번들에 없다. 값은 lib/businessAddress.ts 단일 출처(서버 전용). */
import { useEffect, useState } from "react";

export default function BusinessAddressLine() {
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER !== "true") return;
    let alive = true;
    fetch("/api/public/business-address").then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d && typeof d.address === "string") setAddress(d.address); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (process.env.NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER !== "true" || !address) return null;
  return <div data-testid="business-address">사업장 소재지 {address}</div>;
}
