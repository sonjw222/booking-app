/*
  TEST-002 임시 진단 스크립트 — 읽기 전용, 아무것도 만들거나 지우지 않는다.
  ACL-003 통합 테스트(acl-003-permission-read.test.ts)의 beforeAll이 남긴 fixture가
  공유 개발 Supabase에 실제로 어떤 행으로 남아 있는지 CI 로그로 확인하기 위한 일회성 조사용
  파일이다. 조사가 끝나면 이 파일은 삭제한다(이 브랜치의 최종 커밋에는 포함되지 않음).
  이메일/전체 UUID는 출력하지 않고 마스킹한다.
*/
import { describe, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, getFixtureAdminClient } from "./setup";

function mask(id: string | null | undefined): string {
  if (!id) return "(null)";
  return id.slice(0, 8) + "…";
}

describe("TEST-002 진단(읽기 전용, 임시)", () => {
  it("centerA에 남아있는 ACL-003 fixture 상태를 보고한다", async () => {
    const managerA = await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
    const centerAId = await getOrCreateOwnedTestCenter(managerA);
    const managerB = await switchToTestUser("TEST_MANAGER_B_EMAIL", "TEST_MANAGER_B_PASSWORD");

    const admin = getFixtureAdminClient();

    console.log(`[diag] centerA id: ${mask(centerAId)}`);
    console.log(`[diag] managerA account id: ${mask(managerA.accountId)}`);
    console.log(`[diag] managerB account id: ${mask(managerB.accountId)}`);

    const { data: mcRows, error: mcErr } = await admin
      .from("manager_centers")
      .select("id, account_id, center_id, role_id, status")
      .eq("center_id", centerAId)
      .in("account_id", [managerA.accountId, managerB.accountId]);
    if (mcErr) console.log(`[diag] manager_centers 조회 오류: ${mcErr.message}`);
    console.log(`[diag] manager_centers 행 수(centerA, managerA/B): ${(mcRows ?? []).length}`);
    for (const r of (mcRows ?? []) as any[]) {
      const who = r.account_id === managerA.accountId ? "managerA" : "managerB";
      console.log(
        `[diag] manager_centers: id=${mask(r.id)} account=${who}(${mask(r.account_id)}) role_id=${mask(r.role_id)} status=${r.status}`
      );
    }

    const roleIds = ((mcRows ?? []) as any[]).map((r) => r.role_id).filter(Boolean);
    if (roleIds.length > 0) {
      const { data: roles, error: roleErr } = await admin
        .from("center_roles")
        .select("id, name, is_owner, center_id")
        .in("id", roleIds);
      if (roleErr) console.log(`[diag] center_roles 조회 오류: ${roleErr.message}`);
      for (const r of (roles ?? []) as any[]) {
        console.log(`[diag] center_roles: id=${mask(r.id)} name="${r.name}" is_owner=${r.is_owner} center_id=${mask(r.center_id)}`);
      }
    }

    // admin(service_role) client는 account_center_permissions에 대한 SQL GRANT 자체가 없어
    // "permission denied"를 반환한다(RLS 우회와는 별개 — describeAdminQueryError 참고).
    // 대신 오너(managerA)로 로그인된 일반 client로 조회한다 — 오너는 현재(수정 전) 정책에서도
    // 같은 센터 소속이므로 조회 가능하다.
    await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
    const mcIds = ((mcRows ?? []) as any[]).map((r) => r.id);
    if (mcIds.length > 0) {
      const { data: overrides, error: ovErr } = await supabase
        .from("account_center_permissions")
        .select("id, manager_center_id, permission_key, grant_type")
        .in("manager_center_id", mcIds);
      if (ovErr) console.log(`[diag] account_center_permissions 조회 오류: ${ovErr.message}`);
      console.log(`[diag] account_center_permissions 행 수: ${(overrides ?? []).length}`);
      for (const o of (overrides ?? []) as any[]) {
        console.log(
          `[diag] account_center_permissions: id=${mask(o.id)} manager_center_id=${mask(o.manager_center_id)} key=${o.permission_key} grant=${o.grant_type}`
        );
      }
    }

    // 무권한 역할(centerA 전용으로 생성됨)이 정확히 managerB의 행 하나에만 쓰이는지
    // role_id별로 분리해서 확인한다(같은 이름의 역할이 다른 센터에도 있을 수 있으므로
    // center_roles.id 기준으로만 판단 — center_roles는 애초에 센터별로 독립된 행이라
    // 다른 센터에서 이 정확한 role_id를 참조할 수 없다).
    const noPermRoleId = ((mcRows ?? []) as any[]).find((r) => r.account_id === managerB.accountId)?.role_id;
    if (noPermRoleId) {
      const { data: usage } = await admin
        .from("manager_centers")
        .select("id, account_id, status")
        .eq("role_id", noPermRoleId);
      console.log(`[diag] 무권한 역할(${mask(noPermRoleId)})을 쓰는 manager_centers 행 수: ${(usage ?? []).length} (이 값이 1이어야 managerB 행만 삭제하면 role도 안전하게 삭제 가능)`);
    }
  }, 30000);
});
