/*
  SEC-101 + SEC-112(둘 다 P0) 통합 회귀 테스트 — manager_centers 권한 상승 2건.

  ⚠ 이 파일은 fix_manager_centers_privilege_escalation_draft_proposed.sql이 Supabase에
  적용되기 전까지는 A/B/C(self-join)와 G/H/J(self-promote)가 실패한다(취약점이 실제로
  열려 있다는 것을 보여주는 것 자체가 목적). SQL 적용 후에는 전부 통과해야 한다. 이
  세션에서는 SQL을 실행하지 않았으므로 이 파일도 아직 실행하지 않았다(static 작성만).

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

async function asManagerA() { await switchToTestUser(MANAGER_A.email, MANAGER_A.password); }
async function asUserA() { await switchToTestUser(USER_A.email, USER_A.password); }
async function asUserB() { await switchToTestUser(USER_B.email, USER_B.password); }

// 이 파일이 crypto.randomUUID()로 매번 새로 만드는 부트스트랩/orphan 테스트센터들
// (SEC-D/K, SEC-J, SEC-Q, SEC-Q-2)은 이름이 고정 리터럴이지만 id는 매 실행 다르다 —
// CI가 afterAll 전에 죽으면(cancel-in-progress 등) 이전 실행의 행이 지워지지 않고
// 그대로 남고, 다음 실행은 그 존재를 모른 채 또 새로 만들어 같은 이름의 행이
// 계속 쌓인다(getOrCreateOwnedTestCenter의 self-healing sweep과 동일한 문제,
// 동일한 해법). beforeAll 맨 앞에서 "이 파일이 쓰는 고정 이름들로 이미 남아있는
// 이전 실행 잔재"를 먼저 쓸어내 항상 깨끗한 상태에서 시작한다 — FK 순서
// (manager_centers → center_roles → centers) 준수.
const KNOWN_FIXTURE_CENTER_NAMES = [
  "SEC-D/K 부트스트랩 테스트센터",
  "SEC-J 타센터 role 탈취용",
  "SEC-Q orphan(approved) 재현용",
  "SEC-Q-2 pending 대조군",
];
async function sweepStaleFixtureCenters(): Promise<void> {
  const admin = getFixtureAdminClient();
  const { data: stale, error } = await admin
    .from("centers").select("id").in("name", KNOWN_FIXTURE_CENTER_NAMES);
  if (error) throw new Error(`stale fixture 조회 실패: ${error.message}`);
  const staleIds = (stale ?? []).map((r: any) => r.id);
  if (staleIds.length === 0) return;
  await admin.from("manager_centers").delete().in("center_id", staleIds);
  await admin.from("center_roles").delete().in("center_id", staleIds);
  await admin.from("centers").delete().in("id", staleIds);
}

beforeAll(async () => {
  await sweepStaleFixtureCenters();
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
  for (const cid of [bootstrapCenterId, secondBootstrapCenterId]) {
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
    // RLS가 막은 UPDATE는 에러 없이 조용히 0건 처리될 수 있으므로(이 파일의 다른
    // 테스트들과 동일한 패턴) 에러 유무가 아니라 실제로 안 바뀌었는지로 판정한다.
    await supabase
      .from("manager_centers")
      .update({ role_id: (ownerRoleOfNewCenter as any).id })
      .eq("id", lowPrivStaffRowId);
    const admin = getFixtureAdminClient();
    const { data: check } = await admin.from("manager_centers").select("role_id").eq("id", lowPrivStaffRowId).maybeSingle();
    expect((check as any)?.role_id).not.toBe((ownerRoleOfNewCenter as any).id);
  });

  it("L: 한 계정(userB)이 여러 센터에서 서로 다른 역할을 갖는 정상 케이스는 그대로 유지된다", async () => {
    // 위 테스트들의 결과로 userB는 이제 centerA(강사, 초대됨)와 새로 만든 센터(오너,
    // 스스로 부트스트랩)에 동시에 서로 다른 역할로 존재한다 — 그 자체가 이 케이스의 증거.
    //
    // ⚠ 이 describe 블록은 asManagerA()/asUserB()를 여러 번 오가며 세션을 전환한다.
    // 파일 맨 앞 outer beforeAll에서 딱 한 번 로그인했던 userA 세션의 GoTrueClient
    // 백그라운드 auto-refresh 타이머가, 한참 뒤(G~J를 거친 이 시점)에 뒤늦게 발동해
    // 그사이 signIn으로 전환해둔 userB 세션 저장을 덮어써버리는 현상이 실측 확인됐다
    // (RLS 정책 문제가 아니라 supabase-js 세션 전환 시 이미 문서화된 race — 이 파일
    // switchToTestUser() 위쪽 주석의 "commit guard" 설명과 같은 계열의 문제). 그래서
    // 이 assert 직전에 세션을 다시 명시적으로 userB로 확정한다.
    await asUserB();
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

describe("P~Q [v2, 2026-08-14 추가]: 사용자가 지적한 SEC-112/SEC-101 미해결 재현 시나리오", () => {
  it("P(SEC-112 v2): role_id=null로 정상 초대된 저권한 스태프는 self-UPDATE로 오너가 될 수 없다(부트스트랩과 구분)", async () => {
    // lib/roles.ts의 실제 inviteStaff()는 roleId가 필수 매개변수라 앱 UI 경로로는
    // role_id=null 초대가 일어나지 않지만, "오너 스태프 초대" INSERT 정책 자체는
    // DB 레벨에서 role_id=null을 명시적으로 허용한다(facility.staff.create 권한자가
    // API를 직접 쳐서 "역할은 나중에 정하기로 하고 일단 초대"하는 것을 막지 않음).
    // v1의 self-UPDATE 분기는 "role_id가 null인 내 행"이면 무조건 후보였으므로, 이렇게
    // 초대된 행도 부트스트랩 행과 구분 없이 self-promote가 가능했다(v2에서 막힘).
    // E 테스트가 이미 (userB, centerA) 조합으로 manager_centers 행을 만들어뒀을 수 있다
    // (그 파일의 cleanup은 afterAll에서만 일괄 처리돼 테스트 사이에는 안 지워짐) —
    // unique(account_id, center_id) 충돌을 피하려고 이 테스트 전용으로 먼저 정리한다.
    const admin = getFixtureAdminClient();
    await admin.from("manager_centers").delete().eq("account_id", userB.accountId).eq("center_id", centerAId);

    await asManagerA();
    const { data: invited, error: inviteErr } = await supabase
      .from("manager_centers")
      .insert({ account_id: userB.accountId, center_id: centerAId, status: "pending", role_id: null })
      .select("id")
      .single();
    expect(inviteErr).toBeNull();
    if (!invited) throw new Error("role_id=null 초대 fixture 생성 실패");
    const invitedRowId = (invited as any).id;
    cleanupManagerCenterIds.push(invitedRowId);

    await asUserB();
    const { data, error } = await supabase
      .from("manager_centers")
      .update({ role_id: ownerRoleIdOfCenterA, status: "active" })
      .eq("id", invitedRowId)
      .select("id");
    // RLS 매칭 실패는 에러 없이 빈 결과로 조용히 끝날 수 있으므로 실제 값도 재확인한다.
    expect((data ?? []).length === 0 || error !== null).toBe(true);
    const { data: check } = await supabase.from("manager_centers").select("role_id, status").eq("id", invitedRowId).maybeSingle();
    expect((check as any)?.role_id).toBeNull();
  });

  it("Q(SEC-101 v2): manager_centers가 0건인 승인된(orphan) 센터는 self-insert로 재점유할 수 없다", async () => {
    // orphan center(SEC-113: 오너가 자기 마지막 행을 삭제해 관리자가 아무도 없어진 상태)를
    // admin(service_role)으로 직접 재현한다 — status='approved'로 만들어 "실사용 이력이
    // 있던 진짜 센터가 orphan이 된" 상황을 흉내낸다(진짜 orphan을 만들려면 SEC-113의
    // DELETE 정책 취약점을 실제로 트리거해야 하는데, 그건 이번 파일이 다루는 범위 밖).
    const admin = getFixtureAdminClient();
    const orphanCenterId = crypto.randomUUID();
    const { error: centerErr } = await admin
      .from("centers")
      .insert({
        id: orphanCenterId, name: "SEC-Q orphan(approved) 재현용", status: "approved",
        address: "테스트", phone: "010-0000-0000", business_number: "000-00-00002",
      });
    expect(centerErr).toBeNull();
    // manager_centers 행은 의도적으로 하나도 만들지 않는다 — orphan 상태 그대로.

    try {
      await asUserA();
      const { data, error } = await supabase
        .from("manager_centers")
        .insert({ account_id: userA.accountId, center_id: orphanCenterId, status: "active" })
        .select("id");
      if (!error && data && data.length > 0) {
        await admin.from("manager_centers").delete().in("id", data.map((r: any) => r.id));
      }
      expect(error).not.toBeNull();
    } finally {
      await admin.from("manager_centers").delete().eq("center_id", orphanCenterId);
      await admin.from("center_roles").delete().eq("center_id", orphanCenterId);
      await admin.from("centers").delete().eq("id", orphanCenterId);
    }
  });

  it("Q-2(대조군, SEC-101 정상 동작 확인): manager_centers가 0건인 pending 센터는 여전히 self-insert 부트스트랩 대상이다", async () => {
    // Q와 정확히 같은 모양(orphan, 0행)이지만 status가 pending이면(= 승인 전, 실사용
    // 이력이 있을 수 없는 신규/미완료 센터) 정상 부트스트랩 경로를 계속 허용해야 한다 —
    // v2 수정이 "orphan이면 무조건 다 막는" 과잉 차단이 아님을 확인하는 대조군.
    const admin = getFixtureAdminClient();
    const pendingOrphanCenterId = crypto.randomUUID();
    const { error: centerErr } = await admin
      .from("centers")
      .insert({
        id: pendingOrphanCenterId, name: "SEC-Q-2 pending 대조군", status: "pending",
        address: "테스트", phone: "010-0000-0000", business_number: "000-00-00003",
      });
    expect(centerErr).toBeNull();

    try {
      await asUserA();
      const { error } = await supabase
        .from("manager_centers")
        .insert({ account_id: userA.accountId, center_id: pendingOrphanCenterId, status: "active" });
      expect(error).toBeNull();
    } finally {
      await admin.from("manager_centers").delete().eq("center_id", pendingOrphanCenterId);
      await admin.from("center_roles").delete().eq("center_id", pendingOrphanCenterId);
      await admin.from("centers").delete().eq("id", pendingOrphanCenterId);
    }
  });
});

describe("K [2026-08-14 추가]: 회원 관계(center_members)와 manager_centers 관계의 독립성", () => {
  it("K: centerA의 정식 회원(center_members)이어도 manager_centers self-join은 여전히 거부된다", async () => {
    const admin = getFixtureAdminClient();
    const { data: member, error: memberErr } = await admin
      .from("center_members")
      .insert({ center_id: centerAId, profile_id: userA.profileId, status: "active" })
      .select("id").single();
    expect(memberErr).toBeNull();

    try {
      await asUserA();
      const { data, error } = await supabase
        .from("manager_centers")
        .insert({ account_id: userA.accountId, center_id: centerAId, status: "active" })
        .select("id");
      if (!error && data && data.length > 0) cleanupManagerCenterIds.push((data[0] as any).id);
      // center_members 존재 여부가 manager_centers RLS 판정에 전혀 관여하지 않으므로
      // A/B/C와 동일하게 거부돼야 한다 — 두 관계가 서로 독립적임을 증명.
      expect(error).not.toBeNull();
    } finally {
      if (member) await admin.from("center_members").delete().eq("id", (member as any).id);
    }
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
