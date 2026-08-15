/*
  관리자 직접배치/무료 추가 배치 RPC(admin_assign_reservation/admin_cancel_reservation) 통합 테스트.

  Fixture 전략 (서비스 역할 키 없이, anon key + RLS만으로 자체 생성):
  - "센터 생성" RLS 정책(auth_policies.sql)은 로그인한 계정이면 누구나 centers를 insert할 수 있고,
    trg_create_default_center_roles 트리거가 오너 역할을 자동 생성하며, "매니저센터 생성" 정책은
    account_id = my_account_id()이면 누구나 manager_centers를 status='active'로 insert할 수 있다
    (매니저 가입 플로우가 원래 이렇게 동작함). 이 세 가지를 조합해 테스트 전용 매니저 계정이
    스스로 센터를 만들고 그 센터의 활성 오너가 되는 fixture를 tests/integration/setup.ts에 구현했다
    (`getOrCreateOwnedTestCenter`) — 운영자가 미리 수동 설정할 것이 없다.
  - 회원 fixture는 기존 TEST_USER_A(get-or-create 계정)를 그대로 재사용한다.
  - 필요한 신규 환경변수: TEST_MANAGER_A_EMAIL/PASSWORD(테스트 센터 A의 오너),
    TEST_MANAGER_B_EMAIL/PASSWORD(테스트 센터 B의 오너 — "다른 센터 관리자 차단" 검증 전용).
    둘 다 TEST_USER_A/B와 동일하게 get-or-create 방식이라 최초 1회 자동 가입되고 이후 재사용된다.

  정리(cleanup): 각 테스트가 만든 예약은 admin_cancel_reservation으로 취소한 뒤 삭제하고, 수업도
  같이 삭제한다. memberships는 매니저가 delete할 수 있는 RLS 정책이 없어(payments/orders와 동일한
  기존 제약) 남는다 — 누적되면 저장소의 reset_test_data.sql로 정리한다. 센터/manager_centers/역할은
  다음 실행에서 재사용하도록 일부러 지우지 않는다(계정 get-or-create와 같은 철학).
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  signOutTestSession,
  type TestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  createTestMembership,
  fetchMembershipRemaining,
  cleanupTestClass,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };
const MEMBER = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };
const MEMBER_B = { email: "TEST_USER_B_EMAIL", password: "TEST_USER_B_PASSWORD" };

let managerA: TestUser;
let managerB: TestUser;
let member: TestUser;
let memberB: TestUser;
let centerAId: string;
let centerBId: string;

// 정리 대상 추적 (센터 A에서 만든 수업만 — 실제 배치가 일어날 수 있는 곳)
const cleanupTargets: { classId: string; reservationIds: string[] }[] = [];
function trackClass(classId: string) {
  const entry = { classId, reservationIds: [] as string[] };
  cleanupTargets.push(entry);
  return entry;
}

async function asManagerA() {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
}
async function asManagerB() {
  await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
}
async function asMember() {
  await switchToTestUser(MEMBER.email, MEMBER.password);
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  centerBId = await getOrCreateOwnedTestCenter(managerB);

  member = await switchToTestUser(MEMBER.email, MEMBER.password);
  memberB = await switchToTestUser(MEMBER_B.email, MEMBER_B.password);
}, 30000);

afterAll(async () => {
  await asManagerA();
  for (const target of cleanupTargets) {
    await cleanupTestClass(target.classId, target.reservationIds);
  }
  await signOutTestSession();
}, 30000);

// 기본 세션: 매니저 A. 다른 주체가 필요한 테스트는 내부에서 명시적으로 전환한다
// (다음 테스트의 이 beforeEach가 다시 A로 되돌려 놓으므로 테스트 간 순서에 의존하지 않는다).
beforeEach(async () => {
  await asManagerA();
});

describe("admin_assign_reservation 입력 검증 (fixture 불필요)", () => {
  it("잘못된 배치 방식(assignment_type)이면 즉시 거부된다", async () => {
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: "00000000-0000-0000-0000-000000000000",
      p_profile_id: member.profileId,
      p_assignment_type: "SOMETHING_ELSE",
      p_membership_id: null,
      p_reason_code: null,
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("잘못된 배치 방식");
  });

  it("잘못된 배치 사유 코드면 거부된다", async () => {
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: "00000000-0000-0000-0000-000000000000",
      p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "NOT_A_REAL_CODE",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("잘못된 배치 사유");
  });

  it("존재하지 않는 수업으로 배치를 시도하면 거부된다", async () => {
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: "00000000-0000-0000-0000-000000000000",
      p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "EVENT",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("수업을 찾을 수 없어요");
  });

  it("일반 회원(비관리자)이 실제 수업에 직접배치를 시도하면 '관리자 권한이 없어요'로 거부된다", async () => {
    await asManagerA();
    const cls = await createFutureTestClass(centerAId, { title: "권한테스트-일반회원차단" });
    trackClass(cls.id);

    await asMember();
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id,
      p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "EVENT",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("관리자 권한이 없어요");
  });

  it("다른 센터의 관리자는 이 센터에 배치를 시도할 수 없다", async () => {
    await asManagerA();
    const cls = await createFutureTestClass(centerAId, { title: "권한테스트-타센터차단" });
    trackClass(cls.id);

    await asManagerB();
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id,
      p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "EVENT",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("관리자 권한이 없어요");
    expect(centerAId).not.toBe(centerBId); // 실제로 서로 다른 센터인지 재확인
  });
});

describe("admin_cancel_reservation 입력 검증 (fixture 불필요)", () => {
  it("존재하지 않는 예약을 취소하려 하면 거부된다", async () => {
    const { data, error } = await supabase.rpc("admin_cancel_reservation", {
      p_reservation_id: "00000000-0000-0000-0000-000000000000",
      p_cancel_reason: null,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("예약을 찾을 수 없어요");
  });
});

describe("관리자 직접배치/무료 추가 배치 성공 경로", () => {
  it("센터 관리자가 ADMIN_ASSIGNMENT 예약을 정상 생성한다 (수강권 차감)", async () => {
    const membership = await createTestMembership(centerAId, member.profileId, { remainingCount: 5 });
    const cls = await createFutureTestClass(centerAId, { title: "성공경로-일반직접배치" });
    const entry = trackClass(cls.id);

    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id,
      p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT",
      p_membership_id: membership.id,
      p_reason_code: "MAKEUP_CLASS",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(error).toBeNull();
    expect((data as any).needs_capacity_confirm).toBeFalsy();
    expect((data as any).reservation_id).toBeTruthy();
    entry.reservationIds.push((data as any).reservation_id);

    const { data: resRow, error: resErr } = await supabase
      .from("reservations")
      .select("reservation_type, reservation_source, membership_id, membership_consumed, status")
      .eq("id", (data as any).reservation_id)
      .single();
    if (resErr) throw new Error(resErr.message);
    expect(resRow.reservation_type).toBe("ADMIN_ASSIGNMENT");
    expect(resRow.reservation_source).toBe("ADMIN");
    expect(resRow.membership_id).toBe(membership.id);
    expect(resRow.membership_consumed).toBe(true);
    expect(resRow.status).toBe("confirmed");

    const remaining = await fetchMembershipRemaining(membership.id);
    expect(remaining).toBe(4); // 5 → 1회 차감
  });

  it("센터 관리자가 ADMIN_FREE 예약을 정상 생성한다 (차감 없음)", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "성공경로-무료추가배치" });
    const entry = trackClass(cls.id);

    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id,
      p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "EVENT",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(error).toBeNull();
    expect((data as any).reservation_id).toBeTruthy();
    entry.reservationIds.push((data as any).reservation_id);

    const { data: resRow, error: resErr } = await supabase
      .from("reservations")
      .select("reservation_type, membership_id, membership_consumed, status")
      .eq("id", (data as any).reservation_id)
      .single();
    if (resErr) throw new Error(resErr.message);
    expect(resRow.reservation_type).toBe("ADMIN_FREE");
    expect(resRow.membership_id).toBeNull();
    expect(resRow.membership_consumed).toBe(false);
    expect(resRow.status).toBe("confirmed");
  });

  it("이용권이 없어도(또는 무관하게) ADMIN_FREE 배치가 성공한다", async () => {
    // ADMIN_FREE는 memberships를 전혀 조회하지 않으므로, 이 프로필이 이 센터에 다른 테스트가 만든
    // 수강권을 이미 갖고 있더라도 그와 무관하게 성공해야 한다 — "이용권 없는 회원"이 통과하는 이유가
    // "운 좋게 조건을 만족해서"가 아니라 "애초에 조건을 보지 않아서"임을 함께 확인한다.
    const cls = await createFutureTestClass(centerAId, { title: "성공경로-이용권없음" });
    const entry = trackClass(cls.id);

    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id,
      p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "TRIAL",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(error).toBeNull();
    expect((data as any).reservation_id).toBeTruthy();
    entry.reservationIds.push((data as any).reservation_id);
  });

  it("만료된 수강권만 있는 회원도 ADMIN_FREE 배치가 성공하고, 그 수강권은 그대로 유지된다", async () => {
    const expired = await createTestMembership(centerAId, member.profileId, { expired: true });
    const cls = await createFutureTestClass(centerAId, { title: "성공경로-만료회원" });
    const entry = trackClass(cls.id);

    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id,
      p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "TRIAL",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(error).toBeNull();
    expect((data as any).reservation_id).toBeTruthy();
    entry.reservationIds.push((data as any).reservation_id);

    const remaining = await fetchMembershipRemaining(expired.id);
    expect(remaining).toBe(0); // 만료 수강권은 손대지 않음(그대로 0)
  });

  it("ADMIN_ASSIGNMENT 취소 시 사용한 수강권 잔여횟수가 정확히 복구된다", async () => {
    const membership = await createTestMembership(centerAId, member.profileId, { remainingCount: 5 });
    const cls = await createFutureTestClass(centerAId, { title: "성공경로-직접배치취소복구" });
    const entry = trackClass(cls.id);

    const { data: assignData, error: assignErr } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id,
      p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT",
      p_membership_id: membership.id,
      p_reason_code: "MAKEUP_CLASS",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(assignErr).toBeNull();
    const reservationId = (assignData as any).reservation_id as string;
    entry.reservationIds.push(reservationId);
    expect(await fetchMembershipRemaining(membership.id)).toBe(4);

    const { data: cancelData, error: cancelErr } = await supabase.rpc("admin_cancel_reservation", {
      p_reservation_id: reservationId,
      p_cancel_reason: "테스트 취소",
    });
    expect(cancelErr).toBeNull();
    expect((cancelData as any).restored).toBe(true);
    expect(await fetchMembershipRemaining(membership.id)).toBe(5); // 정확히 복구

    const { data: resRow, error: resErr } = await supabase
      .from("reservations")
      .select("status, cancelled_by, cancel_reason, cancelled_at")
      .eq("id", reservationId)
      .single();
    if (resErr) throw new Error(resErr.message);
    expect(resRow.status).toBe("cancelled");
    expect(resRow.cancelled_by).toBe(managerA.accountId);
    expect(resRow.cancel_reason).toBe("테스트 취소");
    expect(resRow.cancelled_at).toBeTruthy();
  });

  it("ADMIN_FREE 취소 시 수강권/미배치 상태에 변화가 없다", async () => {
    // 취소가 "아무것도 건드리지 않는다"는 것을 증명하기 위해, 같은 회원의 무관한 수강권을 하나
    // 곁에 두고 취소 전후 잔여횟수가 그대로인지 확인한다.
    const untouched = await createTestMembership(centerAId, member.profileId, { remainingCount: 5 });
    const cls = await createFutureTestClass(centerAId, { title: "성공경로-무료배치취소" });
    const entry = trackClass(cls.id);

    const { data: assignData, error: assignErr } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id,
      p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "EVENT",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(assignErr).toBeNull();
    const reservationId = (assignData as any).reservation_id as string;
    entry.reservationIds.push(reservationId);

    const { data: cancelData, error: cancelErr } = await supabase.rpc("admin_cancel_reservation", {
      p_reservation_id: reservationId,
      p_cancel_reason: null,
    });
    expect(cancelErr).toBeNull();
    expect((cancelData as any).restored).toBe(false); // 복구할 것 자체가 없음

    expect(await fetchMembershipRemaining(untouched.id)).toBe(5); // 무관한 수강권은 그대로
  });

  it("예약 생성과 동시에 admin_action_logs가 생성된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "성공경로-작업로그" });
    const entry = trackClass(cls.id);

    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id,
      p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "CENTER_OPERATION",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(error).toBeNull();
    const reservationId = (data as any).reservation_id as string;
    entry.reservationIds.push(reservationId);

    const { data: logs, error: logErr } = await supabase
      .from("admin_action_logs")
      .select("action_type, reservation_type, admin_id, member_profile_id, class_id, reason_code")
      .eq("reservation_id", reservationId);
    if (logErr) throw new Error(logErr.message);
    expect(logs).toHaveLength(1);
    expect(logs![0].action_type).toBe("CREATE_FREE");
    expect(logs![0].reservation_type).toBe("ADMIN_FREE");
    expect(logs![0].admin_id).toBe(managerA.accountId);
    expect(logs![0].member_profile_id).toBe(member.profileId);
    expect(logs![0].class_id).toBe(cls.id);
    expect(logs![0].reason_code).toBe("CENTER_OPERATION");
  });

  it("예약 생성과 동시에 회원 앱 내 알림이 생성된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "성공경로-회원알림" });
    const entry = trackClass(cls.id);

    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id,
      p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "EVENT",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(error).toBeNull();
    const reservationId = (data as any).reservation_id as string;
    entry.reservationIds.push(reservationId);

    await asMember();
    const { data: notis, error: notiErr } = await supabase
      .from("notifications")
      .select("kind, title, data")
      .eq("kind", "admin_assigned")
      .order("created_at", { ascending: false })
      .limit(20);
    if (notiErr) throw new Error(notiErr.message);
    const match = (notis ?? []).find((n: any) => n.data?.reservation_id === reservationId);
    expect(match).toBeTruthy();
    expect(match!.title).toBe("관리자가 예약을 등록했습니다");
    // 무료배치 여부/사유/관리자명 등 내부 정보가 회원 알림에 노출되지 않아야 함 —
    // data에 reservation_type 자체가 없어야 함(ADMIN_FREE/ADMIN_ASSIGNMENT 구분이 새어나가면 안 됨)
    expect((match as any).data.reservation_type).toBeUndefined();
    expect((match as any).data.reason_code).toBeUndefined();
    expect(JSON.stringify(match)).not.toContain("EVENT");
    expect(JSON.stringify(match)).not.toContain(managerA.accountId);
  });

  it("같은 회원·같은 수업에 대한 동시 요청은 정확히 한 건만 생성된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "성공경로-동시요청" });
    const entry = trackClass(cls.id);

    const call = () =>
      supabase.rpc("admin_assign_reservation", {
        p_class_id: cls.id,
        p_profile_id: member.profileId,
        p_assignment_type: "ADMIN_FREE",
        p_membership_id: null,
        p_reason_code: "EVENT",
        p_reason_detail: null,
        p_force_capacity: false,
      });
    const [r1, r2] = await Promise.all([call(), call()]);

    const successes = [r1, r2].filter((r) => !r.error && (r.data as any)?.reservation_id);
    const failures = [r1, r2].filter((r) => !!r.error);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].error!.message).toContain("이미 이 수업에 예약된 회원");
    entry.reservationIds.push((successes[0].data as any).reservation_id);

    const { count, error: countErr } = await supabase
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("class_id", cls.id)
      .in("status", ["confirmed", "waitlisted", "attended"]);
    if (countErr) throw new Error(countErr.message);
    expect(count).toBe(1);
  });
});

// P1-11: 그룹 수업의 정원초과 2단계 확인 흐름(1차 저지 → 사유 입력 → p_force_capacity
// 재호출로 실제 생성) 자체를 검증하는 테스트가 없었다(docs/TODO.md P1-11 참고) — 프라이빗
// 수업 쪽은 tests/integration/private-class-capacity.test.ts가 이미 "이 override는 아예
// 거부돼야 한다"를 검증하지만, 그룹 수업은 반대로 "1차는 막히고 재호출하면 실제로 생성돼야
// 한다"는 정상 동작 자체가 미검증이었다.
describe("관리자 직접배치 — 그룹 수업 정원초과 2단계 확인 흐름", () => {
  it("정원이 차면 force_capacity 없이는 needs_capacity_confirm만 반환하고 예약을 만들지 않으며, force_capacity=true로 재호출하면 실제 생성된다", async () => {
    const cls = await createFutureTestClass(centerAId, { capacity: 1, title: "정원초과2단계-그룹" });
    const entry = trackClass(cls.id);
    const memA = await createTestMembership(centerAId, member.profileId, { remainingCount: 5 });
    const memB = await createTestMembership(centerAId, memberB.profileId, { remainingCount: 5 });

    // 1) 정원(1명)을 채운다
    const first = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id, p_profile_id: member.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT", p_membership_id: memA.id,
      p_reason_code: "MAKEUP_CLASS", p_reason_detail: null, p_force_capacity: false,
    });
    expect(first.error).toBeNull();
    expect((first.data as any).needs_capacity_confirm).toBeFalsy();
    entry.reservationIds.push((first.data as any).reservation_id);

    // 2) 정원 찬 상태에서 force_capacity 없이 두 번째 배치 시도 → 저지, 예약 미생성
    const second = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id, p_profile_id: memberB.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT", p_membership_id: memB.id,
      p_reason_code: "MEMBER_REQUEST", p_reason_detail: null, p_force_capacity: false,
    });
    expect(second.error).toBeNull();
    expect((second.data as any).needs_capacity_confirm).toBe(true);
    expect((second.data as any).reservation_id).toBeFalsy();

    const { data: afterBlock, error: afterBlockErr } = await supabase
      .from("reservations").select("id").eq("class_id", cls.id).neq("status", "cancelled");
    if (afterBlockErr) throw new Error(afterBlockErr.message);
    expect((afterBlock ?? []).length).toBe(1);

    // 3) 사유 입력 후 force_capacity=true로 재호출 → 실제 생성, over_capacity=true
    const third = await supabase.rpc("admin_assign_reservation", {
      p_class_id: cls.id, p_profile_id: memberB.profileId,
      p_assignment_type: "ADMIN_ASSIGNMENT", p_membership_id: memB.id,
      p_reason_code: "MEMBER_REQUEST", p_reason_detail: "정원 초과 요청", p_force_capacity: true,
    });
    expect(third.error).toBeNull();
    expect((third.data as any).reservation_id).toBeTruthy();
    expect((third.data as any).over_capacity).toBe(true);
    entry.reservationIds.push((third.data as any).reservation_id);

    const { data: finalRows, error: finalErr } = await supabase
      .from("reservations").select("id, is_capacity_override").eq("class_id", cls.id).neq("status", "cancelled");
    if (finalErr) throw new Error(finalErr.message);
    expect((finalRows ?? []).length).toBe(2);
    const overrideRow = (finalRows ?? []).find((r: any) => r.id === (third.data as any).reservation_id);
    expect(overrideRow?.is_capacity_override).toBe(true);
  });
});
