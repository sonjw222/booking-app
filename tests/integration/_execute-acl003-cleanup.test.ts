/*
  TEST-002 승인된 일회성 정리 실행 스크립트 (2026-08-01 사용자 승인).

  cleanup_acl003_test_fixture_proposed.sql과 동일한 안전장치를 그대로 적용한다:
  미리보기 조회 → 예상 행 수(account_center_permissions=2, manager_centers=1,
  center_roles=1) 정확히 일치 확인 → 불일치 시 즉시 중단(삭제 없음) → 일치 시
  FK 안전 순서(override → manager_centers → center_roles)로 삭제 → 실행 후 잔여 0건 확인.

  원본 .sql 파일 자체(BEGIN/임시테이블/DO 블록)를 실행할 SQL Editor/psql 접근 수단이
  이 환경에는 없어, 동일 로직을 lib/roles.ts의 기존 함수(app이 실제로 쓰는 함수, 새
  로직 아님)로 구현했다. 이 파일은 실행 확인 후 삭제한다. add_rls_gap_tables_draft_proposed.sql,
  fix_account_center_permissions_select_draft_proposed.sql은 이 스크립트와 무관하며
  건드리지 않는다.
*/
import { describe, it, expect } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser } from "./setup";
import { removeStaff, deleteRole, setStaffOverride } from "../../lib/roles";

const NO_PERM_ROLE_NAME = "ACL-003 테스트 무권한 역할";
const OVERRIDE_KEY = "customer.member.view";

function mask(id: string | null | undefined): string {
  if (!id) return "(null)";
  return id.slice(0, 8) + "…";
}

describe("TEST-002 승인된 정리 실행 (1회성, 사용자 승인 완료)", () => {
  it("미리보기 → 행수 검증 → 삭제 → 잔여 확인", async () => {
    await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");

    // STEP 1: 대상 role 미리보기
    const { data: roles, error: roleErr } = await supabase
      .from("center_roles")
      .select("id, center_id, name, is_owner")
      .eq("name", NO_PERM_ROLE_NAME)
      .eq("is_owner", false);
    if (roleErr) throw new Error(`center_roles 조회 실패: ${roleErr.message}`);
    console.log(`[cleanup] STEP1 center_roles 미리보기 (${(roles ?? []).length}건):`);
    for (const r of (roles ?? []) as any[]) console.log(`  id=${mask(r.id)} center_id=${mask(r.center_id)} name="${r.name}"`);

    expect(roles ?? [], "center_roles 행 수가 예상(1)과 다릅니다 — 여기서 중단, 삭제 없음").toHaveLength(1);
    const role = (roles as any[])[0];

    // STEP 2: 이 role을 쓰는 manager_centers 미리보기
    const { data: mcRows, error: mcErr } = await supabase
      .from("manager_centers")
      .select("id, account_id, center_id, role_id, status")
      .eq("role_id", role.id);
    if (mcErr) throw new Error(`manager_centers 조회 실패: ${mcErr.message}`);
    console.log(`[cleanup] STEP2 manager_centers 미리보기 (${(mcRows ?? []).length}건):`);
    for (const r of (mcRows ?? []) as any[]) console.log(`  id=${mask(r.id)} status=${r.status}`);

    expect(mcRows ?? [], "manager_centers 행 수가 예상(1)과 다릅니다 — 여기서 중단, 삭제 없음").toHaveLength(1);
    const staffMc = (mcRows as any[])[0];

    // STEP 3: 같은 센터의 오너 manager_center_id 찾기 (오너 자신의 override 대상 식별용)
    const { data: ownerRoles } = await supabase
      .from("center_roles")
      .select("id")
      .eq("center_id", role.center_id)
      .eq("is_owner", true);
    const ownerRoleIds = ((ownerRoles ?? []) as any[]).map((r) => r.id);
    const { data: ownerMcRows } = await supabase
      .from("manager_centers")
      .select("id")
      .eq("center_id", role.center_id)
      .in("role_id", ownerRoleIds.length > 0 ? ownerRoleIds : ["00000000-0000-0000-0000-000000000000"]);
    const targetMcIds = [staffMc.id, ...((ownerMcRows ?? []) as any[]).map((r) => r.id)];

    // STEP 4: 정리 대상 account_center_permissions 미리보기
    const { data: perms, error: permErr } = await supabase
      .from("account_center_permissions")
      .select("id, manager_center_id, permission_key, grant_type")
      .in("manager_center_id", targetMcIds)
      .eq("permission_key", OVERRIDE_KEY);
    if (permErr) throw new Error(`account_center_permissions 조회 실패: ${permErr.message}`);
    console.log(`[cleanup] STEP4 account_center_permissions 미리보기 (${(perms ?? []).length}건):`);
    for (const p of (perms ?? []) as any[]) console.log(`  id=${mask(p.id)} manager_center_id=${mask(p.manager_center_id)} key=${p.permission_key} grant=${p.grant_type}`);

    expect(perms ?? [], "account_center_permissions 행 수가 예상(2)과 다릅니다 — 여기서 중단, 삭제 없음").toHaveLength(2);

    // 여기까지 전부 예상과 일치해야만 도달 — STEP 5부터 실제 삭제 시작.
    console.log(`[cleanup] 검증 통과 — 삭제를 시작합니다.`);

    // STEP 5: 삭제 (자식 → manager_centers → role 순서, FK 제약과 일치)
    for (const p of (perms as any[])) {
      await setStaffOverride(p.manager_center_id, p.permission_key, null);
      console.log(`[cleanup] account_center_permissions 삭제됨: id=${mask(p.id)}`);
    }
    await removeStaff(staffMc.id);
    console.log(`[cleanup] manager_centers 삭제됨: id=${mask(staffMc.id)}`);
    await deleteRole(role.id);
    console.log(`[cleanup] center_roles 삭제됨: id=${mask(role.id)}`);

    // STEP 6: 잔여 확인
    const { data: remainRoles } = await supabase
      .from("center_roles").select("id").eq("name", NO_PERM_ROLE_NAME).eq("is_owner", false);
    const { data: remainMc } = await supabase
      .from("manager_centers").select("id").eq("role_id", role.id);
    const { data: remainPerms } = await supabase
      .from("account_center_permissions").select("id").in("manager_center_id", targetMcIds).eq("permission_key", OVERRIDE_KEY);

    console.log(
      `[cleanup] STEP6 실행 후 잔여: center_roles=${(remainRoles ?? []).length} ` +
      `manager_centers=${(remainMc ?? []).length} account_center_permissions=${(remainPerms ?? []).length}`
    );

    expect(remainRoles ?? [], "삭제 후에도 center_roles가 남아 있습니다").toHaveLength(0);
    expect(remainMc ?? [], "삭제 후에도 manager_centers가 남아 있습니다").toHaveLength(0);
    expect(remainPerms ?? [], "삭제 후에도 account_center_permissions가 남아 있습니다").toHaveLength(0);
  }, 30000);
});
