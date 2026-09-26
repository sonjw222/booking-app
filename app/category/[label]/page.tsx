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
import UiIcon from "../../components/UiIcon";
import ErrorState from "../../components/ErrorState";
import EmptyState from "../../components/EmptyState";
import BackButton from "../../components/BackButton";

export default function CategoryPage() {
  const params = useParams();
  const label = decodeURIComponent((params?.label as string) ?? "");
  const [centers, setCenters] = useState<SearchCenter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try { setCenters(await fetchCentersByCategory(label)); }
    catch { setError(true); }
    finally { setLoading(false); }
  }, [label]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="app-shell discovery-page-v2 category-page-v2">
      <div className="back-header">
        <BackButton fallbackHref="/" />
        <div className="title">{label}</div>
        <div className="side" />
      </div>

      {loading ? <Loading /> : error ? (
        <ErrorState title="센터를 불러오지 못했어요" description="연결 상태를 확인하고 다시 시도해 주세요."
          action={<button type="button" className="primary-btn" onClick={load}>다시 시도</button>} />
      ) : centers.length === 0 ? (
        <EmptyState icon="search" title={`아직 ${label} 센터가 없어요`}
          description="다른 종목을 둘러보거나 새로운 센터를 검색해보세요."
          action={<a className="primary-btn" href="/search">다른 종목 찾아보기</a>} />
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
    </div>
  );
}
