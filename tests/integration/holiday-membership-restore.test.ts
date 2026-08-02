/*
  P0-6 회귀 테스트 — add_holiday_safe()가 강제 휴무일 지정 시 삭제되는 예약의 수강권
  횟수를 정확히 복구하는지 검증한다.

  ⚠️ 이 파일은 fix_holiday_membership_restore_draft_proposed.sql이 실제로 Supabase에
  적용되기 전에는 의도적으로 FAIL해야 합니다(현재 add_holiday_safe()는 예약을 그냥
  지우기만 하고 수강권을 복구하지 않음). 승인 후 실행하면 이 파일이 green이 되어야
  정상입니다.

  범위: 일반취소(cancel_reservation)/관리자취소(admin_cancel_reservation)는 기존
  tests/integration/payment-lifecycle.test.ts, admin-assignment-security.test.ts가 이미
  광범위하게 커버하고 있어 이 파일에서 다시 만들지 않는다(전체 회귀 테스트로 이 파일들이
  계속 green인지만 확인). 동시성(동시 예약/동시 취소)은 이 테스트 스위트가 계정 세션을
  하나씩 순서대로 전환하는 구조(setup.ts 상단 설명)라 진짜 병렬 요청을 만들 수 없다 —
  대신 "이미 취소된 예약이 섞여 있어도 이중 복구되지 않는다"로 핵심 안전 속성(같은 예약을
  두 번 복구하지 않음)을 검증한다. "복구 중 실패" 시나리오는 함수 전체가 하나의 PL/pgSQL
  트랜잭션이라 Postgres가 원자적으로 보장하므로(부분 실패 시 전체 롤백) 별도 fault-injection
  테스트 없이 분석적으로 커버된 것으로 간주한다.

  예약 fixture는 raw insert 대신 실제 RPC(admin_assign_reservation/admin_cancel_reservation)만
  사용한다 — CI에서 service_role이 reservations/memberships 테이블에 대한 SQL GRANT 자체가
  없다는 사실을 발견해(docs/TODO.md P2-13) admin client로 직접 insert/select를 할 수 없기
  때문이다. 이 방식이 오히려 실제 앱이 예약을 만드는 유일한 경로와 100% 동일해 더 사실적이다.

  Fixture: TEST_MANAGER_A(centerA 오너)만 사용 — 새 GitHub Secrets 없음. 이 파일이
  생성한 모든 행은 afterAll에서 성공·실패와 무관하게 정리를 시도한다(TEST-002 원칙). 다만
  memberships는 매니저 delete RLS 정책 자체가 없어(payments/orders와 동일한 기존 관례,
  admin-assignment-security.test.ts에도 동일하게 기록됨) 삭제하지 않고 공유 개발 DB에
  잔존시킨다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  createTestMembership,
  cleanupTestClass,
  type TestUser,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };

function kstDateOf(isoStart: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(isoStart));
}

async function assignAdmin(classId: string, profileId: string, membershipId: string | null, type: "ADMIN_ASSIGNMENT" | "ADMIN_FREE") {
  const { data, error } = await supabase.rpc("admin_assign_reservation", {
    p_class_id: classId,
    p_profile_id: profileId,
    p_assignment_type: type,
    p_membership_id: membershipId,
    p_reason_code: type === "ADMIN_FREE" ? "EVENT" : null,
  });
  if (error) throw new Error(`admin_assign_reservation 실패(class=${classId}): ${error.message}`);
  return (data as { reservation_id: string }).reservation_id;
}

let managerA: TestUser;
let centerAId: string;
let holidayDate: string;

const classIds: string[] = [];
let membershipLimitedId: string;
let membershipMultiId: string;
let membershipUnlimitedId: string;
let membershipAlreadyCancelledId: string;
let createdHoliday = false;

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  // 같은 KST 날짜에 클래스 6개(시나리오별로 1개씩 — admin_assign_reservation은 같은
  // (class, profile) 쌍에 활성 예약이 이미 있으면 거부하므로 클래스를 분리한다).
  const hours = [60, 61, 62, 63, 64, 65];
  const classes = [];
  for (const h of hours) {
    const c = await createFutureTestClass(centerAId, { title: `P0-6 테스트 수업 ${h}`, hoursFromNow: h });
    classes.push(c);
    classIds.push(c.id);
  }
  holidayDate = kstDateOf(classes[0].startTime);
  for (const c of classes) {
    if (kstDateOf(c.startTime) !== holidayDate) {
      throw new Error("테스트 전제 실패: 모든 테스트 수업이 같은 KST 날짜에 있어야 합니다(hoursFromNow 조정 필요)");
    }
  }
  const [classLimited, classMultiA, classMultiB, classUnlimited, classFree, classCancelled] = classes;

  membershipLimitedId = (await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 })).id;
  membershipMultiId = (await createTestMembership(centerAId, managerA.profileId, { remainingCount: 2 })).id;
  membershipAlreadyCancelledId = (await createTestMembership(centerAId, managerA.profileId, { remainingCount: 1 })).id;

  // 무제한(기간)권 — createTestMembership은 횟수권만 지원해 직접 생성. schema.sql 주석 기준
  // pass_type은 'count'(횟수권)/'period'(기간권=무제한)만 허용된다(memberships_pass_type_check).
  {
    const { data, error } = await supabase
      .from("memberships")
      .insert({
        profile_id: managerA.profileId, center_id: centerAId, product_name: "P0-6 테스트 무제한권",
        pass_type: "period", total_count: null, remaining_count: null,
        expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10), status: "active",
      })
      .select("id").single();
    if (error) throw new Error("무제한권 fixture 생성 실패: " + error.message);
    membershipUnlimitedId = (data as { id: string }).id;
  }

  await assignAdmin(classLimited.id, managerA.profileId, membershipLimitedId, "ADMIN_ASSIGNMENT");   // 복구되어야 함(3→4)
  await assignAdmin(classMultiA.id, managerA.profileId, membershipMultiId, "ADMIN_ASSIGNMENT");      // 복구되어야 함(같은 수강권 2건 중 1건)
  await assignAdmin(classMultiB.id, managerA.profileId, membershipMultiId, "ADMIN_ASSIGNMENT");      // 복구되어야 함(합쳐서 2→4)
  await assignAdmin(classUnlimited.id, managerA.profileId, membershipUnlimitedId, "ADMIN_ASSIGNMENT"); // 복구 대상 아님(무제한, null 유지, 크래시 없음)
  await assignAdmin(classFree.id, managerA.profileId, null, "ADMIN_FREE");                           // membership_id=null — 복구 대상 자체가 아님

  // 이미 취소된 예약 — admin_cancel_reservation이 이미 정확히 복구(1 그대로)한 상태로 만든 뒤,
  // add_holiday_safe가 이걸 다시 건드리지(이중 복구) 않는지 확인한다.
  const cancelledReservationId = await assignAdmin(classCancelled.id, managerA.profileId, membershipAlreadyCancelledId, "ADMIN_ASSIGNMENT");
  const { error: cancelErr } = await supabase.rpc("admin_cancel_reservation", {
    p_reservation_id: cancelledReservationId, p_cancel_reason: "P0-6 fixture: 사전 취소",
  });
  if (cancelErr) throw new Error("사전 취소 fixture 실패: " + cancelErr.message);
}, 30000);

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];

  // 휴무일 지정이 성공했다면 클래스/예약은 이미 삭제됐을 것 — cleanupTestClass는 best-effort라
  // 남아있으면 정리하고, 이미 없으면 조용히 넘어간다.
  for (const classId of classIds) {
    try {
      await cleanupTestClass(classId, []);
    } catch (e: any) {
      errors.push(`class 정리 실패(id=${classId}): ${e.message}`);
    }
  }
  // memberships는 매니저가 delete할 수 있는 RLS 정책이 없어(payments/orders와 동일한 기존 관례)
  // 삭제하지 않는다 — 테스트 수강권 fixture는 공유 개발 DB에 의도적으로 잔존시킨다.
  if (createdHoliday) {
    try {
      await supabase.from("center_holidays").delete().eq("center_id", centerAId).eq("holiday_date", holidayDate);
    } catch (e: any) {
      errors.push(`휴무일 정리 실패: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`P0-6 fixture cleanup 실패 — 공유 개발 DB에 잔여 데이터가 남았을 수 있습니다:\n${errors.join("\n")}`);
  }
}, 30000);

describe("P0-6: add_holiday_safe() 강제 지정 시 수강권 복구", () => {
  it("먼저 강제(force) 없이 호출하면 확인 요청만 반환하고 아무것도 지우지 않는다", async () => {
    const { data, error } = await supabase.rpc("add_holiday_safe", {
      p_center_id: centerAId, p_date: holidayDate, p_reason: "P0-6 통합테스트", p_force: false,
    });
    expect(error).toBeNull();
    expect((data as any).needs_confirm).toBe(true);
    expect((data as any).class_count).toBeGreaterThanOrEqual(6);
    expect((data as any).reservation_count).toBeGreaterThanOrEqual(5); // cancelled 1건 제외한 나머지
  });

  it("force=true로 실제 지정하면 수강권이 정확히 복구되고, 무제한/미배치/이미취소 건은 영향 없다", async () => {
    const { data, error } = await supabase.rpc("add_holiday_safe", {
      p_center_id: centerAId, p_date: holidayDate, p_reason: "P0-6 통합테스트", p_force: true,
    });
    expect(error).toBeNull();
    expect((data as any).needs_confirm).toBe(false);
    createdHoliday = true;

    const { data: mems, error: memErr } = await supabase
      .from("memberships")
      .select("id, remaining_count")
      .in("id", [membershipLimitedId, membershipMultiId, membershipUnlimitedId, membershipAlreadyCancelledId]);
    if (memErr) throw new Error(memErr.message);
    const byId = new Map((mems ?? []).map((m: any) => [m.id, m.remaining_count]));

    expect(byId.get(membershipLimitedId)).toBe(4); // 3 → 4, 확정 예약 1건 복구
    expect(byId.get(membershipMultiId)).toBe(4);   // 2 → 4, 같은 수강권으로 확정 예약 2건(다른 클래스) 복구
    expect(byId.get(membershipUnlimitedId)).toBeNull(); // 무제한권은 그대로 null 유지(크래시 없음)
    expect(byId.get(membershipAlreadyCancelledId)).toBe(1); // 이미 취소된 예약 — 이중 복구되지 않고 1 그대로

    // 예약/클래스는 삭제됐어야 한다(기존 동작 유지 확인)
    const { data: remainingClasses } = await supabase.from("classes").select("id").in("id", classIds);
    expect(remainingClasses ?? []).toHaveLength(0);
  });

  it("휴무일이 등록됐다", async () => {
    const { data, error } = await supabase
      .from("center_holidays")
      .select("id")
      .eq("center_id", centerAId)
      .eq("holiday_date", holidayDate);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });
});
