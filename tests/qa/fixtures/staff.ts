/*
  QA 직원 fixture — 이번 실행 전용 역할 + TEST_MANAGER_B 연결(권한 검증 시나리오용).
  역할은 "[QA <runId>] 직원" 이름이고 지정한 permission만 role_permissions에 넣는다(기존 역할/권한은 수정하지 않음).
  연결(manager_centers)/역할(center_roles) UUID를 tracker에 기록해 이번 실행 것만 정리한다.
*/
import type { SupabaseClient } from "@supabase/supabase-js";
import { FixtureTracker, qaName } from "../runContext";

export async function createQaStaff(
  admin: SupabaseClient, t: FixtureTracker, opts: { centerId: string; staffAccountId: string; permissionKeys: string[] },
): Promise<{ roleId: string; managerCenterId: string }> {
  const role = await admin.from("center_roles").insert({ center_id: opts.centerId, name: qaName(t.runId, "직원"), is_owner: false }).select("id").single();
  if (role.error || !role.data) throw new Error(`QA 직원 역할 생성 실패: ${role.error?.message}`);
  t.add("center_roles", role.data.id);
  if (opts.permissionKeys.length > 0) {
    const perms = await admin.from("role_permissions").insert(opts.permissionKeys.map((k) => ({ role_id: role.data!.id, permission_key: k })));
    if (perms.error) throw new Error(`QA 직원 권한 부여 실패: ${perms.error.message}`);
  }
  const link = await admin.from("manager_centers")
    .insert({ account_id: opts.staffAccountId, center_id: opts.centerId, role_id: role.data.id, status: "active" }).select("id").single();
  if (link.error || !link.data) throw new Error(`QA 직원 연결 실패: ${link.error?.message}`);
  t.add("manager_centers", link.data.id);
  return { roleId: role.data.id as string, managerCenterId: link.data.id as string };
}
