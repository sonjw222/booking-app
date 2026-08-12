/*
  SEC-101 + SEC-112 + SEC-113(전부 P0) 통합 회귀 테스트 — manager_centers 권한 상승 3건.

  ⚠ 이 파일은 fix_manager_centers_privilege_escalation_draft_proposed.sql이 Supabase에
  적용되기 전까지는 A/B/C(self-join)와 G/H/J(self-promote)와 P/S(orphan self-delete/
  self-claim)가 실패한다(취약점이 실제로 열려 있다는 것을 보여주는 것 자체가 목적).
  SQL 적용 후에는 전부 통과해야 한다. 이 세션에서는 SQL을 실행하지 않았으므로 이
  파일도 아직 실행하지 않았다(static 작성만).

  대체한 파일: tests/integration/manager-centers-self-join-security.test.ts(SEC-101 단독
  버전)는 이 파일로 흡수·확장됐다 — 삭제는 사용자 확인 후 별도로 처리(이 세션에서는
  건드리지 않음, 두 파일이 당분간 공존해도 서로 충돌하지 않는다).

  getOrCreateOwnedTestCenter()(setup.ts)는 service_role(admin) client로 manager_centers를
  직접 insert/role_id까지 채워서 만들기 때문에 이번 정책 변경의 영향을 받지 않는다
  (RLS를 아예 거치지 않음) — 기존 테스트 스위트 전체에 회귀가 없다는 근거.
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
let trainerRoleIdOfCenterA: string; // "낮은 권한 역할"로 미리 초대해 SEC-112를 재현할 때 사용

const cleanupManagerCenterIds: string[] = [];
let bootstrapCenterId: string | null = null; // SEC-D/K가 만드는 완전히 새 센터
let secondBootstrapCenterId: string | null = null; // SEC-J(타 센터 role_id 주입)용 두 번째 센터
let orphanTestCenterId: string | null = null; // SEC-P/Q/S용 전용 센터
let transferTestCenterId: string | null = null; // SEC-T(오너 핸드오프)용 전용 센터

async function asManagerA() { await switchToTestUser(MANAGER_A.email, MANAGER_A.password); }
async function asUserA() { await switchToTestUser(USER_A.email, USER_A.password); }
async function asUserB() { await switchToTestUser(USER_B.email, USER_B.password); }

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
  for (const cid of [bootstrapCenterId, secondBootstrapCenterId, orphanTestCenterId, transferTestCenterId]) {
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

describe("A~C: 일반 회원의 manager_centers self-join(SEC-101) — 반드시 거부돼야 함", () => {
  it("A: 기존 타 센터(centerA)에 자기 자신을 그냥 추가하면 거부된다", async () => {
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: userA.accountId, center_id: centerAId, status: "pending" })
      .select("id");
    if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
    expect(error).not.toBeNull();
  });

  it("B: 같은 공격 + status='active' 명시 지정 — 거부된다", async () => {
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: userA.accountId, center_id: centerAId, status: "active" })
      .select("id");
    if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
    expect(error).not.toBeNull();
  });

  it("C: 같은 공격 + centerA 오너 role_id까지 주입 — 거부된다", async () => {
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: userA.accountId, center_id: centerAId, status: "active", role_id: ownerRoleIdOfCenterA })
      .select("id");
    if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
    expect(error).not.toBeNull();
  });
});

describe("D, K: 정상 센터 생성 → 최초 오너 bootstrap은 계속 정상 동작해야 함", () => {
  it("D+K: 막 만든 센터에 self-insert(role_id null, status active) 후 오너 role로 self-UPDATE 전환까지 성공한다", async () => {
    const newCenterId = crypto.randomUUID();
    const { error: centerErr } = await supabase
      .from("centers")
      .insert({ id: newCenterId, name: "SEC-D/K 부트스트랩 테스트센터", address: "테스트", phone: "010-0000-0000", business_number: "000-00-00000" });
    expect(centerErr).toBeNull();
    bootstrapCenterId = newCenterId;

    const { error: mcErr } = await supabase
      .from("manager_centers")
      .insert({ account_id: userA.accountId, center_id: newCenterId, status: "active" });
    expect(mcErr).toBeNull();

    const { data: ownerRole, error: roleErr } = await supabase
      .from("center_roles")
      .select("id")
      .eq("center_id", newCenterId)
      .eq("role_key", "owner")
      .single();
    expect(roleErr).toBeNull();

    // K: null → 이 센터의 오너 role로 전환(부트스트랩 1회 self-UPDATE)
    const { error: updErr } = await supabase
      .from("manager_centers")
      .update({ role_id: (ownerRole as any).id })
      .eq("account_id", userA.accountId)
      .eq("center_id", newCenterId);
    expect(updErr).toBeNull();

    const { data: check } = await supabase
      .from("manager_centers")
      .select("role_id, status")
      .eq("account_id", userA.accountId)
      .eq("center_id", newCenterId)
      .maybeSingle();
    expect((check as any)?.role_id).toBe((ownerRole as any).id);
    expect((check as any)?.status).toBe("active");
  });

  it("부트스트랩 재시도 방지: 이미 자기 오너 행이 있는 센터에 같은 계정으로 다시 self-insert하면 거부된다", async () => {
    if (!bootstrapCenterId) throw new Error("선행 D/K 테스트가 먼저 실행돼야 합니다");
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: userA.accountId, center_id: bootstrapCenterId, status: "active" })
      .select("id");
    if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
    expect(error).not.toBeNull();
  });
});

describe("E~F: 정상 스태프 초대(오너 스태프 초대 정책)는 그대로 동작해야 함", () => {
  it("E: facility.staff.create 권한을 가진 오너(managerA)가 다른 계정(userB)을 centerA에 초대하면 성공한다", async () => {
    await asManagerA();
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: userB.accountId, center_id: centerAId, status: "active", role_id: trainerRoleIdOfCenterA })
      .select("id");
    expect(error).toBeNull();
    if (data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
  });

  it("F: 권한 없는 일반 회원(userA)은 다른 계정(userB)을 centerA에 초대할 수 없다", async () => {
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: userB.accountId, center_id: centerAId, status: "active" })
      .select("id");
    if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
    expect(error).not.toBeNull();
  });
});

describe("G, H, J: SEC-112 — 이미 초대된 저권한 스태프의 self-promote 차단", () => {
  let lowPrivStaffRowId: string;

  beforeAll(async () => {
    // userB를 centerA에 "강사"(권한 없음) role로 정상 초대해둔다(오너 경유, admin 아님 —
    // 실제 RLS 경로를 그대로 태우기 위함).
    await asManagerA();
    const admin = getFixtureAdminClient();
    const { data: existing } = await admin
      .from("manager_centers").select("id").eq("account_id", userB.accountId).eq("center_id", centerAId).maybeSingle();
    if (existing) {
      lowPrivStaffRowId = (existing as any).id;
      await admin.from("manager_centers").update({ role_id: trainerRoleIdOfCenterA, status: "active" }).eq("id", lowPrivStaffRowId);
    } else {
      const { data, error } = await supabase
        .from("manager_centers")
        .insert({ account_id: userB.accountId, center_id: centerAId, status: "active", role_id: trainerRoleIdOfCenterA })
        .select("id").single();
      if (error || !data) throw new Error(`저권한 스태프 fixture 생성 실패: ${error?.message}`);
      lowPrivStaffRowId = (data as any).id;
      cleanupManagerCenterIds.push(lowPrivStaffRowId);
    }
  });

  it("G: 저권한 스태프(userB)가 자기 role_id를 centerA의 오너 role로 직접 UPDATE하면 거부된다(같은 센터 self-promote)", async () => {
    await asUserB();
    const { data, error } = await supabase
      .from("manager_centers")
      .update({ role_id: ownerRoleIdOfCenterA })
      .eq("id", lowPrivStaffRowId)
      .select("id");
    // RLS가 막으면 매칭 0건으로 조용히 실패할 수도 있으므로 실제 반영 여부까지 재확인한다.
    expect((data ?? []).length === 0 || error !== null).toBe(true);
    const { data: check } = await supabase.from("manager_centers").select("role_id").eq("id", lowPrivStaffRowId).maybeSingle();
    expect((check as any)?.role_id).toBe(trainerRoleIdOfCenterA);
  });

  it("H: 저권한 스태프(userB)가 자기 role_id를 null로 되돌려 부트스트랩 상태를 재현한 뒤 다시 셀프승격을 노려도(2단계 우회 시도) 첫 단계부터 막힌다", async () => {
    // USING 절이 "role_id가 이미 null이 아닌 내 행"은 self 분기 후보에서 아예 제외하므로,
    // "role_id를 null로 되돌리는 것" 자체가 이미 self 분기로는 대상 행이 안 잡힌다
    // (has_permission도 없으므로 어느 분기로도 매칭되는 행이 0건 — RLS 매칭 실패는
    // PostgREST에서 에러 없이 빈 결과로 조용히 끝날 수 있어, 실제 값이 안 바뀌었는지로
    // 판정한다).
    await asUserB();
    await supabase.from("manager_centers").update({ role_id: null }).eq("id", lowPrivStaffRowId);
    const { data: check } = await supabase.from("manager_centers").select("role_id").eq("id", lowPrivStaffRowId).maybeSingle();
    expect((check as any)?.role_id).toBe(trainerRoleIdOfCenterA);
  });

  it("I: 권한 있는 오너(managerA)는 저권한 스태프의 role을 정상적으로 변경할 수 있다(허용된 staff role 변경)", async () => {
    await asManagerA();
    const { data: managerRole } = await supabase
      .from("center_roles").select("id").eq("center_id", centerAId).eq("role_key", "manager").single();
    const { error } = await supabase
      .from("manager_centers")
      .update({ role_id: (managerRole as any).id })
      .eq("id", lowPrivStaffRowId);
    expect(error).toBeNull();
    // 원복(다음 테스트 오염 방지)
    await supabase.from("manager_centers").update({ role_id: trainerRoleIdOfCenterA }).eq("id", lowPrivStaffRowId);
  });

  it("J: userB가 자기 소유의 다른 센터를 새로 만들어 그 오너 role_id를 얻은 뒤, centerA의 자기 행에 그 role_id를 주입해도 거부된다(타 센터 role_id 주입)", async () => {
    await asUserB();
    const newCenterId = crypto.randomUUID();
    const { error: centerErr } = await supabase
      .from("centers")
      .insert({ id: newCenterId, name: "SEC-J 타센터 role 탈취용", address: "테스트", phone: "010-0000-0000", business_number: "000-00-00001" });
    expect(centerErr).toBeNull();
    secondBootstrapCenterId = newCenterId;
    await supabase.from("manager_centers").insert({ account_id: userB.accountId, center_id: newCenterId, status: "active" });
    const { data: ownerRoleOfNewCenter } = await supabase
      .from("center_roles").select("id").eq("center_id", newCenterId).eq("role_key", "owner").single();
    await supabase
      .from("manager_centers")
      .update({ role_id: (ownerRoleOfNewCenter as any).id })
      .eq("account_id", userB.accountId)
      .eq("center_id", newCenterId);

    // 이제 userB는 "다른 센터"의 진짜 오너 role_id를 하나 갖고 있다. 이걸 centerA의
    // 자기 행에 주입 시도 — role_id가 그 행의 center_id(centerA) 소속이 아니므로 거부돼야 함.
    const { error } = await supabase
      .from("manager_centers")
      .update({ role_id: (ownerRoleOfNewCenter as any).id })
      .eq("id", lowPrivStaffRowId);
    expect(error).not.toBeNull();
  });

  it("L: 한 계정(userB)이 여러 센터에서 서로 다른 역할을 갖는 정상 케이스는 그대로 유지된다", async () => {
    // 위 테스트들의 결과로 userB는 이제 centerA(강사, 초대됨)와 새로 만든 센터(오너,
    // 스스로 부트스트랩)에 동시에 서로 다른 역할로 존재한다 — 그 자체가 이 케이스의 증거.
    const { data, error } = await supabase
      .from("manager_centers")
      .select("center_id, role_id, status")
      .eq("account_id", userB.accountId);
    expect(error).toBeNull();
    const centerIds = (data ?? []).map((r: any) => r.center_id);
    expect(centerIds).toContain(centerAId);
    if (secondBootstrapCenterId) expect(centerIds).toContain(secondBootstrapCenterId);
  });
});

describe("M~O: self-join/self-promote 차단 후 다운스트림 공격 경로 재확인", () => {
  it("M: centerA에 발판을 얻지 못한 userA는 centerA의 classes를 수정할 수 없다", async () => {
    const { error } = await supabase
      .from("classes")
      .insert({ center_id: centerAId, title: "SEC-M 공격시도", start_time: new Date().toISOString(), end_time: new Date().toISOString() });
    expect(error).not.toBeNull();
  });

  it("N: centerA에 발판을 얻지 못한 userA는 centers(centerA) 정보를 수정할 수 없다", async () => {
    await supabase.from("centers").update({ name: "SEC-N 공격시도" }).eq("id", centerAId);
    const { data: check } = await supabase.from("centers").select("name").eq("id", centerAId).maybeSingle();
    expect((check as any)?.name).not.toBe("SEC-N 공격시도");
  });

  it("O: centerA에 발판을 얻지 못한 userA는 centerA의 reservations를 조회할 수 없다(매니저 조회 정책 미충족)", async () => {
    const { data, error } = await supabase
      .from("reservations")
      .select("id")
      .neq("profile_id", userA.profileId); // 본인 소유가 아닌 예약만 대상으로
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });
});

describe("P~Q: 마지막 남은 행 self-delete 차단(SEC-113) — 정상 삭제는 유지돼야 함", () => {
  it("P: 센터에 자기 자신 하나만 남아있으면 self-delete가 거부된다(orphan 방지)", async () => {
    // 전용 센터를 새로 부트스트랩한다(D/K와 동일 패턴, 독립된 센터로 분리해 테스트 순서
    // 결합을 피한다) — userB를 이 센터의 유일한 오너로 만든다.
    await asUserB();
    const newCenterId = crypto.randomUUID();
    const { error: centerErr } = await supabase
      .from("centers")
      .insert({ id: newCenterId, name: "SEC-P 마지막행 테스트센터", address: "테스트", phone: "010-0000-0000", business_number: "000-00-00001" });
    expect(centerErr).toBeNull();
    orphanTestCenterId = newCenterId;

    const { error: mcErr } = await supabase
      .from("manager_centers")
      .insert({ account_id: userB.accountId, center_id: newCenterId, status: "active" });
    expect(mcErr).toBeNull();

    const { data: ownerRole } = await supabase
      .from("center_roles")
      .select("id")
      .eq("center_id", newCenterId)
      .eq("role_key", "owner")
      .single();
    await supabase
      .from("manager_centers")
      .update({ role_id: (ownerRole as any).id })
      .eq("account_id", userB.accountId)
      .eq("center_id", newCenterId);

    // 지금 이 센터의 manager_centers 행은 userB 것 딱 1개뿐이다 — self-delete 시도.
    const { error: delErr } = await supabase
      .from("manager_centers")
      .delete()
      .eq("account_id", userB.accountId)
      .eq("center_id", newCenterId);
    // Supabase RLS는 대상 행이 없어서 삭제가 "0건 영향"으로 조용히 성공 처리될 수 있어
    // error보다 실제 남은 행 수로 판정하는 것이 더 확실하다(delErr가 null이어도 무방).
    void delErr;

    const admin = getFixtureAdminClient();
    const { data: remaining, error: countErr } = await admin
      .from("manager_centers")
      .select("id")
      .eq("center_id", newCenterId);
    expect(countErr).toBeNull();
    // R: orphan center가 만들어지지 않았는지 — 행이 여전히 1개(그대로) 남아있어야 한다.
    expect((remaining ?? []).length).toBe(1);
  });

  it("Q: 다른 active manager가 남아있으면 본인 staff 행 self-delete는 기존 정책대로 허용된다", async () => {
    // centerA는 managerA(오너) + 이 테스트가 초대하는 userA(스태프) 2명 구조로 만든다.
    await asManagerA();
    const { data: invited, error: inviteErr } = await supabase
      .from("manager_centers")
      .insert({ account_id: userA.accountId, center_id: centerAId, role_id: trainerRoleIdOfCenterA, status: "active" })
      .select("id")
      .maybeSingle();
    // 이미 다른 SEC-112 테스트에서 초대돼 있을 수 있으므로 실패해도 계속 진행(멱등 처리).
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
    expect((check ?? []).length).toBe(0); // 정상적으로 삭제됨(centerA에 managerA가 남아있으므로 허용)
    // centerA 자체는 managerA가 남아있어 orphan이 아니다 — 이후 다른 테스트(E~O)에 영향 없음.
  });
});

describe("S: orphan center self-claim 2단계 공격 체인 종단 확인", () => {
  it("S: P에서 self-delete가 거부됐으므로, 그 센터는 여전히 소유자가 있어 제3자(managerA)가 self-join할 수 없다", async () => {
    if (!orphanTestCenterId) throw new Error("선행 P 테스트가 먼저 실행돼야 합니다");
    // 2단계 공격: [1] 마지막 행 삭제(P에서 이미 거부 확인됨) → [2] 그 틈에 제3자가 self-claim.
    // P가 [1]을 막았으므로 이 센터는 여전히 userB가 소유한 상태다 — 그렇다면 SEC-101 정책
    // (not exists ...)도 여전히 실패해야 하고, 제3자의 self-join도 당연히 거부돼야 한다.
    // 이 테스트는 그 연결고리(1이 막히면 2도 도달 불가능하다는 것)를 명시적으로 확인한다.
    await asManagerA();
    const { data, error } = await supabase
      .from("manager_centers")
      .insert({ account_id: managerA.accountId, center_id: orphanTestCenterId, status: "active" })
      .select("id");
    if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
    expect(error).not.toBeNull();
  });
});

describe("T: 정상 owner 핸드오프(현재 구조상 가능한 절차 확인)", () => {
  it("T: 오너가 제2의 오너를 먼저 초대한 뒤 자기 행을 self-delete하면 허용된다(핸드오프 가능)", async () => {
    // 현재 스키마/코드에는 전용 "owner transfer" RPC가 없다(NEEDS PRODUCT DECISION,
    // 최종 보고서 참고) — 하지만 "오너 역할을 가진 사람을 먼저 하나 더 만들고, 그 다음
    // 원래 오너가 나가는" 절차는 지금 있는 정책만으로도 가능한지 확인한다.
    await asUserB();
    const newCenterId = crypto.randomUUID();
    const { error: centerErr } = await supabase
      .from("centers")
      .insert({ id: newCenterId, name: "SEC-T 핸드오프 테스트센터", address: "테스트", phone: "010-0000-0000", business_number: "000-00-00002" });
    expect(centerErr).toBeNull();
    transferTestCenterId = newCenterId;

    const { error: mcErr } = await supabase
      .from("manager_centers")
      .insert({ account_id: userB.accountId, center_id: newCenterId, status: "active" });
    expect(mcErr).toBeNull();
    const { data: ownerRole } = await supabase
      .from("center_roles")
      .select("id")
      .eq("center_id", newCenterId)
      .eq("role_key", "owner")
      .single();
    await supabase
      .from("manager_centers")
      .update({ role_id: (ownerRole as any).id })
      .eq("account_id", userB.accountId)
      .eq("center_id", newCenterId);

    // userB(오너)가 has_permission(facility.staff.create) 분기로 managerA를 "오너 role"로
    // 직접 초대한다 — "오너 스태프 초대" 정책은 role_id가 그 센터 소속이기만 하면 되므로
    // 오너 role_id로 초대하는 것도 허용된다(현재 정책상 막을 이유 없음).
    const { error: inviteErr } = await supabase
      .from("manager_centers")
      .insert({ account_id: managerA.accountId, center_id: newCenterId, role_id: (ownerRole as any).id, status: "active" });
    expect(inviteErr).toBeNull();

    // 이제 이 센터엔 오너 role인 사람이 2명(userB, managerA) — userB가 self-delete해도
    // 마지막 행이 아니므로 SEC-113 정책에 안 걸려야 한다.
    const { error: delErr } = await supabase
      .from("manager_centers")
      .delete()
      .eq("account_id", userB.accountId)
      .eq("center_id", newCenterId);
    expect(delErr).toBeNull();

    const admin = getFixtureAdminClient();
    const { data: remaining } = await admin.from("manager_centers").select("account_id").eq("center_id", newCenterId);
    expect((remaining ?? []).map((r: any) => r.account_id)).toEqual([managerA.accountId]);
    // 결론: 전용 RPC 없이도 "오너를 먼저 하나 더 만들고 원래 오너가 나가는" 수동 핸드오프는
    // 현재 정책만으로 가능하다. 다만 UI에 이 절차를 위한 화면은 없다(코드 확인) — 필요하면
    // 별도 TODO로 전용 UI/RPC(owner transfer workflow) 추가를 검토할 것.
  });
});
