import type { MetadataRoute } from "next";
import { PRIVATE_PATH_PREFIXES, SITE_URL } from "../lib/siteMeta";

// robots.txt — 공개 페이지는 허용, 로그인·개인·관리자·결제·API 경로는 크롤링 비허용.
// 주의: robots.txt는 접근 통제도 색인 차단도 보장하지 않는다(링크로 색인될 수 있음). 그래서 같은 경로에 X-Robots-Tag: noindex 헤더를
// next.config.ts에서 함께 보내고, 실제 접근 통제는 인증/RLS가 담당한다.
export default function robots(): MetadataRoute.Robots {
  return {
    // 경로 세그먼트 단위로만 막는다: `/reservation$`(정확히 그 경로), `/reservation/`(하위 경로), `/reservation?`(쿼리 포함).
    // 순수 접두사(`/reservation`)로 쓰면 `/reservation-guide` 같은 무관한 경로까지 막히기 때문이다(RFC 9309의 `$` 앵커 사용).
    rules: [{ userAgent: "*", allow: "/", disallow: PRIVATE_PATH_PREFIXES.flatMap((p) => [`${p}$`, `${p}/`, `${p}?`]) }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
