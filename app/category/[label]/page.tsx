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
    <div className="app-shell">
      <div className="back-header">
        <a className="side" href="/">‹</a>
        <div className="title">{label}</div>
        <div className="side" />
      </div>

      {loading ? <Loading /> : centers.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 60 }}>
          아직 {label} 센터가 없어요
        </div>
      ) : (
        <div style={{ paddingBottom: 20 }}>
          {centers.map((c) => (
            <a key={c.id} className="cat-center-card" href={`/center/${c.id}`}>
              {c.photoUrl
                ? <img className="cat-center-photo" src={centerPhotoUrl(c.photoUrl) ?? ""} alt="" />
                : <div className="cat-center-photo-empty">{c.name.slice(0, 1)}</div>}
              <div className="cat-center-body">
                <div className="cat-center-name">{c.name}</div>
                {c.categories.length > 0 && <div className="cat-center-tags">{c.categories.join(" · ")}</div>}
                {c.intro && <div className="cat-center-intro">{c.intro}</div>}
              </div>
            </a>
          ))}
        </div>
      )}
      <BottomNav />
    </div>
  );
}
