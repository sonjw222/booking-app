"use client";

/*
  매니저 - 개인별 권한 설정
  - 특정 스태프(manager_centers.id)의 권한을 역할 위에 덮어쓰기
  - 각 권한은 3상태: 역할따름 / 허용추가(allow) / 차단(deny)
  - 오너만 접근 (facility.role_permission 권한)
  - URL: /manager/staff/permissions?mc=<manager_center_id>&role=<role_id>&name=<이름>
*/

import { useCallback, useEffect, useState, Suspense } from "react";
import Loading from "../../../components/Loading";
import { useSearchParams } from "next/navigation";
import { fetchMyCenters, isOwnerOfCenter } from "../../../../lib/manager";
import {
  fetchPermissions, fetchRolePermissions,
  fetchStaffOverrides, setStaffOverride,
  buildTree, effectiveState, CATEGORY_LABEL,
  type Permission, type GrantType, type EffectiveState,
} from "../../../../lib/roles";

function PermInner() {
  const params = useSearchParams();
  const mcId = params.get("mc");
  const roleId = params.get("role");
  const centerId = params.get("center");
  const staffName = params.get("name") ?? "스태프";

  const [perms, setPerms] = useState<Permission[]>([]);
  const [rolePermKeys, setRolePermKeys] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, GrantType>>({});
  const [activeCat, setActiveCat] = useState("facility");
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // null = 확인중, false = 오너 아님(또는 이 센터 소속 아님), true = 오너 확인됨
  const [isOwner, setIsOwner] = useState<boolean | null>(null);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2000); }

  const load = useCallback(async () => {
    if (!mcId || !roleId || !centerId) { setError("잘못된 접근이에요"); setLoading(false); setIsOwner(false); return; }
    setLoading(true);
    try {
      const myCenters = await fetchMyCenters();
      const owned = isOwnerOfCenter(myCenters, centerId);
      setIsOwner(owned);
      if (!owned) { setLoading(false); return; }

      const [ps, rk, ov] = await Promise.all([
        fetchPermissions(),
        fetchRolePermissions(roleId),
        fetchStaffOverrides(mcId),
      ]);
      setPerms(ps);
      setRolePermKeys(new Set(rk));
      setOverrides(ov);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [mcId, roleId, centerId]);

  useEffect(() => { load(); }, [load]);

  // 한 권한의 상태를 순환: 역할따름 → 허용 → 차단 → 역할따름
  async function cycle(key: string) {
    if (!mcId) return;
    const cur = effectiveState(key, rolePermKeys, overrides);
    // 다음 상태 결정
    let nextGrant: GrantType | null;
    if (cur === "role-on" || cur === "role-off") nextGrant = "allow";
    else if (cur === "allow") nextGrant = "deny";
    else nextGrant = null; // deny → 역할따름

    setBusyKey(key);
    try {
      await setStaffOverride(mcId, key, nextGrant);
      setOverrides((prev) => {
        const next = { ...prev };
        if (nextGrant === null) delete next[key];
        else next[key] = nextGrant;
        return next;
      });
    } catch (e: any) { setError(e.message); }
    finally { setBusyKey(null); }
  }

  function stateBadge(st: EffectiveState) {
    switch (st) {
      case "allow": return <span className="ov-badge allow">허용 추가</span>;
      case "deny": return <span className="ov-badge deny">차단</span>;
      case "role-on": return <span className="ov-badge role-on">역할 있음</span>;
      case "role-off": return <span className="ov-badge role-off">역할 없음</span>;
    }
  }

  if (isOwner === false) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager/staff">‹</a>
          <div className="title">{staffName} 개인 권한</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>
          {error === "잘못된 접근이에요" ? error : "이 센터의 오너만 접근할 수 있는 화면이에요"}
        </div>
      </div>
    );
  }

  if (loading || isOwner === null) return <div className="app-shell"><Loading /></div>;

  const tree = buildTree(perms, activeCat);

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/manager/staff">‹</a>
        <div className="title">{staffName} 개인 권한</div>
        <div className="side" />
      </div>

      <div className="perm-guide">
        각 권한을 눌러 <b>역할따름 → 허용추가 → 차단</b> 순으로 바꿀 수 있어요.
        개인 설정은 역할 권한보다 우선합니다.
      </div>

      {error && <div className="auth-msg error" style={{ margin: "8px 20px" }}>{error}</div>}

      {/* 카테고리 탭 */}
      <div className="mem-filters">
        {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
          <button key={k} className={`filter-chip ${activeCat === k ? "on" : ""}`} onClick={() => setActiveCat(k)}>
            {v}
          </button>
        ))}
      </div>

      <div className="perm-list">
        {tree.length === 0 ? (
          <div className="daylist-empty" style={{ paddingTop: 20 }}>이 카테고리에 권한이 없어요</div>
        ) : (
          tree.map((p) => {
            const all = [p, ...p.children];
            return (
              <div key={p.key} className="perm-group">
                {all.map((perm, idx) => {
                  const st = effectiveState(perm.key, rolePermKeys, overrides);
                  return (
                    <button
                      key={perm.key}
                      className={`ov-item ${idx > 0 ? "child" : ""} st-${st}`}
                      disabled={busyKey === perm.key}
                      onClick={() => cycle(perm.key)}
                    >
                      <div className="perm-text">
                        <div className="perm-label">{perm.label}</div>
                        {perm.description && <div className="perm-desc">{perm.description}</div>}
                      </div>
                      {stateBadge(st)}
                    </button>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default function StaffPermissionsPage() {
  return (
    <Suspense fallback={<div className="app-shell"><Loading /></div>}>
      <PermInner />
    </Suspense>
  );
}
