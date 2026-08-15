"use client";

/*
  매니저 - 상품 관리 (대여·물품)
  - 피겨화 대여 같은 상품. 수강권과 별개.
  - 무제한(대여권) 또는 횟수제한(5회권처럼) 선택
  - 회원이 수업 예약 시 이 상품을 같이 선택해 차감할 수 있음 (횟수제한인 경우)
  - 수강권 관리 권한(pass.update) 필요
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchProducts, createProduct, updateProduct, deleteProduct, won, type Product } from "../../../lib/passes";

export default function GoodsPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [sheet, setSheet] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [pName, setPName] = useState("");
  const [pPrice, setPPrice] = useState("");
  const [unlimited, setUnlimited] = useState(false);
  const [pCount, setPCount] = useState("");
  const [pDesc, setPDesc] = useState("");
  const [pSizes, setPSizes] = useState("");

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchMyCenters();
        setCenters(list);
        if (list.length > 0) setCenterId(list[0].id);
        else setLoading(false);
      } catch (e: any) { setError(e.message); setLoading(false); }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      setProducts(await fetchProducts(centerId, "goods"));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  const num = (s: string) => parseInt(s.replace(/[^0-9]/g, "") || "0", 10);

  async function handleCreate() {
    if (!centerId || !pName.trim()) { setError("상품 이름을 입력해주세요"); return; }
    if (!unlimited && num(pCount) === 0) { setError("횟수를 입력해주세요"); return; }
    setBusy(true);
    try {
      const sizeArr = pSizes.split(",").map((s) => s.trim()).filter(Boolean);
      if (editId) {
        await updateProduct(editId, pName.trim(), num(pPrice), num(pCount), unlimited, { description: pDesc.trim(), sizes: sizeArr });
      } else {
        await createProduct(centerId, pName.trim(), num(pPrice), num(pCount), "goods", unlimited, { description: pDesc.trim(), sizes: sizeArr });
      }
      setPName(""); setPPrice(""); setPCount(""); setUnlimited(false); setPDesc(""); setPSizes("");
      setSheet(false);
      showToast(editId ? "상품을 수정했어요" : "상품을 추가했어요");
      setEditId(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  function openEdit(p: Product) {
    setEditId(p.id);
    setPName(p.name);
    setPPrice(String(p.price ?? ""));
    setPCount(String(p.totalCount ?? ""));
    setUnlimited(p.unlimited);
    setPDesc(p.description ?? "");
    setPSizes((p.sizes ?? []).join(", "));
    setSheet(true);
  }

  function openCreate() {
    setEditId(null);
    setPName(""); setPPrice(""); setPCount(""); setUnlimited(false); setPDesc(""); setPSizes("");
    setSheet(true);
  }

  async function handleDelete(p: Product) {
    if (!confirm(`'${p.name}' 상품을 삭제할까요?`)) return;
    setBusy(true);
    try { await deleteProduct(p.id); showToast("삭제했어요"); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">상품 관리</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">상품 관리</div>
        <button className="header-action" onClick={openCreate}>+ 상품</button>
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="perm-guide">
        피겨화 대여 같은 물품·대여 상품이에요. 수강권과 별개예요.
        무제한 또는 횟수제한(예: 5회권)으로 만들 수 있고, 횟수제한 상품은
        회원이 수업 예약 때 같이 선택해 차감할 수 있어요.
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {loading ? (
        <Loading />
      ) : products.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 30 }}>
          등록된 상품이 없어요<br />
          <span style={{ fontSize: 12 }}>우측 상단 &apos;+ 상품&apos;으로 추가하세요</span>
        </div>
      ) : (
        <div className="pass-list">
          {products.map((p) => (
            <div key={p.id} className="pass-card">
              <div className="pass-head">
                <div>
                  <div className="pass-name">{p.name}</div>
                  <div className="pass-sub">
                    {won(p.price)} · {p.unlimited ? "무제한" : `${p.totalCount ?? 0}회`}
                  </div>
                </div>
                <button className="text-btn" onClick={() => openEdit(p)}>수정</button>
                <button className="text-btn danger" disabled={busy} onClick={() => handleDelete(p)}>삭제</button>
              </div>
            </div>
          ))}
          <div style={{ height: 40 }} />
        </div>
      )}

      {/* 상품 추가 시트 */}
      {sheet && (
        <div className="sheet-overlay" onClick={() => setSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{editId ? "상품 수정" : "상품 추가"}</div>

            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>상품 이름</div>
            <input className="input-field" placeholder="예: 피겨화 대여" value={pName} onChange={(e) => setPName(e.target.value)} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>가격</div>
            <input inputMode="numeric" className="input-field" placeholder="0" value={pPrice} onChange={(e) => setPPrice(e.target.value)} />

            <div className="set-row" style={{ padding: "14px 0 6px", borderBottom: "none" }}>
              <div className="set-label">횟수 제한 없음 (무제한)</div>
              <button className={`switch ${unlimited ? "on" : ""}`} onClick={() => setUnlimited(!unlimited)}>
                <span className="knob" />
              </button>
            </div>

            {!unlimited && (
              <>
                <div className="menu-section-label" style={{ padding: "6px 0 6px" }}>총 횟수 (예: 5회권 → 5)</div>
                <input inputMode="numeric" className="input-field" placeholder="예: 5" value={pCount} onChange={(e) => setPCount(e.target.value)} />
              </>
            )}

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>상세 설명 (선택)</div>
            <textarea className="input-field" style={{ minHeight: 70, resize: "vertical", lineHeight: 1.5 }}
              placeholder="상품 설명 (회원이 이름을 누르면 보여요)" value={pDesc} onChange={(e) => setPDesc(e.target.value)} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>사이즈 (선택, 쉼표로 구분)</div>
            <input className="input-field" placeholder="예: 230, 240, 250, 260" value={pSizes} onChange={(e) => setPSizes(e.target.value)} />
            <div className="perm-guide" style={{ margin: "4px 0 0" }}>
              대여화·의류처럼 사이즈가 있으면 입력하세요. 회원이 구매 시 사이즈를 선택해요.
            </div>

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => { setSheet(false); setEditId(null); }}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleCreate}>{editId ? "수정" : "추가"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
