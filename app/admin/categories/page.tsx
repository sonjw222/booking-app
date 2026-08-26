"use client";

/*
  운영자 - 종목 관리
  - 홈에 뜨는 종목(카테고리) 추가/삭제
*/

import { useCallback, useEffect, useState } from "react";
import { fetchCategories, addCategory, deleteCategory, type ServiceCategory } from "../../../lib/operator";
import { checkPlatformAdmin } from "../../../lib/admin";
import Loading from "../../components/Loading";

export default function CategoriesPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [cats, setCats] = useState<ServiceCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [emoji, setEmoji] = useState("");

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2000); }

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setCats(await fetchCategories()); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    (async () => {
      const admin = await checkPlatformAdmin();
      setIsAdmin(admin);
      if (admin) await load();
      else setLoading(false);
    })();
  }, [load]);

  async function handleAdd() {
    if (!label.trim()) { setError("종목 이름을 입력해주세요"); return; }
    setBusy(true);
    try {
      await addCategory(label.trim(), emoji.trim());
      setLabel(""); setEmoji("");
      showToast("종목을 추가했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete(c: ServiceCategory) {
    if (!(await globalThis.appConfirm(`'${c.label}' 종목을 삭제할까요?`))) return;
    setBusy(true);
    try { await deleteCategory(c.id); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (isAdmin === false) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/admin">‹</a>
          <div className="title">종목 관리</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>
          플랫폼 운영자만 접근할 수 있는 화면이에요
        </div>
      </div>
    );
  }

  if (isAdmin === null || loading) {
    return (
      <div className="app-shell">
        <Loading />
      </div>
    );
  }

  return (
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/admin">‹</a>
        <div className="title">종목 관리</div>
        <div className="side" />
      </div>

      <div className="hol-add" style={{ padding: "8px 20px 4px" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="input-field" style={{ width: 64 }} placeholder="🏷️" value={emoji} onChange={(e) => setEmoji(e.target.value)} />
          <input className="input-field" placeholder="종목 이름 (예: 클라이밍)" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAdd()} />
          <button className="primary-btn small" disabled={busy} onClick={() => handleAdd()}>추가</button>
        </div>
      </div>

      {loading ? <Loading /> : cats.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 40 }}>등록된 종목이 없어요</div>
      ) : (
        <div className="profile-list">
          {cats.map((c) => (
            <div key={c.id} className="profile-item">
              <div className="profile-item-info">
                <div className="profile-item-name">{c.emoji} {c.label}</div>
              </div>
              <button className="profile-del" disabled={busy} onClick={() => handleDelete(c)}>삭제</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
