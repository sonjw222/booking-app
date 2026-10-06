"use client";

/*
  매니저 - 진도표 기술 목록 관리 (1단계)
  - 대분류 추가/삭제/이름수정 (예: 점프, 스핀, 스텝)
  - 분류(category)를 최대 7단계까지 중첩하고(accordion 접기/펼치기), 각 분류에 "하위 분류"와 "기술(skill)"을 명시적으로 구분해 추가/삭제
    (예: 점프 › 싱글 점프 › 엣지 점프 › [왈츠, 살코]). 기술은 분류 아래 말단이고 진도 기록은 기술에만 한다.
  - 진도표 관리 권한(customer.progress) 필요
*/

import Link from "next/link";
import React, { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchCategories, addTopCategory, addSubCategory, addSkill, renameCategory, deleteCategory,
} from "../../../lib/progress";
import {
  buildTree, canAddSkill, canAddSubCategory, countDescendants, flattenTree, indentLevel, MAX_PROGRESS_DEPTH, type TreeNode,
} from "../../../lib/progressTree";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../../lib/roles";

import { toUserMessage } from "../../../lib/userError";
export default function ProgressCategoryPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 입력 상태
  const [newTop, setNewTop] = useState("");
  const [subInput, setSubInput] = useState<Record<string, string>>({});     // 분류 id → 하위 분류 이름 입력값
  const [skillInput, setSkillInput] = useState<Record<string, string>>({});   // 분류 id → 기술 이름 입력값
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});     // 접기/펼치기(accordion) — 입력값(subInput)은 접어도 유지된다
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchMyCenters();
        setCenters(list);
        if (list.length > 0) setCenterId(list[0].id);
        else setLoading(false);
      } catch (e: any) { setError(toUserMessage(e)); setLoading(false); }
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
      .catch((e) => { if (!cancelled) setError(toUserMessage(e)); });
    return () => { cancelled = true; };
  }, [activeCenter]);

  // 이 화면의 CRUD 전체가 customer.progress 단일 키로 묶여있다(세분화된 키 없음).
  const canManageProgress = canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, "customer.progress");

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      const cats = await fetchCategories(centerId);
      setTree(buildTree(cats));
    } catch (e: any) { setError(toUserMessage(e)); }
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
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setBusy(false); }
  }

  async function handleAddSub(parent: TreeNode) {
    const name = (subInput[parent.id] ?? "").trim();
    if (!centerId || !name) { setError("하위 분류 이름을 입력해주세요"); return; }
    if (!canAddSubCategory(parent)) { setError(`분류는 최대 ${MAX_PROGRESS_DEPTH}단계까지 만들 수 있어요`); return; }
    setBusy(true);
    try {
      await addSubCategory(centerId, parent.id, name, parent.children.filter((c) => c.nodeType === "category").length);
      setSubInput((p) => ({ ...p, [parent.id]: "" }));
      setExpanded((p) => ({ ...p, [parent.id]: true }));   // 추가한 항목이 바로 보이도록 펼친 채 유지
      showToast("하위 분류를 추가했어요");
      await load();
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setBusy(false); }
  }

  async function handleAddSkill(parent: TreeNode) {
    const name = (skillInput[parent.id] ?? "").trim();
    if (!centerId || !name) { setError("기술 이름을 입력해주세요"); return; }
    if (!canAddSkill(parent)) return;
    setBusy(true);
    try {
      await addSkill(centerId, parent.id, name, parent.children.filter((c) => c.nodeType === "skill").length);
      setSkillInput((p) => ({ ...p, [parent.id]: "" }));
      setExpanded((p) => ({ ...p, [parent.id]: true }));
      showToast("기술을 추가했어요");
      await load();
    } catch (e: any) { setError(toUserMessage(e)); }
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
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setBusy(false); }
  }

  async function handleDelete(id: string, name: string, hasChildren: boolean) {
    const msg = hasChildren
      ? `'${name}'과(와) 그 안의 하위 분류·기술이 모두 삭제됩니다. 계속할까요?`
      : `'${name}'을(를) 삭제할까요?`;
    if (!(await globalThis.appConfirm(msg))) return;
    setBusy(true);
    try {
      await deleteCategory(id);
      showToast("삭제했어요");
      await load();
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setBusy(false); }
  }

  // 재귀 렌더: 최상위 분류는 카드(.prog-group), 하위 분류/기술은 같은 행 규격(.ptree-row)으로 들여쓰기 상한(4단계)까지만 밀고 이후는 깊이 배지로 구분한다.
  // 분류 행에는 chevron(accordion), 기술 행에는 chevron이 없다(기록 가능한 최종 항목). 분류 안에서는 하위 분류 → 기술 순으로 보여준다.
  function renderNode(node: TreeNode): React.ReactNode {
    const indent = { paddingLeft: `calc(14px + ${indentLevel(node.depth) * 12}px)` };
    if (node.nodeType === "skill") {
      return (
        <div key={node.id} className="ptree-node">
          <div className="ptree-row ptree-skill" style={indent}>
            <span className="ptree-skill-main"><span className="ptree-name">{node.name}</span><span className="ptree-tag">기술</span></span>
            {canManageProgress && (
              <div className="ptree-actions">
                <button className="quiet-action" onClick={() => handleRename(node.id, node.name)}>수정</button>
                <button className="quiet-action danger" onClick={() => handleDelete(node.id, node.name, false)}>삭제</button>
              </div>
            )}
          </div>
        </div>
      );
    }
    const hasKids = node.children.length > 0;
    const open = !!expanded[node.id];
    const typing = (subInput[node.id] ?? "").trim().length > 0 || (skillInput[node.id] ?? "").trim().length > 0;
    const panelId = `ptree-${node.id}`;
    const subs = node.children.filter((c) => c.nodeType === "category");
    const skills = node.children.filter((c) => c.nodeType === "skill");
    const rowCommon = (
      <>
        <button
          type="button"
          className="ptree-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${node.name} ${open ? "접기" : "펼치기"}`}
          onClick={() => setExpanded((p) => ({ ...p, [node.id]: !p[node.id] }))}
        >
          <span className={`ptree-chevron${open ? " open" : ""}`} aria-hidden="true">›</span>
          <span className="ptree-name">{node.name}</span>
          {hasKids && <span className="ptree-count">{countDescendants(node)}</span>}
          {node.catDepth > 4 && <span className="ptree-lv">Lv {node.catDepth}</span>}
          {!open && typing && <span className="ptree-typing" title="입력 중인 내용이 있어요">입력 중</span>}
        </button>
        {canManageProgress && (
          <div className="ptree-actions">
            <button className="quiet-action" onClick={() => handleRename(node.id, node.name)}>수정</button>
            <button className="quiet-action danger" onClick={() => handleDelete(node.id, node.name, hasKids)}>삭제</button>
          </div>
        )}
      </>
    );
    const addPad = { paddingLeft: `calc(14px + ${indentLevel(node.depth + 1) * 12}px)` };
    const panel = open && (
      <div id={panelId} className="ptree-panel">
        {subs.map((c) => renderNode(c))}
        {skills.map((c) => renderNode(c))}
        {canManageProgress && (
          <>
            {canAddSubCategory(node) ? (
              <div className="ptree-add" style={addPad}>
                <input
                  className="input-field"
                  aria-label={`${node.name} 하위 분류 이름`}
                  placeholder="하위 분류 이름"
                  value={subInput[node.id] ?? ""}
                  onChange={(e) => setSubInput((p) => ({ ...p, [node.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && handleAddSub(node)}
                />
                <button className="outline-action" disabled={busy} onClick={() => handleAddSub(node)}>하위 분류 추가</button>
              </div>
            ) : (
              <div className="ptree-add" style={addPad}>
                <span className="ptree-max">분류는 최대 {MAX_PROGRESS_DEPTH}단계라 하위 분류를 더 만들 수 없어요</span>
                <button className="outline-action" disabled>하위 분류 추가</button>
              </div>
            )}
            <div className="ptree-add" style={addPad}>
              <input
                className="input-field"
                aria-label={`${node.name} 기술 이름`}
                placeholder="기술 이름"
                value={skillInput[node.id] ?? ""}
                onChange={(e) => setSkillInput((p) => ({ ...p, [node.id]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && handleAddSkill(node)}
              />
              <button className="outline-action" disabled={busy} onClick={() => handleAddSkill(node)}>기술 추가</button>
            </div>
          </>
        )}
      </div>
    );
    if (node.depth === 1) {
      return (
        <div key={node.id} className="prog-group ptree-group">
          <div className="ptree-row ptree-top">{rowCommon}</div>
          {panel}
        </div>
      );
    }
    return (
      <div key={node.id} className="ptree-node">
        <div className="ptree-row" style={indent}>{rowCommon}</div>
        {panel}
      </div>
    );
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <Link className="side" href="/manager" prefetch={false}>‹</Link>
          <div className="title">진도표 기술 목록</div>
          <div className="side" />
        </div>
        <div className="daylist-empty daylist-empty--page">운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <Link className="side" href="/manager/progress/record" prefetch={false}>‹</Link>
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
        회원 진도를 기록할 <b>기술 목록</b>을 만들어요. <b>분류</b>(예: 점프)는 최대 7단계까지 겹쳐 만들 수 있고,
        각 분류 안에 <b>기술</b>(예: 왈츠)을 추가해요. 진도는 기술에만 기록할 수 있어요.
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
            <div className="daylist-empty daylist-empty--sm">
              아직 기술이 없어요<br />
              <span style={{ fontSize: 12 }}>위에서 분류부터 추가해보세요</span>
            </div>
          ) : (
            <>
              <div className="ptree-toolbar">
                <button type="button" className="quiet-action" onClick={() => setExpanded(Object.fromEntries(flattenTree(tree).filter((n) => n.nodeType === "category").map((n) => [n.id, true])))}>모두 펼치기</button>
                <button type="button" className="quiet-action" onClick={() => setExpanded({})}>모두 접기</button>
              </div>
              {tree.map((top) => renderNode(top))}
            </>
          )}

          <div style={{ height: 40 }} />
        </div>
      )}
    </div>
  );
}
