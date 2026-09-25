"use client";

import { useEffect, useRef, useState } from "react";
import { searchHome, searchClasses, haversineKm, NEARBY_RADIUS_KM, type SearchCenter, type SearchClass } from "../../lib/home";
import { centerPhotoUrl } from "../../lib/center";
import EmptyState from "../components/EmptyState";
import AppButton from "../components/AppButton";

const PAGE_SIZE = 20;
const RECENT_KEY = "mwhabit_recent_searches";
type Scope = "all" | "classes" | "centers";

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

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
      if (Array.isArray(saved)) setRecent(saved.filter((x): x is string => typeof x === "string").slice(0, 5));
    } catch { /* 잘못된 저장값은 무시 */ }
  }, []);

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
      requestId.current++;
      setSearched(false); setBusy(false); setError(null);
      return;
    }
    const timer = window.setTimeout(() => { void runSearch(query); }, 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kw]);

  function selectTerm(term: string) {
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
  const withinNearby = (lat: number | null, lng: number | null) =>
    !nearOnly || !position || (lat != null && lng != null && haversineKm(position.lat, position.lng, lat, lng) <= NEARBY_RADIUS_KM);
  const filteredClasses = classes.filter((cls) => (!todayOnly || cls.date === today) && withinNearby(cls.latitude, cls.longitude));
  const filteredCenters = centers.filter((c) => withinNearby(c.latitude, c.longitude)).sort((a, b) => {
    if (!position) return 0;
    const aDistance = a.latitude != null && a.longitude != null ? haversineKm(position.lat, position.lng, a.latitude, a.longitude) : Infinity;
    const bDistance = b.latitude != null && b.longitude != null ? haversineKm(position.lat, position.lng, b.latitude, b.longitude) : Infinity;
    return aDistance - bDistance;
  });

  const showClasses = scope !== "centers";
  const showCenters = scope !== "classes";
  const noResults = (scope !== "all" || categories.length === 0) &&
    (scope === "classes" || filteredCenters.length === 0) &&
    (scope === "centers" || filteredClasses.length === 0);

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
        {noResults ? <EmptyState icon="search" title="검색 결과가 없어요" description="더 짧은 이름이나 다른 종목으로 검색해보세요." /> : <>
          {scope === "all" && categories.length > 0 && <section className="search-category-results" aria-label="종목 검색 결과">
            <h2 className="menu-section-label">종목</h2>
            <div className="search-category-grid">{categories.map((cat) => <a key={cat} className="list-row" href={`/category/${encodeURIComponent(cat)}`}>
              <div className="left">{cat}</div><span className="chevron" aria-hidden="true">›</span>
            </a>)}</div>
          </section>}
          {showClasses && <section aria-label="수업 검색 결과">
            <h2 className="menu-section-label">수업 {filteredClasses.length > 0 ? `(${filteredClasses.length}${classes.length === 100 ? "+" : ""})` : ""}</h2>
            {filteredClasses.length === 0 ? <p className="discovery-section-empty">조건에 맞는 예정 수업이 없어요.</p> :
              <><div className="search-class-grid">{filteredClasses.slice(0, visibleClassCount).map((cls) => <a key={cls.id} className="search-class-row" href={`/reservation?openClassId=${encodeURIComponent(cls.id)}&openDate=${cls.date}`}>
                <span className="search-class-time">{cls.startText}</span><strong>{cls.title}</strong><span>{cls.centerName}</span><b>예약 보기 <span aria-hidden="true">›</span></b>
              </a>)}</div>
              {filteredClasses.length > visibleClassCount && <button type="button" className="discovery-more" onClick={() => setVisibleClassCount((count) => count + PAGE_SIZE)}>수업 더보기 ({filteredClasses.length - visibleClassCount}개 남음)</button>}</>}
          </section>}
          {showCenters && <section aria-label="센터 검색 결과">
            <h2 className="menu-section-label">센터 {filteredCenters.length > 0 ? `(${filteredCenters.length})` : ""}</h2>
            {filteredCenters.length === 0 ? <p className="discovery-section-empty">조건에 맞는 센터가 없어요.</p> : <>
              <div className="search-center-grid">{filteredCenters.slice(0, visibleCount).map((c) => <a key={c.id} className="search-center-row" href={`/center/${c.id}`}>
                {c.photoUrl ? <img className="search-center-photo" src={centerPhotoUrl(c.photoUrl) ?? ""} alt="" /> :
                  <div className="search-center-badge" aria-hidden="true">{c.name.slice(0, 1)}</div>}
                <div className="search-center-info"><div className="search-center-name">{c.name}</div>
                  {c.categories.length > 0 && <div className="search-center-cat">{c.categories.join(" · ")}</div>}
                  {position && c.latitude != null && c.longitude != null && <div className="search-center-distance">{haversineKm(position.lat, position.lng, c.latitude, c.longitude).toFixed(1)}km</div>}
                  {c.intro && <div className="search-center-intro">{c.intro}</div>}
                </div><span className="chevron" aria-hidden="true">›</span>
              </a>)}</div>
              {filteredCenters.length > visibleCount && <button type="button" className="discovery-more" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>센터 더보기 ({filteredCenters.length - visibleCount}개 남음)</button>}
            </>}
          </section>}
        </>}
      </>}
    </div>
  );
}
