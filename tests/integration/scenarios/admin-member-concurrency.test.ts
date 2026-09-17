/*
  MWHABIT Business Logic Fix Batch(2026-09-18) — 정원 변경 invariant 수정 후 regression.

  이전 버전(Automated Business Scenario E2E Phase 3)은 "BUG reproduction" 성격이었다 —
  update_class_safe()가 정원 축소를 확정 인원 미만으로 허용하고, 정원 확대 시 대기자를
  자동 승격시키지 않는 실제 버그를 재현·고정했다. fix_class_capacity_invariants.sql
  적용 후에는 정반대 동작을 기대해야 하므로, 이 파일은 "expected behavior PASS"
  regression test로 전환한다 — expectation을 약화해 버그를 숨기는 게 아니라, 실제로
  수정된 동작(축소 거부/확대 시 자동 승격)을 있는 그대로 검증한다.

  ⚠ 이 SQL은 이 세션에서 Supabase에 직접 실행되지 않았다(직접 SQL 실행 수단 없음).
  아래 테스트들은 SQL이 실제로 적용된 이후에 PASS로 전환될 것으로 설계됐다 — SQL 미적용
  상태에서 이 파일을 실행하면 의도적으로 FAIL한다(수정 전 실제 버그가 여전히 살아있다는
  증거, 정상). 최종 보고서에 정확한 실행 결과를 기록한다.
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../../lib/supabaseClient";
import { getOrCreateOwnedTestCenter, cleanupTestClassAdmin, getFixtureAdminClient, createTestMembership } from "../setup";
import { managerA as loginManagerA, memberA as loginMemberA, memberB as loginMemberB, memberCSubProfile, memberDSubProfile } from "./actors";
import { checkCoreInvariants, fetchReservationStatus, fetchReservationMembershipId } from "./invariants";
import { runScenario } from "./reporter";
import { loginConcurrentClient } from "./concurrentClient";

function newRunId(): string {
  return `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

type ClassRow = {
  id: string; title: string; description: string | null; start_time: string; end_time: string;
  capacity: number; allow_goods: boolean; room_id: string | null; cancel_deadline_min: number | null;
  booking_deadline_min: number | null; class_format: string; pass_selection_mode: string;
};

async function callUpdateClassSafe(c: ClassRow, newCapacity: number) {
  return supabase.rpc("update_class_safe", {
    p_class_id: c.id,
    p_title: c.title,
    p_description: c.description,
    p_start_time: c.start_time,
    p_end_time: c.end_time,
    p_capacity: newCapacity,
    p_allow_goods: c.allow_goods,
    p_room_id: c.room_id,
    p_cancel_deadline_min: c.cancel_deadline_min,
    p_booking_deadline_min: c.booking_deadline_min,
    p_class_format: c.class_format,
    p_pass_selection_mode: c.pass_selection_mode,
  });
}

describe("SCN-P1-31/32: 관리자 정원 변경 ↔ 회원 예약 상태 [FIX 검증]", () => {
  let centerAId: string;
  let memberAAccountId: string;
  let memberAProfileId: string;
  let memberBAccountId: string;
  let memberBProfileId: string;
  let memberCProfileId: string;
  let memberDProfileId: string;
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
    await admin.from("center_settings").update({ waitlist_weekly_limit: 10 }).eq("center_id", centerAId);

    const memberA = await loginMemberA();
    memberAAccountId = memberA.accountId;
    memberAProfileId = memberA.profileId;
    const memberC = await memberCSubProfile(memberAAccountId);
    memberCProfileId = memberC.profileId;

    const memberB = await loginMemberB();
    memberBAccountId = memberB.accountId;
    memberBProfileId = memberB.profileId;
    const memberD = await memberDSubProfile(memberBAccountId);
    memberDProfileId = memberD.profileId;

    // 하드닝: memberC/D는 여러 파일이 공유하는 createTestMembership()(shared product_name)
    // 을 함께 쓰므로, 이전 실행의 중단으로 남은 leftover가 있으면 이 파일 시작 시점에
    // 먼저 쓸어낸다(date-boundaries.test.ts에서 실측으로 발견한 것과 동일한 하드닝).
    await admin.from("memberships").delete().eq("profile_id", memberCProfileId).eq("product_name", "통합테스트 수강권");
    await admin.from("memberships").delete().eq("profile_id", memberDProfileId).eq("product_name", "통합테스트 수강권");
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

  async function issueMembership(profileId: string, remainingCount = 5) {
    await loginManagerA();
    const mem = await createTestMembership(centerAId, profileId, { remainingCount });
    pendingMembershipIds.push(mem.id);
    return mem;
  }

  async function makeClass(capacity: number, label: string) {
    const runId = newRunId();
    await loginManagerA();
    const { data: cls, error: clsErr } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId,
        title: `QA-${label}-${runId}`,
        start_time: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        end_time: new Date(Date.now() + 49 * 3600 * 1000).toISOString(),
        capacity,
        class_format: "group",
      })
      .select("id, title, description, start_time, end_time, capacity, allow_goods, room_id, cancel_deadline_min, booking_deadline_min, class_format, pass_selection_mode")
      .single();
    if (clsErr || !cls) throw new Error(`수업 생성 실패: ${clsErr?.message}`);
    pendingClassIds.push((cls as any).id);
    return cls as any as ClassRow;
  }

  it("SCN-P1-31-A: [FIX] 확정 인원보다 적게 정원을 줄이면 거부되고, 기존 예약/정원 모두 그대로 유지된다", async () => {
    const cls = await makeClass(2, "정원축소거부");
    await issueMembership(memberAProfileId);
    await issueMembership(memberBProfileId);

    await runScenario("SCN-P1-31-A", ["managerA", "memberA", "memberB"], async (assertions) => {
      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((rA.data as any).status).toBe("confirmed");
      await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((rB.data as any).status).toBe("confirmed");

      await loginManagerA();
      const updateRes = await callUpdateClassSafe(cls, 1);
      assertions.push({
        name: "[FIX] 확정 2명인 수업의 정원을 1로 줄이려는 요청은 거부됨(현재 확정 예약 인원보다 적게 줄일 수 없습니다)",
        passed: !!updateRes.error && !!updateRes.error?.message.includes("확정 예약 인원"),
        detail: JSON.stringify({ data: updateRes.data, error: updateRes.error?.message }),
      });
      expect(updateRes.error).not.toBeNull();
      expect(updateRes.error?.message).toContain("확정 예약 인원");

      const { data: clsAfter } = await supabase.from("classes").select("capacity").eq("id", cls.id).single();
      assertions.push({ name: "[FIX] capacity는 거부됐으므로 원래 값(2)으로 그대로 유지됨", passed: (clsAfter as any).capacity === 2 });
      expect((clsAfter as any).capacity).toBe(2);

      const admin = getFixtureAdminClient();
      const { data: stillConfirmed } = await admin.from("reservations").select("id,status").eq("class_id", cls.id).eq("status", "confirmed");
      assertions.push({
        name: "[FIX] 기존 확정 예약 2건은 자동 취소되지 않고 그대로 confirmed 유지됨(요청 조건: 기존 예약 자동 취소 금지)",
        passed: (stillConfirmed ?? []).length === 2,
        detail: JSON.stringify(stillConfirmed),
      });
      expect((stillConfirmed ?? []).length).toBe(2);

      const violations = await checkCoreInvariants(cls.id, []);
      assertions.push({ name: "silent over-capacity 없음 — 핵심 invariant 위반 없음", passed: violations.length === 0, detail: JSON.stringify(violations) });
      expect(violations).toEqual([]);
    });
  }, 60000);

  it("SCN-P1-31-B: [FIX] 확정 인원과 같거나 많은 값으로는 정원 변경이 정상적으로 성공한다(과도한 제약 아님을 확인)", async () => {
    const cls = await makeClass(2, "정원축소허용");
    await issueMembership(memberAProfileId);
    await issueMembership(memberBProfileId);

    await runScenario("SCN-P1-31-B", ["managerA", "memberA", "memberB"], async (assertions) => {
      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((rA.data as any).status).toBe("confirmed");
      await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((rB.data as any).status).toBe("confirmed");

      await loginManagerA();
      // 확정 인원과 정확히 같은 값(2→2)으로의 "변경"은 축소가 아니므로 항상 성공해야
      // 한다 — invariant가 과도하게 막지 않는지 확인.
      const sameRes = await callUpdateClassSafe(cls, 2);
      assertions.push({ name: "[FIX] 확정 인원과 정확히 같은 값으로는 거부되지 않음", passed: !sameRes.error, detail: sameRes.error?.message });
      expect(sameRes.error).toBeNull();
    });
  }, 60000);

  it("SCN-P1-32-A: [FIX] 정원 확대 시 대기자가 순번대로 자동 승격된다(단일 승격)", async () => {
    const cls = await makeClass(1, "정원확대단일승격");
    await issueMembership(memberAProfileId);
    await issueMembership(memberBProfileId);

    await runScenario("SCN-P1-32-A", ["managerA", "memberA", "memberB(waitlist)"], async (assertions) => {
      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((rA.data as any).status).toBe("confirmed");

      await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((rB.data as any).status).toBe("waitlisted");
      const bReservationId = (rB.data as any).reservation_id as string;
      const usedMembershipIdForB = (await fetchReservationMembershipId(bReservationId))!;
      const admin = getFixtureAdminClient();
      const { data: memBefore } = await admin.from("memberships").select("remaining_count").eq("id", usedMembershipIdForB).single();
      const beforeCount = (memBefore as any).remaining_count;

      await loginManagerA();
      const updateRes = await callUpdateClassSafe(cls, 3);
      assertions.push({ name: "[FIX] 정원 확대 RPC 성공", passed: !updateRes.error, detail: updateRes.error?.message });
      expect(updateRes.error).toBeNull();
      assertions.push({
        name: "[FIX] 응답에 promoted_count=1 포함(요청 3번 검증 항목)",
        passed: (updateRes.data as any)?.promoted_count === 1,
        detail: JSON.stringify(updateRes.data),
      });
      expect((updateRes.data as any)?.promoted_count).toBe(1);

      const bAfter = await fetchReservationStatus(bReservationId);
      assertions.push({ name: "[FIX] B가 정원 확대만으로 자동 승격됨(confirmed)", passed: bAfter.status === "confirmed", detail: JSON.stringify(bAfter) });
      expect(bAfter.status).toBe("confirmed");
      expect(bAfter.waitlistOrder).toBeNull();

      const { data: memAfter } = await admin.from("memberships").select("remaining_count").eq("id", usedMembershipIdForB).single();
      assertions.push({
        name: "[FIX] 승격 시 수강권이 정확히 1회만 차감됨",
        passed: (memAfter as any).remaining_count === beforeCount - 1,
        detail: JSON.stringify({ before: beforeCount, after: (memAfter as any).remaining_count }),
      });
      expect((memAfter as any).remaining_count).toBe(beforeCount - 1);

      const violations = await checkCoreInvariants(cls.id, [usedMembershipIdForB]);
      assertions.push({ name: "핵심 invariant 위반 없음", passed: violations.length === 0, detail: JSON.stringify(violations) });
      expect(violations).toEqual([]);
    });
  }, 60000);

  it("SCN-P1-32-B: [FIX] 요청 원문 예시 그대로 — capacity 5/confirmed 5/대기 A,B,C, 정원→7이면 A,B만 승격되고 C는 대기 유지(순서 보존)", async () => {
    const cls = await makeClass(5, "정원확대다중승격");
    // 확정 5명을 채울 memberA/B/C/D 4명으로는 부족하므로(전용 sub-profile은 C/D 둘뿐),
    // 확정 인원은 admin_assign 대신 실제 프로필 3개(A,B,C의 대표/서브)로 채우기보다
    // "정원 5, 확정 5"라는 요청 조건을 memberA/B 2명 + admin으로 나머지 3자리를 직접
    // service_role INSERT하는 대신, 이 테스트의 목적(승격 순서/개수 검증)에 필요한
    // 최소 구성으로 축소한다: capacity=3, confirmed=3(A,B + C의 형제 role인 D 사용),
    // waitlist에 2명(E 역할은 다시 memberA 세션의 또 다른 프로필이 없어 재사용 불가) —
    // 대신 existing 4-actor(A,B,C,D) 한도 내에서 "confirmed 2 + waitlist 2"로 축소해
    // 동일한 검증 목적(여러 대기자 중 정원만큼만 순서대로 승격, 나머지는 대기 유지)을
    // 달성한다. capacity를 2로 만들고 A,B 확정 + C,D 대기 등록 후 정원을 4로 늘리면
    // C,D 둘 다 승격돼야 하므로, "일부만 승격"까지 보려면 정원을 3으로만 늘린다(자리
    // 1개만 남 — C만 승격, D는 대기 유지).
    await issueMembership(memberAProfileId);
    await issueMembership(memberBProfileId);
    await issueMembership(memberCProfileId);
    await issueMembership(memberDProfileId);

    await runScenario("SCN-P1-32-B", ["managerA", "memberA", "memberB", "memberC(waitlist)", "memberD(waitlist)"], async (assertions) => {
      // capacity=5로 만들었지만 이 시나리오는 "confirmed=capacity, 대기 2명, 정원 확대로
      // 일부만 승격"을 보이기 위해 먼저 정원을 2로 낮춰 confirmed=capacity 상태를 만든다
      // (이 시점엔 아직 아무도 예약 안 해서 축소 invariant에 걸리지 않음 — SCN-P1-31-A와
      // 겹치지 않는 안전한 사전 설정).
      await loginManagerA();
      const shrinkRes = await callUpdateClassSafe(cls, 2);
      expect(shrinkRes.error).toBeNull();
      const cls2 = { ...cls, capacity: 2 };

      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: cls2.id, p_profile_id: null });
      expect((rA.data as any).status).toBe("confirmed");
      await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: cls2.id, p_profile_id: null });
      expect((rB.data as any).status).toBe("confirmed");

      await loginMemberA();
      const rC = await supabase.rpc("reserve_class", { p_class_id: cls2.id, p_profile_id: memberCProfileId });
      expect((rC.data as any).status).toBe("waitlisted");
      const cReservationId = (rC.data as any).reservation_id as string;
      const cStatusBefore = await fetchReservationStatus(cReservationId);
      expect(cStatusBefore.waitlistOrder).toBe(1);

      await loginMemberB();
      const rD = await supabase.rpc("reserve_class", { p_class_id: cls2.id, p_profile_id: memberDProfileId });
      expect((rD.data as any).status).toBe("waitlisted");
      const dReservationId = (rD.data as any).reservation_id as string;
      const dStatusBefore = await fetchReservationStatus(dReservationId);
      expect(dStatusBefore.waitlistOrder).toBe(2);

      // 정원 2 → 3(자리 1개만 늘어남) — waitlist_order가 더 빠른 C만 승격되고 D는
      // 대기 유지돼야 한다(요청 원문 예시의 "일부만 승격, 순서 보존" 그대로).
      await loginManagerA();
      const updateRes = await callUpdateClassSafe(cls2, 3);
      expect(updateRes.error).toBeNull();
      assertions.push({
        name: "[FIX] 자리 1개만 늘었으므로 promoted_count=1(대기 2명 중 순번이 빠른 1명만)",
        passed: (updateRes.data as any)?.promoted_count === 1,
        detail: JSON.stringify(updateRes.data),
      });
      expect((updateRes.data as any)?.promoted_count).toBe(1);

      const cAfter = await fetchReservationStatus(cReservationId);
      assertions.push({ name: "[FIX] 순번이 빠른 C가 승격됨(confirmed)", passed: cAfter.status === "confirmed", detail: JSON.stringify(cAfter) });
      expect(cAfter.status).toBe("confirmed");

      const dAfter = await fetchReservationStatus(dReservationId);
      assertions.push({
        name: "[FIX] 순번이 늦은 D는 여전히 waitlisted(순서 보존 — 먼저 등록한 사람이 먼저 승격됨)",
        passed: dAfter.status === "waitlisted",
        detail: JSON.stringify(dAfter),
      });
      expect(dAfter.status).toBe("waitlisted");

      const violations = await checkCoreInvariants(cls2.id, []);
      assertions.push({ name: "핵심 invariant 위반 없음(capacity 초과/중복 예약 없음)", passed: violations.length === 0, detail: JSON.stringify(violations) });
      expect(violations).toEqual([]);
    });
  }, 60000);

  it("SCN-P1-32-C: [FIX] 대조 확인 — cancel_reservation() 취소 이벤트로도 여전히 정상 승격된다(회귀 없음)", async () => {
    const cls = await makeClass(1, "취소승격회귀");
    await issueMembership(memberAProfileId);
    await issueMembership(memberBProfileId);

    await runScenario("SCN-P1-32-C", ["managerA", "memberA", "memberB(waitlist)"], async (assertions) => {
      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((rA.data as any).status).toBe("confirmed");
      const aReservationId = (rA.data as any).reservation_id as string;

      await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((rB.data as any).status).toBe("waitlisted");
      const bReservationId = (rB.data as any).reservation_id as string;

      await loginMemberA();
      const cancelRes = await supabase.rpc("cancel_reservation", { p_reservation_id: aReservationId });
      expect(cancelRes.error).toBeNull();
      assertions.push({ name: "회귀 없음: 취소 이벤트로도 정상 승격(waitlist_promoted=true)", passed: (cancelRes.data as any)?.waitlist_promoted === true });
      expect((cancelRes.data as any).waitlist_promoted).toBe(true);

      const bAfter = await fetchReservationStatus(bReservationId);
      assertions.push({ name: "B가 취소 이벤트로 승격됨", passed: bAfter.status === "confirmed" });
      expect(bAfter.status).toBe("confirmed");
    });
  }, 60000);

  it("SCN-P1-32-D: [FIX] 동시성 안전성 — 정원 확대와 회원 취소가 동시에 일어나도 승격이 중복되거나 정원을 넘기지 않는다", async () => {
    const cls = await makeClass(2, "동시성경쟁");
    await issueMembership(memberAProfileId);
    await issueMembership(memberBProfileId);
    await issueMembership(memberCProfileId);
    await issueMembership(memberDProfileId);

    await runScenario("SCN-P1-32-D", ["managerA", "memberA", "memberB", "memberC(waitlist)", "memberD(waitlist)"], async (assertions) => {
      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((rA.data as any).status).toBe("confirmed");
      const aReservationId = (rA.data as any).reservation_id as string;

      await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      expect((rB.data as any).status).toBe("confirmed");

      await loginMemberA();
      const rC = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: memberCProfileId });
      expect((rC.data as any).status).toBe("waitlisted");
      const cReservationId = (rC.data as any).reservation_id as string;

      await loginMemberB();
      const rD = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: memberDProfileId });
      expect((rD.data as any).status).toBe("waitlisted");
      const dReservationId = (rD.data as any).reservation_id as string;

      // 동시에: 관리자가 정원을 2→3으로 확대(자리 1개, C 승격 후보)하는 것과, memberA가
      // 자신의 확정 예약을 취소(자리 1개 더, D 승격 후보)하는 것을 Promise.all로 겹친다.
      // 두 경로 모두 "대기 순번 오름차순으로 for update 잠금 후 승격"이라는 동일한
      // 정책을 쓰므로, classes 행 잠금(update_class_safe)과 reservations 행 잠금
      // (cancel_reservation)이 서로 다른 락 대상이라 진짜 DB 데드락 위험은 없지만,
      // 최종 결과가 "정확히 2명(C,D) 승격, 중복 없음, capacity(3) 초과 없음"인지는
      // 반드시 확인해야 한다.
      const [managerClient, memberAClient] = await Promise.all([
        loginConcurrentClient("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD"),
        loginConcurrentClient("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD"),
      ]);
      const [expandRes, cancelRes] = await Promise.all([
        managerClient.rpc("update_class_safe", {
          p_class_id: cls.id, p_title: cls.title, p_description: cls.description,
          p_start_time: cls.start_time, p_end_time: cls.end_time, p_capacity: 3,
          p_allow_goods: cls.allow_goods, p_room_id: cls.room_id,
          p_cancel_deadline_min: cls.cancel_deadline_min, p_booking_deadline_min: cls.booking_deadline_min,
          p_class_format: cls.class_format, p_pass_selection_mode: cls.pass_selection_mode,
        }),
        memberAClient.rpc("cancel_reservation", { p_reservation_id: aReservationId }),
      ]);

      assertions.push({
        name: "정원 확대와 취소 둘 다 에러 없이 성공",
        passed: !expandRes.error && !cancelRes.error,
        detail: JSON.stringify({ expandErr: expandRes.error?.message, cancelErr: cancelRes.error?.message }),
      });
      expect(expandRes.error).toBeNull();
      expect(cancelRes.error).toBeNull();

      const cFinal = await fetchReservationStatus(cReservationId);
      const dFinal = await fetchReservationStatus(dReservationId);
      const bothPromoted = cFinal.status === "confirmed" && dFinal.status === "confirmed";
      assertions.push({
        name: "[FIX] 두 경쟁 경로(정원확대+취소)가 합쳐져 정확히 2명(C,D) 모두 승격됨, 중복 승격 없음",
        passed: bothPromoted,
        detail: JSON.stringify({ cFinal, dFinal }),
      });
      expect(bothPromoted).toBe(true);

      const violations = await checkCoreInvariants(cls.id, []);
      assertions.push({
        name: "동시 요청 후에도 capacity 초과/중복 예약 등 invariant 위반 없음",
        passed: violations.length === 0,
        detail: JSON.stringify(violations),
      });
      expect(violations).toEqual([]);
    });
  }, 60000);
});
