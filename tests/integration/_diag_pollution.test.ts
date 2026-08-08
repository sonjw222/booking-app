/*
  임시 읽기 전용 진단 스크립트 — class-allowed-products.spec.ts가 공유 dev DB 오염(TEST-002/#24)
  으로 간헐 실패하는 문제의 실제 오염 범위를 파악하기 위한 것. 아무것도 쓰지 않는다(전부 select).
  진단이 끝나면 이 파일은 삭제한다 — 정식 회귀 테스트가 아님.
*/
import { describe, it, beforeAll } from "vitest";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  type TestUser,
} from "./setup";

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;

beforeAll(async () => {
  managerA = await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  userA = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
}, 30000);

describe("진단(읽기 전용)", () => {
  it("centerA 정보", async () => {
    console.log("=== centerAId ===", centerAId);
    console.log("=== managerA.profileId ===", managerA.profileId, "accountId:", managerA.accountId);
    console.log("=== userA.profileId ===", userA.profileId, "accountId:", userA.accountId);
  });

  it("products in centerA", async () => {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin.from("products").select("id, name, product_kind, created_at").eq("center_id", centerAId).order("created_at");
    if (error) throw new Error(error.message);
    console.log(`=== products count: ${data!.length} ===`);
    for (const p of data!) console.log(`  ${p.id} | ${p.product_kind} | ${p.name} | ${p.created_at}`);
  });

  it("memberships in centerA (grouped by product_name)", async () => {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin.from("memberships").select("id, profile_id, product_id, product_name, status, created_at").eq("center_id", centerAId).order("created_at");
    if (error) throw new Error(error.message);
    console.log(`=== memberships count (all profiles): ${data!.length} ===`);
    const byName = new Map<string, number>();
    for (const m of data!) byName.set(m.product_name, (byName.get(m.product_name) ?? 0) + 1);
    for (const [name, count] of byName) console.log(`  product_name="${name}": ${count}건`);

    const userAMemberships = data!.filter((m) => m.profile_id === userA.profileId);
    console.log(`=== memberships for userA.profileId: ${userAMemberships.length} ===`);
    const userAByName = new Map<string, number>();
    for (const m of userAMemberships) userAByName.set(m.product_name, (userAByName.get(m.product_name) ?? 0) + 1);
    for (const [name, count] of userAByName) console.log(`  userA product_name="${name}": ${count}건`);

    const managerAMemberships = data!.filter((m) => m.profile_id === managerA.profileId);
    console.log(`=== memberships for managerA.profileId: ${managerAMemberships.length} ===`);

    const otherProfiles = new Set(data!.map((m) => m.profile_id).filter((id) => id !== userA.profileId && id !== managerA.profileId));
    console.log(`=== distinct 그 외 profile_id 수: ${otherProfiles.size} ===`, [...otherProfiles]);
  });

  it("profiles under userA/managerA accounts (orphan is_primary=false 확인)", async () => {
    const admin = getFixtureAdminClient();
    for (const [label, accountId] of [["userA", userA.accountId], ["managerA", managerA.accountId]] as const) {
      const { data, error } = await admin.from("profiles").select("id, name, is_primary, created_at").eq("account_id", accountId).order("created_at");
      if (error) throw new Error(error.message);
      console.log(`=== profiles under ${label} account (${data!.length}건) ===`);
      for (const p of data!) console.log(`  ${p.id} | primary=${p.is_primary} | ${p.name} | ${p.created_at}`);
    }
  });

  it("membership_schedule_rules referencing centerA products", async () => {
    const admin = getFixtureAdminClient();
    const { data: products } = await admin.from("products").select("id, name").eq("center_id", centerAId);
    const productIds = (products ?? []).map((p) => p.id);
    if (productIds.length === 0) return;
    const { data, error } = await admin.from("membership_schedule_rules").select("id, product_id").in("product_id", productIds);
    if (error) throw new Error(error.message);
    console.log(`=== membership_schedule_rules referencing centerA products: ${data!.length} ===`);
  });

  it("classes in centerA (제목 패턴별)", async () => {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin.from("classes").select("id, title, start_time, created_at").eq("center_id", centerAId).order("created_at");
    if (error) throw new Error(error.message);
    console.log(`=== classes count: ${data!.length} ===`);
    const byPrefix = new Map<string, number>();
    for (const c of data!) {
      const prefix = (c.title ?? "").split(" ")[0] ?? "(제목없음)";
      byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
    }
    for (const [prefix, count] of byPrefix) console.log(`  title prefix "${prefix}": ${count}건`);
  });

  it("class_allowed_products referencing centerA classes", async () => {
    const admin = getFixtureAdminClient();
    const { data: classes } = await admin.from("classes").select("id").eq("center_id", centerAId);
    const classIds = (classes ?? []).map((c) => c.id);
    if (classIds.length === 0) return;
    const { data, error } = await admin.from("class_allowed_products").select("id, class_id, product_id").in("class_id", classIds);
    if (error) throw new Error(error.message);
    console.log(`=== class_allowed_products referencing centerA classes: ${data!.length} ===`);
  });

  it("reservations in centerA classes", async () => {
    const admin = getFixtureAdminClient();
    const { data: classes } = await admin.from("classes").select("id").eq("center_id", centerAId);
    const classIds = (classes ?? []).map((c) => c.id);
    if (classIds.length === 0) return;
    const { data, error } = await admin.from("reservations").select("id, status", { count: "exact" }).in("class_id", classIds);
    if (error) throw new Error(error.message);
    console.log(`=== reservations referencing centerA classes: ${data!.length} ===`);
  });

  it("payments referencing centerA memberships (있으면 삭제 전 확인 필요)", async () => {
    const admin = getFixtureAdminClient();
    const { data: memberships } = await admin.from("memberships").select("id").eq("center_id", centerAId);
    const membershipIds = (memberships ?? []).map((m) => m.id);
    if (membershipIds.length === 0) return;
    const { data, error } = await admin.from("payments").select("id, membership_id").in("membership_id", membershipIds);
    if (error) throw new Error(error.message);
    console.log(`=== payments referencing centerA memberships: ${data!.length} ===`);
  });
});
