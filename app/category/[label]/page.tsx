"use client";

/*
  종목별 센터 목록
  - 홈에서 종목 누르거나 검색에서 종목 선택 시
  - 그 종목 센터들을 사진 + 소개와 함께 리스트하고, 검색어 · 거리 범위 · 정렬로 좁힌다.
  - 필터 상태(q/r/s)는 URL 쿼리에 둔다: 센터 상세에서 뒤로가기 해도, 새로고침해도, 링크를 공유해도 같은 목록이 복원된다.
    스크롤 위치는 뒤로가기로 돌아온 경우에만 복원한다(lib/listScroll.ts).
  - 거리·평점은 실제 데이터만 쓴다: 좌표가 없는 센터는 거리를 숨기고, 후기가 없는 센터는 평점을 숨긴다(가짜 값 없음).
*/

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { fetchCentersByCategory, type SearchCenter } from "../../../lib/home";
import { fetchCenterRatings } from "../../../lib/centerRatings";
import {
  DEFAULT_DISCOVERY, activeFilterCount, applyDiscovery, formatDistance, parseDiscoveryParams, radiusLabel,
  serializeDiscoveryParams, sortLabel, summarizeAddress,
  type CenterRating, type DiscoveryState, type RadiusKm, type SortKey,
} from "../../../lib/centerDiscovery";
import { useGeolocation } from "../../../lib/useGeolocation";
import { consumeListScroll, rememberListScroll } from "../../../lib/listScroll";
import { centerPhotoUrl } from "../../../lib/center";
import Loading from "../../components/Loading";
import UiIcon from "../../components/UiIcon";
import ErrorState from "../../components/ErrorState";
import EmptyState from "../../components/EmptyState";
import BackButton from "../../components/BackButton";
import CenterFilterSheet from "../../components/CenterFilterSheet";

export default function CategoryPage() {
  return <Suspense fallback={<div className="app-shell discovery-page-v2 category-page-v2"><Loading /></div>}><CategoryContent /></Suspense>;
}

function CategoryContent() {
  const params = useParams();
  const label = decodeURIComponent((params?.label as string) ?? "");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const state = useMemo(() => parseDiscoveryParams(searchParams), [searchParams]);

  const [centers, setCenters] = useState<SearchCenter[]>([]);
  const [ratings, setRatings] = useState<Record<string, CenterRating>>({});
  const [ratingsLoaded, setRatingsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [queryDraft, setQueryDraft] = useState(state.query);
  const geo = useGeolocation();
  const scrollKey = `category:${label}`;
  const scrollRestored = useRef(false);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await fetchCentersByCategory(label);
        if (!alive) return;
        setCenters(list); setLoading(false);
        // 평점은 목록을 먼저 보여준 뒤 따로 채운다 — 실패해도 목록은 그대로(평점순만 비활성).
        try { const r = await fetchCenterRatings(list.map((c) => c.id)); if (alive) { setRatings(r); setRatingsLoaded(true); } }
        catch { if (alive) { setRatings({}); setRatingsLoaded(false); } }
      } catch { if (alive) { setError(true); setLoading(false); } }
    })();
    return () => { alive = false; };
  }, [label, reloadKey]);
  const retry = () => { setError(false); setLoading(true); setReloadKey((k) => k + 1); };

  // URL 변경(뒤로가기 등)으로 q가 바뀌면 입력창도 맞춘다(렌더 중 상태 보정 — effect 안 setState 금지 규칙).
  const [syncedQuery, setSyncedQuery] = useState(state.query);
  if (syncedQuery !== state.query) { setSyncedQuery(state.query); setQueryDraft(state.query); }

  const update = useCallback((next: DiscoveryState) => {
    const qs = serializeDiscoveryParams(next);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router]);

  // 검색어는 입력이 멈춘 뒤 URL에 반영한다(타이핑마다 히스토리/렌더 부담 방지).
  useEffect(() => {
    if (queryDraft === state.query) return;
    const t = window.setTimeout(() => update({ ...state, query: queryDraft }), 250);
    return () => window.clearTimeout(t);
  }, [queryDraft, state, update]);

  const result = useMemo(() => applyDiscovery(centers, state, geo.position, ratings), [centers, state, geo.position, ratings]);
  const anyRated = useMemo(() => centers.some((c) => ratings[c.id]), [centers, ratings]);

  // 뒤로가기로 돌아온 경우에만 스크롤 복원 — 목록이 그려진 뒤 한 번.
  useEffect(() => {
    if (loading || error || scrollRestored.current) return;
    scrollRestored.current = true;
    const y = consumeListScroll(scrollKey);
    if (y != null) requestAnimationFrame(() => window.scrollTo(0, y));
  }, [loading, error, scrollKey]);

  const changeRadius = (r: RadiusKm) => { update({ ...state, radiusKm: r }); if (r != null && !geo.position && geo.status !== "loading") geo.request(); };
  const changeSort = (s: SortKey) => { update({ ...state, sort: s }); if (s === "distance" && !geo.position && geo.status !== "loading") geo.request(); };
  const withoutLocation = () => update({ ...state, radiusKm: null, sort: state.sort === "distance" ? "recommended" : state.sort });
  const reset = () => { setQueryDraft(""); update(DEFAULT_DISCOVERY); };

  const filterCount = activeFilterCount(state);
  const hasPosition = !!geo.position;
  const locationBlocked = result.locationNeeded && (geo.status === "denied" || geo.status === "unavailable");

  return (
    <div className="app-shell discovery-page-v2 category-page-v2">
      <div className="back-header">
        <BackButton fallbackHref="/" />
        <div className="title">{label}</div>
        <div className="side" />
      </div>

      {loading ? <Loading /> : error ? (
        <ErrorState title="센터를 불러오지 못했어요" description="연결 상태를 확인하고 다시 시도해 주세요."
          action={<button type="button" className="primary-btn" onClick={retry}>다시 시도</button>} />
      ) : centers.length === 0 ? (
        <EmptyState icon="search" title={`아직 ${label} 센터가 없어요`}
          description="다른 종목을 둘러보거나 새로운 센터를 검색해보세요."
          action={<Link className="primary-btn" href="/search" prefetch={false}>다른 종목 찾아보기</Link>} />
      ) : (
        <main className="category-results-v3">
          <div className="category-results-head">
            <div><b>{label} 센터</b><span>{result.rows.length}곳</span></div>
          </div>

          <div className="category-toolbar">
            <label className="sr-only" htmlFor="category-query">{label} 센터 이름·주소 검색</label>
            <div className="category-query">
              <UiIcon name="search" size={16} />
              <input id="category-query" className="category-query-input" type="search" inputMode="search" enterKeyHint="search" autoComplete="off" maxLength={100}
                placeholder="센터 이름·주소 검색" value={queryDraft} onChange={(e) => setQueryDraft(e.target.value)} />
            </div>
            <div className="category-filter-chips" role="group" aria-label="필터와 정렬">
              <button type="button" className={`cf-trigger ${state.radiusKm != null ? "on" : ""}`} aria-haspopup="dialog" onClick={() => setSheetOpen(true)}>
                <span>거리 {radiusLabel(state.radiusKm)}</span><span aria-hidden="true">▾</span>
              </button>
              <button type="button" className={`cf-trigger ${state.sort !== "recommended" ? "on" : ""}`} aria-haspopup="dialog" onClick={() => setSheetOpen(true)}>
                <span>정렬: {sortLabel(state.sort)}</span><span aria-hidden="true">▾</span>
              </button>
              {filterCount > 0 && <button type="button" className="cf-reset" onClick={reset}>초기화</button>}
            </div>
          </div>

          {geo.status === "loading" && <p className="category-notice" role="status">내 위치를 확인하고 있어요…</p>}
          {locationBlocked && (
            <div className="category-notice warn" role="alert">
              <p>{geo.status === "denied" ? "위치 권한이 꺼져 있어 거리 조건을 적용하지 못했어요." : "현재 위치를 확인하지 못해 거리 조건을 적용하지 못했어요."} 지금은 전체 센터를 보여드려요.</p>
              <div className="category-notice-actions">
                <button type="button" className="ghost-btn" onClick={geo.request}>다시 시도</button>
                <button type="button" className="ghost-btn" onClick={withoutLocation}>위치 없이 보기</button>
              </div>
            </div>
          )}
          {state.radiusKm != null && hasPosition && result.excludedNoDistance > 0 && (
            <p className="category-notice" role="status">위치 정보가 등록되지 않은 센터 {result.excludedNoDistance}곳은 거리 범위에서 제외했어요.</p>
          )}

          {result.rows.length === 0 ? (
            <EmptyState icon="search"
              title={state.query.trim() ? `'${state.query.trim()}'에 맞는 센터가 없어요` : "조건에 맞는 센터가 없어요"}
              description={state.radiusKm != null ? "거리 범위를 넓히거나 조건을 초기화해 보세요." : "검색어나 정렬 조건을 바꿔 보세요."}
              action={<button type="button" className="primary-btn" onClick={reset}>조건 초기화</button>} />
          ) : result.rows.map(({ center: c, distanceKm, rating }) => {
            const area = summarizeAddress(c.address);
            const showDistance = hasPosition && distanceKm != null;
            return (
              <Link key={c.id} className="cat-center-card" href={`/center/${c.id}`} prefetch={false} onClick={() => rememberListScroll(scrollKey)}>
                <div className="cat-center-media">
                  {c.photoUrl
                    ? <img className="cat-center-photo" loading="lazy" decoding="async" src={centerPhotoUrl(c.photoUrl) ?? ""} alt={`${c.name} 센터`} />
                    : <div className="cat-center-photo-empty"><UiIcon name="building" size={24} /></div>}
                </div>
                <div className="cat-center-body">
                  <div className="cat-center-title-row">
                    <div className="cat-center-name">{c.name}</div>
                    {(rating || showDistance || area) && (
                      <div className="cat-center-meta">
                        {rating && <span className="cat-meta-rating" aria-label={`평점 ${rating.average.toFixed(1)}점, 후기 ${rating.count}개`}><b aria-hidden="true">★</b> {rating.average.toFixed(1)}<small>({rating.count})</small></span>}
                        {showDistance && <span className="cat-meta-distance">{formatDistance(distanceKm as number)}</span>}
                        {area && <span className="cat-meta-area">{area}</span>}
                      </div>
                    )}
                    <span className="cat-center-chevron" aria-hidden="true">›</span>
                  </div>
                  {c.categories.length > 0 && <div className="cat-center-tags">{c.categories.slice(0, 3).map((category) => <span key={category}>{category}</span>)}</div>}
                  {c.intro && <div className="cat-center-intro">{c.intro}</div>}
                  <div className="cat-center-action"><UiIcon name="calendar" size={14} />수업 일정 확인</div>
                </div>
              </Link>
            );
          })}
        </main>
      )}

      {sheetOpen && (
        <CenterFilterSheet
          state={state} locationStatus={geo.status} hasPosition={hasPosition}
          ratingsLoaded={ratingsLoaded} anyRated={anyRated} resultCount={result.rows.length}
          onChangeRadius={changeRadius} onChangeSort={changeSort}
          onRequestLocation={geo.request} onWithoutLocation={withoutLocation}
          onReset={reset} onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  );
}
