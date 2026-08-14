/*
  P3: class_allowed_products(수업별 사용 가능 수강권) — 서버 강제가 실제로 되는지 통합 테스트.

  기존 구조 감사 결과: reserve_class()(자동 매칭 경로)와 usable_memberships_for_classes()
  (회원 화면 목록)는 이미 class_allowed_products를 정확히 반영한다. 실제로 빠져 있던 것은
  reserve_with_membership()(회원이 화면에서 수강권을 "직접 선택"해 예약하는 경로) — 화면의
  목록 자체는 걸러져 있어 정상 사용에서는 안 드러나지만, RPC를 직접 호출하면(다른 화면
  버그·API 직접 호출 등) 허용되지 않은 수강권으로도 예약이 성립했다.

  fix_class_allowed_products_enforcement_draft_proposed.sql이 아직 Supabase에 적용되지
  않았다면 이 파일의 "거부돼야 하는" 테스트들은 실패한다(예상된 실패 — 최종 보고서
  "SQL 필요 여부"에 기록).
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { fetchPurchasableProductsByClass } from "../../lib/reservations";
import {
  switchToTestUser,
  signOutTestSession,
  type TestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  getFixtureAdminClient,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MEMBER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };

let managerA: TestUser;
let memberA: TestUser;
let centerAId: string;
let passX: { id: string };
let passY: { id: string };
let goodsZ: { id: string };
let foreignCenterId: string;
let foreignPassId: string;

const cleanupClassIds: string[] = [];

async function asManagerA() { await switchToTestUser(MANAGER_A.email, MANAGER_A.password); }
async function asMemberA() { await switchToTestUser(MEMBER_A.email, MEMBER_A.password); }

async function createNamedPassProduct(centerId: string, name: string, kind: "pass" | "goods" = "pass"): Promise<{ id: string }> {
  const admin = getFixtureAdminClient();
  const { data: existing } = await admin.from("products").select("id").eq("center_id", centerId).eq("name", name).eq("product_kind", kind).maybeSingle();
  if (existing) return { id: existing.id };
  const { data, error } = await admin
    .from("products")
    .insert({ center_id: centerId, name, product_kind: kind, pass_type: "count", total_count: 999, is_on_sale: true, is_active: true })
    .select("id").single();
  if (error || !data) throw new Error(`상품(${name}) 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id };
}

// get-or-create + self-healing refresh(2026-08 공유 센터 오염 진단 후 도입) — 예전엔 호출마다
// 무조건 insert해서 CI를 반복 실행할 때마다 같은 (profile, product) 조합에 "통합테스트
// 수강권(P3)" 행이 계속 쌓였다(진단에서 실제 확인) — class-allowed-products.spec.ts처럼
// "이 프로필의 사용 가능한 수강권 전체"를 나열하는 화면을 간헐적으로 타임아웃/오염시키던
// 원인 중 하나. createTestMembershipForProduct(setup.ts)와 동일 패턴.
async function createMembershipForProduct(centerId: string, profileId: string, productId: string): Promise<{ id: string }> {
  // 회원(memberA) 세션의 RLS로는 자기 자신의 memberships 행도 직접 insert할 수 없다(정상
  // 결제 RPC를 거쳐야 함) — 테스트 fixture라 admin(service-role) 클라이언트로 직접 만든다.
  const admin = getFixtureAdminClient();

  const { data: existing, error: findErr } = await admin
    .from("memberships")
    .select("id")
    .eq("profile_id", profileId)
    .eq("center_id", centerId)
    .eq("product_id", productId)
    .limit(1);
  if (findErr) throw new Error(`수강권 조회 실패: ${findErr.message}`);
  if (existing && existing.length > 0) {
    const { error: refreshErr } = await admin
      .from("memberships")
      .update({
        total_count: 5, remaining_count: 5,
        expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
        status: "active",
      })
      .eq("id", existing[0].id);
    if (refreshErr) throw new Error(`수강권 갱신 실패: ${refreshErr.message}`);
    return { id: existing[0].id };
  }

  const { data, error } = await admin
    .from("memberships")
    .insert({
      profile_id: profileId, center_id: centerId, product_id: productId,
      product_name: "통합테스트 수강권(P3)", pass_type: "count",
      total_count: 5, remaining_count: 5,
      expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      status: "active",
    })
    .select("id").single();
  if (error || !data) throw new Error(`수강권 생성 실패: ${error.message}`);
  return { id: data.id };
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  memberA = await switchToTestUser(MEMBER_A.email, MEMBER_A.password);

  await asManagerA();
  passX = await createNamedPassProduct(centerAId, "P3 통합-패스X");
  passY = await createNamedPassProduct(centerAId, "P3 통합-패스Y");
  goodsZ = await createNamedPassProduct(centerAId, "P3 통합-굿즈Z", "goods");

  // [2026-08-14 수정] CI가 중간에 죽으면(cancel-in-progress 등) afterAll이 실행되지
  // 못해 이 "타센터" fixture(+products)가 매 실행마다 새로 쌓였다(get-or-create가
  // 아니라 매번 무조건 insert였음 — 이미 이 이름으로 leaked된 행이 있어도 신경쓰지
  // 않고 또 만듦). getOrCreateOwnedTestCenter()와 동일한 관례로 이름 기준
  // get-or-create로 전환 — 이미 있으면 재사용, 없을 때만 새로 만든다. 앞으로는 절대
  // 누적되지 않는다(기존에 이미 쌓인 것은 별도 cleanup SQL로 정리, 이 파일과 무관).
  const admin = getFixtureAdminClient();
  const { data: existingFc } = await admin
    .from("centers").select("id").eq("name", "P3 통합-타센터").maybeSingle();
  if (existingFc) {
    foreignCenterId = (existingFc as any).id;
  } else {
    const { data: fc, error: fcErr } = await admin
      .from("centers").insert({ name: "P3 통합-타센터", status: "approved" }).select("id").single();
    if (fcErr || !fc) throw new Error(`타 센터 생성 실패: ${fcErr?.message ?? "no data"}`);
    foreignCenterId = fc.id;
  }
  const { data: existingFp } = await admin
    .from("products").select("id").eq("center_id", foreignCenterId).eq("name", "P3 통합-타센터패스").maybeSingle();
  if (existingFp) {
    foreignPassId = (existingFp as any).id;
  } else {
    const { data: fp, error: fpErr } = await admin
      .from("products")
      .insert({ center_id: foreignCenterId, name: "P3 통합-타센터패스", product_kind: "pass", pass_type: "count", total_count: 999, is_on_sale: true, is_active: true })
      .select("id").single();
    if (fpErr || !fp) throw new Error(`타 센터 상품 생성 실패: ${fpErr?.message ?? "no data"}`);
    foreignPassId = fp.id;
  }
}, 30000);

afterAll(async () => {
  await asManagerA();
  for (const id of cleanupClassIds) {
    await supabase.from("reservations").delete().eq("class_id", id);
    await supabase.from("classes").delete().eq("id", id);
  }
  // [2026-08-14 수정] foreignCenterId/foreignPassId는 이제 get-or-create로 재사용되는
  // 공유 fixture다(getOrCreateOwnedTestCenter()와 동일 철학) — 매 실행 끝마다 지웠다가
  // 다음 실행에서 또 만드는 건 get-or-create의 이점을 없애고 불필요한 DB write만
  // 늘린다. 더 이상 여기서 삭제하지 않는다.
  await signOutTestSession();
}, 30000);

beforeEach(async () => {
  await asManagerA();
});

describe("reserve_with_membership()의 class_allowed_products 서버 강제", () => {
  it("class_allowed_products 지정이 없으면(전체 허용) 어떤 pass로도 예약된다(대조군)", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P3 통합-전체허용", hoursFromNow: 60 });
    cleanupClassIds.push(cls.id);

    await asMemberA();
    const mem = await createMembershipForProduct(centerAId, memberA.profileId, passX.id);
    const res = await supabase.rpc("reserve_with_membership", { p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: mem.id });
    expect(res.error).toBeNull();
    expect(res.data.status).toBe("confirmed");
  });

  it("class_allowed_products에 지정된 pass면 정상 예약된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P3 통합-허용패스", hoursFromNow: 61 });
    cleanupClassIds.push(cls.id);
    const { error: linkErr } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: passX.id });
    expect(linkErr).toBeNull();

    await asMemberA();
    const mem = await createMembershipForProduct(centerAId, memberA.profileId, passX.id);
    const res = await supabase.rpc("reserve_with_membership", { p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: mem.id });
    expect(res.error).toBeNull();
    expect(res.data.status).toBe("confirmed");
  });

  it("class_allowed_products에 지정되지 않은 pass면 서버가 거부한다(회원 화면 우회 시도 가정)", async () => {
    // [수강권 허용 정책 변경, add_class_trainers_pass_selection_mode_draft_proposed.sql] RPC가
    // "class_allowed_products 행 존재 여부" 대신 classes.pass_selection_mode를 신뢰하도록
    // 바뀌었으므로, cap 행만 넣고 mode를 'selected'로 두지 않으면(기본값 'all') 이 테스트가
    // 검증하려는 거부가 더 이상 일어나지 않는다 — 반드시 함께 지정해야 함.
    const cls = await createFutureTestClass(centerAId, { title: "P3 통합-미허용패스", hoursFromNow: 62, passSelectionMode: "selected" });
    cleanupClassIds.push(cls.id);
    // passX만 허용 — passY는 허용 목록에 없음.
    const { error: linkErr } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: passX.id });
    expect(linkErr).toBeNull();

    await asMemberA();
    const memY = await createMembershipForProduct(centerAId, memberA.profileId, passY.id);
    // 회원 화면이라면 애초에 passY가 목록에 안 보이지만, RPC를 직접 호출하는 상황을 가정.
    const res = await supabase.rpc("reserve_with_membership", { p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: memY.id });
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toContain("사용할 수 없는 수강권");

    const { data: rows } = await supabase.from("reservations").select("id").eq("class_id", cls.id);
    expect((rows ?? []).length).toBe(0);
  });
});

describe("class_allowed_products INSERT RLS 강화 — 타 센터/goods 혼입 차단", () => {
  it("같은 센터의 pass 상품 연결은 허용된다(대조군)", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P3 통합-RLS대조군", hoursFromNow: 63 });
    cleanupClassIds.push(cls.id);
    const { error } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: passY.id });
    expect(error).toBeNull();
  });

  it("타 센터의 pass 상품을 연결하려 하면 RLS가 거부한다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P3 통합-RLS타센터차단", hoursFromNow: 64 });
    cleanupClassIds.push(cls.id);
    const { error } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: foreignPassId });
    expect(error).not.toBeNull();
  });

  it("goods 상품을 연결하려 하면 RLS가 거부한다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P3 통합-RLSgoods차단", hoursFromNow: 65 });
    cleanupClassIds.push(cls.id);
    const { error } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: goodsZ.id });
    expect(error).not.toBeNull();
  });
});

describe("fetchPurchasableProductsByClass()의 goods 노출 버그 수정 (P3 감사에서 발견, SQL 무관 — 순수 코드)", () => {
  // TEST_USER_A는 이 세션 내내 재사용된 계정이라 기본 프로필엔 이미 pass 수강권이 잔뜩
  // 쌓여 있어 "사용 가능한 수강권이 0건"인 상태를 재현할 수 없다 — memberships는
  // account가 아니라 profile 단위라서, 그 계정에 방금 만든 새 프로필(추가 회원)은 항상
  // 수강권 0건에서 시작한다는 점을 이용해 깨끗한 상태를 만든다.
  let freshProfileId: string;

  beforeAll(async () => {
    await asManagerA(); // admin insert 전 세션은 상관없음(getFixtureAdminClient는 RLS 우회)
    const admin = getFixtureAdminClient();
    const { data, error } = await admin
      .from("profiles")
      .insert({ account_id: memberA.accountId, name: "P3 통합-빈프로필", is_primary: false })
      .select("id").single();
    if (error || !data) throw new Error(`빈 프로필 생성 실패: ${error?.message ?? "no data"}`);
    freshProfileId = data.id;
  });

  afterAll(async () => {
    const admin = getFixtureAdminClient();
    if (freshProfileId) await admin.from("profiles").delete().eq("id", freshProfileId);
  });

  it("class_allowed_products 지정이 없는 수업 + 사용 가능한 pass가 0건이면, 추천 목록에 goods가 섞이지 않는다", async () => {
    await asManagerA();
    const cls = await createFutureTestClass(centerAId, { title: "P3 통합-구매추천goods제외", hoursFromNow: 66 });
    cleanupClassIds.push(cls.id);

    const result = await fetchPurchasableProductsByClass([{ classId: cls.id, centerId: centerAId }], [freshProfileId]);
    const names = (result[cls.id] ?? []).map((p) => p.productName);
    expect(names).toContain("P3 통합-패스X"); // pass는 추천에 나와야 함
    expect(names).not.toContain("P3 통합-굿즈Z"); // goods는 어떤 경우에도 제외
    expect((result[cls.id] ?? []).every((p) => p.kind === "pass")).toBe(true);
  });
});
