/*
  TEST-002 최종 안전 검증 — 읽기 전용, 임시. cleanup SQL 실행 전 managerA 자신의
  account_center_permissions 행이 ACL-003 테스트가 만든 것인지 created_at으로 재확인한다.
  이 파일은 확인 후 삭제한다.
*/
import { describe, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter } from "./setup";

function mask(id: string | null | undefined): string {
  if (!id) return "(null)";
  return id.slice(0, 8) + "…";
}

describe("TEST-002 최종 검증(읽기 전용, 임시)", () => {
  it("created_at 비교로 managerA override가 ACL-003 테스트 생성분인지 확인한다", async () => {
    const managerA = await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
    const centerAId = await getOrCreateOwnedTestCenter(managerA);

    const { data: ownerMc } = await supabase
      .from("manager_centers")
      .select("id, created_at")
      .eq("center_id", centerAId)
      .eq("account_id", managerA.accountId)
      .single();
    console.log(`[diag2] centerA owner(managerA) manager_centers: id=${mask((ownerMc as any)?.id)} created_at=${(ownerMc as any)?.created_at}`);

    const { data: perms, error } = await supabase
      .from("account_center_permissions")
      .select("id, manager_center_id, permission_key, grant_type, created_at")
      .eq("manager_center_id", (ownerMc as any)?.id);
    if (error) console.log(`[diag2] 조회 오류: ${error.message}`);
    for (const p of (perms ?? []) as any[]) {
      console.log(
        `[diag2] managerA(오너) 소유 account_center_permissions: id=${mask(p.id)} key=${p.permission_key} grant=${p.grant_type} created_at=${p.created_at}`
      );
    }

    const { data: staffMc } = await supabase
      .from("manager_centers")
      .select("id, created_at, account_id")
      .eq("center_id", centerAId)
      .neq("account_id", managerA.accountId);
    for (const s of (staffMc ?? []) as any[]) {
      console.log(`[diag2] centerA의 다른 manager_centers 행: id=${mask(s.id)} created_at=${s.created_at}`);
    }
  }, 30000);
});
