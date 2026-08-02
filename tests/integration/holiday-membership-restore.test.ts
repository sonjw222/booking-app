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

  Fixture: TEST_MANAGER_A(centerA 오너)만 사용 — 새 GitHub Secrets 없음. 이 파일이
  생성한 모든 행은 afterAll에서 성공·실패와 무관하게 전부 정리한다(TEST-002 원칙).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  describeAdminQueryError,
  createFutureTestClass,
  createTestMembership,
  type TestUser,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };

function kstDateOf(isoStart: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(isoStart));
}

let managerA: TestUser;
let centerAId: string;
let holidayDate: string;

// 생성한 리소스 — afterAll에서 정리(휴무일 지정으로 이미 지워졌을 클래스/예약은 정리 시도만 하고 무시)
let classAId: string | null = null;
let classBId: string | null = null;
let membershipLimitedId: string | null = null;
let membershipMultiId: string | null = null;
let membershipUnlimitedId: string | null = null;
let membershipFreeId: string | null = null;
let membershipAlreadyCancelledId: string | null = null;
let createdHoliday = false;

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  // 같은 날짜에 클래스 2개(같은 수강권으로 두 건 예약하는 케이스 검증용)
  const classA = await createFutureTestClass(centerAId, { title: "P0-6 테스트 수업 A", hoursFromNow: 72 });
  classAId = classA.id;
  holidayDate = kstDateOf(classA.startTime);

  // classB도 같은 KST 날짜에 들어가도록 hoursFromNow를 classA와 가깝게(같은 날 다른 시간) 잡는다.
  const classB = await createFutureTestClass(centerAId, { title: "P0-6 테스트 수업 B", hoursFromNow: 74 });
  classBId = classB.id;
  if (kstDateOf(classB.startTime) !== holidayDate) {
    throw new Error("테스트 전제 실패: classA/classB가 같은 KST 날짜에 있어야 합니다(hoursFromNow 조정 필요)");
  }

  membershipLimitedId = (await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 })).id;
  membershipMultiId = (await createTestMembership(centerAId, managerA.profileId, { remainingCount: 2 })).id;
  membershipAlreadyCancelledId = (await createTestMembership(centerAId, managerA.profileId, { remainingCount: 1 })).id;

  const admin = getFixtureAdminClient();

  // 무제한권(remaining_count = null) — admin client로 직접 생성(createTestMembership은 횟수권만 지원)
  {
    const { data, error } = await admin
      .from("memberships")
      .insert({
        profile_id: managerA.profileId, center_id: centerAId, product_name: "P0-6 테스트 무제한권",
        pass_type: "unlimited", total_count: null, remaining_count: null,
        expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10), status: "active",
      })
      .select("id").single();
    if (error) throw new Error("무제한권 fixture 생성 실패: " + describeAdminQueryError("memberships", error));
    membershipUnlimitedId = (data as { id: string }).id;
  }
  // ADMIN_FREE 시뮬레이션용 — 실제로 차감된 적 없는 상태를 만들기 위해 membership_consumed=false로
  // 표시할 예약에 연결할 횟수권(복구되면 안 됨을 확인하는 용도)
  membershipFreeId = (await createTestMembership(centerAId, managerA.profileId, { remainingCount: 4 })).id;

  // 예약 fixture들 — admin client로 직접 생성(정확한 status/membership_consumed 조합을 세밀하게 통제하기 위함)
  async function insertReservation(classId: string, membershipId: string, status: string, consumed: boolean) {
    const { error } = await admin.from("reservations").insert({
      class_id: classId, profile_id: managerA.profileId, membership_id: membershipId,
      status, membership_consumed: consumed,
    });
    if (error) throw new Error("예약 fixture 생성 실패: " + describeAdminQueryError("reservations", error));
  }

  await insertReservation(classAId, membershipLimitedId, "confirmed", true);       // 복구되어야 함(3→4)
  await insertReservation(classAId, membershipMultiId, "confirmed", true);         // 복구되어야 함(같은 수강권 2건 중 1건)
  await insertReservation(classBId, membershipMultiId, "confirmed", true);         // 복구되어야 함(같은 수강권 2건 중 1건, 합쳐서 2→4)
  await insertReservation(classAId, membershipUnlimitedId, "confirmed", true);     // 복구 대상 아님(무제한, null 유지)
  await insertReservation(classAId, membershipFreeId, "confirmed", false);        // 복구되면 안 됨(membership_consumed=false)
  await insertReservation(classBId, membershipAlreadyCancelledId, "cancelled", true); // 이미 취소됨 — 이중 복구되면 안 됨(1 유지)
}, 30000);

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const admin = getFixtureAdminClient();
  const errors: string[] = [];

  // 휴무일 지정이 성공했다면 classA/classB와 그 예약들은 이미 삭제됐을 것 — 남아있으면 정리.
  for (const classId of [classAId, classBId]) {
    if (!classId) continue;
    try { await admin.from("reservations").delete().eq("class_id", classId); } catch { /* 이미 없음 */ }
    try { await admin.from("classes").delete().eq("id", classId); } catch { /* 이미 없음 */ }
  }
  for (const mId of [membershipLimitedId, membershipMultiId, membershipUnlimitedId, membershipFreeId, membershipAlreadyCancelledId]) {
    if (!mId) continue;
    const { error } = await admin.from("memberships").delete().eq("id", mId);
    if (error) errors.push(`membership 정리 실패(id=${mId}): ${describeAdminQueryError("memberships", error)}`);
  }
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
    expect((data as any).class_count).toBeGreaterThanOrEqual(2);
    expect((data as any).reservation_count).toBeGreaterThanOrEqual(5); // cancelled 1건 제외한 나머지
  });

  it("force=true로 실제 지정하면 수강권이 정확히 복구되고, 무제한/미차감/이미취소 건은 영향 없다", async () => {
    const { data, error } = await supabase.rpc("add_holiday_safe", {
      p_center_id: centerAId, p_date: holidayDate, p_reason: "P0-6 통합테스트", p_force: true,
    });
    expect(error).toBeNull();
    expect((data as any).needs_confirm).toBe(false);
    createdHoliday = true;

    const admin = getFixtureAdminClient();
    const { data: mems, error: memErr } = await admin
      .from("memberships")
      .select("id, remaining_count")
      .in("id", [membershipLimitedId, membershipMultiId, membershipUnlimitedId, membershipFreeId, membershipAlreadyCancelledId]);
    if (memErr) throw new Error(describeAdminQueryError("memberships", memErr));
    const byId = new Map((mems ?? []).map((m: any) => [m.id, m.remaining_count]));

    expect(byId.get(membershipLimitedId)).toBe(4); // 3 → 4, 확정 예약 1건 복구
    expect(byId.get(membershipMultiId)).toBe(4);   // 2 → 4, 같은 수강권으로 확정 예약 2건(다른 클래스) 복구
    expect(byId.get(membershipUnlimitedId)).toBeNull(); // 무제한권은 그대로 null 유지(크래시 없음)
    expect(byId.get(membershipFreeId)).toBe(4);    // membership_consumed=false라 복구 안 됨(원래 4 그대로)
    expect(byId.get(membershipAlreadyCancelledId)).toBe(1); // 이미 취소된 예약 — 이중 복구되지 않고 1 그대로

    // 예약/클래스는 삭제됐어야 한다(기존 동작 유지 확인)
    const { data: remainingRes } = await admin.from("reservations").select("id").eq("class_id", classAId!);
    expect(remainingRes ?? []).toHaveLength(0);
    const { data: remainingClasses } = await admin.from("classes").select("id").in("id", [classAId!, classBId!]);
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
