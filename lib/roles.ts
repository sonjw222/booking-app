/*
  매니저 - 역할/권한 및 스태프 관리
  - 역할(center_roles) 목록·생성·삭제
  - 권한 카탈로그(permissions) 조회 → 화면이 이 표를 읽어서 자동으로 그려짐
  - 역할별 권한(role_permissions) 저장
  - 스태프 초대/역할변경/삭제
*/

import { supabase } from "./supabaseClient";

export type Permission = {
  key: string;
  category: string;
  parentKey: string | null;
  label: string;
  description: string | null;
  sortOrder: number;
};

export type Role = {
  id: string;
  name: string;
  roleKey: string | null;
  isSystem: boolean;
  isOwner: boolean;
};

export type Staff = {
  id: string;           // manager_centers.id
  accountId: string;
  name: string;
  phone: string | null;
  roleId: string | null;
  roleName: string | null;
  isOwner: boolean;
  status: "pending" | "active" | "suspended";
};

export const CATEGORY_LABEL: Record<string, string> = {
  facility: "시설 관리",
  customer: "고객 관리",
  pass: "수강권",
  schedule: "일정",
  board: "게시판",
  message: "메시지",
  contract: "전자계약서",
};

// 권한 카탈로그 전체 (고정 목록)
export async function fetchPermissions(): Promise<Permission[]> {
  const { data, error } = await supabase
    .from("permissions")
    .select("key, category, parent_key, label, description, sort_order")
    .order("category")
    .order("sort_order");
  if (error) throw new Error("권한 목록을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((p: any) => ({
    key: p.key,
    category: p.category,
    parentKey: p.parent_key,
    label: p.label,
    description: p.description,
    sortOrder: p.sort_order,
  }));
}

// 센터의 역할 목록
export async function fetchRoles(centerId: string): Promise<Role[]> {
  const { data, error } = await supabase
    .from("center_roles")
    .select("id, name, role_key, is_system, is_owner")
    .eq("center_id", centerId)
    .order("sort_order");
  if (error) throw new Error("역할 목록을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    id: r.id, name: r.name, roleKey: r.role_key,
    isSystem: r.is_system, isOwner: r.is_owner,
  }));
}

export async function createRole(centerId: string, name: string): Promise<void> {
  const { error } = await supabase
    .from("center_roles")
    .insert({ center_id: centerId, name, is_system: false, is_owner: false, sort_order: 99 });
  if (error) {
    if (error.message.includes("duplicate")) throw new Error("이미 있는 역할 이름이에요");
    throw new Error("역할 생성에 실패했어요: " + error.message);
  }
}

export async function deleteRole(roleId: string): Promise<void> {
  const { error } = await supabase.from("center_roles").delete().eq("id", roleId);
  if (error) throw new Error("역할 삭제에 실패했어요: " + error.message);
}

// 역할이 가진 권한 키 목록
export async function fetchRolePermissions(roleId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("role_permissions")
    .select("permission_key")
    .eq("role_id", roleId);
  if (error) throw new Error("권한을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => r.permission_key);
}

// 역할 권한 저장 (전체 교체 방식)
export async function saveRolePermissions(roleId: string, keys: string[]): Promise<void> {
  // 기존 것 모두 삭제 후 다시 삽입 (개수가 많지 않아 단순하게)
  const { error: delErr } = await supabase.from("role_permissions").delete().eq("role_id", roleId);
  if (delErr) throw new Error("권한 저장에 실패했어요: " + delErr.message);

  if (keys.length === 0) return;
  const { error: insErr } = await supabase
    .from("role_permissions")
    .insert(keys.map((k) => ({ role_id: roleId, permission_key: k })));
  if (insErr) throw new Error("권한 저장에 실패했어요: " + insErr.message);
}

// 센터의 스태프 목록
export async function fetchStaff(centerId: string): Promise<Staff[]> {
  const { data, error } = await supabase
    .from("manager_centers")
    .select("id, account_id, status, accounts(name, phone), center_roles(id, name, is_owner)")
    .eq("center_id", centerId);
  if (error) throw new Error("스태프 목록을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((s: any) => ({
    id: s.id,
    accountId: s.account_id,
    name: s.accounts?.name ?? "(이름 없음)",
    phone: s.accounts?.phone ?? null,
    roleId: s.center_roles?.id ?? null,
    roleName: s.center_roles?.name ?? null,
    isOwner: s.center_roles?.is_owner ?? false,
    status: s.status,
  }));
}

// 초대할 계정 검색 (이름 또는 전화번호)
export async function searchAccounts(keyword: string): Promise<{ id: string; name: string; phone: string | null }[]> {
  const kw = keyword.trim();
  if (!kw) return [];
  const { data, error } = await supabase
    .from("accounts")
    .select("id, name, phone")
    .or(`name.ilike.%${kw}%,phone.ilike.%${kw}%`)
    .limit(10);
  if (error) throw new Error("계정 검색에 실패했어요: " + error.message);
  return (data ?? []).map((a: any) => ({ id: a.id, name: a.name, phone: a.phone }));
}

// 스태프 초대 (pending 상태로 추가 → 본인이 수락하거나 오너가 바로 active)
export async function inviteStaff(centerId: string, accountId: string, roleId: string): Promise<void> {
  const { error } = await supabase.from("manager_centers").insert({
    center_id: centerId,
    account_id: accountId,
    role_id: roleId,
    status: "active", // 오너가 직접 추가하는 것이므로 바로 활성
  });
  if (error) {
    if (error.message.includes("duplicate")) throw new Error("이미 이 센터의 스태프예요");
    throw new Error("스태프 추가에 실패했어요: " + error.message);
  }
  // 매니저 역할 플래그 켜기
  await supabase.from("accounts").update({ is_manager: true }).eq("id", accountId);
}

export async function updateStaffRole(staffId: string, roleId: string): Promise<void> {
  const { error } = await supabase.from("manager_centers").update({ role_id: roleId }).eq("id", staffId);
  if (error) throw new Error("역할 변경에 실패했어요: " + error.message);
}

export async function removeStaff(staffId: string): Promise<void> {
  const { error } = await supabase.from("manager_centers").delete().eq("id", staffId);
  if (error) throw new Error("스태프 삭제에 실패했어요: " + error.message);
}

/*
  권한을 트리로 묶기
  - 최상위 권한 아래에 하위 권한을 넣어 화면에서 중첩 표시
*/
export type PermissionNode = Permission & { children: Permission[] };

export function buildTree(perms: Permission[], category: string): PermissionNode[] {
  const inCat = perms.filter((p) => p.category === category);
  const tops = inCat.filter((p) => !p.parentKey);
  return tops.map((t) => ({
    ...t,
    children: inCat.filter((c) => c.parentKey === t.key),
  }));
}

/*
  상위 권한을 끄면 하위도 같이 꺼지고,
  하위를 켜면 상위도 같이 켜져야 함 (스튜디오메이트 동작과 동일)
*/
export function togglePermission(
  perms: Permission[],
  selected: Set<string>,
  key: string,
  checked: boolean
): Set<string> {
  const next = new Set(selected);
  const target = perms.find((p) => p.key === key);
  if (!target) return next;

  if (checked) {
    next.add(key);
    // 상위 권한도 자동으로 켜기 (하위만 켜져 있으면 접근 자체가 안 되므로)
    let parent = target.parentKey;
    while (parent) {
      next.add(parent);
      parent = perms.find((p) => p.key === parent)?.parentKey ?? null;
    }
  } else {
    next.delete(key);
    // 하위 권한도 모두 끄기
    const removeChildren = (k: string) => {
      for (const c of perms.filter((p) => p.parentKey === k)) {
        next.delete(c.key);
        removeChildren(c.key);
      }
    };
    removeChildren(key);
  }
  return next;
}

/* ============================================================
   개인별 권한 예외 (account_center_permissions)
   - 역할 위에 덮어쓰기: allow(추가 허용) / deny(예외 차단)
   ============================================================ */

export type GrantType = "allow" | "deny";

// 특정 스태프(manager_centers.id)의 개인 예외 권한
//   { permission_key: 'allow' | 'deny' }
export async function fetchStaffOverrides(managerCenterId: string): Promise<Record<string, GrantType>> {
  const { data, error } = await supabase
    .from("account_center_permissions")
    .select("permission_key, grant_type")
    .eq("manager_center_id", managerCenterId);
  if (error) throw new Error("개인 권한을 불러오지 못했어요: " + error.message);
  const map: Record<string, GrantType> = {};
  for (const r of data ?? []) map[(r as any).permission_key] = (r as any).grant_type;
  return map;
}

// 개인 예외 한 건 설정 (allow/deny) 또는 해제(null → 역할 따름)
export async function setStaffOverride(
  managerCenterId: string,
  permissionKey: string,
  grant: GrantType | null
): Promise<void> {
  if (grant === null) {
    // 해제 = 삭제 → 역할 권한을 따르게 됨
    const { error } = await supabase
      .from("account_center_permissions")
      .delete()
      .eq("manager_center_id", managerCenterId)
      .eq("permission_key", permissionKey);
    if (error) throw new Error("권한 해제에 실패했어요: " + error.message);
    return;
  }
  // upsert: 있으면 grant_type 갱신, 없으면 삽입
  const { error } = await supabase
    .from("account_center_permissions")
    .upsert(
      { manager_center_id: managerCenterId, permission_key: permissionKey, grant_type: grant },
      { onConflict: "manager_center_id,permission_key" }
    );
  if (error) throw new Error("권한 설정에 실패했어요: " + error.message);
}

// 최종 권한 계산 (화면 표시용)
//   오너 전권은 화면에서 별도 처리. 여기선 역할+개인 예외만 계산.
export type EffectiveState = "role-on" | "role-off" | "allow" | "deny";

export function effectiveState(
  permissionKey: string,
  rolePermKeys: Set<string>,
  overrides: Record<string, GrantType>
): EffectiveState {
  const ov = overrides[permissionKey];
  if (ov === "deny") return "deny";
  if (ov === "allow") return "allow";
  return rolePermKeys.has(permissionKey) ? "role-on" : "role-off";
}

// 그 상태에서 실제로 권한이 있는지 (true/false)
export function isEffectivelyAllowed(state: EffectiveState): boolean {
  return state === "allow" || state === "role-on";
}
