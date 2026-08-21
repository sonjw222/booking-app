"use client";

/*
  매니저 - 스태프 & 권한 관리
  - 스태프 탭: 초대(계정 검색), 역할 변경, 삭제
  - 권한 탭: 역할 선택 → 카테고리별 권한 체크 → 저장
    (권한 목록은 DB의 permissions 카탈로그를 읽어서 자동으로 그려짐)
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import UiIcon from "../../components/UiIcon";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchPermissions, fetchRoles, createRole, deleteRole,
  fetchRolePermissions, saveRolePermissions,
  fetchStaff, searchAccounts, inviteStaff, updateStaffRole, removeStaff,
  buildTree, togglePermission, CATEGORY_LABEL,
  fetchMyEffectivePermissionKeys, canSeeManagerMenu,
  type Permission, type Role, type Staff,
} from "../../../lib/roles";

type Tab = "staff" | "perm";

export default function StaffPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("staff");

  const [roles, setRoles] = useState<Role[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [perms, setPerms] = useState<Permission[]>([]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 권한 탭 상태
  const [activeRoleId, setActiveRoleId] = useState<string | null>(null);
  const [activeCat, setActiveCat] = useState<string>("facility");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);

  // 시트
  const [inviteSheet, setInviteSheet] = useState(false);
  const [searchKw, setSearchKw] = useState("");
  const [found, setFound] = useState<{ id: string; name: string; phone: string | null }[]>([]);
  const [inviteRoleId, setInviteRoleId] = useState<string>("");
  const [roleSheet, setRoleSheet] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [staffDetail, setStaffDetail] = useState<Staff | null>(null);
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }

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
      const [rs, st, ps] = await Promise.all([
        fetchRoles(centerId), fetchStaff(centerId), fetchPermissions(),
      ]);
      setRoles(rs); setStaff(st); setPerms(ps);
      // 오너가 아닌 첫 역할을 기본 선택 (오너는 모든 권한 자동 보유라 편집 불필요)
      const editable = rs.find((r) => !r.isOwner);
      if (editable && !activeRoleId) setActiveRoleId(editable.id);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId, activeRoleId]);

  useEffect(() => { load(); }, [load]);

  const activeCenter = centers.find((c) => c.id === centerId);

  // 이 화면 자체는 오너/매니저 누구나 열 수 있지만(메뉴 노출은 별도), 버튼별로
  // 실제 서버 권한(facility.staff.*, facility.role_permission)이 있는지 미리 계산해
  // 없는 버튼은 눌러도 RLS에 막힐 걸 미리 숨긴다 — 오너는 항상 전권.
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

  function canDo(key: string): boolean {
    return canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, key);
  }
  const canAddStaff = canDo("facility.staff.create");
  const canUpdateStaffRole = canDo("facility.staff.update");
  const canRemoveStaff = canDo("facility.staff.delete");
  const canManageRolePermissions = canDo("facility.role_permission");

  // 역할 바뀌면 그 역할의 권한 불러오기
  useEffect(() => {
    if (!activeRoleId) return;
    (async () => {
      try {
        const keys = await fetchRolePermissions(activeRoleId);
        setSelected(new Set(keys));
        setDirty(false);
      } catch (e: any) { setError(e.message); }
    })();
  }, [activeRoleId]);

  function handleToggle(key: string, checked: boolean) {
    setSelected((prev) => togglePermission(perms, prev, key, checked));
    setDirty(true);
  }

  function handleSelectAllInCat() {
    const keys = perms.filter((p) => p.category === activeCat).map((p) => p.key);
    setSelected((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      return next;
    });
    setDirty(true);
  }

  function handleDeselectAllInCat() {
    const keys = new Set(perms.filter((p) => p.category === activeCat).map((p) => p.key));
    setSelected((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.delete(k));
      return next;
    });
    setDirty(true);
  }

  async function handleSavePerms() {
    if (!activeRoleId) return;
    setBusy(true);
    try {
      await saveRolePermissions(activeRoleId, Array.from(selected));
      showToast("권한을 저장했어요");
      setDirty(false);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleSearch() {
    try { setFound(await searchAccounts(searchKw)); }
    catch (e: any) { setError(e.message); }
  }

  async function handleInvite(accountId: string) {
    if (!centerId || !inviteRoleId) { setError("역할을 선택해주세요"); return; }
    setBusy(true);
    try {
      await inviteStaff(centerId, accountId, inviteRoleId);
      showToast("스태프를 추가했어요");
      setInviteSheet(false); setSearchKw(""); setFound([]);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleChangeRole(roleId: string) {
    if (!staffDetail) return;
    setBusy(true);
    try {
      await updateStaffRole(staffDetail.id, roleId);
      showToast("역할을 변경했어요");
      setStaffDetail(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleRemoveStaff(s: Staff) {
    if (s.isOwner) { setError("오너는 삭제할 수 없어요"); return; }
    if (!confirm(`${s.name} 님을 스태프에서 제외할까요?`)) return;
    setBusy(true);
    try {
      await removeStaff(s.id);
      showToast("스태프를 제외했어요");
      setStaffDetail(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleCreateRole() {
    if (!centerId || !newRoleName.trim()) { setError("역할 이름을 입력해주세요"); return; }
    setBusy(true);
    try {
      await createRole(centerId, newRoleName.trim());
      setNewRoleName("");
      showToast("역할을 추가했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDeleteRole(r: Role) {
    if (r.isSystem) { setError("기본 역할은 삭제할 수 없어요"); return; }
    if (!confirm(`'${r.name}' 역할을 삭제할까요?`)) return;
    setBusy(true);
    try {
      await deleteRole(r.id);
      showToast("역할을 삭제했어요");
      if (activeRoleId === r.id) setActiveRoleId(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">스태프 & 권한</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  const activeRole = roles.find((r) => r.id === activeRoleId) ?? null;
  const tree = buildTree(perms, activeCat);

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">스태프 & 권한</div>
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

      <div className="perm-tabs">
        <button className={`perm-tab ${tab === "staff" ? "on" : ""}`} onClick={() => setTab("staff")}>스태프</button>
        <button className={`perm-tab ${tab === "perm" ? "on" : ""}`} onClick={() => setTab("perm")}>역할별 권한</button>
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {loading ? (
        <Loading />
      ) : tab === "staff" ? (
        /* ---------- 스태프 탭 ---------- */
        <>
          <div className="mem-toolbar">
            <span className="mem-count">스태프 {staff.length}명</span>
            {canAddStaff && (
              <button className="quiet-action" onClick={() => { setInviteSheet(true); setInviteRoleId(roles.find((r) => !r.isOwner)?.id ?? ""); }}>
                스태프 추가
              </button>
            )}
          </div>

          <div className="mem-list">
            {[...staff].sort((a, b) => {
              const ownerOrder = Number(b.isOwner) - Number(a.isOwner);
              if (ownerOrder) return ownerOrder;
              const aRank = roles.findIndex((r) => r.id === a.roleId);
              const bRank = roles.findIndex((r) => r.id === b.roleId);
              return (aRank < 0 ? Number.MAX_SAFE_INTEGER : aRank) - (bRank < 0 ? Number.MAX_SAFE_INTEGER : bRank);
            }).map((s) => (
              <button key={s.id} className="mem-row" onClick={() => setStaffDetail(s)}>
                <div className="mem-main">
                  <div className="mem-name-line">
                    <span className="mem-name">{s.name}</span>
                    {s.roleName && <span className={`grade-badge staff-role ${s.isOwner ? "owner" : ""}`}>{s.roleName}</span>}
                    {s.status === "pending" && <span className="mem-flag">승인대기</span>}
                  </div>
                  <div className="mem-sub">{s.phone ?? "번호 없음"}</div>
                </div>
                <span className="chevron">›</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        /* ---------- 권한 탭 ---------- */
        <>
          <div className="mem-toolbar">
            <span className="mem-count">역할을 선택하세요</span>
            {canManageRolePermissions && (
              <button className="quiet-action" onClick={() => setRoleSheet(true)}>역할 관리</button>
            )}
          </div>

          <div className="mem-filters">
            {roles.map((r) => (
              <button
                key={r.id}
                className={`filter-chip ${activeRoleId === r.id ? "on" : ""}`}
                onClick={() => setActiveRoleId(r.id)}
              >
                {r.name}
              </button>
            ))}
          </div>

          {activeRole?.isOwner ? (
            <div className="daylist-empty" style={{ paddingTop: 30 }}>
              스튜디오 오너는 모든 권한을 가져요<br />
              <span style={{ fontSize: 12 }}>권한 설정이 필요 없습니다</span>
            </div>
          ) : !activeRoleId ? (
            <div className="daylist-empty" style={{ paddingTop: 30 }}>역할을 선택해주세요</div>
          ) : (
            <>
              {/* 카테고리 탭 */}
              <div className="mem-filters">
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                  <button key={k} className={`filter-chip ${activeCat === k ? "on" : ""}`} onClick={() => setActiveCat(k)}>
                    {v}
                  </button>
                ))}
              </div>

              {!canManageRolePermissions && (
                <div className="perm-guide" style={{ margin: "0 0 6px" }}>
                  권한 편집 권한이 없어요 — 오너에게 문의하세요.
                </div>
              )}
              <div className="perm-actions">
                <div className="perm-bulk">
                  <button className="text-btn" disabled={!canManageRolePermissions} onClick={handleSelectAllInCat}>이 탭 모두 선택</button>
                  <button className="text-btn" disabled={!canManageRolePermissions} onClick={handleDeselectAllInCat}>모두 해제</button>
                </div>
                <button className="primary-btn small" disabled={busy || !dirty || !canManageRolePermissions} onClick={handleSavePerms}>
                  {busy ? "저장 중..." : dirty ? "저장" : "저장됨"}
                </button>
              </div>

              <div className="perm-list">
                {tree.length === 0 ? (
                  <div className="daylist-empty" style={{ paddingTop: 20 }}>이 카테고리에 권한이 없어요</div>
                ) : (
                  tree.map((p) => (
                    <div key={p.key} className="perm-group">
                      <label className="perm-item">
                        <input
                          type="checkbox"
                          disabled={!canManageRolePermissions}
                          checked={selected.has(p.key)}
                          onChange={(e) => handleToggle(p.key, e.target.checked)}
                        />
                        <div className="perm-text">
                          <div className="perm-label">{p.label}</div>
                          {p.description && <div className="perm-desc">{p.description}</div>}
                        </div>
                      </label>

                      {p.children.length > 0 && (
                        <div className="perm-children">
                          {p.children.map((c) => (
                            <label key={c.key} className="perm-item child">
                              <input
                                type="checkbox"
                                disabled={!canManageRolePermissions}
                                checked={selected.has(c.key)}
                                onChange={(e) => handleToggle(c.key, e.target.checked)}
                              />
                              <div className="perm-text">
                                <div className="perm-label">{c.label}</div>
                                {c.description && <div className="perm-desc">{c.description}</div>}
                              </div>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* 스태프 추가 시트 */}
      {inviteSheet && (
        <div className="sheet-overlay" onClick={() => setInviteSheet(false)}>
          <div className="sheet staff-invite-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">스태프 추가</div>
            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>이미 가입한 계정을 검색해서 추가해요</div>

            <div className="staff-search-row">
              <input
                className="input-field"
                placeholder="이름 또는 전화번호"
                value={searchKw}
                onChange={(e) => setSearchKw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              />
              <button className="outline-action" onClick={handleSearch}>검색</button>
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>역할</div>
            <div className="mem-filters" style={{ padding: 0 }}>
              {roles.filter((r) => !r.isOwner).map((r) => (
                <button key={r.id} className={`filter-chip ${inviteRoleId === r.id ? "on" : ""}`} onClick={() => setInviteRoleId(r.id)}>
                  {r.name}
                </button>
              ))}
            </div>

            {found.length > 0 && (
              <>
                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>검색 결과</div>
                <div className="grade-list">
                  {found.map((a) => (
                    <div key={a.id} className="grade-item">
                      <span className="grade-name">{a.name} <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{a.phone}</span></span>
                      <button className="text-btn" disabled={busy} onClick={() => handleInvite(a.id)}>추가</button>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="add-profile-actions">
              <button className="ghost-btn" onClick={() => setInviteSheet(false)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* 스태프 상세 시트 */}
      {staffDetail && (
        <div className="sheet-overlay" onClick={() => setStaffDetail(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{staffDetail.name}</div>
            <div className="admin-row"><span className="k">전화</span><span className="v">{staffDetail.phone ?? "-"}</span></div>
            <div className="admin-row"><span className="k">현재 역할</span><span className="v">{staffDetail.roleName ?? "없음"}</span></div>

            {!staffDetail.isOwner && canUpdateStaffRole && (
              <>
                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>역할 변경</div>
                <div className="mem-filters" style={{ padding: 0 }}>
                  {roles.filter((r) => !r.isOwner).map((r) => (
                    <button key={r.id} className={`filter-chip ${staffDetail.roleId === r.id ? "on" : ""}`} disabled={busy} onClick={() => handleChangeRole(r.id)}>
                      {r.name}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="add-profile-actions">
              <button className="ghost-btn" onClick={() => setStaffDetail(null)}>닫기</button>
              {!staffDetail.isOwner && canRemoveStaff && (
                <button className="danger-btn" disabled={busy} onClick={() => handleRemoveStaff(staffDetail)}>스태프 제외</button>
              )}
            </div>

            {!staffDetail.isOwner && staffDetail.roleId && canManageRolePermissions && (
              <a
                className="list-row"
                href={`/manager/staff/permissions?mc=${staffDetail.id}&role=${staffDetail.roleId}&name=${encodeURIComponent(staffDetail.name)}&center=${centerId}`}
                style={{ marginTop: 8 }}
              >
                <div className="left"><span className="icon"><UiIcon name="settings" /></span>개인 권한 설정 (역할 예외)</div>
                <span className="chevron">›</span>
              </a>
            )}
          </div>
        </div>
      )}

      {/* 역할 관리 시트 */}
      {roleSheet && (
        <div className="sheet-overlay" onClick={() => setRoleSheet(false)}>
          <div className="sheet role-manage-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">역할 관리</div>

            <div className="grade-list">
              {roles.map((r) => (
                <div key={r.id} className="grade-item">
                  <span className="grade-name">
                    {r.name}
                    {r.isSystem && <span style={{ color: "var(--text-dim)", fontSize: 11, marginLeft: 6 }}>기본</span>}
                  </span>
                  {!r.isSystem && canManageRolePermissions && (
                    <button className="text-btn danger" disabled={busy} onClick={() => handleDeleteRole(r)}>삭제</button>
                  )}
                </div>
              ))}
            </div>

            {canManageRolePermissions && (
              <>
                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>새 역할 추가</div>
                <input className="input-field" placeholder="역할 이름 (예: 데스크)" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} />
              </>
            )}

            <div className="add-profile-actions">
              <button className="ghost-btn" onClick={() => setRoleSheet(false)}>닫기</button>
              {canManageRolePermissions && (
                <button className="outline-action" disabled={busy} onClick={handleCreateRole}>추가</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
