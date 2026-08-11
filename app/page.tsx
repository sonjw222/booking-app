"use client";

/*
  홈 화면
  - 디자인은 유지하되, 제휴 센터/예약 가능한 클래스는 실제 DB 데이터로
  - 카테고리·클래스·센터·하단 네비를 실제 라우트로 연결
*/

import { useEffect, useMemo, useState, useRef } from "react";
import { fetchHomeCenters, fetchHomeClasses, fetchMyUpcomingClasses, type HomeCenter, type HomeClass } from "../lib/home";
import { fetchBanners, fetchCategories, type HomeBanner, type ServiceCategory } from "../lib/operator";
import { supabase } from "../lib/supabaseClient";
import BottomNav from "./components/BottomNav";
import UiIcon, { type IconName } from "./components/UiIcon";

const CATEGORIES = [
  { icon: "skate" as IconName, label: "피겨스케이팅" },
  { icon: "pilates" as IconName, label: "필라테스" },
  { icon: "ballet" as IconName, label: "발레" },
  { icon: "rhythm" as IconName, label: "리듬체조" },
  { icon: "yoga" as IconName, label: "요가" },
  { icon: "boxing" as IconName, label: "복싱" },
  { icon: "swim" as IconName, label: "수영" },
  { icon: "golf" as IconName, label: "골프" },
];

const CATEGORY_ICONS: Record<string, IconName> = {
  피겨스케이팅: "skate", 필라테스: "pilates", 발레: "ballet", 리듬체조: "rhythm",
  요가: "yoga", 복싱: "boxing", 수영: "swim", 골프: "golf",
};

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
  const validBanners = useMemo(
    () => banners.filter((banner) => banner.title?.trim().length >= 2),
    [banners]
  );
  const visibleCategories = useMemo(
    () => (catList.length > 0 ? catList.map((category) => ({ icon: CATEGORY_ICONS[category.label] ?? "grid" as IconName, label: category.label })) : CATEGORIES).slice(0, 8),
    [catList]
  );
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
    supabase.auth.getUser().then(({ data }) => {
      setLoggedIn(!!data.user);
    });
  }, []);

  useEffect(() => {
    (async () => {
      // 위치 권한 시도 (거부해도 그냥 최신순)
      let lat: number | undefined, lng: number | undefined;
      try {
        const pos = await new Promise<GeolocationPosition>((res, rej) => {
          if (!navigator.geolocation) return rej();
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 4000 });
        });
        lat = pos.coords.latitude; lng = pos.coords.longitude;
      } catch { /* 위치 거부/실패 → 최신순 */ }

      try {
        const [cs, cl, bn, ct] = await Promise.all([
          fetchHomeCenters(lat, lng), fetchHomeClasses(), fetchBanners(true), fetchCategories(),
        ]);
        setCenters(cs);
        setClasses(cl);
        setBanners(bn);
        setCatList(ct);
        try { setMyUpcoming(await fetchMyUpcomingClasses()); } catch { /* 비로그인 */ }
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
            </div>
          </div>
          <a className="home-location-row" href="/search"><UiIcon name="location" size={15} /><span>내 주변 클래스</span><b>›</b></a>
          <a className="searchbar" href="/search">
            <span>클래스, 센터를 검색해보세요</span>
            <UiIcon name="search" size={20} />
          </a>
        </div>

        <div className="home-value-line" aria-label="서비스 주요 기능">
          <span><UiIcon name="search" size={15} />내 주변 수업 찾기</span><i />
          <span><UiIcon name="calendar" size={15} />한 번에 예약</span><i />
          <span><UiIcon name="ticket" size={15} />수강권 관리</span>
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
        <div className="home-category-head"><h2>종목 둘러보기</h2><a href="/search">전체 종목</a></div>
        <div className="cat-grid">
          {visibleCategories.map((cat) => (
            <a className="cat-item" key={cat.label} href={`/category/${encodeURIComponent(cat.label)}`}>
              <div className="cat-icon"><UiIcon name={cat.icon} size={27} /></div>
              <div className="cat-label">{cat.label}</div>
            </a>
          ))}
        </div>

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
                    <small>정원 {c.capacity}명 중 <b>{Math.max(c.capacity - c.reserved, 0)}명 남음</b>{full ? " · 대기" : ""}</small>
                  </div>
                </a>
              );
            })}
          </div>
        )}

        <div style={{ height: 80 }} />
      </div>

      {/* 하단 네비게이션 */}
      <BottomNav />
    </div>
  );
}
