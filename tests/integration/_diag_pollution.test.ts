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
  // ⚠ 직전 시도에서 target membership id 1000개를 .in()에 통째로 넣었다가 URL이 너무 길어
  // "Bad Request"가 났다 — 대신 (a) admin_action_logs는 center_id(단일 값)로, (b) 나머지는
  // userA/managerA 두 profile_id(작은 목록)로 좁혀서 조회한다. cleanup 대상 memberships는
  // 전부 이 두 profile_id에만 속한다는 것을 이미 별도로 확인했으므로(그 외 profile_id 0건)
  // 이 두 profile_id 기준 조회만으로 충분하다.
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

  const TARGET_PROFILE_IDS = ["689fd564-40d2-4c39-a687-5b6a6b220fbd", "bf0939f6-d676-43bd-a164-c021ad623063"]; // managerA, userA

  it("admin_action_logs — centerA 전체 건수 및 membership_id/reservation_id/member_profile_id 참조 유무", async () => {
    const admin = getFixtureAdminClient();
    const { count, error: countErr } = await admin.from("admin_action_logs").select("id", { count: "exact", head: true }).eq("center_id", centerAId);
    if (countErr) throw new Error(countErr.message);
    console.log(`=== admin_action_logs centerA 전체 건수: ${count} ===`);

    const { count: withMem, error: e1 } = await admin.from("admin_action_logs").select("id", { count: "exact", head: true }).eq("center_id", centerAId).not("membership_id", "is", null);
    if (e1) throw new Error(e1.message);
    console.log(`=== admin_action_logs centerA 중 membership_id NOT NULL: ${withMem} ===`);

    const { count: withSrc, error: e2 } = await admin.from("admin_action_logs").select("id", { count: "exact", head: true }).eq("center_id", centerAId).not("source_unassigned_id", "is", null);
    if (e2) throw new Error(e2.message);
    console.log(`=== admin_action_logs centerA 중 source_unassigned_id NOT NULL: ${withSrc} ===`);

    const { data: sample, error: e3 } = await admin.from("admin_action_logs").select("id, action_type, admin_id, member_profile_id, created_at").eq("center_id", centerAId).limit(5);
    if (e3) throw new Error(e3.message);
    console.log(`=== admin_action_logs 샘플(admin_id/member_profile_id가 테스트 계정인지 확인용) ===`);
    for (const r of sample ?? []) console.log(`  ${r.id} | ${r.action_type} | admin_id=${r.admin_id} | member_profile_id=${r.member_profile_id} | ${r.created_at}`);
    const nonTestAdmin = (sample ?? []).some((r) => r.admin_id !== managerA.accountId);
    const nonTestMember = (sample ?? []).some((r) => !TARGET_PROFILE_IDS.includes(r.member_profile_id));
    console.log(`=== 샘플 중 managerA 계정이 아닌 admin_id 존재: ${nonTestAdmin} / userA·managerA가 아닌 member_profile_id 존재: ${nonTestMember} ===`);
  });

  it("나머지 memberships/profiles 참조 테이블 — userA/managerA profile_id 기준 조사", async () => {
    const admin = getFixtureAdminClient();
    for (const [table, col] of [
      ["membership_transfers", "from_profile_id"], ["membership_transfers", "to_profile_id"],
      ["product_passes", "profile_id"], ["contracts", "profile_id"],
      ["locker_assignments", "profile_id"], ["point_transactions", "profile_id"],
      ["progress_records", "profile_id"],
    ] as const) {
      const { count, error } = await admin.from(table).select("id", { count: "exact", head: true }).in(col, TARGET_PROFILE_IDS);
      if (error) throw new Error(`${table}.${col} 조회 실패: ${error.message}`);
      console.log(`=== ${table}.${col} 참조(userA/managerA 기준): ${count} ===`);
    }
  });

  // 2026-08-09 v3 실행 결과: [3] guard(product_id is null + product_name + profile_id in
  // (userA, managerA))가 0건을 세었는데, 진단의 "롤백 검증"(profile_id 필터 없음)은 2525건을
  // 셌다 — v3의 profile_id 필터가 실제 분포와 안 맞는지, 아니면 product_name 텍스트 자체가
  // (한글 유니코드 정규화 등으로) 미묘하게 다른 값인지 실측으로 확인한다.
  it("'통합테스트 수강권'(product_id is null) 전체 모집단의 profile_id 분포", async () => {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin
      .from("memberships")
      .select("profile_id")
      .eq("center_id", centerAId)
      .is("product_id", null)
      .eq("product_name", "통합테스트 수강권")
      .limit(5000);
    if (error) throw new Error(error.message);
    const byProfile = new Map<string, number>();
    for (const r of data ?? []) byProfile.set(r.profile_id, (byProfile.get(r.profile_id) ?? 0) + 1);
    console.log(`=== profile_id 분포(응답 행 수 ${data!.length}, PostgREST 캡 가능성 있음) ===`);
    for (const [pid, count] of byProfile) {
      const isUserA = pid === userA.profileId;
      const isManagerA = pid === managerA.profileId;
      console.log(`  profile_id=${pid} | ${count}건 | userA와 일치=${isUserA} | managerA와 일치=${isManagerA}`);
    }
    console.log(`=== 비교 대상 값: userA.profileId=${userA.profileId}, managerA.profileId=${managerA.profileId} ===`);
  });

  it("'통합테스트 수강권' product_name의 바이트 수준 동일성 확인(유니코드 정규화 차이 의심)", async () => {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin
      .from("memberships")
      .select("product_name")
      .eq("center_id", centerAId)
      .is("product_id", null)
      .not("product_name", "is", null)
      .limit(2000);
    if (error) throw new Error(error.message);
    const distinct = new Set((data ?? []).map((r) => r.product_name));
    console.log(`=== product_id is null인 행들의 distinct product_name 값 목록 ===`);
    for (const name of distinct) {
      const bytes = Buffer.from(name, "utf8");
      console.log(`  "${name}" | length=${name.length} | utf8bytes=${bytes.length} | hex=${bytes.toString("hex")} | ===target?: ${name === "통합테스트 수강권"}`);
    }
    const targetBytes = Buffer.from("통합테스트 수강권", "utf8");
    console.log(`=== SQL/진단 스크립트가 사용하는 리터럴 "통합테스트 수강권" | length=${"통합테스트 수강권".length} | utf8bytes=${targetBytes.length} | hex=${targetBytes.toString("hex")} ===`);
  });

  it("product_id is null 조건 자체가 실제 분포와 맞는지(product_name만으로 필터링한 경우와 비교)", async () => {
    const admin = getFixtureAdminClient();
    const { count: withNullProduct, error: e1 } = await admin.from("memberships").select("id", { count: "exact", head: true })
      .eq("center_id", centerAId).is("product_id", null).eq("product_name", "통합테스트 수강권");
    if (e1) throw new Error(e1.message);
    const { count: anyProduct, error: e2 } = await admin.from("memberships").select("id", { count: "exact", head: true })
      .eq("center_id", centerAId).eq("product_name", "통합테스트 수강권");
    if (e2) throw new Error(e2.message);
    console.log(`=== product_id is null AND product_name 일치: ${withNullProduct} / product_name만 일치(product_id 무관): ${anyProduct} ===`);

    const { count: userAOnly, error: e3 } = await admin.from("memberships").select("id", { count: "exact", head: true })
      .eq("center_id", centerAId).is("product_id", null).eq("product_name", "통합테스트 수강권").eq("profile_id", userA.profileId);
    if (e3) throw new Error(e3.message);
    const { count: managerAOnly, error: e4 } = await admin.from("memberships").select("id", { count: "exact", head: true })
      .eq("center_id", centerAId).is("product_id", null).eq("product_name", "통합테스트 수강권").eq("profile_id", managerA.profileId);
    if (e4) throw new Error(e4.message);
    const { count: bothIn, error: e5 } = await admin.from("memberships").select("id", { count: "exact", head: true })
      .eq("center_id", centerAId).is("product_id", null).eq("product_name", "통합테스트 수강권").in("profile_id", [userA.profileId, managerA.profileId]);
    if (e5) throw new Error(e5.message);
    console.log(`=== profile_id=userA만: ${userAOnly} / profile_id=managerA만: ${managerAOnly} / .in([userA,managerA]): ${bothIn} (v3 guard와 동일 조건) ===`);
  });

  it("status/center_id/created_at 분포 및 다른 center_id 혼입 여부", async () => {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin
      .from("memberships")
      .select("status, center_id, created_at")
      .is("product_id", null)
      .eq("product_name", "통합테스트 수강권")
      .limit(5000);
    if (error) throw new Error(error.message);
    const byStatus = new Map<string, number>();
    const byCenter = new Map<string, number>();
    let minCreated = "", maxCreated = "";
    for (const r of data ?? []) {
      byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      byCenter.set(r.center_id, (byCenter.get(r.center_id) ?? 0) + 1);
      if (!minCreated || r.created_at < minCreated) minCreated = r.created_at;
      if (!maxCreated || r.created_at > maxCreated) maxCreated = r.created_at;
    }
    console.log(`=== status 분포(center_id 무관, product_name 전체) ===`);
    for (const [s, c] of byStatus) console.log(`  status=${s}: ${c}건`);
    console.log(`=== center_id 분포(다른 센터 혼입 여부) ===`);
    for (const [cid, c] of byCenter) console.log(`  center_id=${cid} | centerA와 일치=${cid === centerAId} | ${c}건`);
    console.log(`=== created_at 범위: ${minCreated} ~ ${maxCreated} (응답 ${data!.length}행 기준) ===`);
  });

  // 2026-08-09 재진단: "통합테스트 수강권" 전체 모집단이 2525건→168건으로, managerA
  // 소유분이 488→0건으로 급감했고 미확인 profile_id가 새로 나타남 — 문자열/조건 버그가
  // 아니라 이 공유 dev DB 자체가 조사 도중에도 계속 바뀌고 있다는 뜻(다른 동시 세션/CI일
  // 가능성). "통합테스트 수강권"을 실제로 만드는 코드는 setup.ts의 createTestMembership()
  // 하나뿐임을 grep으로 재확인했으므로(다른 어떤 앱 코드도 이 정확한 문자열을 쓰지 않음),
  // 어느 profile_id에 속하든 이 조합(center_id + product_id is null + 이 정확한 product_name)
  // 자체가 테스트 전용이라는 근거는 여전히 유효하다 — 단지 미리 정해둔 2개 profile_id로
  // 좁힌 게 이 시점의 실제 분포와 안 맞았을 뿐. 새로 나타난 profile_id가 진짜 테스트
  // 계정인지 계정/센터까지 교차검증한다.
  it("미확인 profile_id 교차검증(계정/센터 소속 확인)", async () => {
    const admin = getFixtureAdminClient();
    const { data: mems, error: e1 } = await admin
      .from("memberships").select("profile_id")
      .eq("center_id", centerAId).is("product_id", null).eq("product_name", "통합테스트 수강권")
      .limit(1000);
    if (e1) throw new Error(e1.message);
    const distinctProfileIds = [...new Set((mems ?? []).map((m) => m.profile_id))];
    console.log(`=== 현재 시점 distinct profile_id 전체 목록(${distinctProfileIds.length}개) ===`);
    for (const pid of distinctProfileIds) {
      const { data: prof, error: e2 } = await admin.from("profiles").select("id, account_id, name, is_primary").eq("id", pid).maybeSingle();
      if (e2) throw new Error(e2.message);
      if (!prof) { console.log(`  ${pid} | profiles에 없음(이미 삭제된 profile?)`); continue; }
      const { data: acct, error: e3 } = await admin.from("accounts").select("id, name, is_manager, is_member").eq("id", prof.account_id).maybeSingle();
      if (e3) throw new Error(e3.message);
      const { data: mc, error: e4 } = await admin.from("manager_centers").select("center_id, status").eq("account_id", prof.account_id);
      if (e4) throw new Error(e4.message);
      console.log(`  profile_id=${pid} | account_id=${prof.account_id} | account.name=${acct?.name} | is_manager=${acct?.is_manager} | is_member=${acct?.is_member} | manager_centers=${JSON.stringify(mc)}`);
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
