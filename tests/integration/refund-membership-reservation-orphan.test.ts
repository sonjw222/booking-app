/*
  refund_membership() 환불 후 예약 잔존 회귀 테스트(P1, 데이터 무결성 — 보안 아님).

  D안(A+C) 검증:
  - A: 미래 confirmed/waitlisted 예약이 있는 수강권은 refund_membership()이 거부한다.
  - C: (이미 존재하는 orphan 데이터에 대한 안전망) refunded 상태인 수강권에 연결된
    confirmed 예약을 cancel_reservation()으로 취소해도 remaining_count가 유령으로
    복구되지 않는다.

  실제 Live에서 2026-08-14 read-only 진단으로 이 orphan 상태(membership c582ef56...)가
  이미 존재함을 확인했다 — REFUND-SEC-C는 그 실제 시나리오를 재현한다.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  createFutureTestClass,
  createTestMembership,
  fetchMembershipRemaining,
  cleanupTestClassAdmin,
  type TestUser,
} from "./setup";

let userA: TestUser;
let centerAId: string;
const cleanupClassIds: string[] = [];

beforeAll(async () => {
  userA = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
  // 이 파일은 회원 본인 소유 수강권/예약만 다루므로 매니저 fixture는 필요 없지만,
  // createFutureTestClass가 요구하는 center_id는 있어야 한다 — 기존 TEST_MANAGER_A
  // 소유 센터를 그대로 재사용(다른 통합 테스트와 동일 관례).
  const manager = await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  centerAId = await getOrCreateOwnedTestCenter(manager);
  userA = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
}, 30000);

beforeEach(async () => {
  userA = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
});

afterAll(async () => {
  for (const id of cleanupClassIds) await cleanupTestClassAdmin(id);
});

describe("REFUND-SEC-A: 미래 예약이 있으면 환불 거부", () => {
  it("확정 예약이 남아있는 수강권은 환불이 거부된다", async () => {
    const membership = await createTestMembership(centerAId, userA.profileId, { remainingCount: 3 });
    const cls = await createFutureTestClass(centerAId, { title: "REFUND-SEC-A", hoursFromNow: 48 });
    cleanupClassIds.push(cls.id);

    const admin = getFixtureAdminClient();
    const { error: insertErr } = await admin.from("reservations").insert({
      class_id: cls.id, profile_id: userA.profileId, membership_id: membership.id, status: "confirmed",
    });
    if (insertErr) throw new Error("테스트 예약 생성 실패: " + insertErr.message);

    const { data, error } = await supabase.rpc("refund_membership", { p_membership_id: membership.id });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("예약된 수업이 있어요");

    // 정리: 다음 테스트에 영향 없도록 예약/수강권 상태 원복
    await admin.from("reservations").delete().eq("class_id", cls.id).eq("profile_id", userA.profileId);
  });
});

describe("REFUND-SEC-B: 예약 없는 정상 수강권은 그대로 환불된다(회귀)", () => {
  it("예약이 전혀 없는 미사용 수강권은 정상적으로 환불된다", async () => {
    const membership = await createTestMembership(centerAId, userA.profileId, { remainingCount: 5 });
    const { data, error } = await supabase.rpc("refund_membership", { p_membership_id: membership.id });
    expect(error).toBeNull();
    expect((data as any)?.refunded).toBe(true);

    // 다음 테스트를 위해 active로 원복(createTestMembership이 get-or-create라 같은 행을 재사용함)
    const admin = getFixtureAdminClient();
    await admin.from("memberships").update({ status: "active", remaining_count: 5 }).eq("id", membership.id);
  });
});

describe("REFUND-SEC-C: 이미 refunded인 수강권은 cancel_reservation()이 remaining_count를 복구하지 않는다(안전망)", () => {
  it("refunded 상태의 수강권에 남은 확정 예약을 취소해도 remaining_count는 0으로 유지된다", async () => {
    const admin = getFixtureAdminClient();
    // 2026-08-14 실측 orphan 사례(membership c582ef56...)와 동일한 상태를 직접 재현한다 —
    // 정상 흐름(REFUND-SEC-A가 막음)과 무관하게, 이미 이런 데이터가 존재할 수 있다는 걸
    // 실측으로 확인했으므로 이 안전망 자체를 독립적으로 검증한다.
    const { data: membership, error: memErr } = await admin
      .from("memberships")
      .insert({
        profile_id: userA.profileId, center_id: centerAId, product_name: "REFUND-SEC-C 테스트",
        pass_type: "count", total_count: 3, remaining_count: 0, status: "refunded",
        expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      })
      .select("id")
      .single();
    if (memErr || !membership) throw new Error("orphan 시나리오용 수강권 생성 실패: " + memErr?.message);

    const cls = await createFutureTestClass(centerAId, { title: "REFUND-SEC-C", hoursFromNow: 48 });
    cleanupClassIds.push(cls.id);

    const { data: reservation, error: resErr } = await admin
      .from("reservations")
      .insert({ class_id: cls.id, profile_id: userA.profileId, membership_id: membership.id, status: "confirmed" })
      .select("id")
      .single();
    if (resErr || !reservation) throw new Error("orphan 시나리오용 예약 생성 실패: " + resErr?.message);

    const { error } = await supabase.rpc("cancel_reservation", { p_reservation_id: reservation.id });
    expect(error).toBeNull();

    const remaining = await fetchMembershipRemaining(membership.id);
    expect(remaining).toBe(0); // 수정 전이었다면 1로 잘못 복구됐을 것

    await admin.from("memberships").delete().eq("id", membership.id);
  });
});
