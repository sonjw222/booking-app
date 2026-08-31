/*
  cancel_reservation() 유령 잔여횟수 회귀 테스트.

  ⚠️ 이 파일은 다음 SQL이 적용되기 전에는 의도적으로 FAIL해야 합니다:
    fix_cancel_reservation_refunded_membership_ghost_count.sql
  적용 후 green이 되어야 정상입니다.

  배경: cancel_reservation()이 status='confirmed'인 예약을 취소할 때 memberships.remaining_count를
  조건 없이 +1 했다. 그 사이 그 수강권이 이미 환불(refunded, 돈이 정산됨)되거나 양도(transferred,
  소유권이 다른 사람에게 넘어감)됐다면, 취소 시 되살아난 remaining_count는 아무도 정당하게 쓸 수
  없는 "유령 잔여횟수"가 된다(프로덕션에서 실제로 발견된 사례).

  createTestMembership()(setup.ts)은 (profile, center, product_id is null) 조합의 행을 이름으로
  찾아 재사용하는 공유 fixture라 이 테스트처럼 status를 refunded/transferred로 바꿔야 하는 경우
  다른 파일과 충돌할 위험이 있다(memory: shared fixture pollution) — 이 파일은 그 헬퍼를 쓰지 않고
  전용 product_name으로 직접 memberships 행을 만들어 완전히 격리한다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  cleanupTestClass,
  getFixtureAdminClient,
  fetchMembershipRemaining,
  type TestUser,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const PRODUCT_NAME_PREFIX = "통합테스트 유령잔여횟수";

let managerA: TestUser;
let centerAId: string;
const createdClassIds: string[] = [];
const createdMembershipIds: string[] = [];

// totalCount짜리 수강권을 "이미 1회 소모된"(remaining = totalCount - 1) 상태로 만든다 —
// createConfirmedReservation()이 reserve_class()를 거치지 않고 직접 확정 예약을 심는
// 대신, 그 예약이 정상적으로 1회를 소모한 상태를 미리 반영해둔다(cancel_reservation()이
// 취소 시 +1 하는 게 맞는지만 보면 되므로 실제 예약→차감 과정을 재현할 필요는 없음).
async function createIsolatedMembership(totalCount: number): Promise<string> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin
    .from("memberships")
    .insert({
      profile_id: managerA.profileId,
      center_id: centerAId,
      product_name: `${PRODUCT_NAME_PREFIX} ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      pass_type: "count",
      total_count: totalCount,
      remaining_count: totalCount - 1,
      expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`격리된 테스트 수강권 생성 실패: ${error?.message ?? "no data"}`);
  createdMembershipIds.push(data.id);
  return data.id;
}

// reserve_class()는 그 프로필의 "만료 임박순" 유효 수강권을 자동 선택한다(reservation_
// functions.sql, order by expires_at asc limit 1) — managerA는 다른 통합 테스트 파일들이
// 공유하는 fixture 계정이라 이미 유효한 수강권을 여러 개 갖고 있을 수 있고, 실측 확인 결과
// 실제로 매번 다른(격리되지 않은) 수강권이 선택돼 충돌했다. 이 테스트는 reserve_class()의
// 선택 로직 자체를 검증하는 게 아니라 cancel_reservation()의 환급 로직만 보면 되므로,
// reserve_class()를 거치지 않고 "확정 예약 1건이 이미 존재하고 그 수강권이 1회 소모된"
// 상태를 admin으로 직접 재현한다(membership은 remaining을 미리 1 줄여서 만들고, 그 상태를
// 가리키는 confirmed 예약 행을 직접 insert).
async function createConfirmedReservation(classId: string, membershipId: string): Promise<string> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin
    .from("reservations")
    .insert({ class_id: classId, profile_id: managerA.profileId, membership_id: membershipId, status: "confirmed" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`격리된 확정 예약 생성 실패: ${error?.message ?? "no data"}`);
  return data.id;
}

async function setMembershipStatus(membershipId: string, status: "refunded" | "transferred", remainingCount: number) {
  const admin = getFixtureAdminClient();
  const { error } = await admin
    .from("memberships")
    .update({ status, remaining_count: remainingCount })
    .eq("id", membershipId);
  if (error) throw new Error(`수강권 상태 변경 실패: ${error.message}`);
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
}, 30000);

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];
  for (const classId of createdClassIds) {
    try { await cleanupTestClass(classId, []); } catch (e: any) { errors.push(e.message); }
  }
  const admin = getFixtureAdminClient();
  for (const id of createdMembershipIds) {
    try { await admin.from("memberships").delete().eq("id", id); } catch (e: any) { errors.push(e.message); }
  }
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 30000);

describe("cancel_reservation(): 환불/양도된 수강권의 유령 잔여횟수 방지", () => {
  it("정상(active) 수강권은 기존과 동일하게 취소 시 잔여횟수가 환급된다 (회귀 확인)", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "유령잔여-active대조군", hoursFromNow: 240 });
    createdClassIds.push(cls.id);
    const memId = await createIsolatedMembership(3);
    expect(await fetchMembershipRemaining(memId)).toBe(2); // 1회 소모된 상태로 생성됨

    const resId = await createConfirmedReservation(cls.id, memId);

    const { data, error } = await supabase.rpc("cancel_reservation", { p_reservation_id: resId });
    expect(error).toBeNull();
    expect((data as any).cancelled).toBe(true);
    expect(await fetchMembershipRemaining(memId)).toBe(3); // 정상 환급
  });

  it("환불(refunded) 처리된 수강권에 걸린 예약을 취소해도 잔여횟수가 되살아나지 않는다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "유령잔여-refunded", hoursFromNow: 240 });
    createdClassIds.push(cls.id);
    const memId = await createIsolatedMembership(3);
    const resId = await createConfirmedReservation(cls.id, memId);

    // 환불 처리를 흉내낸다: 상태를 refunded로, 잔여횟수를 0으로(실제 환불 로직과 동일하게)
    await setMembershipStatus(memId, "refunded", 0);

    const { data, error } = await supabase.rpc("cancel_reservation", { p_reservation_id: resId });
    expect(error).toBeNull();
    expect((data as any).cancelled).toBe(true); // 취소 자체는 정상 처리됨
    expect(await fetchMembershipRemaining(memId)).toBe(0); // 유령 잔여횟수가 생기지 않음 (여전히 0)
  });

  it("양도(transferred)된 수강권에 걸린 예약을 취소해도 잔여횟수가 되살아나지 않는다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "유령잔여-transferred", hoursFromNow: 240 });
    createdClassIds.push(cls.id);
    const memId = await createIsolatedMembership(3);
    const resId = await createConfirmedReservation(cls.id, memId);

    // 양도 처리를 흉내낸다: 소유권이 넘어가 잔여횟수는 새 소유자 몫이므로 원래 값(2)을 그대로 둔 채 상태만 바꾼다
    await setMembershipStatus(memId, "transferred", 2);

    const { data, error } = await supabase.rpc("cancel_reservation", { p_reservation_id: resId });
    expect(error).toBeNull();
    expect((data as any).cancelled).toBe(true);
    expect(await fetchMembershipRemaining(memId)).toBe(2); // +1 되지 않고 그대로 유지
  });
});
