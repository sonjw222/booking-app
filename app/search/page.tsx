"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { searchHome, searchClasses, haversineKm, NEARBY_RADIUS_KM, type SearchCenter, type SearchClass } from "../../lib/home";
import { centerPhotoUrl } from "../../lib/center";
import EmptyState from "../components/EmptyState";
import AppButton from "../components/AppButton";
import { consumeListScroll, rememberListScroll } from "../../lib/listScroll";
import { fetchCenterRatings } from "../../lib/centerRatings";
import { summarizeAddress, type CenterRating } from "../../lib/centerDiscovery";
import { computeSearchView, SEARCH_EMPTY_COPY, type Scope } from "../../lib/searchView";

const PAGE_SIZE = 20;
const RECENT_KEY = "mwhabit_recent_searches";
// 검색 결과에서 센터/수업으로 들어갔다가 뒤로가기로 돌아오면 검색어·범위·필터·스크롤을 그대로 복원한다(같은 탭 세션 안에서만).
const STATE_KEY = "mwhabit_search_state";
const SCROLL_KEY = "search";

export default function SearchPage() {
  const [kw, setKw] = useState("");
  const [centers, setCenters] = useState<SearchCenter[]>([]);
  const [classes, setClasses] = useState<SearchClass[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [scope, setScope] = useState<Scope>("all");
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [visibleClassCount, setVisibleClassCount] = useState(PAGE_SIZE);
  const [todayOnly, setTodayOnly] = useState(false);
  const [nearOnly, setNearOnly] = useState(false);
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const requestId = useRef(0);
  // UX-07 — 센터 카드의 평점·후기 수(실제 center_reviews 집계). 조회 실패는 "후기 없음"이 아니므로 값을 비워 둔다.
  const [ratings, setRatings] = useState<Record<string, CenterRating>>({});
  const [ratingsLoaded, setRatingsLoaded] = useState(false);
  // PERF-005 — 검색어 선택(selectTerm)은 즉시 검색하는데 kw 변경 때문에 debounce 타이머가 같은
  // 검색어로 350ms 뒤 한 번 더 요청하던 중복을 막는다. 직접 입력으로 검색어가 바뀌면 해제.
  const immediateTerm = useRef<string | null>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
      if (Array.isArray(saved)) setRecent(saved.filter((x): x is string => typeof x === "string").slice(0, 5));
    } catch { /* 잘못된 저장값은 무시 */ }
  }, []);

  // 하이드레이션이 끝나기 전에(느린 기기·느린 네트워크) 사용자가 입력창에 이미 글자를 쳤다면, React 상태에는 반영되지 않아 검색이 시작되지 않고 입력만 남는다.
  // 마운트 시 DOM의 현재 값을 한 번 읽어 상태로 가져온다(빈 값이면 아무것도 하지 않는다).
  useEffect(() => {
    const typed = (document.getElementById("discovery-search") as HTMLInputElement | null)?.value ?? "";
    if (typed) void Promise.resolve().then(() => setKw((prev) => prev || typed));
  }, []);

  const restoredState = useRef(false);
  useEffect(() => {
    // 뒤로가기(popstate)로 돌아온 경우에만 복원한다. 처음 여는 찾기 탭은 항상 빈 검색창.
    if (restoredState.current) return;
    restoredState.current = true;
    const y = consumeListScroll(SCROLL_KEY);
    if (y == null) { try { sessionStorage.removeItem(STATE_KEY); } catch { /* 무시 */ } return; }
    try {
      const saved = JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "null") as { kw?: string; scope?: Scope; todayOnly?: boolean; nearOnly?: boolean; position?: { lat: number; lng: number } | null; visibleCount?: number; visibleClassCount?: number } | null;
      if (saved && typeof saved.kw === "string" && saved.kw.trim().length >= 2) {
        immediateTerm.current = saved.kw.trim();
        const restoredKw = saved.kw;
        // 마운트 직후 한 번만 하는 복원 — effect 본문에서 동기 setState를 하지 않도록 마이크로태스크로 미룬다.
        void Promise.resolve().then(() => {
          setKw(restoredKw);
          if (saved.scope === "classes" || saved.scope === "centers" || saved.scope === "all") setScope(saved.scope);
          if (saved.todayOnly === true) setTodayOnly(true);
          // 내 주변 조건과 그때의 위치를 그대로 복원한다(권한을 다시 묻지 않는다 — 이미 허용돼 얻은 좌표만 같은 탭에서 재사용).
          if (saved.nearOnly === true && saved.position && Number.isFinite(saved.position.lat) && Number.isFinite(saved.position.lng)) { setPosition(saved.position); setNearOnly(true); }
          return runSearch(restoredKw).then(() => {
            // 더보기로 펼친 개수까지 복원해야 스크롤 위치가 같은 항목을 가리킨다(runSearch가 개수를 초기화한 뒤에 적용).
            if (typeof saved.visibleCount === "number" && saved.visibleCount > PAGE_SIZE) setVisibleCount(Math.min(saved.visibleCount, 500));
            if (typeof saved.visibleClassCount === "number" && saved.visibleClassCount > PAGE_SIZE) setVisibleClassCount(Math.min(saved.visibleClassCount, 500));
          });
        }).then(() => requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y))));
      }
    } catch { /* 잘못된 저장값은 무시 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function rememberSearchState() {
    rememberListScroll(SCROLL_KEY);
    try { sessionStorage.setItem(STATE_KEY, JSON.stringify({ kw, scope, todayOnly, nearOnly, position: nearOnly ? position : null, visibleCount, visibleClassCount })); } catch { /* 사생활 모드 */ }
  }

  async function runSearch(term: string, remember = false) {
    const query = term.trim();
    if (query.length < 2) {
      requestId.current++;
      setSearched(false); setBusy(false); setError(null);
      return;
    }
    if (remember) {
      const updated = [query, ...recent.filter((item) => item !== query)].slice(0, 5);
      setRecent(updated);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(updated)); } catch { /* 사생활 모드 */ }
    }
    const current = ++requestId.current;
    setBusy(true); setError(null);
    try {
      const [home, matchedClasses] = await Promise.all([searchHome(query), searchClasses(query)]);
      if (current !== requestId.current) return;
      setCenters(home.centers); setCategories(home.categories); setClasses(matchedClasses);
      setSearched(true); setVisibleCount(PAGE_SIZE); setVisibleClassCount(PAGE_SIZE);
    } catch (cause) {
      if (current !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : "검색 결과를 불러오지 못했어요.");
      setSearched(false);
    } finally {
      if (current === requestId.current) setBusy(false);
    }
  }

  useEffect(() => {
    const query = kw.trim();
    if (query.length < 2) {
      immediateTerm.current = null;
      requestId.current++;
      setSearched(false); setBusy(false); setError(null);
      return;
    }
    if (immediateTerm.current === query) { immediateTerm.current = null; return; }
    immediateTerm.current = null;
    const timer = window.setTimeout(() => { void runSearch(query); }, 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kw]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (centers.length === 0) { if (alive) { setRatings({}); setRatingsLoaded(false); } return; }
      try { const r = await fetchCenterRatings(centers.slice(0, 100).map((c) => c.id)); if (alive) { setRatings(r); setRatingsLoaded(true); } }
      catch { if (alive) { setRatings({}); setRatingsLoaded(false); } }
    })();
    return () => { alive = false; };
  }, [centers]);

  function selectTerm(term: string) {
    immediateTerm.current = term.trim();
    setKw(term);
    void runSearch(term, true);
  }

  function toggleNearby() {
    if (nearOnly) { setNearOnly(false); return; }
    if (position) { setNearOnly(true); return; }
    if (!navigator.geolocation) { setLocationError("이 브라우저에서는 위치를 확인할 수 없어요."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => { setPosition({ lat: coords.latitude, lng: coords.longitude }); setNearOnly(true); setLocationError(null); setLocating(false); },
      () => { setLocationError("위치 권한을 허용하면 내 주변 결과를 볼 수 있어요."); setLocating(false); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  const todayParts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const todayPart = (type: string) => todayParts.find((item) => item.type === type)?.value ?? "";
  const today = `${todayPart("year")}-${todayPart("month")}-${todayPart("day")}`;
  const view = computeSearchView({ classes, centers, categories, scope, todayOnly, nearOnly, today, position, radiusKm: NEARBY_RADIUS_KM, distanceKm: haversineKm });
  const filteredClasses = view.classes;
  const filteredCenters = [...view.centers].sort((a, b) => {
    if (!position) return 0;
    const aDistance = a.latitude != null && a.longitude != null ? haversineKm(position.lat, position.lng, a.latitude, a.longitude) : Infinity;
    const bDistance = b.latitude != null && b.longitude != null ? haversineKm(position.lat, position.lng, b.latitude, b.longitude) : Infinity;
    return aDistance - bDistance;
  });

  const showClasses = scope !== "centers";
  const showCenters = scope !== "classes";
  const noResults = view.empty !== "none";

  return (
    <div className="app-shell discovery-page-v2">
      <div className="discovery-heading"><h1>찾기</h1><p>내게 맞는 수업과 센터를 찾아보세요.</p></div>
      <form className="search-header" role="search" onSubmit={(e) => { e.preventDefault(); void runSearch(kw, true); }}>
        <label className="sr-only" htmlFor="discovery-search">수업, 센터 또는 종목 검색</label>
        <input id="discovery-search" className="search-input" type="search" placeholder="수업, 센터 또는 종목 검색" value={kw} onChange={(e) => { requestId.current++; setKw(e.target.value); }} />
        <AppButton className="search-go" type="submit" disabled={busy || kw.trim().length < 2}>검색</AppButton>
      </form>
      {error && <div className="discovery-error" role="alert">{error}<button type="button" onClick={() => void runSearch(kw)}>다시 시도</button></div>}
      {!searched && !busy && !error && <div className="search-suggestions">
        {recent.length > 0 && <>
          <div className="search-suggestion-title">최근 검색</div>
          <div className="search-suggestion-chips">{recent.map((term) => <button key={term} type="button" onClick={() => selectTerm(term)}>{term}</button>)}</div>
        </>}
        <div className="search-suggestion-title search-popular-title">인기 종목</div>
        <div className="search-suggestion-chips">{["필라테스", "피겨", "수영", "요가"].map((item) => <button key={item} type="button" onClick={() => selectTerm(item)}>{item}</button>)}</div>
        <p>두 글자 이상 입력하면 결과가 자동으로 나타나요.</p>
      </div>}
      {busy && <p className="discovery-status" role="status">검색 중이에요...</p>}
      {searched && !busy && <>
        <div className="discovery-filters" role="group" aria-label="결과 필터">
          {scope !== "centers" && <button type="button" aria-pressed={todayOnly} className={todayOnly ? "on" : ""} onClick={() => setTodayOnly((value) => !value)}>오늘 수업</button>}
          <button type="button" aria-pressed={nearOnly} className={nearOnly ? "on" : ""} onClick={toggleNearby} disabled={locating}>{locating ? "위치 확인 중..." : `내 주변 ${NEARBY_RADIUS_KM}km`}</button>
        </div>
        {locationError && <p className="discovery-location-error" role="status">{locationError}</p>}
        <div className="discovery-scopes" role="group" aria-label="검색 결과 종류">
          {([["all", "전체"], ["classes", "수업"], ["centers", "센터"]] as const).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={scope === value} className={scope === value ? "on" : ""} onClick={() => setScope(value)}>{label}</button>)}
        </div>
        {noResults ? <EmptyState icon="search" title={SEARCH_EMPTY_COPY[view.empty as Exclude<typeof view.empty, "none">].title} description={SEARCH_EMPTY_COPY[view.empty as Exclude<typeof view.empty, "none">].description}
          action={view.empty === "today_filter" || view.empty === "both_filters" || view.empty === "near_filter" ? <div className="empty-actions">
            {(view.empty === "today_filter" || view.empty === "both_filters") && todayOnly && <button type="button" className="ghost-btn" onClick={() => setTodayOnly(false)}>오늘 조건 해제</button>}
            {(view.empty === "near_filter" || view.empty === "both_filters") && nearOnly && <button type="button" className="ghost-btn" onClick={() => setNearOnly(false)}>주변 조건 해제</button>}
          </div> : undefined} /> : <>
          {scope === "all" && categories.length > 0 && <section className="search-category-results" aria-label="종목 검색 결과">
            <h2 className="menu-section-label">종목</h2>
            <div className="search-category-grid">{categories.map((cat) => <Link key={cat} className="list-row" href={`/category/${encodeURIComponent(cat)}`} prefetch={false} onClick={rememberSearchState}>
              <div className="left">{cat}</div><span className="chevron" aria-hidden="true">›</span>
            </Link>)}</div>
          </section>}
          {showClasses && <section aria-label="수업 검색 결과">
            <h2 className="menu-section-label">수업 {filteredClasses.length > 0 ? `(${filteredClasses.length}${classes.length === 100 ? "+" : ""})` : ""}</h2>
            {filteredClasses.length === 0 ? <p className="discovery-section-empty">조건에 맞는 예정 수업이 없어요.</p> :
              <><div className="search-class-grid">{filteredClasses.slice(0, visibleClassCount).map((cls) => <Link key={cls.id} className="search-class-row" href={`/center/${cls.centerId}/class/${cls.id}`} prefetch={false} onClick={rememberSearchState}>
                <span className="search-class-time">{cls.startText}</span><strong>{cls.title}</strong><span>{cls.centerName}</span><b>수업 보기 <span aria-hidden="true">›</span></b>
              </Link>)}</div>
              {filteredClasses.length > visibleClassCount && <button type="button" className="discovery-more" onClick={() => setVisibleClassCount((count) => count + PAGE_SIZE)}>수업 더보기 ({filteredClasses.length - visibleClassCount}개 남음)</button>}</>}
          </section>}
          {showCenters && <section aria-label="센터 검색 결과">
            <h2 className="menu-section-label">센터 {filteredCenters.length > 0 ? `(${filteredCenters.length})` : ""}</h2>
            {filteredCenters.length === 0 ? <p className="discovery-section-empty">조건에 맞는 센터가 없어요.</p> : <>
              <div className="search-center-grid">{filteredCenters.slice(0, visibleCount).map((c) => <Link key={c.id} className="search-center-row" href={`/center/${c.id}`} prefetch={false} onClick={rememberSearchState}>
                {c.photoUrl ? <img className="search-center-photo" loading="lazy" decoding="async" src={centerPhotoUrl(c.photoUrl) ?? ""} alt="" /> :
                  <div className="search-center-badge" aria-hidden="true">{c.name.slice(0, 1)}</div>}
                <div className="search-center-info"><div className="search-center-name">{c.name}</div>
                  {c.categories.length > 0 && <div className="search-center-cat">{c.categories.join(" · ")}</div>}
                  {(() => {
                    const rating = ratings[c.id];
                    const area = summarizeAddress(c.address);
                    const hasCoord = c.latitude != null && c.longitude != null;
                    return <div className="search-center-meta">
                      {rating ? <span className="cat-meta-rating" aria-label={`평점 ${rating.average.toFixed(1)}점, 후기 ${rating.count}개`}><b aria-hidden="true">★</b> {rating.average.toFixed(1)}<small>({rating.count})</small></span>
                        : ratingsLoaded ? <span className="search-center-missing">아직 후기 없음</span> : null}
                      {area ? <span>{area}</span> : <span className="search-center-missing">위치 미등록</span>}
                      {position && hasCoord && <span className="search-center-distance">{haversineKm(position.lat, position.lng, c.latitude as number, c.longitude as number).toFixed(1)}km</span>}
                    </div>;
                  })()}
                  {c.intro && <div className="search-center-intro">{c.intro}</div>}
                </div><span className="chevron" aria-hidden="true">›</span>
              </Link>)}</div>
              {filteredCenters.length > visibleCount && <button type="button" className="discovery-more" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>센터 더보기 ({filteredCenters.length - visibleCount}개 남음)</button>}
            </>}
          </section>}
        </>}
      </>}
    </div>
  );
}
