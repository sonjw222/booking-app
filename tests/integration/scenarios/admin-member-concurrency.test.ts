/*
  Automated Business Scenario E2E Batch(2026-09-18) — Phase 3: 관리자↔회원 동시 상태.
  SCN-P1-31(관리자 정원 축소 후 기존 확정자/신규 예약자 상태), SCN-P1-32(관리자 정원 확대
  시 대기 자동 승격 정책 — 실제로는 승격 로직이 없음을 실측 확인).

  ⚠ 실제 코드 기준(추측 아님): 관리자의 수업 수정은 update_class_safe RPC를 거친다
  (fix_class_cancel_deadline_override.sql 실제 본문 확인) — 이 함수는 권한 체크 후
  classes 테이블을 그대로 UPDATE할 뿐, capacity 변경 시 confirmed_count와 비교하거나
  대기자를 승격시키는 로직이 전혀 없다. 즉:
  - 정원을 기존 확정 인원보다 작게 줄여도 기존 확정자는 자동으로 정리(취소)되지 않는다 —
    "확정 인원 > 새 정원"인 상태가 그대로 유지될 수 있다.
  - 정원을 늘려도 기존 대기자가 자동으로 승격되지 않는다 — 승격은 오직
    cancel_reservation()이 호출될 때만 일어난다(reservation_functions.sql류 본문 확인).
  이 두 가지는 "예상과 다를 수 있는 실제 동작"이라 임의로 추측하지 않고 실제 RPC로
  재현·고정한다. 버그인지 의도된 동작인지는 이 QA 배치의 판단 범위 밖이라 BUG FOUND로
  보고만 하고 product code는 고치지 않는다(최종 보고서 참고).
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../../lib/supabaseClient";
import { getOrCreateOwnedTestCenter, cleanupTestClassAdmin, getFixtureAdminClient, createTestMembership } from "../setup";
import { managerA as loginManagerA, memberA as loginMemberA, memberB as loginMemberB, memberCSubProfile } from "./actors";
import { checkCapacityInvariant, checkCoreInvariants } from "./invariants";
import { runScenario } from "./reporter";

function newRunId(): string {
  return `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe("SCN-P1-31/32: 관리자 정원 변경 ↔ 회원 예약 상태", () => {
  let centerAId: string;
  let memberAAccountId: string;
  let memberAProfileId: string;
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
    await admin.from("center_settings").update({ waitlist_weekly_limit: 10 }).eq("center_id", centerAId);

    const memberA = await loginMemberA();
    memberAAccountId = memberA.accountId;
    memberAProfileId = memberA.profileId;
    const memberC = await memberCSubProfile(memberAAccountId);
    memberCProfileId = memberC.profileId;

    const memberB = await loginMemberB();
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

  async function issueMembership(profileId: string, remainingCount = 5) {
    await loginManagerA();
    const mem = await createTestMembership(centerAId, profileId, { remainingCount });
    pendingMembershipIds.push(mem.id);
    return mem;
  }

  it("SCN-P1-31: [BUG FOUND 재현] 관리자가 정원을 확정 인원보다 작게 줄여도 기존 확정자는 자동 정리되지 않는다", async () => {
    const runId = newRunId();
    await loginManagerA();
    const { data: cls, error: clsErr } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId,
        title: `QA-정원축소-${runId}`,
        start_time: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        end_time: new Date(Date.now() + 49 * 3600 * 1000).toISOString(),
        capacity: 2,
        class_format: "group",
      })
      .select("id, title, description, start_time, end_time, capacity, allow_goods, room_id, cancel_deadline_min, booking_deadline_min, class_format, pass_selection_mode")
      .single();
    if (clsErr || !cls) throw new Error(`수업 생성 실패: ${clsErr?.message}`);
    pendingClassIds.push((cls as any).id);
    await issueMembership(memberAProfileId);
    await issueMembership(memberBProfileId);
    await issueMembership(memberCProfileId);

    await runScenario("SCN-P1-31-BUGFOUND", ["managerA", "memberA", "memberB", "memberC"], async (assertions) => {
      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: (cls as any).id, p_profile_id: null });
      expect((rA.data as any).status).toBe("confirmed");

      await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: (cls as any).id, p_profile_id: null });
      expect((rB.data as any).status).toBe("confirmed");

      // 정원 2/2 확정된 상태에서, 관리자가 정원을 1로 축소 — 실제 프로덕션 코드가 쓰는
      // update_class_safe RPC를 그대로 호출한다(lib/classes.ts updateClass와 동일 경로).
      await loginManagerA();
      const c = cls as any;
      const updateRes = await supabase.rpc("update_class_safe", {
        p_class_id: c.id,
        p_title: c.title,
        p_description: c.description,
        p_start_time: c.start_time,
        p_end_time: c.end_time,
        p_capacity: 1,
        p_allow_goods: c.allow_goods,
        p_room_id: c.room_id,
        p_cancel_deadline_min: c.cancel_deadline_min,
        p_booking_deadline_min: c.booking_deadline_min,
        p_class_format: c.class_format,
        p_pass_selection_mode: c.pass_selection_mode,
      });
      assertions.push({ name: "정원 축소 RPC 자체는 성공(권한 체크만 하고 인원수 검증 없음)", passed: !updateRes.error, detail: updateRes.error?.message });
      expect(updateRes.error).toBeNull();

      const { data: clsAfter } = await supabase.from("classes").select("capacity").eq("id", c.id).single();
      assertions.push({ name: "capacity가 실제로 1로 바뀜", passed: (clsAfter as any).capacity === 1 });
      expect((clsAfter as any).capacity).toBe(1);

      const admin = getFixtureAdminClient();
      const { data: stillConfirmed } = await admin.from("reservations").select("id,status,profile_id").eq("class_id", c.id).eq("status", "confirmed");
      assertions.push({
        name: "BUG FOUND 재현: 기존 확정자 2명이 새 정원(1)을 초과한 채로 자동 정리 없이 그대로 confirmed 유지됨",
        passed: (stillConfirmed ?? []).length === 2,
        detail: JSON.stringify(stillConfirmed),
      });
      expect((stillConfirmed ?? []).length).toBe(2);

      // 이 상태에서 checkCapacityInvariant를 돌리면 "위반"으로 잡힌다 — 이게 바로 이
      // invariant 헬퍼가 존재하는 이유(정상 플로우에서는 절대 안 생겨야 하는데, 관리자의
      // 정원 축소라는 실제 존재하는 경로로 실제로 생길 수 있음을 이 테스트가 증명한다).
      const capacityViolation = await checkCapacityInvariant(c.id);
      assertions.push({
        name: "checkCapacityInvariant가 이 상태를 정확히 위반으로 탐지함(invariant 헬퍼 자체의 신뢰성 확인)",
        passed: capacityViolation !== null,
        detail: JSON.stringify(capacityViolation),
      });
      expect(capacityViolation).not.toBeNull();

      // 신규 회원(C)이 이 수업에 예약을 시도하면 어떻게 되는지도 함께 확인 — confirmed_count
      // (2) >= capacity(1)이므로 "정원 초과"로 분류돼 대기 등록으로 흡수된다(waitlist_weekly_
      // limit을 beforeAll에서 이미 켜둠). C는 memberA 계정의 서브프로필이므로 반드시
      // memberA 세션으로 되돌아온 뒤 호출해야 한다(직전에 managerA로 전환돼 있었음 — 안
      // 그러면 reserve_class의 "내 계정 소유 프로필인지" 체크에서 거부된다).
      await loginMemberA();
      const rC = await supabase.rpc("reserve_class", { p_class_id: c.id, p_profile_id: memberCProfileId });
      assertions.push({
        name: "신규 예약자(C)는 이미 초과된 정원 때문에 대기로 흡수됨(거부 아님)",
        passed: !rC.error && (rC.data as any)?.status === "waitlisted",
        detail: JSON.stringify({ data: rC.data, error: rC.error?.message }),
      });
      expect((rC.data as any).status).toBe("waitlisted");
    });
  }, 60000);

  it("SCN-P1-32: [BUG FOUND 재현] 관리자가 정원을 확대해도 기존 대기자는 자동 승격되지 않는다(cancel_reservation 호출 시에만 승격)", async () => {
    const runId = newRunId();
    await loginManagerA();
    const { data: cls, error: clsErr } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId,
        title: `QA-정원확대-${runId}`,
        start_time: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        end_time: new Date(Date.now() + 49 * 3600 * 1000).toISOString(),
        capacity: 1,
        class_format: "group",
      })
      .select("id, title, description, start_time, end_time, capacity, allow_goods, room_id, cancel_deadline_min, booking_deadline_min, class_format, pass_selection_mode")
      .single();
    if (clsErr || !cls) throw new Error(`수업 생성 실패: ${clsErr?.message}`);
    pendingClassIds.push((cls as any).id);
    await issueMembership(memberAProfileId);
    await issueMembership(memberBProfileId);

    await runScenario("SCN-P1-32-BUGFOUND", ["managerA", "memberA", "memberB(waitlist)"], async (assertions) => {
      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: (cls as any).id, p_profile_id: null });
      expect((rA.data as any).status).toBe("confirmed");

      await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: (cls as any).id, p_profile_id: null });
      assertions.push({ name: "B는 정원(1) 초과로 대기 등록", passed: !rB.error && (rB.data as any)?.status === "waitlisted" });
      expect((rB.data as any).status).toBe("waitlisted");
      const bReservationId = (rB.data as any).reservation_id as string;

      // 관리자가 정원을 1 → 3으로 확대 — 이제 자리가 2개 남는 셈인데, 대기 중인 B가
      // 자동으로 승격되는지 확인한다.
      await loginManagerA();
      const c = cls as any;
      const updateRes = await supabase.rpc("update_class_safe", {
        p_class_id: c.id,
        p_title: c.title,
        p_description: c.description,
        p_start_time: c.start_time,
        p_end_time: c.end_time,
        p_capacity: 3,
        p_allow_goods: c.allow_goods,
        p_room_id: c.room_id,
        p_cancel_deadline_min: c.cancel_deadline_min,
        p_booking_deadline_min: c.booking_deadline_min,
        p_class_format: c.class_format,
        p_pass_selection_mode: c.pass_selection_mode,
      });
      expect(updateRes.error).toBeNull();

      const admin = getFixtureAdminClient();
      const { data: bAfter } = await admin.from("reservations").select("status,waitlist_order").eq("id", bReservationId).single();
      assertions.push({
        name: "BUG FOUND 재현: 정원 확대만으로는 B가 자동 승격되지 않고 여전히 waitlisted(자리는 남는데 아무도 안 채워짐)",
        passed: (bAfter as any).status === "waitlisted",
        detail: JSON.stringify(bAfter),
      });
      expect((bAfter as any).status).toBe("waitlisted");

      // 확정자(A)가 취소하면 그제서야 cancel_reservation()의 승격 루프가 실행돼 B가
      // 승격된다 — "정원 변경"이 아니라 "취소 이벤트"가 유일한 승격 트리거임을 대조 확인.
      const aReservationId = (rA.data as any).reservation_id as string;
      await loginMemberA();
      const cancelRes = await supabase.rpc("cancel_reservation", { p_reservation_id: aReservationId });
      expect(cancelRes.error).toBeNull();
      expect((cancelRes.data as any).waitlist_promoted).toBe(true);

      const { data: bFinal } = await admin.from("reservations").select("status").eq("id", bReservationId).single();
      assertions.push({
        name: "대조 확인: cancel_reservation() 호출(취소 이벤트) 시에는 B가 정상적으로 승격됨",
        passed: (bFinal as any).status === "confirmed",
        detail: JSON.stringify(bFinal),
      });
      expect((bFinal as any).status).toBe("confirmed");

      const violations = await checkCoreInvariants(c.id, []);
      assertions.push({ name: "최종 상태 핵심 invariant 위반 없음", passed: violations.length === 0, detail: JSON.stringify(violations) });
      expect(violations).toEqual([]);
    });
  }, 60000);
});
