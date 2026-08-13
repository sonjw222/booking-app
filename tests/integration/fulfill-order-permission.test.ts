/*
  SEC-116: fulfill_order()가 세분권한(pass.payment.create) 대신 my_managed_center_ids()만
  써서 "그 센터의 active 매니저이기만 하면" 결제 등록 권한 없는 스태프도 주문을 발급
  처리할 수 있던 문제 회귀 테스트.

  fixture 패턴은 acl-003-permission-read.test.ts/account-search-scope.test.ts와 동일
  (TEST_MANAGER_A/B 두 계정만 재사용, getOrCreateOwnedTestCenter + 무권한 role +
  inviteStaff).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, getFixtureAdminClient, type TestUser } from "./setup";
import { createRole, fetchRoles, inviteStaff, removeStaff, deleteRole } from "../../lib/roles";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };

const NO_PERM_ROLE_NAME = "SEC-116 테스트 무권한 역할";

let managerA: TestUser;
let managerB: TestUser;
let centerAId: string;
const cleanupProductIds: string[] = [];

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

async function createTestProduct(price: number) {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin
    .from("products")
    .insert({
      center_id: centerAId, name: "SEC-116 테스트 상품", product_kind: "pass", pass_type: "count",
      price, total_count: 10, is_on_sale: true, is_active: true,
    })
    .select("id, price")
    .single();
  if (error || !data) throw new Error("테스트 상품 생성 실패: " + error?.message);
  cleanupProductIds.push(data.id);
  return data as { id: string; price: number };
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
  const admin = getFixtureAdminClient();
  for (const id of cleanupProductIds) await admin.from("products").delete().eq("id", id);

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
    throw new Error(`fulfill-order-permission fixture cleanup 실패:\n${errors.join("\n")}`);
  }
}, 30000);

describe("SEC-116: fulfill_order() pass.payment.create 권한 확인", () => {
  it("결제 등록 권한이 없는 스태프는 같은 센터의 주문이라도 발급 처리할 수 없다", async () => {
    const product = await createTestProduct(15000);
    const admin = getFixtureAdminClient();
    const { data: order, error: insertErr } = await admin
      .from("orders")
      .insert({
        center_id: centerAId, profile_id: managerB.profileId, product_id: product.id,
        product_name: "SEC-116 테스트 상품", amount: 15000, pay_method: "card", status: "pending",
      })
      .select("id")
      .single();
    if (insertErr || !order) throw new Error("주문 생성 실패: " + insertErr?.message);

    // managerB는 centerA의 active 스태프이긴 하지만 pass.payment.create 권한이 없다 —
    // SEC-116 이전이었다면 my_managed_center_ids()만으로 통과했을 것.
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.rpc("fulfill_order", { p_order_id: (order as any).id });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("이 주문을 처리할 권한이 없어요");
  });

  it("오너는 결제 등록 권한이 항상 있으므로(is_owner) 정상적으로 발급 처리할 수 있다", async () => {
    const product = await createTestProduct(15000);
    const admin = getFixtureAdminClient();
    const { data: order, error: insertErr } = await admin
      .from("orders")
      .insert({
        center_id: centerAId, profile_id: managerB.profileId, product_id: product.id,
        product_name: "SEC-116 테스트 상품", amount: 15000, pay_method: "card", status: "pending",
      })
      .select("id")
      .single();
    if (insertErr || !order) throw new Error("주문 생성 실패: " + insertErr?.message);

    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const { data, error } = await supabase.rpc("fulfill_order", { p_order_id: (order as any).id });
    expect(error).toBeNull();
    expect((data as any)?.already_done).toBe(false);
    expect((data as any)?.membership_id).toBeTruthy();
  });
});
