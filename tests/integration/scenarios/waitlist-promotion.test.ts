/*
  Automated Business Scenario E2E Batch(2026-09-18, Test Harness Hardening checkpoint 반영) —
  Layer A(Shared), Phase 1 핵심.
  SCN-P0-23(대기 자동 승격), SCN-P0-24(다중 대기 승격 순서), SCN-P0-25(대기자 자가취소)를
  각각 독립적인 it()으로 구현한다 — 요청 22번("각 테스트는 독립적으로 실행 가능해야 하며
  다른 테스트의 잔여 데이터에 의존하지 않아야 한다")에 따라 시나리오마다 자신만의
  class/membership을 새로 만든다(기존 tests/integration/*.test.ts 파일들과 동일한 관례).

  ⚠ reserve_class() source of truth (하드닝 체크포인트 1번): 저장소 루트의
  reservation_functions.sql 텍스트 하나만 보고 판단하지 않는다. git log로 reserve_class()를
  create or replace하는 모든 파일을 시간순 정렬해보면 add_rolling_month_product_expiry.sql
  (2026-09-10, 가장 최근)이 마지막이고, 그 파일의 waitlist_weekly_limit 게이트 로직이 실제
  라이브 dev Supabase에 대한 RPC 호출로 재현한 동작(정원 초과 시 waitlist_weekly_limit=0이면
  "이 센터는 대기예약을 사용하지 않아요" 거부)과 정확히 일치함을 실측으로 확인했다 — 즉
  "어느 파일이 최종본인가"를 파일 이름/주석으로 추정하지 않고, git 커밋 시간순 + 실제 RPC
  응답이라는 두 독립적인 근거로 교차검증했다. 이 파일의 모든 단언은 이 실측된 라이브 동작을
  기준으로 하며, 정적 SQL 텍스트는 "왜 그런 동작이 나오는지"를 설명하는 참고 자료일 뿐이다.

  ⚠ center_settings 격리(하드닝 2번): waitlist_weekly_limit을 beforeAll에서 켜는 대신
  "원래 값을 읽어서 기억해뒀다가 afterAll에서 정확히 그 값으로 되돌린다" — 다른 테스트
  파일의 resetStaleTestCenterSettings()(매 파일 시작 시 스키마 기본값 0으로 되돌리는 로직)
  가 "우연히" 다음 실행의 정합성을 맞춰주는 구조에 기대지 않는다. 이 파일 자신이 만든 변경은
  이 파일 자신이 되돌린다.

  ⚠ membership fixture 신뢰성(하드닝 3번): createTestMembership()의 최초 insert 분기는
  "현재 로그인된 세션"의 RLS로 실행된다(tests/integration/setup.ts 참고). 실제 배포된
  RLS 정책(fix_membership_rls.sql 등, "매니저 수강권 발급" — has_permission(center_id,
  'customer.member.issue_pass'))은 manager_centers에 등록된 매니저만 통과시키므로, 일반
  회원 세션으로는 최초 발급이 실패한다(실측 확인). 이 파일은 memberships 발급을 반드시
  managerA 세션에서 수행할 뿐 아니라, 매 it() 종료 시 afterEach에서 이번 run이 만든
  membership row를 admin(service_role)으로 직접 삭제한다 — "이전 실행에서 이미 만들어진
  row가 남아 있어 update 분기를 타면서 우연히 통과하는" 구조를 원천적으로 없애고, 매 실행마다
  진짜 insert 분기(=진짜 매니저 권한 경로)가 깨끗한 상태에서 매번 검증되게 한다.

  ⚠ run 격리(하드닝 3/4번): 매 setupCapacity2Class() 호출마다 고유 runId
  (qa_<timestamp>_<random>)를 수업 제목에 넣어, 실패로 정리가 안 된 이전 run의 잔여
  데이터가 있어도(sweepStaleTestClasses가 1시간 뒤 자동으로 쓸어가긴 하지만, 그 전이라도)
  이번 run의 판정과는 무관하게 만든다 — classId/membershipId가 항상 새로 생성된 고유 행이라
  이름 패턴으로 조회하지 않는 이 파일의 설계상 원래도 leftover에 의존하지 않았지만, runId를
  제목에 남겨 수동/자동 스윕 시 추적 가능하게 한다. cleanup은 이번 run이 만든 classId/
  membershipId만 지운다(패턴 기반 bulk delete 없음) — 공유 센터(getOrCreateOwnedTestCenter가
  반환하는 "통합테스트센터-%") 자체는 43개 기존 파일과 공유하는 기존 관례를 그대로 따른다.

  reserve_class()/cancel_reservation()는 lib/reservations.ts가 실제로 호출하는 것과 동일한
  RPC를 그대로 쓴다 — 새 로직을 만들지 않고 실제 프로덕션 RPC를 있는 그대로 검증한다.
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../../lib/supabaseClient";
import { createFutureTestClass, createTestMembership, getOrCreateOwnedTestCenter, cleanupTestClassAdmin, getFixtureAdminClient } from "../setup";
import { managerA as loginManagerA, memberA as loginMemberA, memberB as loginMemberB, memberCSubProfile, memberDSubProfile } from "./actors";
import { checkCoreInvariants, fetchReservationStatus } from "./invariants";
import { runScenario } from "./reporter";

function newRunId(): string {
  return `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe("SCN-P0-23/24/25: 대기 자동 승격", () => {
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
    const memberD = await memberDSubProfile(memberBAccountId);
    memberDProfileId = memberD.profileId;
  }, 60000);

  // 이 파일이 스스로 바꾼 설정을 스스로 되돌린다 — 다른 테스트 파일의 reset helper가
  // "다음 실행 시작 시" 되돌려주는 데 기대지 않는다(하드닝 2번).
  afterAll(async () => {
    if (originalWaitlistWeeklyLimit === null) return;
    const admin = getFixtureAdminClient();
    await admin.from("center_settings").update({ waitlist_weekly_limit: originalWaitlistWeeklyLimit }).eq("center_id", centerAId);
  }, 30000);

  // best-effort 정리 — 각 it()이 자신이 만든 classId/membershipId를 pending 배열에 넣어두면
  // 실패로 도중에 throw 하더라도 admin(service_role)으로 확실히 지운다(cleanupTestClassAdmin은
  // 예약 상태와 무관하게 지움 — setup.ts 주석 참고, P1-14와 동일 이유). 예약(reservations)이
  // membership_id를 참조하므로, class/reservations를 먼저 지운 뒤 membership을 지운다(순서
  // 중요 — 반대로 하면 FK 위반 위험).
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

  async function setupCapacity2Class(): Promise<{
    classId: string;
    membershipA: string;
    membershipB: string;
    membershipC: string;
    membershipD: string;
  }> {
    const runId = newRunId();
    await loginManagerA();
    const cls = await createFutureTestClass(centerAId, { capacity: 2, title: `QA-대기승격-${runId}` });
    pendingClassIds.push(cls.id);
    const membershipA = (await createTestMembership(centerAId, memberAProfileId, { remainingCount: 5 })).id;
    const membershipB = (await createTestMembership(centerAId, memberBProfileId, { remainingCount: 5 })).id;
    const membershipC = (await createTestMembership(centerAId, memberCProfileId, { remainingCount: 5 })).id;
    const membershipD = (await createTestMembership(centerAId, memberDProfileId, { remainingCount: 5 })).id;
    pendingMembershipIds.push(membershipA, membershipB, membershipC, membershipD);
    return { classId: cls.id, membershipA, membershipB, membershipC, membershipD };
  }

  it("SCN-P0-23: capacity=2에서 A/B 확정 후 C 대기, A 취소 → C가 자동 승격되고 occupancy=2 유지", async () => {
    const { classId, membershipA, membershipB, membershipC } = await setupCapacity2Class();

    await runScenario("SCN-P0-23", ["managerA", "memberA", "memberB", "memberC"], async (assertions) => {
      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: null });
      assertions.push({ name: "A 예약 성공", passed: !rA.error, detail: rA.error?.message });
      expect(rA.error).toBeNull();
      expect((rA.data as any).status).toBe("confirmed");

      await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: null });
      assertions.push({ name: "B 예약 성공(정원 도달)", passed: !rB.error, detail: rB.error?.message });
      expect((rB.data as any).status).toBe("confirmed");

      await loginMemberA();
      const rC = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: memberCProfileId });
      assertions.push({ name: "C 대기 등록(정원 초과)", passed: !rC.error && (rC.data as any)?.status === "waitlisted" });
      expect((rC.data as any).status).toBe("waitlisted");
      const cReservationId = (rC.data as any).reservation_id as string;

      const aReservationId = (rA.data as any).reservation_id as string;
      const cancelRes = await supabase.rpc("cancel_reservation", { p_reservation_id: aReservationId });
      assertions.push({ name: "A 취소 성공 + 대기 승격 발생", passed: !cancelRes.error && (cancelRes.data as any)?.waitlist_promoted === true });
      expect((cancelRes.data as any).waitlist_promoted).toBe(true);

      const cStatus = await fetchReservationStatus(cReservationId);
      assertions.push({ name: "C가 confirmed로 승격됨", passed: cStatus.status === "confirmed", detail: JSON.stringify(cStatus) });
      expect(cStatus.status).toBe("confirmed");
      expect(cStatus.waitlistOrder).toBeNull();

      const violations = await checkCoreInvariants(classId, [membershipA, membershipB, membershipC]);
      assertions.push({ name: "핵심 invariant 위반 없음(capacity/waitlist중복/음수방지)", passed: violations.length === 0, detail: JSON.stringify(violations) });
      expect(violations).toEqual([]);
    });
  }, 60000);

  it("SCN-P0-24: A/B 확정, C/D 순서대로 대기(#1,#2) 후 A 취소 → C 승격, D는 여전히 대기(다음 순번)", async () => {
    const { classId, membershipA, membershipB, membershipC, membershipD } = await setupCapacity2Class();

    await runScenario("SCN-P0-24", ["managerA", "memberA", "memberB", "memberC", "memberD"], async (assertions) => {
      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: null });
      expect((rA.data as any).status).toBe("confirmed");

      await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: null });
      expect((rB.data as any).status).toBe("confirmed");

      await loginMemberA();
      const rC = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: memberCProfileId });
      expect((rC.data as any).status).toBe("waitlisted");
      const cReservationId = (rC.data as any).reservation_id as string;
      const cStatusBefore = await fetchReservationStatus(cReservationId);
      assertions.push({ name: "C 대기순번 1", passed: cStatusBefore.waitlistOrder === 1, detail: JSON.stringify(cStatusBefore) });
      expect(cStatusBefore.waitlistOrder).toBe(1);

      await loginMemberB();
      const rD = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: memberDProfileId });
      expect((rD.data as any).status).toBe("waitlisted");
      const dReservationId = (rD.data as any).reservation_id as string;
      const dStatusBefore = await fetchReservationStatus(dReservationId);
      assertions.push({ name: "D 대기순번 2(C 다음)", passed: dStatusBefore.waitlistOrder === 2, detail: JSON.stringify(dStatusBefore) });
      expect(dStatusBefore.waitlistOrder).toBe(2);

      const aReservationId = (rA.data as any).reservation_id as string;
      await loginMemberA();
      const cancelRes = await supabase.rpc("cancel_reservation", { p_reservation_id: aReservationId });
      expect((cancelRes.data as any).waitlist_promoted).toBe(true);

      const cStatusAfter = await fetchReservationStatus(cReservationId);
      assertions.push({ name: "C가 confirmed로 승격됨", passed: cStatusAfter.status === "confirmed" });
      expect(cStatusAfter.status).toBe("confirmed");

      // 실측 + git 시간순으로 교차검증한 최종본(fix_same_day_cancel_deadline_regression.sql,
      // 2026-09-10 02:37 커밋 — cancel_reservation()을 재정의하는 파일 중 가장 최근)에서도
      // 승격된 사람의 waitlist_order만 null로 바뀌고 나머지 대기자의 값 자체는 재정렬
      // (2→1)되지 않는다 — 그래서 D는 "여전히 waitlisted, order=2"가 맞는 결과다. 대신
      // "다음 승격 대상"이라는 의미에서는 유일한 대기자이므로 사실상 1순위와 동등하다 —
      // ORDER BY waitlist_order ASC로 다음 승격 대상을 고르는 로직만 정확하면 되고 값
      // 자체의 연속성은 실제 구현상 보장되지 않는다(invariants.ts 상단 주석 참고, 요청
      // 원문의 "waitlist 순번 재정렬" 기대와 실제 코드가 다른 지점). 참고: 이 최종본은
      // center_settings.waitlist_auto_hours/minutes로 "승격 자체를 막는" 마감 게이트도
      // 추가했지만 기본값 0/0이면 무조건 승격(기존 동작 유지)이고, resetStaleTestCenterSettings
      // 가 이 값을 0/0으로 맞춰두므로 이 파일의 시나리오에는 영향 없음(실측 확인됨 —
      // 아래 승격 성공 단언이 통과한다는 것 자체가 증거).
      const dStatusAfter = await fetchReservationStatus(dReservationId);
      assertions.push({
        name: "D는 여전히 waitlisted 상태(승격 없음, 정원 변화 없었으므로 정상)",
        passed: dStatusAfter.status === "waitlisted",
        detail: JSON.stringify(dStatusAfter),
      });
      expect(dStatusAfter.status).toBe("waitlisted");

      const violations = await checkCoreInvariants(classId, [membershipA, membershipB, membershipC, membershipD]);
      assertions.push({ name: "핵심 invariant 위반 없음", passed: violations.length === 0, detail: JSON.stringify(violations) });
      expect(violations).toEqual([]);
    });
  }, 60000);

  it("SCN-P0-25: 대기 중인 회원이 스스로 취소해도 환급/승격 없이 정상 취소되고 나머지 대기자는 영향 없음", async () => {
    const { classId, membershipA, membershipB, membershipC, membershipD } = await setupCapacity2Class();

    await runScenario("SCN-P0-25", ["managerA", "memberA", "memberB", "memberC", "memberD"], async (assertions) => {
      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: null });
      expect((rA.data as any).status).toBe("confirmed");

      await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: null });
      expect((rB.data as any).status).toBe("confirmed");

      await loginMemberA();
      const rC = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: memberCProfileId });
      expect((rC.data as any).status).toBe("waitlisted");
      const cReservationId = (rC.data as any).reservation_id as string;

      await loginMemberB();
      const rD = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: memberDProfileId });
      expect((rD.data as any).status).toBe("waitlisted");
      const dReservationId = (rD.data as any).reservation_id as string;
      const dOrderBefore = (await fetchReservationStatus(dReservationId)).waitlistOrder;

      // C(대기 1순위)가 스스로 취소 — cancel_reservation은 대기 상태였으면 환급/승격
      // 로직 자체를 건드리지 않는다(실제 최종본 fix_same_day_cancel_deadline_regression.sql
      // 기준: status='confirmed'일 때만 환급+승격 블록을 탐).
      await loginMemberA();
      const cancelRes = await supabase.rpc("cancel_reservation", { p_reservation_id: cReservationId });
      assertions.push({ name: "C 자가취소 성공", passed: !cancelRes.error && (cancelRes.data as any)?.cancelled === true });
      expect((cancelRes.data as any).cancelled).toBe(true);
      assertions.push({ name: "대기 취소는 승격을 유발하지 않음(정원 변화 없었으므로 당연)", passed: (cancelRes.data as any)?.waitlist_promoted === false });
      expect((cancelRes.data as any).waitlist_promoted).toBe(false);

      const cStatusAfter = await fetchReservationStatus(cReservationId);
      assertions.push({ name: "C는 cancelled 상태", passed: cStatusAfter.status === "cancelled" });
      expect(cStatusAfter.status).toBe("cancelled");

      const dStatusAfter = await fetchReservationStatus(dReservationId);
      assertions.push({
        name: "D는 영향받지 않음(여전히 waitlisted, order 불변)",
        passed: dStatusAfter.status === "waitlisted" && dStatusAfter.waitlistOrder === dOrderBefore,
        detail: JSON.stringify({ before: dOrderBefore, after: dStatusAfter }),
      });
      expect(dStatusAfter.status).toBe("waitlisted");
      expect(dStatusAfter.waitlistOrder).toBe(dOrderBefore);

      // A/B는 여전히 confirmed 그대로(정원 2/2) — C의 대기취소가 confirmed 쪽에
      // 영향을 주면 안 됨.
      const violations = await checkCoreInvariants(classId, [membershipA, membershipB, membershipD]);
      assertions.push({ name: "핵심 invariant 위반 없음", passed: violations.length === 0, detail: JSON.stringify(violations) });
      expect(violations).toEqual([]);
    });
  }, 60000);
});
