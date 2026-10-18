/*
  앱 안 이동 이력 추적 (뒤로가기 목적지 판단용)
  - Next.js <Link>/router 이동은 문서를 새로 만들지 않으므로 document.referrer가 "처음 문서의 유입 경로"로 고정된다
    (카카오톡 링크로 들어온 뒤 앱 안에서 이동하면 referrer가 외부라 BackButton이 항상 폴백(홈)으로 튀었다).
    그래서 NavigationPolicy가 경로가 바뀔 때마다 trackAppHistory()를 불러 "이 문서 안에서 앱 내 이동이 있었는지"를 센다.
  - popstate(브라우저/제스처 뒤로가기)가 방금 일어났는지도 기록해, 목록 화면이 "뒤로가기로 돌아온 경우에만" 스크롤을 복원할 수 있게 한다.
*/
const STORE_KEY = "mwhabit_nav_trail";   // 같은 탭(sessionStorage)에서 새로고침해도 "직전 앱 내 화면이 있었는지"를 알기 위한 기록
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
  // 새로고침으로 문서가 새로 만들어져도 같은 경로면 이전 기록(직전 화면)을 유지한다. 다른 경로로 새로 들어왔으면(주소 직접 입력/외부 링크) 기록을 새로 시작한다.
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    const stored = raw ? (JSON.parse(raw) as { prev?: string | null; current?: string }) : null;
    if (lastPath !== null && pathname !== lastPath) sessionStorage.setItem(STORE_KEY, JSON.stringify({ prev: lastPath, current: pathname }));
    else if (lastPath === null) {
      if (!(stored && stored.current === pathname && stored.prev)) sessionStorage.setItem(STORE_KEY, JSON.stringify({ prev: null, current: pathname }));
    }
  } catch { /* 사생활 모드 */ }
  lastPath = pathname;
}

/** 이 문서(페이지 로드) 안에서 앱 내부 이동이 한 번이라도 있었으면 router.back()이 앱 안의 이전 화면으로 간다. */
export function hasInAppBackTarget(): boolean {
  if (inAppNavigations > 0) return true;
  // 새로고침 직후: 같은 경로의 기록에 직전 앱 내 화면이 남아 있으면 router.back()이 그 화면으로 간다.
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    const stored = raw ? (JSON.parse(raw) as { prev?: string | null; current?: string }) : null;
    return !!stored && !!stored.prev && stored.current === window.location.pathname;
  } catch { return false; }
}

/** 직전 1.5초 안에 브라우저/제스처 뒤로가기(popstate)가 있었는지. */
export function arrivedByHistoryBack(withinMs = 1500): boolean { return Date.now() - lastPopAt < withinMs; }

/** 테스트용 초기화 */
export function __resetAppHistoryForTests(): void { lastPath = null; inAppNavigations = 0; lastPopAt = 0; try { sessionStorage.removeItem(STORE_KEY); } catch { /* 무시 */ } }
