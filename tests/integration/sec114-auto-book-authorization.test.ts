/*
  SEC-114 회귀 테스트 — auto_book_membership() SECURITY DEFINER authorization bypass.

  배경(2026-08-12 READ-ONLY 보안 감사): auto_book_membership(p_membership_id uuid)이
  SECURITY DEFINER(owner=postgres)로 PUBLIC EXECUTE였고 함수 내부에 caller authorization이
  전혀 없었다 — anon/authenticated 누구나 타인의 membership_id UUID만 알면 memberships RLS를
  우회(security definer)해 피해자 profile_id로 reservations를 생성하고 remaining_count를
  소진시킬 수 있었다. fix_auto_book_membership_authorization_draft_proposed.sql이 이를
  고친다: membership 조회 직후 has_permission(center_id, 'schedule.own.group.booking') or
  is_platform_admin() 체크를 추가하고, PUBLIC/anon EXECUTE를 revoke하고 authenticated만
  grant한다.

  이 파일은 SQL 미적용 상태에서는 의도적으로 RED다(A/B/C/E/F가 현재 Live에서는 거부되지
  않고 성공해버리므로 실패). SQL 적용 후에는 전부 GREEN이어야 한다 — 이 저장소의 기존
  관례(다른 draft_proposed SQL 회귀 테스트들과 동일)를 따른다.

  fixture 전략: TEST_MANAGER_A(centerA 오너)/TEST_MANAGER_B(centerB 오너, 그리고 F에서만
  centerA에 무권한 스태프로 추가 초대됨)/TEST_USER_A(회원, victim membership 소유자)/
  TEST_USER_B(다른 회원, 공격자 역할)를 재사용한다. 신규 계정을 추가하지 않는다.

  필요한 환경변수: TEST_MANAGER_A_EMAIL/PASSWORD, TEST_MANAGER_B_EMAIL/PASSWORD,
  TEST_USER_A_EMAIL/PASSWORD, TEST_USER_B_EMAIL/PASSWORD (전부 기존 테스트와 공유,
  이 파일 전용 신규 계정 없음).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  signOutTestSession,
  type TestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  createTestMembership,
  fetchMembershipRemaining,
  getFixtureAdminClient,
  cleanupTestClass,
} from "./setup";
import { createRole, fetchRoles, inviteStaff } from "../../lib/roles";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };
const MEMBER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };
const MEMBER_B = { email: "TEST_USER_B_EMAIL", password: "TEST_USER_B_PASSWORD" };

const NO_PERM_ROLE_NAME = "SEC-114 테스트 무권한 역할";

let managerA: TestUser;
let managerB: TestUser;
let memberA: TestUser;
let memberB: TestUser;
let centerAId: string;
let centerBId: string;

// victim membership — SEC114-A/B/C/E/F/D/G가 전부 이 하나를 대상으로 시도한다.
// 거부된 시도(A/B/C/E/F)는 이 값을 절대 바꾸면 안 되고, 허용된 시도(D/G)는 요일반이
// 아닌 수강권이라 'not_weekday_pass'로 조기 반환되어 이 값을 바꾸지 않는다 — 그래서
// 마지막 SEC114-I/J에서 파일 전체를 통틀어 단 한 번도 안 바뀌었음을 검증할 수 있다.
let victimMembershipId: string;
const VICTIM_REMAINING = 7;

async function asManagerA() { await switchToTestUser(MANAGER_A.email, MANAGER_A.password); }
async function asManagerB() { await switchToTestUser(MANAGER_B.email, MANAGER_B.password); }
async function asMemberA() { await switchToTestUser(MEMBER_A.email, MEMBER_A.password); }
async function asMemberB() { await switchToTestUser(MEMBER_B.email, MEMBER_B.password); }

async function callAutoBook(membershipId: string) {
  return supabase.rpc("auto_book_membership", { p_membership_id: membershipId });
}

function expectRejected(result: { data: unknown; error: { message: string } | null }) {
  expect(result.error).not.toBeNull();
}

const createdClassIds: string[] = [];
let createdStaffManagerCenterId: string | null = null;
let createdRoleId: string | null = null;

beforeAll(async () => {
  await asManagerA();
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  await asManagerB();
  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  centerBId = await getOrCreateOwnedTestCenter(managerB);

  await asMemberA();
  memberA = await switchToTestUser(MEMBER_A.email, MEMBER_A.password);

  await asMemberB();
  memberB = await switchToTestUser(MEMBER_B.email, MEMBER_B.password);

  // victim membership은 매니저 세션에서 발급(회원 본인은 memberships를 직접 insert할
  // RLS 권한이 없음 — 이 저장소의 기존 fixture 관례, admin-assignment-security.test.ts 등과 동일).
  await asManagerA();
  const mem = await createTestMembership(centerAId, memberA.profileId, { remainingCount: VICTIM_REMAINING });
  victimMembershipId = mem.id;
}, 60_000);

afterAll(async () => {
  const errors: string[] = [];
  try {
    await asManagerA();
    if (createdStaffManagerCenterId) {
      const { error } = await supabase.from("manager_centers").delete().eq("id", createdStaffManagerCenterId);
      if (error) errors.push(`무권한 스태프 초대 정리 실패: ${error.message}`);
    }
    if (createdRoleId) {
      const { error } = await supabase.from("center_roles").delete().eq("id", createdRoleId);
      if (error) errors.push(`무권한 역할 정리 실패: ${error.message}`);
    }
    for (const classId of createdClassIds) {
      try {
        await cleanupTestClass(classId, []);
      } catch (e: any) {
        errors.push(`수업 정리 실패(${classId}): ${e.message}`);
      }
    }
  } finally {
    // platform admin 플래그가 혹시라도 남아있으면 반드시 원복(각 테스트가 자체
    // try/finally로 이미 되돌리지만, 이중 안전장치).
    try {
      const admin = getFixtureAdminClient();
      await admin.from("accounts").update({ is_platform_admin: false }).eq("id", memberB.accountId);
    } catch {
      /* 계정 자체가 이미 원상태면 무시 */
    }
    await signOutTestSession();
  }
  if (errors.length > 0) throw new Error("SEC-114 fixture 정리 중 오류:\n" + errors.join("\n"));
}, 60_000);

describe("SEC-114 authorization — 거부돼야 하는 호출", () => {
  it("SEC114-A: anon(로그아웃 상태) → victim membership_id로 호출 → EXECUTE 자체가 거부된다", async () => {
    await signOutTestSession();
    const result = await callAutoBook(victimMembershipId);
    expectRejected(result);
  });

  it("SEC114-B: 로그인한 무관한 회원(memberB) → victim(memberA)의 membership_id 호출 → 거부", async () => {
    await asMemberB();
    const result = await callAutoBook(victimMembershipId);
    expectRejected(result);
  });

  it("SEC114-C: 회원 본인(memberA)이 자기 membership_id로 호출 → 거부 (이 RPC는 회원용 기능이 아니라 매니저 전용)", async () => {
    await asMemberA();
    const result = await callAutoBook(victimMembershipId);
    expectRejected(result);
  });

  it("SEC114-E: 다른 센터(centerB) 매니저(managerB, centerA와 관계 없음) → 거부", async () => {
    await asManagerB();
    const result = await callAutoBook(victimMembershipId);
    expectRejected(result);
  });

  it("SEC114-F: centerA에 소속됐지만 필요한 permission이 없는 스태프(managerB를 무권한 역할로 초대) → 거부", async () => {
    // E와 다른 상태를 만들기 위해 여기서 처음으로 managerB를 centerA의 스태프로 초대한다
    // (E는 "관계 자체가 없음"을, F는 "관계는 있지만 권한이 부족함"을 검증 — 순서가 중요).
    await asManagerA();
    const roles = await fetchRoles(centerAId);
    let role = roles.find((r) => r.name === NO_PERM_ROLE_NAME);
    if (!role) {
      await createRole(centerAId, NO_PERM_ROLE_NAME);
      const refreshed = await fetchRoles(centerAId);
      role = refreshed.find((r) => r.name === NO_PERM_ROLE_NAME);
    }
    if (!role) throw new Error("SEC-114 무권한 역할 생성 실패");
    createdRoleId = role.id;
    // createRole()은 role_permissions을 채우지 않으므로 이 역할은 permission이 0개 —
    // has_permission(centerA, 'schedule.own.group.booking')이 항상 false를 반환하는
    // "권한 없는 일반 스태프" fixture로 쓰기에 적합(acl-003-permission-read.test.ts와 동일 패턴).
    try {
      await inviteStaff(centerAId, managerB.accountId, role.id);
    } catch (e: any) {
      if (!e.message.includes("이미 이 센터의 스태프")) throw e;
    }
    const { data: mc, error: mcErr } = await supabase
      .from("manager_centers")
      .select("id")
      .eq("center_id", centerAId)
      .eq("account_id", managerB.accountId)
      .single();
    if (mcErr || !mc) throw new Error("무권한 스태프 초대 후 manager_centers 조회 실패: " + mcErr?.message);
    createdStaffManagerCenterId = mc.id;

    await asManagerB();
    const result = await callAutoBook(victimMembershipId);
    expectRejected(result);
  });
});

describe("SEC-114 authorization — 허용돼야 하는 호출", () => {
  it("SEC114-D: centerA 정상 매니저(managerA, 오너) → 허용(호출은 성공, 요일반이 아니라 booked:0)", async () => {
    await asManagerA();
    const { data, error } = await callAutoBook(victimMembershipId);
    expect(error).toBeNull();
    expect((data as any)?.reason).toBe("not_weekday_pass");
  });

  it("SEC114-G: platform admin → 허용(centerA와 아무 매니저 관계 없어도 통과)", async () => {
    await asMemberB(); // memberB는 centerA/centerB 어디에도 manager_centers 행이 없음
    const admin = getFixtureAdminClient();
    const { error: elevateErr } = await admin
      .from("accounts")
      .update({ is_platform_admin: true })
      .eq("id", memberB.accountId);
    if (elevateErr) throw new Error("platform admin 플래그 설정 실패: " + elevateErr.message);
    try {
      const { data, error } = await callAutoBook(victimMembershipId);
      expect(error).toBeNull();
      expect((data as any)?.reason).toBe("not_weekday_pass");
    } finally {
      const { error: resetErr } = await admin
        .from("accounts")
        .update({ is_platform_admin: false })
        .eq("id", memberB.accountId);
      if (resetErr) throw new Error("platform admin 플래그 원복 실패: " + resetErr.message);
    }
  });
});

describe("SEC-114 authorization — fulfill_order 내부 호출 회귀", () => {
  it("SEC114-H: 정상 fulfill_order(auto_book=true) → auto_book_membership 내부 호출이 REVOKE와 무관하게 정상 동작한다", async () => {
    await asManagerA();
    // centerA에서 실제로 예약 가능한 미래 수업을 하나 만들고, 그 수업의 KST 요일에 맞춘
    // 요일반 상품을 만들어 fulfill_order(auto_book=true)가 실제로 예약까지 성사시키는지
    // end-to-end로 확인한다 — REVOKE EXECUTE가 fulfill_order의 내부(owner 권한) 호출까지
    // 막아버리는 회귀가 있다면 이 테스트가 그것을 잡아낸다(booked 여전히 0이 되고 마는 식으로).
    const cls = await createFutureTestClass(centerAId, { title: "SEC114-H 자동예약 회귀", hoursFromNow: 96 });
    createdClassIds.push(cls.id);
    const dow = kstDayOfWeek(cls.startTime);

    const admin = getFixtureAdminClient();
    const { data: product, error: prodErr } = await admin
      .from("products")
      .insert({
        center_id: centerAId,
        name: "SEC114-H 요일반 테스트 상품",
        price: 10000,
        product_kind: "pass",
        pass_type: "count",
        total_count: 3,
        auto_book_days: [dow],
      })
      .select("id")
      .single();
    if (prodErr || !product) throw new Error("SEC114-H 상품 생성 실패: " + prodErr?.message);

    const { data: order, error: orderErr } = await admin
      .from("orders")
      .insert({
        center_id: centerAId,
        profile_id: memberA.profileId,
        product_id: product.id,
        product_name: "SEC114-H 요일반 테스트 상품",
        amount: 10000,
        pay_method: "card",
        status: "pending",
        auto_book: true,
      })
      .select("id")
      .single();
    if (orderErr || !order) throw new Error("SEC114-H 주문 생성 실패: " + orderErr?.message);

    const { data, error } = await supabase.rpc("fulfill_order", { p_order_id: order.id });
    expect(error).toBeNull();
    expect((data as any)?.already_done).toBe(false);
    const newMembershipId = (data as any)?.membership_id as string;
    expect(newMembershipId).toBeTruthy();

    const remaining = await fetchMembershipRemaining(newMembershipId);
    // 총 3회 중 이 수업 하나에 자동예약돼 1회 소진 — auto_book_membership 내부 호출이
    // REVOKE로 막혔다면 remaining은 3 그대로였을 것.
    expect(remaining).toBe(2);

    const { data: res, error: resErr } = await admin
      .from("reservations")
      .select("id, status, membership_id")
      .eq("class_id", cls.id)
      .eq("membership_id", newMembershipId);
    if (resErr) throw new Error("SEC114-H 예약 조회 실패: " + resErr.message);
    expect(res).toHaveLength(1);
    expect(res![0].status).toBe("confirmed");
  }, 30_000);
});

describe("SEC-114 authorization — 공격 실패 후 부작용 없음 확인", () => {
  it("SEC114-I/J: 앞선 모든 거부된 시도(A/B/C/E/F) 이후에도 victim membership.remaining_count와 reservations가 전혀 변하지 않았다", async () => {
    const remaining = await fetchMembershipRemaining(victimMembershipId);
    expect(remaining).toBe(VICTIM_REMAINING);

    const admin = getFixtureAdminClient();
    const { data: res, error } = await admin
      .from("reservations")
      .select("id")
      .eq("membership_id", victimMembershipId);
    if (error) throw new Error("SEC114-I/J 예약 조회 실패: " + error.message);
    expect(res).toHaveLength(0);
  });
});

// Postgres의 extract(dow from ... at time zone 'Asia/Seoul')과 동일한 값(0=일~6=토)을
// KST 기준으로 계산한다.
function kstDayOfWeek(isoUtc: string): number {
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const short = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(
    new Date(isoUtc)
  );
  return map[short];
}
