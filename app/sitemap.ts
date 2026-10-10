import type { MetadataRoute } from "next";
import { PUBLIC_INDEXABLE_PATHS, SITE_URL } from "../lib/siteMeta";

// sitemap.xml — 로그인 없이 공개되는 정적 페이지만(동적 센터 상세·로그인·관리자·개인 화면 제외). 존재하는 라우트만 나열한다.
export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_INDEXABLE_PATHS.map((path) => ({ url: path === "/" ? `${SITE_URL}/` : `${SITE_URL}${path}` }));
}
