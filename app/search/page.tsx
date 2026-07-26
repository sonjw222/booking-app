"use client";

/*
  검색 - 센터명 또는 종목 검색
  - "피겨" → 피겨스케이팅 종목 (누르면 그 종목 센터 목록)
  - "어텐션" → 어텐션 피겨팀 센터 (누르면 센터 상세)
*/

import { useState } from "react";
import { searchHome, type SearchCenter } from "../../lib/home";
import { centerPhotoUrl } from "../../lib/center";
import BottomNav from "../components/BottomNav";

export default function SearchPage() {
  const [kw, setKw] = useState("");
  const [centers, setCenters] = useState<SearchCenter[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);

  async function doSearch() {
    if (!kw.trim()) return;
    setBusy(true);
    try {
      const r = await searchHome(kw);
      setCenters(r.centers);
      setCategories(r.categories);
      setSearched(true);
    } catch { /* 무시 */ }
    finally { setBusy(false); }
  }

  return (
    <div className="app-shell">
      <div className="search-header">
        <a className="side" href="/">‹</a>
        <input
          className="search-input"
          placeholder="센터 이름 또는 종목 검색"
          value={kw}
          autoFocus
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doSearch()}
        />
        <button className="search-go" disabled={busy} onClick={doSearch}>검색</button>
      </div>

      {!searched ? (
        <div className="daylist-empty" style={{ paddingTop: 60 }}>
          센터 이름이나 종목을 검색해보세요<br />
          <span style={{ fontSize: 12 }}>예: &apos;피겨&apos;, &apos;필라테스&apos;, 센터 이름</span>
        </div>
      ) : (
        <>
          {categories.length > 0 && (
            <>
              <div className="menu-section-label">종목</div>
              {categories.map((cat) => (
                <a key={cat} className="list-row" href={`/category/${encodeURIComponent(cat)}`}>
                  <div className="left"><span className="icon">🏷️</span>{cat}</div>
                  <span className="chevron">›</span>
                </a>
              ))}
            </>
          )}

          <div className="menu-section-label">센터 {centers.length > 0 ? `(${centers.length})` : ""}</div>
          {centers.length === 0 && categories.length === 0 ? (
            <div className="daylist-empty" style={{ paddingTop: 30 }}>검색 결과가 없어요</div>
          ) : (
            centers.map((c) => (
              <a key={c.id} className="search-center-row" href={`/center/${c.id}`}>
                {c.photoUrl
                  ? <img className="search-center-photo" src={centerPhotoUrl(c.photoUrl) ?? ""} alt="" />
                  : <div className="search-center-badge">{c.name.slice(0, 1)}</div>}
                <div className="search-center-info">
                  <div className="search-center-name">{c.name}</div>
                  {c.categories.length > 0 && <div className="search-center-cat">{c.categories.join(" · ")}</div>}
                  {c.intro && <div className="search-center-intro">{c.intro}</div>}
                </div>
                <span className="chevron">›</span>
              </a>
            ))
          )}
        </>
      )}
      <BottomNav />
    </div>
  );
}
