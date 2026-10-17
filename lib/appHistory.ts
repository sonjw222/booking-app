/*
  앱 안 이동 이력 추적 (뒤로가기 목적지 판단용)
  - Next.js <Link>/router 이동은 문서를 새로 만들지 않으므로 document.referrer가 "처음 문서의 유입 경로"로 고정된다
    (카카오톡 링크로 들어온 뒤 앱 안에서 이동하면 referrer가 외부라 BackButton이 항상 폴백(홈)으로 튀었다).
    그래서 NavigationPolicy가 경로가 바뀔 때마다 trackAppHistory()를 불러 "이 문서 안에서 앱 내 이동이 있었는지"를 센다.
  - popstate(브라우저/제스처 뒤로가기)가 방금 일어났는지도 기록해, 목록 화면이 "뒤로가기로 돌아온 경우에만" 스크롤을 복원할 수 있게 한다.
*/
let lastPath: string | null = null;
let inAppNavigations = 0;
let lastPopAt = 0;
let listening = false;

export function trackAppHistory(pathname: string): void {
  if (typeof window !== "undefined" && !listening) {
    listening = true;
    window.addEventListener("popstate", () => { lastPopAt = Date.now(); });
  }
  if (lastPath !== null && pathname !== lastPath) inAppNavigations++;
  lastPath = pathname;
}

/** 이 문서(페이지 로드) 안에서 앱 내부 이동이 한 번이라도 있었으면 router.back()이 앱 안의 이전 화면으로 간다. */
export function hasInAppBackTarget(): boolean { return inAppNavigations > 0; }

/** 직전 1.5초 안에 브라우저/제스처 뒤로가기(popstate)가 있었는지. */
export function arrivedByHistoryBack(withinMs = 1500): boolean { return Date.now() - lastPopAt < withinMs; }

/** 테스트용 초기화 */
export function __resetAppHistoryForTests(): void { lastPath = null; inAppNavigations = 0; lastPopAt = 0; }
