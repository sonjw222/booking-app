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

  // 2026-08-09 cleanup SQL이 admin_action_logs.membership_id FK 위반으로 중단됨 —
  // memberships/profiles를 참조하는 테이블 전수를 재조사(schema.sql/add_admin_assignment.sql
  // 코드 감사로 확인한 목록: admin_action_logs, membership_transfers, product_passes,
  // contracts, locker_assignments, point_transactions, progress_records).
  it("cleanup 대상 membership id 집합(정확한 4개 product_name)", async () => {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin
      .from("memberships")
      .select("id, product_name")
      .eq("center_id", centerAId)
      .in("product_name", ["통합테스트 수강권", "통합테스트 수강권(P3)", "P0-6 테스트 무제한권", "USABLE-PASS-KIND 테스트 대여품"]);
    if (error) throw new Error(error.message);
    const ids = (data ?? []).map((m) => m.id);
    console.log(`=== cleanup 대상 membership 수: ${ids.length} ===`);
    (globalThis as any).__targetMembershipIds = ids;
  });

  it("cleanup 대상 orphan profile id 집합(P3 출결-대기용)", async () => {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin
      .from("profiles").select("id")
      .eq("account_id", userA.accountId).eq("is_primary", false).eq("name", "P3 출결-대기용");
    if (error) throw new Error(error.message);
    const ids = (data ?? []).map((p) => p.id);
    console.log(`=== cleanup 대상 orphan profile 수: ${ids.length} ===`);
    (globalThis as any).__targetProfileIds = ids;
  });

  it("admin_action_logs가 cleanup 대상을 참조하는 건수(membership_id/source_unassigned_id/reservation_id/member_profile_id)", async () => {
    const admin = getFixtureAdminClient();
    const membershipIds: string[] = (globalThis as any).__targetMembershipIds ?? [];
    const profileIds: string[] = (globalThis as any).__targetProfileIds ?? [];

    if (membershipIds.length > 0) {
      const { data: byMem, error: e1 } = await admin.from("admin_action_logs").select("id, action_type, reservation_id, membership_id, source_unassigned_id, member_profile_id, created_at").in("membership_id", membershipIds);
      if (e1) throw new Error(e1.message);
      console.log(`=== admin_action_logs.membership_id 참조: ${byMem!.length} ===`);
      for (const r of (byMem ?? []).slice(0, 20)) console.log(`  ${r.id} | ${r.action_type} | reservation_id=${r.reservation_id} | member_profile_id=${r.member_profile_id} | ${r.created_at}`);

      const { data: bySrc, error: e2 } = await admin.from("admin_action_logs").select("id, action_type, source_unassigned_id").in("source_unassigned_id", membershipIds);
      if (e2) throw new Error(e2.message);
      console.log(`=== admin_action_logs.source_unassigned_id 참조: ${bySrc!.length} ===`);
    }
    if (profileIds.length > 0) {
      const { data: byProfile, error: e3 } = await admin.from("admin_action_logs").select("id").in("member_profile_id", profileIds);
      if (e3) throw new Error(e3.message);
      console.log(`=== admin_action_logs.member_profile_id(orphan profile) 참조: ${byProfile!.length} ===`);
    }
  });

  it("admin_action_logs가 참조하는 reservation_id 중 cleanup 대상 membership의 reservations와 겹치는 것", async () => {
    const admin = getFixtureAdminClient();
    const membershipIds: string[] = (globalThis as any).__targetMembershipIds ?? [];
    if (membershipIds.length === 0) return;
    const { data: rsv, error: e1 } = await admin.from("reservations").select("id").in("membership_id", membershipIds);
    if (e1) throw new Error(e1.message);
    const reservationIds = (rsv ?? []).map((r) => r.id);
    console.log(`=== cleanup 대상 membership에 연결된 reservations 수: ${reservationIds.length} ===`);
    if (reservationIds.length === 0) return;
    const { data: logsByRes, error: e2 } = await admin.from("admin_action_logs").select("id, reservation_id, membership_id").in("reservation_id", reservationIds);
    if (e2) throw new Error(e2.message);
    console.log(`=== admin_action_logs.reservation_id 참조(대상 reservations 기준): ${logsByRes!.length} ===`);
  });

  it("나머지 memberships/profiles 참조 테이블 전수 조사", async () => {
    const admin = getFixtureAdminClient();
    const membershipIds: string[] = (globalThis as any).__targetMembershipIds ?? [];
    const profileIds: string[] = (globalThis as any).__targetProfileIds ?? [];

    if (membershipIds.length > 0) {
      for (const [table, col] of [["membership_transfers", "membership_id"], ["product_passes", "linked_membership_id"], ["contracts", "membership_id"]] as const) {
        const { data, error } = await admin.from(table).select("id").in(col, membershipIds);
        if (error) throw new Error(`${table}.${col} 조회 실패: ${error.message}`);
        console.log(`=== ${table}.${col} 참조(대상 membership 기준): ${data!.length} ===`);
      }
    }
    if (profileIds.length > 0) {
      for (const [table, col] of [["membership_transfers", "from_profile_id"], ["membership_transfers", "to_profile_id"], ["product_passes", "profile_id"], ["contracts", "profile_id"], ["locker_assignments", "profile_id"], ["point_transactions", "profile_id"], ["progress_records", "profile_id"]] as const) {
        const { data, error } = await admin.from(table).select("id").in(col, profileIds);
        if (error) throw new Error(`${table}.${col} 조회 실패: ${error.message}`);
        console.log(`=== ${table}.${col} 참조(대상 orphan profile 기준): ${data!.length} ===`);
      }
    }
  });

  it("검증: 지난번 실패한 cleanup 트랜잭션이 실제로 전부 롤백됐는지(원래 스냅샷과 비교)", async () => {
    const admin = getFixtureAdminClient();
    const { count: profCount } = await admin.from("profiles").select("id", { count: "exact", head: true })
      .eq("account_id", userA.accountId).eq("is_primary", false).eq("name", "P3 출결-대기용");
    const { count: memCount } = await admin.from("memberships").select("id", { count: "exact", head: true })
      .eq("center_id", centerAId).is("product_id", null).eq("product_name", "통합테스트 수강권");
    console.log(`=== 롤백 검증: 현재 orphan profile 수=${profCount} (직전 진단 16이었음), "통합테스트 수강권" 수=${memCount} (직전 진단 979 이상이었음, 캡 영향으로 정확한 총량은 아님) ===`);
  });
});
