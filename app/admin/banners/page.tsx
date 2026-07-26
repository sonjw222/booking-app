"use client";

/*
  운영자 - 배너 관리
  - 홈 배너 추가/삭제/노출토글 (순서대로 회전)
*/

import { useCallback, useEffect, useState } from "react";
import { fetchBanners, addBanner, toggleBanner, deleteBanner, type HomeBanner } from "../../../lib/operator";
import Loading from "../../components/Loading";

export default function BannersPage() {
  const [banners, setBanners] = useState<HomeBanner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [emoji, setEmoji] = useState("");
  const [linkUrl, setLinkUrl] = useState("");

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2000); }

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setBanners(await fetchBanners(false)); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function handleAdd() {
    if (!title.trim()) { setError("배너 문구를 입력해주세요"); return; }
    setBusy(true);
    try {
      await addBanner({ title: title.trim(), subtitle: subtitle.trim(), emoji: emoji.trim(), linkUrl: linkUrl.trim() });
      setTitle(""); setSubtitle(""); setEmoji(""); setLinkUrl(""); setAdding(false);
      showToast("배너를 추가했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleToggle(b: HomeBanner) {
    setBusy(true);
    try { await toggleBanner(b.id, !b.isActive); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete(b: HomeBanner) {
    if (!confirm("이 배너를 삭제할까요?")) return;
    setBusy(true);
    try { await deleteBanner(b.id); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/admin">‹</a>
        <div className="title">배너 관리</div>
        <div className="side" />
      </div>

      <div className="perm-guide" style={{ margin: "8px 20px" }}>
        노출 켠 배너들이 홈 상단에서 순서대로 자동으로 넘어가요.
      </div>

      {loading ? <Loading /> : (
        <>
          <div className="profile-list">
            {banners.length === 0 ? (
              <div className="daylist-empty" style={{ padding: 20 }}>등록된 배너가 없어요</div>
            ) : banners.map((b) => (
              <div key={b.id} className="banner-admin-row">
                <div className="banner-admin-main">
                  <div className="banner-admin-title">{b.emoji} {b.title}</div>
                  {b.subtitle && <div className="banner-admin-sub">{b.subtitle}</div>}
                  {b.linkUrl && <div className="banner-admin-link">→ {b.linkUrl}</div>}
                </div>
                <div className="banner-admin-actions">
                  <button className={`switch ${b.isActive ? "on" : ""}`} onClick={() => handleToggle(b)}>
                    <span className="knob" />
                  </button>
                  <button className="profile-del" disabled={busy} onClick={() => handleDelete(b)}>삭제</button>
                </div>
              </div>
            ))}
          </div>

          {adding ? (
            <div className="add-profile-form">
              <input className="input-field" placeholder="큰 문구 (필수)" value={title} onChange={(e) => setTitle(e.target.value)} />
              <input className="input-field" placeholder="작은 문구 (선택)" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
              <input className="input-field" placeholder="이모지 (선택, 예: 🎁)" value={emoji} onChange={(e) => setEmoji(e.target.value)} />
              <input className="input-field" placeholder="이동 링크 (선택, 예: /reservation)" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} />
              <div className="add-profile-actions">
                <button className="ghost-btn" onClick={() => { setAdding(false); setError(null); }}>취소</button>
                <button className="primary-btn" disabled={busy} onClick={() => handleAdd()}>추가하기</button>
              </div>
            </div>
          ) : (
            <button className="add-profile-btn" onClick={() => setAdding(true)}>+ 배너 추가</button>
          )}
        </>
      )}
    </div>
  );
}
