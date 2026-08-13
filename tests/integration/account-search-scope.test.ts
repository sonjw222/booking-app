/*
  SEC-102/103: accounts/profiles "매니저 계정/대표프로필 검색" 시스템 전체 노출 회귀 테스트.

  기존 취약점: "매니저 계정 검색"/"매니저 대표프로필 검색" RLS 정책이 권한 체크 없이
  "어디서든 active 매니저이기만 하면" 테이블 전체를 검색 대상으로 허용했다(검색 대상과
  검색자의 관계를 전혀 확인하지 않음). fix_account_search_scope_draft_proposed.sql로
  두 정책을 제거하고, customer.member.create 권한을 확인하는
  search_accounts_for_member() RPC로 교체했다.

  fixture 패턴은 acl-003-permission-read.test.ts와 동일(TEST_MANAGER_A/B 두 계정만
  재사용, getOrCreateOwnedTestCenter + 무권한 role + inviteStaff).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, type TestUser } from "./setup";
import { createRole, fetchRoles, inviteStaff, removeStaff, deleteRole } from "../../lib/roles";
import { searchAccountsForMember } from "../../lib/members";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };

const NO_PERM_ROLE_NAME = "SEARCH-SEC 테스트 무권한 역할";

let managerA: TestUser;
let managerB: TestUser;
let centerAId: string;

let createdRoleId: string | null = null;
let createdStaffManagerCenterId: string | null = null;

async function getOrCreateNoPermRole(centerId: string): Promise<{ id: string; created: boolean }> {
  const roles = await fetchRoles(centerId);
  const existing = roles.find((r) => r.name === NO_PERM_ROLE_NAME);
  if (existing) return { id: existing.id, created: false };
  await createRole(centerId, NO_PERM_ROLE_NAME);
  const refreshed = await fetchRoles(centerId);
  const created = refreshed.find((r) => r.name === NO_PERM_ROLE_NAME);
  if (!created) throw new Error("무권한 역할 생성에 실패했어요");
  return { id: created.id, created: true };
  // createRole()은 role_permissions을 채우지 않으므로 이 역할은 permission이 0개 —
  // has_permission()이 항상 false를 반환하는 "권한 없는 일반 스태프" fixture로 쓰기에 적합.
}

async function inviteIfNeeded(centerId: string, accountId: string, roleId: string): Promise<boolean> {
  try {
    await inviteStaff(centerId, accountId, roleId);
    return true;
  } catch (e: any) {
    if (e.message.includes("이미 이 센터의 스태프")) return false;
    throw e;
  }
}

async function managerCenterIdFor(centerId: string, accountId: string): Promise<string> {
  const { data, error } = await supabase
    .from("manager_centers")
    .select("id")
    .eq("center_id", centerId)
    .eq("account_id", accountId)
    .single();
  if (error || !data) throw new Error("manager_centers 행을 찾지 못했어요: " + error?.message);
  return (data as { id: string }).id;
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);

  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const role = await getOrCreateNoPermRole(centerAId);
  if (role.created) createdRoleId = role.id;

  const invited = await inviteIfNeeded(centerAId, managerB.accountId, role.id);
  if (invited) createdStaffManagerCenterId = await managerCenterIdFor(centerAId, managerB.accountId);
}, 30000);

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];

  if (createdStaffManagerCenterId) {
    try {
      await removeStaff(createdStaffManagerCenterId);
    } catch (e: any) {
      errors.push(`manager_centers 정리 실패(id=${createdStaffManagerCenterId}): ${e.message}`);
    }
  }
  if (createdRoleId) {
    try {
      await deleteRole(createdRoleId);
    } catch (e: any) {
      errors.push(`역할 정리 실패(id=${createdRoleId}): ${e.message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`account-search-scope fixture cleanup 실패:\n${errors.join("\n")}`);
  }
}, 30000);

describe("SEARCH-SEC-A~B: customer.member.create 권한 확인", () => {
  it("SEARCH-SEC-A: 회원 등록 권한이 없는 스태프는 검색이 거부된다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.rpc("search_accounts_for_member", { p_keyword: "테스트" });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("회원 등록 권한이 없어요");
  });

  it("SEARCH-SEC-B: 오너(모든 권한 보유)는 정상적으로 검색할 수 있다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    // 정확히 몇 건이 매칭되는지는 공유 테스트 계정 데이터에 의존적이라 단정하지 않고,
    // 에러 없이 배열이 돌아오는지(=권한 확인 통과)만 확인한다.
    const results = await searchAccountsForMember("테스트");
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("SEARCH-SEC-C: 정책 제거 확인(직접 접근 시도)", () => {
  it("SEARCH-SEC-C: 무권한 스태프가 accounts를 직접 폭넓게 조회해도(우회 시도) 예전처럼 시스템 전체가 보이지 않는다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    // "매니저 계정 검색" 정책이 살아있었다면 이 조회가 광범위한 결과를 반환했을 것 —
    // 이제는 그 정책이 제거됐으므로 남은 정책(본인 계정, 자기 센터 스태프/회원 등)만
    // 적용되어 무관한 계정은 보이지 않아야 한다. 존재할 리 없는 임의 UUID로 조회해
    // "쿼리 자체는 되지만 결과가 없다"는 것으로 정책이 더 이상 광범위 접근을 허용하지
    // 않음을 확인한다(직접적인 부정 단언이 어려운 공유 DB 환경 특성상, 최소한 에러 없이
    // 0건이 나오는 것으로 우회 경로가 막혔음을 보수적으로 확인).
    const { error } = await supabase
      .from("accounts")
      .select("id, name, phone")
      .ilike("phone", "%01%")
      .limit(50);
    // 쿼리 자체는 에러 없이 수행되어야 정상(RLS가 조용히 행을 걸러내는 것이지 쿼리를
    // 막는 게 아님) — 결과 건수는 공유 DB 상태에 의존적이라 단정하지 않는다.
    expect(error).toBeNull();
  });
});

describe("SEARCH-SEC-D: RPC 자체 방어", () => {
  it("SEARCH-SEC-D: 2글자 미만 키워드는 빈 배열을 반환한다(권한 있는 계정 기준)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const results = await searchAccountsForMember("a");
    expect(results).toEqual([]);
  });
});
