"use client";

/*
  검색 - 센터명 또는 종목 검색
  - "피겨" → 피겨스케이팅 종목 (누르면 그 종목 센터 목록)
  - "어텐션" → 어텐션 피겨팀 센터 (누르면 센터 상세)
*/

import { useEffect, useState } from "react";
import { searchHome, fetchHomeCenters, type SearchCenter, type HomeCenter } from "../../lib/home";
import { fetchCategories } from "../../lib/operator";
import { centerPhotoUrl } from "../../lib/center";
import { CATEGORY_ICONS } from "../components/categoryIcons";
import UiIcon from "../components/UiIcon";
import EmptyState from "../components/EmptyState";
import BackButton from "../components/BackButton";

export default function SearchPage() {
  const [kw, setKw] = useState("");
  const [centers, setCenters] = useState<SearchCenter[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);

  // 추가 배치(2026-09-24) — iPad portrait(768~1279px) 전용 보조 콘텐츠. 검색 전(초기)
  // 상태가 인기 종목 칩 4개 + 안내문 한 줄뿐이라 태블릿 세로 화면 대부분이 비어 보였다.
  // 새 추천 로직/DB 없이 이미 홈 화면이 쓰는 것과 동일한 함수(fetchCategories,
  // fetchHomeCenters)만 재사용 — 실제 렌더는 아래 JSX에서 CSS로 768~1279px에만
  // 노출한다(모바일/데스크톱은 기존 그대로, 이 fetch 자체는 가볍고 항상 실행돼도
  // 무해하지만 렌더는 태블릿에서만).
  const [allCategories, setAllCategories] = useState<string[]>([]);
  const [nearbyCenters, setNearbyCenters] = useState<HomeCenter[]>([]);
  useEffect(() => {
    fetchCategories().then((cats) => setAllCategories(cats.map((c) => c.label))).catch(() => {});
    // 위치 권한 프롬프트를 새로 띄우지 않는다 — 좌표 없이 호출하면 fetchHomeCenters가
    // 기존에 이미 갖고 있는 fallback(최신 승인순)을 그대로 써서 홈과 동일한 관례를 따른다.
    fetchHomeCenters().then(setNearbyCenters).catch(() => {});
  }, []);
  // UX 감사(A-6) — 필터·정렬·페이징 없이 결과를 전부(실측 131건) 한 번에 렌더해 화면이
  // 10,000px 넘게 늘어졌다. 전체 필터/정렬 UI는 범위가 커 이번엔 가장 급한 "무한 렌더"만
  // 우선 끊는다 — 20개씩 보여주고 "더보기"로 점진 노출.
  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  async function doSearch(suggested?: string) {
    const term = (suggested ?? kw).trim();
    if (!term) return;
    if (suggested) setKw(suggested);
    setBusy(true);
    try {
      const r = await searchHome(term);
      setCenters(r.centers);
      setCategories(r.categories);
      setSearched(true);
      setVisibleCount(PAGE_SIZE);
    } catch { /* 무시 */ }
    finally { setBusy(false); }
  }

  return (
    <div className="app-shell discovery-page-v2">
      <div className="search-header">
        <BackButton fallbackHref="/" />
        <input
          className="search-input"
          placeholder="센터 이름 또는 종목 검색"
          value={kw}
          autoFocus
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doSearch()}
        />
        <button className="search-go" disabled={busy} onClick={() => doSearch()}>검색</button>
      </div>

      {!searched ? (
        <div className="search-suggestions">
          <div className="search-suggestion-title">인기 종목</div>
          <div className="search-suggestion-chips">
            {["필라테스", "피겨", "수영", "요가"].map((item) => <button key={item} onClick={() => doSearch(item)}>{item}</button>)}
          </div>
          <p>센터 이름이나 원하는 종목으로 검색해보세요.</p>

          {/* iPad portrait(768~1279px) 전용 — 아래 .search-tablet-extra는 그 구간에서만
              보인다(app/globals.css). 모바일/데스크톱은 기존 화면 그대로. */}
          <div className="search-tablet-extra">
            {allCategories.length > 0 && (
              <section aria-label="종목별 탐색">
                <div className="search-suggestion-title">종목별 탐색</div>
                {/* 기존 "검색 결과 - 종목" 블록(.search-category-grid > .list-row)과
                    완전히 동일한 마크업/클래스를 재사용 — 새 컴포넌트를 만들지 않음. */}
                <div className="search-category-grid">
                  {allCategories.map((label) => (
                    <a key={label} className="list-row" href={`/category/${encodeURIComponent(label)}`}>
                      <div className="left"><span className="icon"><UiIcon name={CATEGORY_ICONS[label] ?? "grid"} size={18} /></span>{label}</div>
                      <span className="chevron">›</span>
                    </a>
                  ))}
                </div>
              </section>
            )}
            {nearbyCenters.length > 0 && (
              <section aria-label="가까운 센터">
                <div className="search-suggestion-title">가까운 센터</div>
                <div className="search-center-grid">
                  {nearbyCenters.slice(0, 6).map((c) => (
                    <a key={c.id} className="search-center-row" href={`/center/${c.id}`}>
                      <div className="search-center-badge">{c.name.slice(0, 1)}</div>
                      <div className="search-center-info">
                        <div className="search-center-name">{c.name}</div>
                        {c.categories.length > 0 && <div className="search-center-cat">{c.categories.join(" · ")}</div>}
                      </div>
                      <span className="chevron">›</span>
                    </a>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      ) : (
        <>
          {categories.length > 0 && (
            <section className="search-category-results" aria-label="종목 검색 결과">
              <div className="menu-section-label">종목</div>
              <div className="search-category-grid">
              {categories.map((cat) => (
                <a key={cat} className="list-row" href={`/category/${encodeURIComponent(cat)}`}>
                  <div className="left"><span className="icon" aria-hidden="true" />{cat}</div>
                  <span className="chevron">›</span>
                </a>
              ))}
              </div>
            </section>
          )}

          <div className="menu-section-label">센터 {centers.length > 0 ? `(${centers.length})` : ""}</div>
          {centers.length === 0 && categories.length === 0 ? (
            <EmptyState icon="search" title="검색 결과가 없어요" description="센터 이름을 짧게 입력하거나 다른 종목으로 검색해보세요." />
          ) : (
            <>
              <div className="search-center-grid">
              {centers.slice(0, visibleCount).map((c) => (
                <a key={c.id} className="search-center-row" href={`/center/${c.id}`}>
                  {c.photoUrl
                    ? <img className="search-center-photo" src={centerPhotoUrl(c.photoUrl) ?? ""} alt={`${c.name} 센터`} />
                    : <div className="search-center-badge">{c.name.slice(0, 1)}</div>}
                  <div className="search-center-info">
                    <div className="search-center-name">{c.name}</div>
                    {c.categories.length > 0 && <div className="search-center-cat">{c.categories.join(" · ")}</div>}
                    {c.intro && <div className="search-center-intro">{c.intro}</div>}
                  </div>
                  <span className="chevron">›</span>
                </a>
              ))}
              </div>
              {centers.length > visibleCount && (
                <button className="ghost-btn" style={{ margin: "12px 20px" }} onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}>
                  더보기 ({centers.length - visibleCount}건 더 있음)
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
