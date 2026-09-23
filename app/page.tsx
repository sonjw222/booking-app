"use client";

/*
  홈 화면
  - 디자인은 유지하되, 제휴 센터/예약 가능한 클래스는 실제 DB 데이터로
  - 카테고리·클래스·센터·하단 네비를 실제 라우트로 연결
*/

import { useEffect, useLayoutEffect, useMemo, useState, useRef } from "react";
import { fetchHomeCenters, fetchHomeClasses, fetchMyUpcomingClasses, type HomeCenter, type HomeClass } from "../lib/home";
import { fetchBanners, fetchCategories, type HomeBanner, type ServiceCategory } from "../lib/operator";
import { fetchMyCenters } from "../lib/manager";
import { supabase } from "../lib/supabaseClient";
import { consumePostLoginNext } from "../lib/postLoginReturn";
import { replaceTabNavigation } from "../lib/navState";
import UiIcon, { type IconName } from "./components/UiIcon";
// 릴리스 폴리시 배치 8차(2026-09-18), 5번 — 운영자 모드 "종목 관리"가 이 홈 화면과
// 똑같은 아이콘을 재사용해야 해서(이모지 제거) CATEGORY_ICONS/CATEGORY_IMAGES를
// app/components/categoryIcons.ts로 옮겼다(단일 출처, 새 asset 없음). 이 파일은 그
// 공용 모듈을 그대로 import — 동작은 이전과 동일하다.
import { CATEGORY_ICONS, CATEGORY_IMAGES } from "./components/categoryIcons";

const CATEGORIES = [
  { icon: "skate" as IconName, image: "/icons/categories/skate.png", label: "피겨스케이팅" },
  { icon: "pilates" as IconName, image: "/icons/categories/pilates.png", label: "필라테스" },
  { icon: "ballet" as IconName, image: "/icons/categories/ballet.png", label: "발레" },
  { icon: "rhythm" as IconName, image: "/icons/categories/rhythm.png", label: "리듬체조" },
  { icon: "yoga" as IconName, image: "/icons/categories/yoga.png", label: "요가" },
  { icon: "boxing" as IconName, image: "/icons/categories/boxing.png", label: "복싱" },
  { icon: "swim" as IconName, image: "/icons/categories/swim.png", label: "수영" },
  { icon: "golf" as IconName, image: "/icons/categories/golf.png", label: "골프" },
];

// 릴리스 폴리시 배치 7차(2026-09-17) — 성능 조사: 이 앱은 Next.js App Router라 레이아웃
// (BottomNav 등)은 탭 전환 사이 유지되지만, 페이지 컴포넌트 자체(이 Home())는 다른 탭에
// 갔다가 돌아올 때마다 매번 새로 마운트된다(App Router의 기본 동작, 버그 아님) — 그래서
// "예약" 탭에 갔다가 "홈"으로 돌아올 때마다 아래 두 useEffect가 처음부터 다시 실행돼
// 센터/클래스/배너/카테고리 목록이 잠깐 비었다가 다시 채워지는 게 매번 보였다("탭
// 진입 시 순간적으로 다시 그려지는 느낌"의 실제 원인 중 하나). 두 개의 모듈 레벨 캐시로
// 데이터 정확성은 그대로 유지하면서(항상 새로 fetch해서 갱신함) 재진입 시에만 마지막
// 결과를 즉시 먼저 보여준다:
//  1) homeDataCache — 센터/클래스/배너/카테고리 목록. TTL 안에서 재진입하면 그 값을
//     먼저 화면에 채운 뒤, 그래도 항상 백그라운드로 새로 fetch해서 최신화한다.
//  2) lastKnownPosition — GPS 위치. 매번 navigator.geolocation.getCurrentPosition()을
//     기다리면(최대 4초 타임아웃) 센터 목록 fetch 자체가 그만큼 늦게 "시작"됐다(lat/lng를
//     구하고 나서야 Promise.all을 시작하는 구조라 매 재진입마다 최대 4초를 그냥 날렸을
//     수 있음) — 마지막으로 구한 위치가 있으면 그걸 즉시 써서 fetch를 바로 시작하고,
//     최신 위치는 백그라운드로만 갱신해 다음 재진입 때 반영한다. 권한 프롬프트 자체는
//     최초 1회만 뜨는 브라우저 표준 동작이라 이 캐시와 무관.
let homeDataCache: {
  centers: HomeCenter[];
  classes: HomeClass[];
  banners: HomeBanner[];
  categories: ServiceCategory[];
  at: number;
} | null = null;
const HOME_CACHE_TTL_MS = 30_000;
let lastKnownPosition: { lat: number; lng: number } | null = null;

export default function Home() {
  const [centers, setCenters] = useState<HomeCenter[]>([]);
  const [classes, setClasses] = useState<HomeClass[]>([]);
  const [myUpcoming, setMyUpcoming] = useState<HomeClass[]>([]);
  const [banners, setBanners] = useState<HomeBanner[]>([]);
  const [catList, setCatList] = useState<ServiceCategory[]>([]);
  const [bannerIdx, setBannerIdx] = useState(0);
  const touchStartX = useRef(0);
  function goBanner(dir: number) {
    if (validBanners.length <= 1) return;
    setBannerIdx((i) => (i + dir + validBanners.length) % validBanners.length);
  }
  const [loading, setLoading] = useState(true);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [isManager, setIsManager] = useState(false);
  const validBanners = useMemo(
    () => banners.filter((banner) => banner.title?.trim().length >= 2),
    [banners]
  );
  const [showAllCategories, setShowAllCategories] = useState(false);
  const allCategories = useMemo(
    () => (catList.length > 0
      ? catList.map((category) => ({
          icon: CATEGORY_ICONS[category.label] ?? "grid" as IconName,
          image: CATEGORY_IMAGES[category.label] ?? null,
          label: category.label,
        }))
      : CATEGORIES),
    [catList]
  );
  // 추가 요구사항 배치(2026-09-23) — "종목 둘러보기" 반응형 레이아웃. 예전엔
  // allCategories.slice(0,8)로 항상 딱 8개만 첫 grid에 렌더하고, 나머지(9번째 이상,
  // 예: 테니스)를 완전히 별개의 두 번째 .cat-grid에 렌더했다. 그 결과: (1) 태블릿/데스크톱
  // 처럼 8개보다 훨씬 많은 아이콘이 한 줄에 들어갈 수 있는 폭에서도 8개 이상은 절대
  // 안 보여줘서 오른쪽에 큰 빈 공간이 남았고, (2) "전체 종목"을 펼치면 9번째 항목이 첫
  // grid의 column 흐름과 무관한 "새 grid 컨테이너에 아이템 1개"가 되어, auto-fit 트랙이
  // 그 아이템 하나에 1fr 전체 폭을 몰아줘 화면 중앙에 혼자 떠 보였다(각 breakpoint의
  // .cat-grid { grid-template-columns: repeat(N,1fr) 또는 auto-fit,minmax(...) } 확인).
  //
  // 수정: 모든 종목을 하나의 .cat-grid에 순서 그대로 렌더한다(mobile/desktop용 배열을
  // 따로 관리하지 않음). "몇 개가 보이는지"는 이제 JS 카운트가 아니라 순수 CSS로 정한다
  // — .cat-grid는 기본적으로 grid-template-rows: repeat(2,auto); grid-auto-rows: 0;
  // overflow: hidden;으로 "최대 2행"까지만 보이게 자르고(2행에 몇 개가 들어가는지는
  // breakpoint별 컬럼 수가 이미 자연스럽게 결정 — mobile 4열이면 8개, tablet auto-fit이면
  // 실제 컨테이너 폭만큼), 펼치면(.is-expanded) 이 제한을 해제한다. 그 결과 태블릿/
  // 데스크톱에서 폭이 충분해 9개가 이미 2행 안에(대개 1행에) 다 들어가면 전혀 잘리지
  // 않고, 아래 ResizeObserver가 "잘린 게 있는지"를 실제로 측정해 있을 때만 버튼을
  // 보여준다 — window.innerWidth 분기 없이 실제 렌더된 높이로 판단하므로 줌/폰트 크기
  // 변화에도 정확하고, hydration 불일치도 없다(초기값은 "있을 수 있다"고 가정해 버튼을
  // 보여주고, 마운트 직후 useLayoutEffect가 페인트 전에 실제 값으로 보정 — 아이콘 자체의
  // 개수/위치는 이 과정에서 전혀 바뀌지 않아 flicker 없음).
  const catGridRef = useRef<HTMLDivElement>(null);
  const [collapsedHasOverflow, setCollapsedHasOverflow] = useState(true);
  useLayoutEffect(() => {
    if (showAllCategories) return; // 펼친 상태에선 "접혔을 때 잘리는지"를 측정할 대상이 없음
    const el = catGridRef.current;
    if (!el) return;
    function measure() {
      if (!el) return;
      setCollapsedHasOverflow(el.scrollHeight - el.clientHeight > 4);
    }
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showAllCategories, allCategories.length]);
  // 펼쳐진 상태(접기 버튼 필요)거나, 접힌 상태에서 실제로 잘리는 항목이 있을 때만 버튼 노출.
  const showCategoryToggle = showAllCategories || collapsedHasOverflow;
  const visibleClasses = useMemo(() => myUpcoming.length > 0 ? myUpcoming : classes, [classes, myUpcoming]);

  useEffect(() => {
    // 소셜 로그인 콜백 실패(사용자가 provider 동의 화면에서 취소, provider가 접근 거부 등)는
    // Supabase가 성공 시 세션 토큰을 싣는 것과 같은 방식으로 이 페이지의 URL 해시에
    // #error=...&error_description=...로 실어 보낸다. 홈 화면에 그대로 두면 아무 안내 없이
    // 조용히 로그인 안 된 상태로만 보여서, 감지되면 로그인 화면으로 보내 이유를 안내한다.
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const oauthError = hashParams.get("error_description") || hashParams.get("error");
    if (oauthError) {
      window.location.replace(`/login?oauth_error=${encodeURIComponent(oauthError)}`);
      return;
    }
    // 계정/프로필 부트스트랩(ensureAccountForCurrentUser)은 app/components/SessionWatcher.tsx로
    // 옮겨 앱 전체에서 한 번만 처리한다(어느 페이지로 로그인/OAuth 리다이렉트가 와도 보장됨).
    //
    // ⚠️ 실기기 iOS 진단(2026-09-13, Google 최초 로그인 무한 로딩) — 여기서 원래
    // supabase.auth.getUser()를 썼는데, 이는 로컬 세션을 읽는 게 아니라 Supabase Auth
    // 서버에 매번 새로 네트워크 요청을 보내 토큰을 검증한다. OAuth(암묵적 흐름, 해시
    // 프래그먼트 토큰) 콜백으로 막 돌아온 이 시점엔 supabase-js가 URL 해시를 파싱해
    // 세션을 세팅하는 내부 초기화(initializePromise)가 이미 끝난 뒤라 세션은 로컬에
    // 이미 존재하는데, 그걸 확인하겠다고 다시 서버 왕복을 만드는 게 불필요했다. 구글
    // OAuth 직후는 앱이 막 구글 서버와 통신하다 돌아온 직후라 실기기 모바일 네트워크가
    // 아직 안정되지 않았을 수 있는데(특히 앱 최초 설치 후 첫 실행이라 TLS 연결도
    // 전부 콜드 상태), 이 불필요한 추가 왕복이 느려지거나 걸리면 아래 로직 전체가
    // 멈춘 것처럼 보인다 — 반면 세션 자체는 이미 로컬에 저장돼 있어서 앱을 강제
    // 종료 후 재실행하면 이 네트워크 호출 없이도(대개 그때는 계정도 이미 만들어져
    // 있어 SessionWatcher 쪽 경로도 더 짧아짐) 바로 로그인된 화면이 뜬다 — 실기기
    // 재현 증상과 정확히 일치. getSession()은 로컬에 이미 세팅된 세션을 그대로
    // 읽기만 해서(네트워크 요청 없음) 이 지연 원인 자체를 없앤다. 이메일/구글/애플/
    // 카카오/네이버 다섯 갈래 전부 결국 이 홈 마운트를 거치므로 한 곳만 고치면 됨.
    supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user ?? null;
      setLoggedIn(!!user);
      // 로그인이 필요해 /login?next=...로 갔다가 돌아온 경우, 이메일/구글/애플/카카오/네이버
      // 다섯 갈래 전부 결국 이 홈으로 도착하도록 이미 통일돼 있어(lib/postLoginReturn.ts
      // 주석 참고) 여기 한 곳에서만 원래 화면으로 이어서 보낸다. 실제로 로그인된 경우에만
      // (user 존재) 이동한다 — 세션 없이 next만 남아있는 경우는 그대로 홈에 둔다.
      if (user) {
        const next = consumePostLoginNext();
        if (next) { window.location.replace(next); return; }
        // 관리자 모드 진입 버튼(오른쪽 위) 노출 여부 — ACL-005와 동일하게 active
        // manager_centers 소속 여부로만 판단(mypage의 "관리자 모드로 전환"과 같은 기준).
        fetchMyCenters().then((centers) => setIsManager(centers.length > 0)).catch(() => {});
      }
    });
  }, []);

  useEffect(() => {
    // 탭을 옮겼다 홈으로 돌아왔을 때(TTL 이내) 마지막 결과를 먼저 보여줘 목록이 잠깐
    // 비었다 채워지는 게 안 보이게 한다 — 아래에서 항상 새로 fetch하므로 데이터
    // 정확성에는 영향 없다(자세한 설명은 파일 상단 homeDataCache 주석 참고).
    if (homeDataCache && Date.now() - homeDataCache.at < HOME_CACHE_TTL_MS) {
      setCenters(homeDataCache.centers);
      setClasses(homeDataCache.classes);
      setBanners(homeDataCache.banners);
      setCatList(homeDataCache.categories);
      setLoading(false);
    }

    (async () => {
      // 위치 권한 시도 (거부해도 그냥 최신순). 마지막으로 구했던 위치가 있으면 그걸
      // 즉시 써서 센터 fetch를 바로 시작하고(매 재진입마다 최대 4초 기다리지 않음),
      // 최신 위치는 아래에서 백그라운드로만 다시 구해 다음 재진입에 반영한다.
      let lat: number | undefined = lastKnownPosition?.lat;
      let lng: number | undefined = lastKnownPosition?.lng;
      const freshPositionPromise = new Promise<GeolocationPosition>((res, rej) => {
        if (!navigator.geolocation) return rej();
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 4000 });
      })
        .then((pos) => {
          lastKnownPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          return lastKnownPosition;
        })
        .catch(() => null); // 위치 거부/실패 → 최신순(또는 캐시된 마지막 위치)
      if (lat == null || lng == null) {
        const fresh = await freshPositionPromise;
        if (fresh) { lat = fresh.lat; lng = fresh.lng; }
      }

      try {
        // 릴리스 폴리시 배치(2026-09-14, 3차) — fetchMyUpcomingClasses()가 원래 위 4개
        // Promise.all이 끝난 "뒤"에 따로 시작돼 불필요하게 순차적이었다(서로 결과를
        // 참조하지 않는데도 네트워크 왕복 하나가 그냥 더 얹힌 셈) — 동시에 시작해두고
        // 마지막에만 기다린다. 비로그인 실패는 기존처럼 여기서 조용히 삼킨다.
        const upcomingPromise = fetchMyUpcomingClasses().catch(() => null);
        const [cs, cl, bn, ct] = await Promise.all([
          fetchHomeCenters(lat, lng), fetchHomeClasses(), fetchBanners(true), fetchCategories(),
        ]);
        setCenters(cs);
        setClasses(cl);
        setBanners(bn);
        setCatList(ct);
        homeDataCache = { centers: cs, classes: cl, banners: bn, categories: ct, at: Date.now() };
        const upcoming = await upcomingPromise;
        if (upcoming) setMyUpcoming(upcoming);
      } catch {
        // 홈은 로그인 전에도 열리므로 오류 시 조용히 빈 상태로
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // 배너 자동 회전 (4초마다)
  useEffect(() => {
    if (validBanners.length <= 1) return;
    const t = setInterval(() => setBannerIdx((i) => (i + 1) % validBanners.length), 4000);
    return () => clearInterval(t);
  }, [validBanners.length]);

  return (
    <div>
      <div className="app-shell member-home">
        {/* 헤더 */}
        <div className="header">
          <div className="header-row home-heading-row">
            <div className="location">오늘은 어떤 움직임을 찾나요?</div>
            <div className="header-icons">
              {loggedIn === false && (
                <a className="login-link" href="/login">로그인</a>
              )}
              {isManager && (
                <a className="login-link" href="/manager" onClick={(e) => replaceTabNavigation(e, "/manager")}>관리자 모드</a>
              )}
            </div>
          </div>
          <a className="home-location-row" href="/search"><UiIcon name="location" size={15} /><span>내 주변 클래스</span><b>›</b></a>
          <a className="searchbar" href="/search">
            <span>클래스, 센터를 검색해보세요</span>
            <UiIcon name="search" size={20} />
          </a>
        </div>

        {/* UX 감사(A-11) — 아이콘+라벨이 이 앱의 다른 클릭 가능한 칩/버튼과 같은 모양이라
            눌러보게 되는데 실제로는 장식용 <span>이라 반응이 없었다. 실제 링크로 연결. */}
        <div className="home-value-line" aria-label="서비스 주요 기능">
          <a href="/search"><UiIcon name="search" size={15} />내 주변 수업 찾기</a><i />
          <a href="/reservation"><UiIcon name="calendar" size={15} />한 번에 예약</a><i />
          <a href="/mypage"><UiIcon name="ticket" size={15} />수강권 관리</a>
        </div>

        {/* 히어로 배너 (운영자 관리, 자동 회전) */}
        {validBanners.length > 0 ? (
          <div
            className="hero-wrap"
            onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX; }}
            onTouchEnd={(e) => {
              const dx = e.changedTouches[0].clientX - touchStartX.current;
              if (Math.abs(dx) > 40) goBanner(dx < 0 ? 1 : -1);
            }}
          >
            <a className="hero" href={validBanners[bannerIdx]?.linkUrl || "/reservation"} style={{ display: "flex", textDecoration: "none" }}>
              <div className="eyebrow">추천</div>
              <h1>{validBanners[bannerIdx]?.title}</h1>
              {validBanners[bannerIdx]?.subtitle && <div className="chip">{validBanners[bannerIdx]?.subtitle}</div>}
              <div className="deco" aria-hidden="true" />
              {validBanners.length > 1 && (
                <div className="banner-dots">
                  {validBanners.map((_, i) => <span key={i} className={`banner-dot ${i === bannerIdx ? "on" : ""}`} />)}
                </div>
              )}
            </a>
          </div>
        ) : (
          <a className="hero" href="/reservation" style={{ display: "flex", textDecoration: "none" }}>
            <div className="eyebrow">이번 주 추천</div>
            <h1>내 주변에서 시작하는<br />새로운 움직임</h1>
            <div className="chip">원하는 종목과 시간을 찾아보세요</div>
            <div className="deco" aria-hidden="true" />
          </a>
        )}

        {/* 종목 카테고리 그리드 */}
        <div className="home-category-head">
          <h2>종목 둘러보기</h2>
          {showCategoryToggle && (
            <button type="button" onClick={() => setShowAllCategories((v) => !v)}>
              {showAllCategories ? "접기" : "전체 종목"}
            </button>
          )}
        </div>
        <div className={`cat-grid ${showAllCategories ? "is-expanded" : ""}`} ref={catGridRef}>
          {allCategories.map((cat) => (
            <a className="cat-item" key={cat.label} href={`/category/${encodeURIComponent(cat.label)}`}>
              <div className="cat-icon">
                {cat.image ? <img src={cat.image} alt="" /> : <UiIcon name={cat.icon} size={27} />}
              </div>
              <div className="cat-label">{cat.label}</div>
            </a>
          ))}
        </div>

        {/* 비회원(로그인 안 한 상태)에게는 "곧 시작하는 클래스"/"내 수강권으로 예약
            가능"을 아예 숨긴다(2026-09-04, 사용자 결정) — 종목 둘러보기·센터 정보·내 주변
            센터 검색은 비회원도 그대로 이용 가능, 예약 관련 개인화 목록만 가입 유도. 로딩
            중(loggedIn === null)엔 깜빡임 방지를 위해 계속 보여주다가, 확실히 비로그인으로
            확인되면(loggedIn === false) 숨긴다. */}
        {loggedIn !== false && (
          <>
            <div className="home-class-head"><h2>{myUpcoming.length > 0 ? "내 수강권으로 예약 가능" : "곧 시작하는 클래스"}</h2><a href="/reservation">전체보기 ›</a></div>
            {visibleClasses.length === 0 ? (
              <div className="daylist-empty" style={{ padding: "12px 20px 30px" }}>
                {loading ? "불러오는 중..." : "예약 가능한 수업이 없어요"}
              </div>
            ) : (
              <div className="home-class-list">
                {visibleClasses.slice(0, 3).map((c) => {
                  const full = c.reserved >= c.capacity;
                  const center = centers.find((item) => item.id === c.centerId);
                  return (
                    <a className="home-class-row" key={c.id} href={`/center/${c.centerId}`}>
                      <div className="home-class-photo photo-fallback" aria-label={`${center?.name ?? c.centerName} 클래스 이미지`}><UiIcon name={CATEGORY_ICONS[center?.categories[0] ?? ""] ?? "calendar"} size={26} /></div>
                      <div className="home-class-copy">
                        <span>{c.startText}</span>
                        <strong>{c.title}</strong>
                        <small>{c.centerName}</small>
                        {/* UX 감사(C-3) — 이 화면만 "정원 8명 중 6명 남음"(잔여 기준)이라
                            센터 상세/예약 화면의 "예약 2/8"(예약자 기준)과 형식이 달라 같은
                            숫자를 매번 다시 해석해야 했다. 두 화면이 이미 쓰는 형식으로 통일. */}
                        <small>예약 {c.reserved}/{c.capacity}{full ? " · 대기" : ""}</small>
                      </div>
                    </a>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* 전자상거래법상 사업자정보는 로그인 없이도 항상 볼 수 있어야 해서 홈 화면에
            링크는 남겨두되(비회원도 접근 가능), 주소·연락처까지 통째로 펼쳐 보여주던
            블록은 없앤다 — 상세 내용은 /legal/business에서 확인(2026-09-04, 사용자 결정:
            사업자 주소가 자택이라 홈 화면에 상시 노출하는 걸 원치 않음). */}
        <div className="home-footer">
          <div className="home-footer-links">
            <a href="/legal/terms">이용약관</a>
            <a href="/legal/privacy">개인정보처리방침</a>
            <a href="/legal/business">사업자 정보</a>
            <a href="/legal/refund">환불·취소 정책</a>
          </div>
        </div>

      </div>

      {/* 하단 네비게이션 */}
    </div>
  );
}
