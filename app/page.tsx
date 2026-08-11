"use client";

/*
  홈 화면
  - 디자인은 유지하되, 제휴 센터/예약 가능한 클래스는 실제 DB 데이터로
  - 카테고리·클래스·센터·하단 네비를 실제 라우트로 연결
*/

import { useEffect, useState, useRef } from "react";
import { fetchHomeCenters, fetchHomeClasses, fetchMyUpcomingClasses, type HomeCenter, type HomeClass } from "../lib/home";
import { fetchBanners, fetchCategories, type HomeBanner, type ServiceCategory } from "../lib/operator";
import { supabase } from "../lib/supabaseClient";
import BottomNav from "./components/BottomNav";

const CATEGORIES = [
  { emoji: "⛸️", label: "피겨스케이팅" },
  { emoji: "🧘‍♀️", label: "필라테스" },
  { emoji: "🩰", label: "발레" },
  { emoji: "🤸‍♀️", label: "리듬체조" },
  { emoji: "🧎‍♀️", label: "요가" },
  { emoji: "🥊", label: "복싱" },
  { emoji: "🏊‍♀️", label: "수영" },
  { emoji: "⛳", label: "골프" },
];

// 센터 뱃지에 쓸 대표 글자/색
const BADGE_COLORS = ["var(--accent)", "#2B4C7E", "#4A4A52", "var(--gold)", "#1F6F63"];

export default function Home() {
  const [centers, setCenters] = useState<HomeCenter[]>([]);
  const [classes, setClasses] = useState<HomeClass[]>([]);
  const [myUpcoming, setMyUpcoming] = useState<HomeClass[]>([]);
  const [banners, setBanners] = useState<HomeBanner[]>([]);
  const [catList, setCatList] = useState<ServiceCategory[]>([]);
  const [bannerIdx, setBannerIdx] = useState(0);
  const touchStartX = useRef(0);
  function goBanner(dir: number) {
    if (banners.length <= 1) return;
    setBannerIdx((i) => (i + dir + banners.length) % banners.length);
  }
  const [loading, setLoading] = useState(true);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);

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
    if (banners.length <= 1) return;
    const t = setInterval(() => setBannerIdx((i) => (i + 1) % banners.length), 4000);
    return () => clearInterval(t);
  }, [banners.length]);

  return (
    <div>
      <div className="app-shell">
        {/* 헤더 */}
        <div className="header">
          <div className="header-row">
            <div className="location">우리동네 클래스</div>
            <div className="header-icons">
              {loggedIn === false && (
                <a className="login-link" href="/login">로그인/회원가입</a>
              )}
            </div>
          </div>
          <a className="searchbar" href="/search">
            <span>오늘은 어떤 클래스로 몸을 깨워볼까요?</span>
            <span>🔍</span>
          </a>
        </div>

        {/* 히어로 배너 (운영자 관리, 자동 회전) */}
        {banners.length > 0 ? (
          <div
            className="hero-wrap"
            onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX; }}
            onTouchEnd={(e) => {
              const dx = e.changedTouches[0].clientX - touchStartX.current;
              if (Math.abs(dx) > 40) goBanner(dx < 0 ? 1 : -1);
            }}
          >
            <a className="hero" href={banners[bannerIdx]?.linkUrl || "/reservation"} style={{ display: "block", textDecoration: "none" }}>
              <div className="eyebrow">추천</div>
              <h1>{banners[bannerIdx]?.title}</h1>
              {banners[bannerIdx]?.subtitle && <div className="chip">{banners[bannerIdx]?.emoji} {banners[bannerIdx]?.subtitle}</div>}
              <div className="deco">{banners[bannerIdx]?.emoji || "🩰"}</div>
              {banners.length > 1 && (
                <div className="banner-dots">
                  {banners.map((_, i) => <span key={i} className={`banner-dot ${i === bannerIdx ? "on" : ""}`} />)}
                </div>
              )}
            </a>
          </div>
        ) : (
          <a className="hero" href="/reservation" style={{ display: "block", textDecoration: "none" }}>
            <div className="eyebrow">신규 회원 웰컴 혜택</div>
            <h1>첫 등록이면<br />수강료 5,000원 쿠폰</h1>
            <div className="chip">🎁 필라테스 · 발레 · 스케이팅 전체 사용</div>
            <div className="deco">🩰</div>
          </a>
        )}

        {/* 종목 카테고리 그리드 */}
        <div className="cat-grid">
          {(catList.length > 0 ? catList.map((c) => ({ emoji: c.emoji ?? "🏷️", label: c.label })) : CATEGORIES).map((cat) => (
            <a className="cat-item" key={cat.label} href={`/category/${encodeURIComponent(cat.label)}`}>
              <div className="cat-icon">{cat.emoji}</div>
              <div className="cat-label">{cat.label}</div>
            </a>
          ))}
          <a className="cat-item" href="/reservation">
            <div className="cat-icon tag">전체<span>보기</span></div>
            <div className="cat-label">더보기</div>
          </a>
        </div>

        <div className="divider" />

        {/* 제휴 센터 (실제 승인된 센터) */}
        <div className="section-title">우리동네 센터</div>
        {centers.length === 0 ? (
          <div className="daylist-empty" style={{ padding: "12px 20px 20px" }}>
            {loading ? "불러오는 중..." : "아직 등록된 센터가 없어요"}
          </div>
        ) : (
          <div className="brand-scroll">
            {centers.map((b, i) => (
              <a className="brand-item" key={b.id} href={`/center/${b.id}`}>
                <div className="brand-badge" style={{ background: BADGE_COLORS[i % BADGE_COLORS.length] }}>
                  {b.name.slice(0, 1)}
                </div>
                <div className="brand-name">{b.name}</div>
                {b.categories.length > 0 && <div className="brand-cat">{b.categories.join(" · ")}</div>}
                {b.distanceKm != null && <div className="brand-dist">{b.distanceKm < 1 ? `${Math.round(b.distanceKm * 1000)}m` : `${b.distanceKm.toFixed(1)}km`}</div>}
              </a>
            ))}
          </div>
        )}

        <div className="divider" />

        {/* 내 수강권으로 예약 가능한 수업 (로그인 + 수강권 보유 시) */}
        {myUpcoming.length > 0 && (
          <>
            <div className="section-title">내 수강권으로 예약 가능 <span style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 500 }}>· 일주일 이내</span></div>
            <div className="card-scroll">
              {myUpcoming.map((c) => {
                const full = c.reserved >= c.capacity;
                return (
                  <a className="class-card" key={c.id} href={`/reservation?center=${c.centerId}`}>
                    <div className="class-thumb" style={{ background: "linear-gradient(160deg,var(--grad1),var(--grad2))" }}>
                      {c.title.slice(0, 1)}
                    </div>
                    <div className="class-name">{c.title}</div>
                    <div className="class-meta">{c.centerName} · <b>{c.startText}</b></div>
                    <div className="class-meta">예약 {c.reserved}/{c.capacity}{full ? " · 대기" : ""}</div>
                  </a>
                );
              })}
            </div>
          </>
        )}

        {/* 지금 예약 가능한 클래스 (실제 수업) */}
        <div className="section-title">지금 예약 가능한 클래스</div>
        {classes.length === 0 ? (
          <div className="daylist-empty" style={{ padding: "12px 20px 30px" }}>
            {loading ? "불러오는 중..." : "예약 가능한 수업이 없어요"}
          </div>
        ) : (
          <div className="card-scroll">
            {classes.map((c) => {
              const full = c.reserved >= c.capacity;
              return (
                <a className="class-card" key={c.id} href={`/center/${c.centerId}`}>
                  <div className="class-thumb" style={{ background: "linear-gradient(160deg,var(--grad2),var(--grad3))" }}>
                    {c.title.slice(0, 1)}
                  </div>
                  <div className="class-name">{c.title}</div>
                  <div className="class-meta">
                    {c.centerName} · <b>{c.startText}</b>
                  </div>
                  <div className={`class-meta ${full ? "" : ""}`}>
                    예약 {c.reserved}/{c.capacity}{full ? " · 대기" : ""}
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
