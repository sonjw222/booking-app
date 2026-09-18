"use client";

/*
  운영자 - 종목 관리
  - 홈에 뜨는 종목(카테고리) 추가/삭제
*/

import { useCallback, useEffect, useState } from "react";
import { fetchCategories, addCategory, deleteCategory, type ServiceCategory } from "../../../lib/operator";
import { checkPlatformAdmin } from "../../../lib/admin";
import Loading from "../../components/Loading";
import CategoryIcon from "../../components/categoryIcons";

export default function CategoriesPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [cats, setCats] = useState<ServiceCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");

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
      // 릴리스 폴리시 배치 8차(2026-09-18), 5번 — 이모지 표시를 없애면서 입력도 함께
      // 없앴다(더 이상 쓸 곳이 없는 입력 남겨두면 혼란). DB의 emoji 컬럼 자체는 손대지
      // 않는다(불필요한 마이그레이션 금지) — 그냥 빈 값으로 저장, 화면은 categoryIconFor()가
      // 이름으로 매핑한 아이콘만 보여준다.
      await addCategory(label.trim(), "");
      setLabel("");
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

      {/* 릴리스 폴리시 배치 8차(2026-09-18), 5번 — 이모지 입력 제거, "추가" 버튼을 입력과
          수직 중앙 정렬(.cat-add-row). 버튼 자체 크기(padding/font)는 안 바꿨다 — 기존
          .primary-btn.small 그대로, row 레벨에서 align-items:center + input의 기본
          margin-bottom만 이 컨텍스트에서 0으로 상쇄(app/globals.css). */}
      <div className="hol-add" style={{ padding: "8px 20px 4px" }}>
        <div className="cat-add-row">
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
              {/* 5번 — 이모지(c.emoji) 대신 홈 화면과 같은 출처의 아이콘/이미지
                  (CategoryIcon, app/components/categoryIcons.tsx)를 재사용. 이미지 로드
                  실패 시 자동으로 UiIcon 아이콘으로 대체돼 레이아웃이 깨지지 않는다. */}
              <div className="cat-row-icon"><CategoryIcon label={c.label} size={26} /></div>
              <div className="profile-item-info">
                <div className="profile-item-name">{c.label}</div>
              </div>
              <button className="profile-del" disabled={busy} onClick={() => handleDelete(c)}>삭제</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
