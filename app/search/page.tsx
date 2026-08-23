"use client";

/*
  검색 - 센터명 또는 종목 검색
  - "피겨" → 피겨스케이팅 종목 (누르면 그 종목 센터 목록)
  - "어텐션" → 어텐션 피겨팀 센터 (누르면 센터 상세)
*/

import { useState } from "react";
import { searchHome, type SearchCenter } from "../../lib/home";
import { centerPhotoUrl } from "../../lib/center";
import EmptyState from "../components/EmptyState";
import BackButton from "../components/BackButton";

export default function SearchPage() {
  const [kw, setKw] = useState("");
  const [centers, setCenters] = useState<SearchCenter[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
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
        </div>
      ) : (
        <>
          {categories.length > 0 && (
            <>
              <div className="menu-section-label">종목</div>
              {categories.map((cat) => (
                <a key={cat} className="list-row" href={`/category/${encodeURIComponent(cat)}`}>
                  <div className="left"><span className="icon" aria-hidden="true" />{cat}</div>
                  <span className="chevron">›</span>
                </a>
              ))}
            </>
          )}

          <div className="menu-section-label">센터 {centers.length > 0 ? `(${centers.length})` : ""}</div>
          {centers.length === 0 && categories.length === 0 ? (
            <EmptyState icon="search" title="검색 결과가 없어요" description="센터 이름을 짧게 입력하거나 다른 종목으로 검색해보세요." />
          ) : (
            <>
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
