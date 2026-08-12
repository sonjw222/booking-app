/*
  manager_centers 권한 모델 완결 회귀 테스트 — SEC-101 + SEC-112 + SEC-113 +
  has_permission() defense-in-depth 통합.

  ⚠ 이 파일은 fix_manager_centers_privilege_model_draft_proposed.sql이 Supabase에
  적용되기 전까지는 A/B/C(self-join)/G/H(self-promote)/K/M(orphan)/N(mismatch trigger)이
  실패한다(취약점이 실제로 열려 있다는 것을 보여주는 것 자체가 목적). SQL 적용 후에는
  전부 GREEN이어야 정상이다.

  이 파일은 tests/integration/manager-centers-privilege-escalation.test.ts(SEC-101/112
  전용, A~T 명명)를 SEC-MC-A~S 명명으로 재구성·확장한 canonical 버전이다 — role_id/
  center_id mismatch 직접 차단(N)과 has_permission() defense-in-depth(O)가 새로
  추가됐다. 기존 파일은 이 파일로 흡수됐으므로 사용자 확인 후 삭제 검토(이 세션에서는
  삭제하지 않음).

  getOrCreateOwnedTestCenter()(setup.ts)는 service_role(admin) client로 manager_centers를
  직접 insert/role_id까지 채워서 만들기 때문에 RLS 정책 변경의 영향을 받지 않지만,
  신규 trigger(role_id/center_id 정합성)는 service_role 쓰기에도 적용되므로 이 헬퍼가
  만드는 정상 데이터가 trigger를 통과하는지도 간접적으로 매 테스트마다 검증된다.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  signOutTestSession,
  type TestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const USER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };
const USER_B = { email: "TEST_USER_B_EMAIL", password: "TEST_USER_B_PASSWORD" };

let managerA: TestUser;
let userA: TestUser;
let userB: TestUser;
let centerAId: string;
let ownerRoleIdOfCenterA: string;
let trainerRoleIdOfCenterA: string;

const cleanupManagerCenterIds: string[] = [];
let bootstrapCenterId: string | null = null; // SEC-MC-D/E/F/G/H/I/J용
let secondBootstrapCenterId: string | null = null; // SEC-MC-H(타 센터 role_id 주입)용
let orphanTestCenterId: string | null = null; // SEC-MC-K/L/M용
let transferTestCenterId: string | null = null; // 정상 핸드오프 절차 확인용(참고, 요구 목록엔 없지만 보존)
let mismatchProbeCenterId: string | null = null; // SEC-MC-N용

async function asManagerA() { await switchToTestUser(MANAGER_A.email, MANAGER_A.password); }
async function asUserA() { await switchToTestUser(USER_A.email, USER_A.password); }
async function asUserB() { await switchToTestUser(USER_B.email, USER_B.password); }

async function createBootstrapCenter(owner: TestUser, namePrefix: string): Promise<string> {
  const newCenterId = crypto.randomUUID();
  const { error: centerErr } = await supabase.from("centers").insert({
    id: newCenterId,
    name: `${namePrefix}-${newCenterId.slice(0, 8)}`,
    address: "테스트",
    phone: "010-0000-0000",
    business_number: `000-00-${Math.floor(Math.random() * 90000 + 10000)}`,
  });
  if (centerErr) throw new Error(`센터 생성 실패: ${centerErr.message}`);
  const { error: mcErr } = await supabase
    .from("manager_centers")
    .insert({ account_id: owner.accountId, center_id: newCenterId, status: "active" });
  if (mcErr) throw new Error(`매니저 연결 실패: ${mcErr.message}`);
  const { data: ownerRole, error: roleErr } = await supabase
    .from("center_roles")
    .select("id")
    .eq("center_id", newCenterId)
    .eq("role_key", "owner")
    .single();
  if (roleErr || !ownerRole) throw new Error(`오너 role 조회 실패: ${roleErr?.message}`);
  const { error: updErr } = await supabase
    .from("manager_centers")
    .update({ role_id: (ownerRole as any).id })
    .eq("account_id", owner.accountId)
    .eq("center_id", newCenterId);
  if (updErr) throw new Error(`오너 전환 실패: ${updErr.message}`);
  return newCenterId;
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  userA = await switchToTestUser(USER_A.email, USER_A.password);
  userB = await switchToTestUser(USER_B.email, USER_B.password);

  const admin = getFixtureAdminClient();
  const { data: roles, error } = await admin
    .from("center_roles")
    .select("id, role_key, is_owner")
    .eq("center_id", centerAId);
  if (error || !roles) throw new Error(`centerA 역할 조회 실패: ${error?.message ?? "no data"}`);
  const ownerRole = roles.find((r: any) => r.is_owner === true);
  const trainerRole = roles.find((r: any) => r.role_key === "trainer");
  if (!ownerRole || !trainerRole) throw new Error("centerA 기본 역할(오너/강사) 조회 실패");
  ownerRoleIdOfCenterA = (ownerRole as any).id;
  trainerRoleIdOfCenterA = (trainerRole as any).id;
}, 30000);

afterAll(async () => {
  const admin = getFixtureAdminClient();
  if (cleanupManagerCenterIds.length > 0) {
    await admin.from("manager_centers").delete().in("id", cleanupManagerCenterIds);
  }
  for (const cid of [bootstrapCenterId, secondBootstrapCenterId, orphanTestCenterId, transferTestCenterId, mismatchProbeCenterId]) {
    if (!cid) continue;
    await admin.from("manager_centers").delete().eq("center_id", cid);
    await admin.from("center_roles").delete().eq("center_id", cid);
    await admin.from("centers").delete().eq("id", cid);
  }
  await signOutTestSession();
}, 30000);

beforeEach(async () => {
  await asUserA();
});

describe("SEC-MC-A~C: 일반 회원의 self-join(SEC-101) — 반드시 거부돼야 함", () => {
  it("SEC-MC-A: 일반 회원 → 기존 타센터(centerA) self INSERT 거부", async () => {
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: userA.accountId, center_id: centerAId, status: "pending" })
      .select("id");
    if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
    expect(error).not.toBeNull();
  });

  it("SEC-MC-B: status='active' 명시 지정 self INSERT도 거부", async () => {
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: userA.accountId, center_id: centerAId, status: "active" })
      .select("id");
    if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
    expect(error).not.toBeNull();
  });

  it("SEC-MC-C: 임의 role_id(centerA 오너 role)까지 주입한 self INSERT도 거부", async () => {
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: userA.accountId, center_id: centerAId, status: "active", role_id: ownerRoleIdOfCenterA })
      .select("id");
    if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
    expect(error).not.toBeNull();
  });
});

describe("SEC-MC-D: 정상 신규 센터 생성 → 최초 owner bootstrap은 계속 성공해야 함", () => {
  it("SEC-MC-D: 막 만든 센터에 self-insert(role_id null, status active) 후 오너 role로 self-UPDATE 전환까지 성공한다", async () => {
    bootstrapCenterId = await createBootstrapCenter(userA, "SEC-MC-D");
    const { data: check } = await supabase
      .from("manager_centers")
      .select("role_id, status")
      .eq("account_id", userA.accountId)
      .eq("center_id", bootstrapCenterId)
      .maybeSingle();
    expect((check as any)?.role_id).toBe(
      (await supabase.from("center_roles").select("id").eq("center_id", bootstrapCenterId).eq("role_key", "owner").single()).data
        ?.id
    );
    expect((check as any)?.status).toBe("active");
  });

  it("부트스트랩 재시도 방지: 이미 자기 오너 행이 있는 센터에 같은 계정으로 다시 self-insert하면 거부된다", async () => {
    if (!bootstrapCenterId) throw new Error("선행 SEC-MC-D 테스트가 먼저 실행돼야 합니다");
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: userA.accountId, center_id: bootstrapCenterId, status: "active" })
      .select("id");
    if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
    expect(error).not.toBeNull();
  });
});

describe("SEC-MC-E~F: 정상 스태프 초대는 그대로 동작해야 함", () => {
  it("SEC-MC-E: facility.staff.create 권한을 가진 오너(managerA)가 다른 계정(userB)을 centerA에 초대하면 성공한다", async () => {
    await asManagerA();
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: userB.accountId, center_id: centerAId, role_id: trainerRoleIdOfCenterA, status: "active" })
      .select("id")
      .maybeSingle();
    if (!error && data) cleanupManagerCenterIds.push((data as any).id);
    expect(error).toBeNull();
  });

  it("SEC-MC-F: 권한 없는 일반 회원(userA)은 다른 계정(userB)을 centerA에 초대할 수 없다", async () => {
    await asUserA();
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: userB.accountId, center_id: centerAId, role_id: trainerRoleIdOfCenterA, status: "active" })
      .select("id");
    if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
    expect(error).not.toBeNull();
  });
});

describe("SEC-MC-G~H, O: SEC-112 self-promote 차단 + cross-center role injection 후 has_permission false", () => {
  it("SEC-MC-G: 저권한 스태프(userB)가 자기 role_id를 centerA의 오너 role로 직접 UPDATE하면 거부된다(같은 센터 self-promote)", async () => {
    await asManagerA();
    const { data: staffRow } = await supabase
      .from("manager_centers")
      .select("id, role_id")
      .eq("account_id", userB.accountId)
      .eq("center_id", centerAId)
      .maybeSingle();
    if (!staffRow) {
      const { data: invited } = await supabase
        .from("manager_centers")
        .insert({ account_id: userB.accountId, center_id: centerAId, role_id: trainerRoleIdOfCenterA, status: "active" })
        .select("id")
        .single();
      if (invited) cleanupManagerCenterIds.push((invited as any).id);
    }

    await asUserB();
    const { error } = await supabase
      .from("manager_centers")
      .update({ role_id: ownerRoleIdOfCenterA })
      .eq("account_id", userB.accountId)
      .eq("center_id", centerAId);
    expect(error).not.toBeNull();

    const admin = getFixtureAdminClient();
    const { data: check } = await admin
      .from("manager_centers")
      .select("role_id")
      .eq("account_id", userB.accountId)
      .eq("center_id", centerAId)
      .single();
    expect((check as any)?.role_id).not.toBe(ownerRoleIdOfCenterA);
  });

  it("SEC-MC-H, O: 저권한 스태프(userB)가 자기 소유의 다른 센터(secondBootstrap)에서 오너 role_id를 얻어 centerA 행에 주입해도 거부되고, has_permission()도 false다", async () => {
    await asUserB();
    secondBootstrapCenterId = await createBootstrapCenter(userB, "SEC-MC-H");
    const { data: secondOwnerRole } = await supabase
      .from("center_roles")
      .select("id")
      .eq("center_id", secondBootstrapCenterId)
      .eq("role_key", "owner")
      .single();

    const { error: injectErr } = await supabase
      .from("manager_centers")
      .update({ role_id: (secondOwnerRole as any).id })
      .eq("account_id", userB.accountId)
      .eq("center_id", centerAId);
    expect(injectErr).not.toBeNull();

    // 방어가 정말 작동했는지 has_permission()으로도 재확인(O) — centerA에서 여전히
    // 오너 권한(facility.role_permission 등 오너 전용 액션)이 없어야 한다.
    const { data: hp, error: hpErr } = await supabase.rpc("has_permission", {
      p_center_id: centerAId,
      p_permission: "facility.role_permission",
    });
    expect(hpErr).toBeNull();
    expect(hp).toBe(false);
  });
});

describe("SEC-MC-I~J: 정상 권한 변경 + 다중센터·다중역할 보존", () => {
  it("SEC-MC-I: 권한 있는 오너(managerA)는 저권한 스태프(userB)의 role을 정상적으로 변경할 수 있다", async () => {
    await asManagerA();
    const { data: staffRow } = await supabase
      .from("manager_centers")
      .select("id")
      .eq("account_id", userB.accountId)
      .eq("center_id", centerAId)
      .maybeSingle();
    if (!staffRow) {
      const { data: invited } = await supabase
        .from("manager_centers")
        .insert({ account_id: userB.accountId, center_id: centerAId, role_id: trainerRoleIdOfCenterA, status: "active" })
        .select("id")
        .single();
      if (invited) cleanupManagerCenterIds.push((invited as any).id);
    }
    const { error } = await supabase
      .from("manager_centers")
      .update({ role_id: trainerRoleIdOfCenterA })
      .eq("account_id", userB.accountId)
      .eq("center_id", centerAId);
    expect(error).toBeNull();
  });

  it("SEC-MC-J: 한 계정(userB)이 여러 센터(centerA 스태프 + secondBootstrap 오너)에서 서로 다른 역할을 갖는 정상 케이스는 그대로 유지된다", async () => {
    await asUserB();
    const { data, error } = await supabase
      .from("manager_centers")
      .select("center_id")
      .eq("account_id", userB.accountId)
      .eq("status", "active");
    expect(error).toBeNull();
    const centerIds = (data ?? []).map((r: any) => r.center_id);
    expect(centerIds).toContain(centerAId);
    if (secondBootstrapCenterId) expect(centerIds).toContain(secondBootstrapCenterId);
  });
});

describe("SEC-MC-K~M: 마지막 행 self-delete 차단(SEC-113) — orphan → takeover 불가", () => {
  it("SEC-MC-K: 센터에 자기 자신 하나만 남아있으면 self-delete가 거부된다(orphan 방지)", async () => {
    await asUserA();
    orphanTestCenterId = await createBootstrapCenter(userA, "SEC-MC-K");

    const { error: delErr } = await supabase
      .from("manager_centers")
      .delete()
      .eq("account_id", userA.accountId)
      .eq("center_id", orphanTestCenterId);
    void delErr; // RLS는 대상 0건이면 error 없이 조용히 0행 삭제로 끝날 수 있어 아래 실측으로 판정.

    const admin = getFixtureAdminClient();
    const { data: remaining, error: countErr } = await admin
      .from("manager_centers")
      .select("id")
      .eq("center_id", orphanTestCenterId);
    expect(countErr).toBeNull();
    expect((remaining ?? []).length).toBe(1);
  });

  it("SEC-MC-L: 다른 active manager가 남아있으면 본인 staff 행 self-delete는 기존 정책대로 허용된다", async () => {
    await asManagerA();
    const { data: invited, error: inviteErr } = await supabase
      .from("manager_centers")
      .insert({ account_id: userA.accountId, center_id: centerAId, role_id: trainerRoleIdOfCenterA, status: "active" })
      .select("id")
      .maybeSingle();
    if (!inviteErr && invited) cleanupManagerCenterIds.push((invited as any).id);

    await asUserA();
    const { error: delErr } = await supabase
      .from("manager_centers")
      .delete()
      .eq("account_id", userA.accountId)
      .eq("center_id", centerAId);
    expect(delErr).toBeNull();

    const admin = getFixtureAdminClient();
    const { data: check } = await admin
      .from("manager_centers")
      .select("id")
      .eq("account_id", userA.accountId)
      .eq("center_id", centerAId);
    expect((check ?? []).length).toBe(0);
  });

  it("SEC-MC-M: K에서 self-delete가 거부됐으므로, 그 센터는 여전히 소유자가 있어 제3자(managerA)가 self-join(orphan takeover)할 수 없다", async () => {
    if (!orphanTestCenterId) throw new Error("선행 SEC-MC-K 테스트가 먼저 실행돼야 합니다");
    await asManagerA();
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: managerA.accountId, center_id: orphanTestCenterId, status: "active" })
      .select("id");
    if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
    expect(error).not.toBeNull();
  });
});

describe("SEC-MC-N: role_id/center_id mismatch는 어떤 쓰기 경로로도(RLS 우회 포함) 차단된다", () => {
  it("SEC-MC-N: service_role(admin) client로도 mismatch 행을 직접 INSERT할 수 없다(테이블 레벨 trigger 방어)", async () => {
    await asUserA();
    mismatchProbeCenterId = await createBootstrapCenter(userA, "SEC-MC-N-A");
    const otherCenterId = await createBootstrapCenter(userA, "SEC-MC-N-B");
    cleanupManagerCenterIds; // no-op, 정리 대상은 아래 afterAll의 orphan 목록에 없으므로 수동 추적
    const admin = getFixtureAdminClient();
    const { data: otherOwnerRole } = await admin
      .from("center_roles")
      .select("id")
      .eq("center_id", otherCenterId)
      .eq("role_key", "owner")
      .single();

    // RLS를 완전히 우회하는 service_role client로도, mismatchProbeCenterId 행의
    // role_id에 otherCenterId 소속 role_id를 넣으려 하면 trigger가 막아야 한다.
    const { error } = await admin
      .from("manager_centers")
      .update({ role_id: (otherOwnerRole as any).id })
      .eq("account_id", userA.accountId)
      .eq("center_id", mismatchProbeCenterId);
    expect(error).not.toBeNull();

    // 정리(otherCenterId는 afterAll 추적 목록에 없으므로 여기서 직접 정리)
    await admin.from("manager_centers").delete().eq("center_id", otherCenterId);
    await admin.from("center_roles").delete().eq("center_id", otherCenterId);
    await admin.from("centers").delete().eq("id", otherCenterId);
  });
});

describe("SEC-MC-P~S: self-join/self-promote 차단 후 다운스트림 공격 경로 재확인", () => {
  it("SEC-MC-P: centerA에 발판을 얻지 못한 userA는 centerA의 classes를 수정할 수 없다", async () => {
    await asUserA();
    const { error } = await supabase
      .from("classes")
      .insert({ center_id: centerAId, title: "SEC-MC-P 공격시도", start_time: new Date().toISOString(), end_time: new Date().toISOString() });
    expect(error).not.toBeNull();
  });

  it("SEC-MC-Q: centerA에 발판을 얻지 못한 userA는 centers(centerA) 정보를 수정할 수 없다", async () => {
    await asUserA();
    await supabase.from("centers").update({ name: "SEC-MC-Q 공격시도" }).eq("id", centerAId);
    const { data: check } = await supabase.from("centers").select("name").eq("id", centerAId).maybeSingle();
    expect((check as any)?.name).not.toBe("SEC-MC-Q 공격시도");
  });

  it("SEC-MC-R: centerA에 발판을 얻지 못한 userA는 centerA의 reservations를 조회할 수 없다(매니저 조회 정책 미충족)", async () => {
    await asUserA();
    const { data, error } = await supabase
      .from("reservations")
      .select("id")
      .neq("profile_id", userA.profileId);
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it("SEC-MC-S: centerA에 발판을 얻지 못한 userA는 centerA의 products를 수정할 수 없다", async () => {
    await asUserA();
    const { data: existingProduct } = await supabase.from("products").select("id").eq("center_id", centerAId).limit(1).maybeSingle();
    if (existingProduct) {
      await supabase.from("products").update({ name: "SEC-MC-S 공격시도" }).eq("id", (existingProduct as any).id);
      const { data: check } = await supabase.from("products").select("name").eq("id", (existingProduct as any).id).maybeSingle();
      expect((check as any)?.name).not.toBe("SEC-MC-S 공격시도");
    }
    const { error: insertErr } = await supabase
      .from("products")
      .insert({ center_id: centerAId, name: "SEC-MC-S 신규상품 공격시도", price: 1000 });
    expect(insertErr).not.toBeNull();
  });
});
