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
    .is("merged_into", null) // 이미 다른 계정에 합쳐진(계정 연동) 계정은 검색·초대 대상에서 제외
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
  // ACL-005: accounts.is_manager를 여기서 true로 갱신하지 않는다 — accounts RLS의
  // "본인 계정 수정" 정책(auth_id = auth.uid())상 오너가 남의 계정 행을 update할 수
  // 없어 항상 조용히 실패했었다(반환 error 미확인이라 발견되지 않음). 매니저 여부는
  // 이제 lib/manager.ts/lib/mypage.ts가 active manager_centers 소속 존재로 직접
  // 판단하므로 이 플래그를 별도로 갱신할 필요가 없다.
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

// ACL-004: 메뉴 노출 여부 판정 (순수 함수 — page.tsx에서 재사용 + 단위 테스트용으로 분리).
//   오너는 전권이므로 myPerms 계산 없이 즉시 true. myPerms가 아직 로딩 중(null)이면
//   깜빡임 방지를 위해 false(숨김)로 처리한다.
export function canSeeManagerMenu(
  isOwner: boolean,
  myPerms: Set<string> | null,
  permissionKey: string
): boolean {
  if (isOwner) return true;
  return myPerms?.has(permissionKey) ?? false;
}

// ManagerNav의 "회원" 탭 판정을 쿠키에 캐싱해 다음 진입의 서버 렌더링 초기값으로 쓴다 —
// 판정 전에는 탭을 숨겨야 하는데(권한 없는 스태프에게 잠깐이라도 보이면 안 됨), 이 앱은
// 클라이언트 라우팅이 없어(app/layout.tsx 주석 참고) 관리자 탭 전환도 매번 전체 페이지가
// 서버에서부터 다시 렌더링된다 — localStorage는 서버가 못 읽어 서버 렌더링(=최초 페인트)
// 자체를 못 바꾸므로, 쿠키에 직전 판정 결과를 저장해 app/manager/layout.tsx(서버
// 컴포넌트)가 다음 로드 때 미리 반영하게 한다("탭 3개→4개" 깜빡임 방지). 실제 권한 판정은
// 여전히 서버(RLS)/클라이언트 재확인이 하고, 이 쿠키는 그 결과가 나오기 전까지 뭘 먼저
// 그릴지 정하는 힌트일 뿐이다.
const CAN_SEE_MEMBERS_COOKIE_KEY = "manager_nav_can_see_members";

export function setCachedCanSeeMembers(v: boolean): void {
  try {
    document.cookie = `${CAN_SEE_MEMBERS_COOKIE_KEY}=${v ? "1" : "0"}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
  } catch { /* 무시 */ }
}

// app/manager/layout.tsx(서버 컴포넌트)가 next/headers의 cookies()로 읽은 원시 문자열을
// 넘겨주면 판정한다 — 이 파일은 클라이언트 컴포넌트에서도 import되므로 next/headers는
// 여기서 직접 import하지 않는다(서버 전용 모듈이라 클라이언트 번들에 섞이면 안 됨).
export function parseCanSeeMembersCookie(raw: string | undefined): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

// 안정화 배치(2026-09-22, 태블릿/웹 nav 깜빡임) — 위 CAN_SEE_MEMBERS_COOKIE_KEY는 "회원"
// 탭 하나만 캐싱한다. ManagerNav의 나머지 메뉴(매출·결제/스태프·권한/룸 관리 등 15개+)는
// 이 캐시가 없어 fetchMyEffectivePermissionKeys()가 끝날 때까지 전부 숨겨졌다가 응답이
// 오면 한꺼번에 나타났다("탭 4개→전체" 신고와 일치). 같은 메커니즘(document.cookie ↔
// app/manager/layout.tsx의 next/headers cookies())을 오너 여부 + 보유 권한 키 전체로
// 확장한다. 기존 CAN_SEE_MEMBERS 쿠키/함수는 그대로 둔다(단위 테스트가 있고, 지우면
// 얻는 것 없이 위험만 늘어남) — ManagerNav는 이제 아래 일반화된 쪽만 쓴다.
const MANAGER_NAV_STATE_COOKIE_KEY = "manager_nav_state";

export interface ManagerNavCachedState {
  isOwner: boolean;
  permKeys: Set<string>;
}

export function setCachedManagerNavState(isOwner: boolean, permKeys: Set<string>): void {
  try {
    // 권한 카탈로그 키는 schema.sql 기준 영문/점/언더스코어만 쓰여 콤마 구분과 충돌하지
    // 않는다 — 그래도 쿠키 값 자체는 encodeURIComponent로 감싸 안전하게 보관한다.
    const encoded = `${isOwner ? "1" : "0"}:${Array.from(permKeys).join(",")}`;
    document.cookie = `${MANAGER_NAV_STATE_COOKIE_KEY}=${encodeURIComponent(encoded)}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
  } catch { /* 무시 — 실패해도 다음 로드 때 기존 방식(전부 숨김 후 표시)으로 안전하게 폴백 */ }
}

// app/manager/layout.tsx가 next/headers cookies()로 읽은 원시 문자열을 넘기면 판정한다
// (parseCanSeeMembersCookie와 동일한 이유로 next/headers는 여기서 직접 import 안 함).
// 이 캐시는 순수 UX 힌트다 — 실제 접근 통제는 RLS가 최종 방어선이라, 여기서 판정이
// 틀려도(쿠키가 오래됐거나 조작돼도) 데이터 노출로는 이어지지 않고, 클라이언트 재확인
// (fetchMyEffectivePermissionKeys)이 끝나면 항상 올바른 값으로 덮어써진다.
export function parseManagerNavStateCookie(raw: string | undefined): ManagerNavCachedState | null {
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw);
    const sep = decoded.indexOf(":");
    if (sep === -1) return null;
    const isOwner = decoded.slice(0, sep) === "1";
    const rest = decoded.slice(sep + 1);
    const permKeys = new Set(rest.length > 0 ? rest.split(",").filter(Boolean) : []);
    return { isOwner, permKeys };
  } catch {
    return null;
  }
}

/*
  로그인한 스태프 본인의 유효 권한 키 목록 (메뉴 노출 등 UI 표시용).
  오너는 전권이므로 이 함수를 호출하지 않고 호출측에서 isOwner로 별도 처리한다.
  role_permissions에 있거나 개인 예외가 'allow'인 키만 포함(= isEffectivelyAllowed 기준).
*/
export async function fetchMyEffectivePermissionKeys(
  managerCenterId: string,
  roleId: string | null
): Promise<Set<string>> {
  const [rolePermKeys, overrides] = await Promise.all([
    roleId ? fetchRolePermissions(roleId) : Promise.resolve([] as string[]),
    fetchStaffOverrides(managerCenterId),
  ]);
  const roleSet = new Set(rolePermKeys);
  const candidateKeys = new Set([...roleSet, ...Object.keys(overrides)]);
  const result = new Set<string>();
  for (const key of candidateKeys) {
    if (isEffectivelyAllowed(effectiveState(key, roleSet, overrides))) result.add(key);
  }
  return result;
}
