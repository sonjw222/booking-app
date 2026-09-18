/*
  Automated Business Scenario E2E Batch(2026-09-18) — Phase 2: P1 동시성/경쟁.
  SCN-P1-01/02(중복 예약 방지: 더블클릭/동일 회원 동시 예약), SCN-P1-03(마지막 1자리
  동시 예약), SCN-P1-05(이중 취소 요청 방지), SCN-P1-07(대기 승격 동시성 — 정확히 1명만
  승격), SCN-P1-11(idempotency/retry — 네트워크 실패 후 재시도의 대리 검증).

  각 시나리오는 "결과가 성공/실패했는가"만 보지 않고, 반드시 최종 DB invariant까지
  검증한다(요청 5번): confirmed_count<=capacity, remaining_count>=0, 동일 회원 활성예약
  중복 없음, 마지막 자리엔 정확히 1명 확정, 승격은 정확히 1명, 수강권 차감/환급은 정확히
  1회.

  ⚠ 진짜 동시성 구현 방법: concurrentClient.ts 참고 — setup.ts의 단일 싱글턴은 세션 전환을
  의도적으로 직렬화하므로(authMutex) 두 사용자가 "같은 순간에" 요청을 보내는 상황을 표현할
  수 없다. race를 일으키는 RPC 호출만 독립된 client 인스턴스로 Promise.all 동시 실행한다.

  ⚠ SCN-P1-10(네트워크 실패 후 재시도) 자체는 이 샌드박스에서 진짜 네트워크 단절을 재현할
  방법이 없어 BLOCKED로 남긴다(registry.ts 참고) — 대신 그 실패가 실제로 위험한 이유("혹시
  중복 예약/중복 차감이 생기지 않을까")는 SCN-P1-11(재시도해도 중복이 안 생기는지)이
  그대로 검증한다. 네트워크 계층 자체를 흉내내는 게 아니라, 네트워크 실패가 우려하는
  결과(idempotency 위반)가 실제로 일어나지 않는지를 직접 확인하는 방식.
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../../lib/supabaseClient";
import { createFutureTestClass, createTestMembership, getOrCreateOwnedTestCenter, cleanupTestClassAdmin, getFixtureAdminClient, fetchMembershipRemaining } from "../setup";
import { managerA as loginManagerA, memberA as loginMemberA, memberB as loginMemberB, memberCSubProfile } from "./actors";
import { checkCoreInvariants, fetchReservationStatus, fetchReservationMembershipId } from "./invariants";
import { runScenario } from "./reporter";
import { loginConcurrentClient } from "./concurrentClient";

function newRunId(): string {
  return `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe("SCN-P1-01/02/03/05/07/11: 예약 동시성/경쟁", () => {
  let centerAId: string;
  let memberAAccountId: string;
  let memberAProfileId: string;
  let memberBAccountId: string;
  let memberBProfileId: string;
  let memberCProfileId: string;
  let originalWaitlistWeeklyLimit: number | null = null;
  const pendingClassIds: string[] = [];
  const pendingMembershipIds: string[] = [];

  beforeAll(async () => {
    const managerA = await loginManagerA();
    centerAId = await getOrCreateOwnedTestCenter(managerA);

    const admin = getFixtureAdminClient();
    const { data: existingSettings, error: readErr } = await admin
      .from("center_settings")
      .select("waitlist_weekly_limit")
      .eq("center_id", centerAId)
      .single();
    if (readErr) throw new Error(`테스트 센터 설정 조회 실패: ${readErr.message}`);
    originalWaitlistWeeklyLimit = (existingSettings as any).waitlist_weekly_limit;

    const { error: settingsErr } = await admin
      .from("center_settings")
      .update({ waitlist_weekly_limit: 10 })
      .eq("center_id", centerAId);
    if (settingsErr) throw new Error(`테스트 센터 대기예약 설정 실패: ${settingsErr.message}`);

    const memberA = await loginMemberA();
    memberAAccountId = memberA.accountId;
    memberAProfileId = memberA.profileId;
    const memberC = await memberCSubProfile(memberAAccountId);
    memberCProfileId = memberC.profileId;

    const memberB = await loginMemberB();
    memberBAccountId = memberB.accountId;
    memberBProfileId = memberB.profileId;
  }, 60000);

  afterAll(async () => {
    if (originalWaitlistWeeklyLimit === null) return;
    const admin = getFixtureAdminClient();
    await admin.from("center_settings").update({ waitlist_weekly_limit: originalWaitlistWeeklyLimit }).eq("center_id", centerAId);
  }, 30000);

  afterEach(async () => {
    while (pendingClassIds.length > 0) {
      const id = pendingClassIds.pop()!;
      await cleanupTestClassAdmin(id);
    }
    if (pendingMembershipIds.length > 0) {
      const admin = getFixtureAdminClient();
      const ids = pendingMembershipIds.splice(0, pendingMembershipIds.length);
      await admin.from("memberships").delete().in("id", ids);
    }
  }, 30000);

  async function makeClass(capacity: number, label: string) {
    const runId = newRunId();
    await loginManagerA();
    const cls = await createFutureTestClass(centerAId, { capacity, title: `QA-경쟁-${label}-${runId}` });
    pendingClassIds.push(cls.id);
    return cls;
  }

  async function issueMembership(profileId: string, remainingCount = 5) {
    await loginManagerA();
    const mem = await createTestMembership(centerAId, profileId, { remainingCount });
    pendingMembershipIds.push(mem.id);
    return mem;
  }

  it("SCN-P1-01/02: 같은 회원이 같은 수업에 동시에 두 번 예약 요청(더블클릭) → 정확히 1건만 확정", async () => {
    const cls = await makeClass(8, "dup");
    const membershipA = await issueMembership(memberAProfileId);

    await runScenario("SCN-P1-01-02", ["memberA(x2 concurrent)"], async (assertions) => {
      const [clientA1, clientA2] = await Promise.all([
        loginConcurrentClient("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD"),
        loginConcurrentClient("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD"),
      ]);

      const [r1, r2] = await Promise.all([
        clientA1.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null }),
        clientA2.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null }),
      ]);

      const successes = [r1, r2].filter((r) => !r.error && (r.data as any)?.status === "confirmed");
      const failures = [r1, r2].filter((r) => r.error);
      assertions.push({
        name: "동시 요청 중 정확히 1건만 성공",
        passed: successes.length === 1,
        detail: JSON.stringify({ r1: { data: r1.data, error: r1.error?.message }, r2: { data: r2.data, error: r2.error?.message } }),
      });
      expect(successes.length).toBe(1);
      assertions.push({ name: "나머지 1건은 명시적으로 거부됨(에러)", passed: failures.length === 1 });
      expect(failures.length).toBe(1);

      const admin = getFixtureAdminClient();
      const { data: activeRes } = await admin
        .from("reservations")
        .select("id,status")
        .eq("class_id", cls.id)
        .eq("profile_id", memberAProfileId)
        .in("status", ["confirmed", "waitlisted"]);
      assertions.push({ name: "DB상 활성 예약이 정확히 1건", passed: (activeRes ?? []).length === 1, detail: JSON.stringify(activeRes) });
      expect((activeRes ?? []).length).toBe(1);

      // ⚠ 실측 발견(하드닝): reserve_class()는 profile_id+center_id 기준 "expires_at ASC
      // LIMIT 1"로 유효 수강권을 자동 선택한다 — 공유 테스트 센터에 43개 기존 파일이 남긴
      // leftover 수강권이 많아서, 방금 issueMembership()으로 만든 membershipA가 아니라
      // 더 일찍 만료되는 다른 leftover 수강권이 실제로 선택/차감될 수 있음을 실측으로
      // 확인했다(재현됨). 그래서 "membershipA.id의 remaining_count가 4"를 직접 단언하면
      // 그 행이 애초에 안 쓰였을 때 거짓 실패(또는 반대로 다른 시나리오에서 거짓 통과)가
      //날 수 있다 — "정확히 1회 차감"은 이미 "활성 예약 정확히 1건"으로 충분히 증명된다
      // (reserve_class는 예약 insert와 차감 update를 같은 트랜잭션에서 원자적으로
      // 묶으므로, 예약이 1건 존재한다는 것 자체가 차감도 정확히 1회 일어났다는 증거).
      // 대신 "실제로 사용된" membership이 무엇이든 음수가 되지 않았는지는 확인한다.
      const usedMembershipId = await fetchReservationMembershipId((activeRes ?? [])[0].id);
      const violations = await checkCoreInvariants(cls.id, [membershipA.id, ...(usedMembershipId ? [usedMembershipId] : [])]);
      assertions.push({ name: "핵심 invariant 위반 없음(실제 사용된 수강권 포함)", passed: violations.length === 0, detail: JSON.stringify(violations) });
      expect(violations).toEqual([]);
    });
  }, 60000);

  it("SCN-P1-03: capacity=1 수업에 서로 다른 두 회원이 동시 예약 → 정확히 1명만 확정, 나머지는 대기", async () => {
    const cls = await makeClass(1, "lastslot");
    const membershipA = await issueMembership(memberAProfileId);
    const membershipB = await issueMembership(memberBProfileId);

    await runScenario("SCN-P1-03", ["memberA", "memberB"], async (assertions) => {
      const [clientA, clientB] = await Promise.all([
        loginConcurrentClient("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD"),
        loginConcurrentClient("TEST_USER_B_EMAIL", "TEST_USER_B_PASSWORD"),
      ]);

      const [rA, rB] = await Promise.all([
        clientA.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null }),
        clientB.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null }),
      ]);

      const statuses = [rA, rB].map((r) => (r.error ? "error" : (r.data as any)?.status));
      const confirmedCount = statuses.filter((s) => s === "confirmed").length;
      const waitlistedCount = statuses.filter((s) => s === "waitlisted").length;
      assertions.push({
        name: "정확히 1명 확정, 나머지 1명 대기(정원 초과 거부 없이 대기로 흡수)",
        passed: confirmedCount === 1 && waitlistedCount === 1,
        detail: JSON.stringify({ statuses, rA: rA.error?.message, rB: rB.error?.message }),
      });
      expect(confirmedCount).toBe(1);
      expect(waitlistedCount).toBe(1);

      const violations = await checkCoreInvariants(cls.id, [membershipA.id, membershipB.id]);
      assertions.push({ name: "capacity invariant 포함 핵심 invariant 위반 없음", passed: violations.length === 0, detail: JSON.stringify(violations) });
      expect(violations).toEqual([]);
    });
  }, 60000);

  it("SCN-P1-05: 같은 예약을 동시에 두 번 취소 요청 → 정확히 1회만 취소 처리, 중복 환급 없음", async () => {
    const cls = await makeClass(8, "dblcancel");
    const membershipA = await issueMembership(memberAProfileId);

    await runScenario("SCN-P1-05", ["memberA"], async (assertions) => {
      await loginMemberA();
      const reserveRes = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((reserveRes.data as any).status).toBe("confirmed");
      const reservationId = (reserveRes.data as any).reservation_id as string;

      // ⚠ 하드닝: membershipA.id가 아니라 예약이 "실제로 사용한" membership을 추적한다
      // (leftover 수강권이 선택될 수 있음 — 위 SCN-P1-01/02 주석 참고). 차감 직후 값을
      // before로 스냅샷해두고, 이중취소 후 정확히 +1(환급 1회)만 됐는지 델타로 검증한다 —
      // 절대값(예: "5여야 함")을 단언하면 애초에 이 membership이 안 쓰였을 때 거짓 통과할
      // 위험이 있다(실측으로 확인된 문제).
      const usedMembershipId = (await fetchReservationMembershipId(reservationId))!;
      const afterReserveCount = (await fetchMembershipRemaining(usedMembershipId))!;

      const [clientA1, clientA2] = await Promise.all([
        loginConcurrentClient("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD"),
        loginConcurrentClient("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD"),
      ]);
      const [c1, c2] = await Promise.all([
        clientA1.rpc("cancel_reservation", { p_reservation_id: reservationId }),
        clientA2.rpc("cancel_reservation", { p_reservation_id: reservationId }),
      ]);

      const successes = [c1, c2].filter((r) => !r.error && (r.data as any)?.cancelled === true);
      assertions.push({
        name: "동시 취소 요청 중 정확히 1건만 성공(나머지는 '이미 취소된 예약' 등으로 거부)",
        passed: successes.length === 1,
        detail: JSON.stringify({ c1: { data: c1.data, error: c1.error?.message }, c2: { data: c2.data, error: c2.error?.message } }),
      });
      expect(successes.length).toBe(1);

      const finalStatus = await fetchReservationStatus(reservationId);
      assertions.push({ name: "최종 상태는 cancelled 정확히 한 번", passed: finalStatus.status === "cancelled" });
      expect(finalStatus.status).toBe("cancelled");

      const afterCancelCount = (await fetchMembershipRemaining(usedMembershipId))!;
      assertions.push({
        name: `수강권 환급이 정확히 1회만 일어남(차감직후=${afterReserveCount} → 취소후=${afterCancelCount}, +1이어야 함. +2면 이중환급 버그)`,
        passed: afterCancelCount === afterReserveCount + 1,
        detail: JSON.stringify({ afterReserveCount, afterCancelCount, usedMembershipId }),
      });
      expect(afterCancelCount).toBe(afterReserveCount + 1);

      const violations = await checkCoreInvariants(cls.id, [membershipA.id, usedMembershipId]);
      assertions.push({ name: "핵심 invariant 위반 없음", passed: violations.length === 0, detail: JSON.stringify(violations) });
      expect(violations).toEqual([]);
    });
  }, 60000);

  it("SCN-P1-07: 대기 1명뿐인 상태에서 확정자 2명이 동시에 취소 → 승격은 정확히 1명만", async () => {
    const cls = await makeClass(2, "promorace");
    const membershipA = await issueMembership(memberAProfileId);
    const membershipB = await issueMembership(memberBProfileId);
    const membershipC = await issueMembership(memberCProfileId);

    await runScenario("SCN-P1-07", ["memberA", "memberB", "memberC(waitlist)"], async (assertions) => {
      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((rA.data as any).status).toBe("confirmed");
      const aReservationId = (rA.data as any).reservation_id as string;

      await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((rB.data as any).status).toBe("confirmed");
      const bReservationId = (rB.data as any).reservation_id as string;

      await loginMemberA();
      const rC = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: memberCProfileId });
      expect((rC.data as any).status).toBe("waitlisted");
      const cReservationId = (rC.data as any).reservation_id as string;

      // ⚠ 하드닝: membershipC.id가 아니라 C의 예약이 "실제로 붙잡아둔" membership을
      // 추적한다(대기 등록 시점에도 membership_id는 이미 pinned됨 — 승격 때만 차감이
      // 일어날 뿐, 어떤 membership을 쓸지는 대기 등록 시점에 이미 결정됨). 승격 전
      // remaining_count를 스냅샷해두고, 승격 후 정확히 -1(1회 차감)만 됐는지 델타로
      // 검증한다.
      const usedMembershipIdForC = (await fetchReservationMembershipId(cReservationId))!;
      const beforePromotionCount = (await fetchMembershipRemaining(usedMembershipIdForC))!;

      // A와 B가 "동시에" 각자의 확정 예약을 취소 — 대기자는 C 1명뿐이므로, 두 취소 중
      // 정확히 하나만 C를 승격시켜야 하고(승격 후보를 for update로 잠그므로 두 번째
      // 취소는 "더 이상 대기자가 없다"를 보게 됨), 두 취소 자체는 각자 독립적으로 둘 다
      // 성공해야 한다(서로 다른 예약을 취소하는 것이므로).
      const [clientA, clientB] = await Promise.all([
        loginConcurrentClient("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD"),
        loginConcurrentClient("TEST_USER_B_EMAIL", "TEST_USER_B_PASSWORD"),
      ]);
      const [cancelA, cancelB] = await Promise.all([
        clientA.rpc("cancel_reservation", { p_reservation_id: aReservationId }),
        clientB.rpc("cancel_reservation", { p_reservation_id: bReservationId }),
      ]);

      assertions.push({
        name: "A/B 취소 둘 다 성공(서로 다른 예약이므로 경쟁 대상 아님)",
        passed: !cancelA.error && !cancelB.error && (cancelA.data as any)?.cancelled && (cancelB.data as any)?.cancelled,
        detail: JSON.stringify({ cancelA: cancelA.data, cancelB: cancelB.data, errA: cancelA.error?.message, errB: cancelB.error?.message }),
      });
      expect(cancelA.error).toBeNull();
      expect(cancelB.error).toBeNull();

      const promotedFlags = [(cancelA.data as any)?.waitlist_promoted, (cancelB.data as any)?.waitlist_promoted];
      const promotedCount = promotedFlags.filter(Boolean).length;
      assertions.push({
        name: "waitlist_promoted=true가 두 응답 중 정확히 1건",
        passed: promotedCount === 1,
        detail: JSON.stringify(promotedFlags),
      });
      expect(promotedCount).toBe(1);

      const cStatus = await fetchReservationStatus(cReservationId);
      assertions.push({ name: "C는 confirmed로 정확히 1번 승격됨", passed: cStatus.status === "confirmed", detail: JSON.stringify(cStatus) });
      expect(cStatus.status).toBe("confirmed");

      const afterPromotionCount = (await fetchMembershipRemaining(usedMembershipIdForC))!;
      assertions.push({
        name: `C의 수강권은 정확히 1회만 차감됨(승격전=${beforePromotionCount} → 승격후=${afterPromotionCount}, -1이어야 함. -2면 중복승격 버그)`,
        passed: afterPromotionCount === beforePromotionCount - 1,
        detail: JSON.stringify({ beforePromotionCount, afterPromotionCount, usedMembershipIdForC }),
      });
      expect(afterPromotionCount).toBe(beforePromotionCount - 1);

      const violations = await checkCoreInvariants(cls.id, [membershipA.id, membershipB.id, membershipC.id, usedMembershipIdForC]);
      assertions.push({ name: "핵심 invariant 위반 없음", passed: violations.length === 0, detail: JSON.stringify(violations) });
      expect(violations).toEqual([]);
    });
  }, 60000);

  it("SCN-P1-11: 응답을 못 받은 클라이언트가 같은 예약 요청을 재시도해도 중복 생성/중복 차감 없음", async () => {
    const cls = await makeClass(8, "retry");
    const membershipA = await issueMembership(memberAProfileId);

    await runScenario("SCN-P1-11", ["memberA"], async (assertions) => {
      await loginMemberA();
      const first = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      assertions.push({ name: "최초 요청 성공", passed: !first.error && (first.data as any)?.status === "confirmed" });
      expect((first.data as any).status).toBe("confirmed");
      const reservationId = (first.data as any).reservation_id as string;

      // 하드닝: membershipA.id가 아니라 실제 사용된 membership을 추적(위 시나리오들과 동일
      // 근거 — leftover 수강권이 선택될 수 있음).
      const usedMembershipId = (await fetchReservationMembershipId(reservationId))!;
      const afterFirstCount = (await fetchMembershipRemaining(usedMembershipId))!;

      // "응답을 못 받아서(네트워크 실패 가정) 클라이언트가 똑같은 요청을 재시도" 시뮬레이션
      // — 실제 네트워크 단절 자체는 이 샌드박스에서 재현 불가(registry.ts SCN-P1-10 BLOCKED
      // 근거 참고)이지만, "재시도해도 안전한가"라는 실질적 질문은 그대로 검증 가능하다.
      const retry = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      assertions.push({
        name: "재시도는 명시적으로 거부됨(이미 예약된 수업)",
        passed: !!retry.error,
        detail: retry.error?.message,
      });
      expect(retry.error).not.toBeNull();

      const admin = getFixtureAdminClient();
      const { data: activeRes } = await admin
        .from("reservations")
        .select("id,status")
        .eq("class_id", cls.id)
        .eq("profile_id", memberAProfileId)
        .in("status", ["confirmed", "waitlisted"]);
      assertions.push({ name: "재시도 후에도 활성 예약은 정확히 1건", passed: (activeRes ?? []).length === 1, detail: JSON.stringify(activeRes) });
      expect((activeRes ?? []).length).toBe(1);

      const afterRetryCount = (await fetchMembershipRemaining(usedMembershipId))!;
      assertions.push({
        name: `수강권은 재시도와 무관하게 정확히 1회만 차감(최초후=${afterFirstCount} → 재시도후=${afterRetryCount}, 값이 같아야 함)`,
        passed: afterRetryCount === afterFirstCount,
        detail: JSON.stringify({ afterFirstCount, afterRetryCount, usedMembershipId }),
      });
      expect(afterRetryCount).toBe(afterFirstCount);

      const violations = await checkCoreInvariants(cls.id, [membershipA.id, usedMembershipId]);
      assertions.push({ name: "핵심 invariant 위반 없음", passed: violations.length === 0, detail: JSON.stringify(violations) });
      expect(violations).toEqual([]);
    });
  }, 60000);
});
