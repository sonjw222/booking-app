/*
  공개 사이트 메타데이터 상수 — metadataBase / robots / sitemap / 소개 페이지가 같은 값을 쓴다.
  확인된 사실만 둔다(추측 URL 금지). App Store URL은 Apple 공개 조회(iTunes Lookup, bundleId=com.mwhabit.app,
  2026-10-10 확인)에 나온 등록 URL이며, 판매자 표기는 코드로 바꿀 수 없다. Google Play는 공개 상태가 확인되면 추가한다.
*/

export const SITE_URL = "https://mwhabit.com";

export const SITE_DESCRIPTION =
  "모하빗(MWHABIT)은 스포츠·취미 클래스 탐색과 예약, 센터 운영(수업·회원·예약 관리)을 돕는 서비스입니다.";

// 확인된 공식 스토어 링크. 확인되지 않은 스토어는 null로 두고 화면에 표시하지 않는다.
export const STORE_LINKS = {
  appStore: "https://apps.apple.com/kr/app/%EB%AA%A8%ED%95%98%EB%B9%97/id6811008551",
  googlePlay: null as string | null,
} as const;

// 검색 색인 대상(로그인 없이 공개되는 정적 페이지만). 동적 센터 상세·로그인·관리자·개인 화면은 넣지 않는다.
export const PUBLIC_INDEXABLE_PATHS = [
  "/",
  "/about",
  "/legal",
  "/legal/terms",
  "/legal/privacy",
  "/legal/refund",
  "/legal/business",
  "/account-deletion",
] as const;

// 색인되면 안 되는 경로(로그인·개인·관리자·결제·API). robots.txt와 X-Robots-Tag 헤더(next.config.ts)에 같은 목록을 쓴다.
// robots.txt만으로는 색인이 막히지 않으므로(링크로 색인될 수 있음) 헤더로 noindex를 함께 보낸다.
export const PRIVATE_PATH_PREFIXES = [
  "/manager",
  "/admin",
  "/mypage",
  "/my-reservations",
  "/purchases",
  "/checkout",
  "/cart",
  "/login",
  "/reset-password",
  "/profiles",
  "/notifications",
  "/settings",
  "/inquiries",
  "/api",
] as const;
