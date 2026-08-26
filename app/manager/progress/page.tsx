"use client";

/*
  매니저 - 진도표 기술 목록 관리 (1단계)
  - 대분류 추가/삭제/이름수정 (예: 점프, 스핀, 스텝)
  - 대분류 밑에 세부기술 추가/삭제 (예: 왈츠점프, 살코)
  - 진도표 관리 권한(customer.progress) 필요
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchCategories, buildCategoryTree,
  addTopCategory, addSubCategory, renameCategory, deleteCategory,
  type CategoryNode,
} from "../../../lib/progress";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../../lib/roles";

export default function ProgressCategoryPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [tree, setTree] = useState<CategoryNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 입력 상태
  const [newTop, setNewTop] = useState("");
  const [subInput, setSubInput] = useState<Record<string, string>>({});   // parentId → 입력값
  const [openSub, setOpenSub] = useState<Record<string, boolean>>({});     // 세부기술 입력창 열림
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);

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

  const activeCenter = centers.find((c) => c.id === centerId);

  useEffect(() => {
    if (!activeCenter) return;
    if (activeCenter.isOwner) { setMyPerms(null); return; }
    let cancelled = false;
    setMyPerms(null);
    fetchMyEffectivePermissionKeys(activeCenter.managerCenterId, activeCenter.roleId)
      .then((keys) => { if (!cancelled) setMyPerms(keys); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [activeCenter]);

  // 이 화면의 CRUD 전체가 customer.progress 단일 키로 묶여있다(세분화된 키 없음).
  const canManageProgress = canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, "customer.progress");

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      const cats = await fetchCategories(centerId);
      setTree(buildCategoryTree(cats));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  async function handleAddTop() {
    if (!centerId || !newTop.trim()) { setError("대분류 이름을 입력해주세요"); return; }
    setBusy(true);
    try {
      await addTopCategory(centerId, newTop.trim(), tree.length);
      setNewTop("");
      showToast("대분류를 추가했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleAddSub(parentId: string, childCount: number) {
    const name = (subInput[parentId] ?? "").trim();
    if (!centerId || !name) { setError("세부기술 이름을 입력해주세요"); return; }
    setBusy(true);
    try {
      await addSubCategory(centerId, parentId, name, childCount);
      setSubInput((p) => ({ ...p, [parentId]: "" }));
      showToast("세부기술을 추가했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleRename(id: string, current: string) {
    const name = prompt("새 이름을 입력하세요", current);
    if (name === null || !name.trim() || name.trim() === current) return;
    setBusy(true);
    try {
      await renameCategory(id, name.trim());
      showToast("이름을 바꿨어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete(id: string, name: string, hasChildren: boolean) {
    const msg = hasChildren
      ? `'${name}'과(와) 하위 세부기술이 모두 삭제됩니다. 계속할까요?`
      : `'${name}'을(를) 삭제할까요?`;
    if (!(await globalThis.appConfirm(msg))) return;
    setBusy(true);
    try {
      await deleteCategory(id);
      showToast("삭제했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">진도표 기술 목록</div>
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
        <a className="side" href="/manager/progress/record">‹</a>
        <div className="title">진도표 기술 목록</div>
        <div className="side" />
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
        회원 진도를 기록할 <b>기술 목록</b>을 만들어요. 대분류(예: 점프) 아래에
        세부기술(예: 왈츠점프)을 넣는 2단계 구조예요.
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {loading ? (
        <Loading />
      ) : (
        <div className="prog-wrap">
          {/* 대분류 추가 */}
          {canManageProgress ? (
            <div className="prog-add-top structured-add-row">
              <input
                className="input-field"
                placeholder="대분류 추가 (예: 점프, 스핀, 스텝)"
                value={newTop}
                onChange={(e) => setNewTop(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTop()}
              />
              <button className="outline-action" disabled={busy} onClick={handleAddTop}>추가</button>
            </div>
          ) : (
            <div className="perm-guide">진도표 관리 권한이 없어요 — 오너에게 문의하세요.</div>
          )}

          {tree.length === 0 ? (
            <div className="daylist-empty" style={{ paddingTop: 30 }}>
              아직 기술이 없어요<br />
              <span style={{ fontSize: 12 }}>위에서 대분류부터 추가해보세요</span>
            </div>
          ) : (
            tree.map((top) => (
              <div key={top.id} className="prog-group">
                <div className="prog-top-row">
                  <span className="prog-top-name">{top.name}</span>
                  {canManageProgress && (
                    <div className="prog-top-actions row-actions">
                      <button className="quiet-action" onClick={() => handleRename(top.id, top.name)}>수정</button>
                      <button className="quiet-action danger" onClick={() => handleDelete(top.id, top.name, top.children.length > 0)}>삭제</button>
                    </div>
                  )}
                </div>

                {/* 세부기술 목록 */}
                <div className="prog-children">
                  {top.children.map((c) => (
                    <div key={c.id} className="prog-sub-row">
                      <span className="prog-sub-name">{c.name}</span>
                      {canManageProgress && (
                        <div className="prog-top-actions row-actions">
                          <button className="quiet-action" onClick={() => handleRename(c.id, c.name)}>수정</button>
                          <button className="quiet-action danger" onClick={() => handleDelete(c.id, c.name, false)}>삭제</button>
                        </div>
                      )}
                    </div>
                  ))}

                  {/* 세부기술 추가 */}
                  {!canManageProgress ? null : openSub[top.id] ? (
                    <div className="prog-sub-add">
                      <input
                        className="input-field"
                        placeholder="세부기술 이름 (예: 왈츠점프)"
                        value={subInput[top.id] ?? ""}
                        onChange={(e) => setSubInput((p) => ({ ...p, [top.id]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && handleAddSub(top.id, top.children.length)}
                      />
                      <button className="outline-action" disabled={busy} onClick={() => handleAddSub(top.id, top.children.length)}>추가</button>
                    </div>
                  ) : (
                    <button className="prog-add-sub-btn" onClick={() => setOpenSub((p) => ({ ...p, [top.id]: true }))}>
                      + 세부기술 추가
                    </button>
                  )}
                </div>
              </div>
            ))
          )}

          <div style={{ height: 40 }} />
        </div>
      )}
    </div>
  );
}
