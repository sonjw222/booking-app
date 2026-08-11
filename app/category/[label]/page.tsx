"use client";

/*
  종목별 센터 목록
  - 홈에서 종목 누르거나 검색에서 종목 선택 시
  - 그 종목 센터들을 사진 + 소개와 함께 리스트
*/

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { fetchCentersByCategory, type SearchCenter } from "../../../lib/home";
import { centerPhotoUrl } from "../../../lib/center";
import Loading from "../../components/Loading";
import BottomNav from "../../components/BottomNav";
import UiIcon from "../../components/UiIcon";

export default function CategoryPage() {
  const params = useParams();
  const label = decodeURIComponent((params?.label as string) ?? "");
  const [centers, setCenters] = useState<SearchCenter[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setCenters(await fetchCentersByCategory(label)); }
    catch { /* 무시 */ }
    finally { setLoading(false); }
  }, [label]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="app-shell discovery-page-v2 category-page-v2">
      <div className="back-header">
        <a className="side" href="/">‹</a>
        <div className="title">{label}</div>
        <div className="side" />
      </div>

      {loading ? <Loading /> : centers.length === 0 ? (
        <div className="category-empty">
          <UiIcon name="search" size={29} />
          <b>아직 {label} 센터가 없어요</b>
          <span>다른 종목을 둘러보거나 새로운 센터를 검색해보세요.</span>
          <a className="primary-btn" href="/search">다른 종목 찾아보기</a>
        </div>
      ) : (
        <main className="category-results-v3">
          <div className="category-results-head">
            <div><b>{label} 센터</b><span>{centers.length}곳</span></div>
            <a href="/search"><UiIcon name="sliders" size={18} />검색 조건</a>
          </div>
          {centers.map((c) => (
            <a key={c.id} className="cat-center-card" href={`/center/${c.id}`}>
              <div className="cat-center-media">
                {c.photoUrl
                  ? <img className="cat-center-photo" src={centerPhotoUrl(c.photoUrl) ?? ""} alt={`${c.name} 센터`} />
                  : <div className="cat-center-photo-empty"><UiIcon name="building" size={24} /></div>}
              </div>
              <div className="cat-center-body">
                <div className="cat-center-title-row"><div className="cat-center-name">{c.name}</div><span>›</span></div>
                {c.categories.length > 0 && <div className="cat-center-tags">{c.categories.slice(0, 3).map((category) => <span key={category}>{category}</span>)}</div>}
                {c.intro && <div className="cat-center-intro">{c.intro}</div>}
                <div className="cat-center-action"><UiIcon name="calendar" size={14} />수업 일정 확인</div>
              </div>
            </a>
          ))}
        </main>
      )}
      <BottomNav />
    </div>
  );
}
