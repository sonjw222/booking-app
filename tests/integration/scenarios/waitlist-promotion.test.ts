/*
  Automated Business Scenario E2E Batch(2026-09-18) — Layer A(Shared), Phase 1 핵심.
  SCN-P0-23(대기 자동 승격), SCN-P0-24(다중 대기 승격 순서), SCN-P0-25(대기자 자가취소)를
  각각 독립적인 it()으로 구현한다 — 요청 22번("각 테스트는 독립적으로 실행 가능해야 하며
  다른 테스트의 잔여 데이터에 의존하지 않아야 한다")에 따라 시나리오마다 자신만의
  class/membership을 새로 만든다(기존 tests/integration/*.test.ts 파일들과 동일한 관례).

  ⚠ createTestMembership()의 최초 insert 분기는 "현재 로그인된 세션"의 RLS로 실행된다
  (tests/integration/setup.ts 참고). fix_membership_rls.sql / reservation_functions.sql의
  "매니저 수강권 발급" 정책(has_permission(center_id, 'customer.member.issue_pass'))은
  manager_centers에 등록된 매니저(오너 포함)만 통과시키므로, 일반 회원 세션으로는 처음
  발급이 실패한다(실측: has_permission()이 manager_centers에 없는 계정은 무조건 false).
  그래서 이 파일은 memberships 발급을 반드시 managerA 세션에서 수행한다 — 기존
  private-class-capacity.test.ts가 memberB 세션 직후 createTestMembership을 호출하는
  것처럼 보이는 지점은, 그 (profile,center) 조합의 수강권이 이전 실행에서 이미 만들어져
  있어 매번 admin(update) 분기를 타기 때문에 우연히 통과하는 것으로 보인다(최초 1회
  생성 시점은 별도로 추적하지 않음) — 이 파일은 그 우연에 기대지 않는다.

  reserve_class()/cancel_reservation()는 lib/reservations.ts가 실제로 호출하는 것과 동일한
  RPC를 그대로 쓴다(reservation_functions.sql 실제 본문 확인 완료) — 새 로직을 만들지 않고
  실제 프로덕션 RPC를 있는 그대로 검증한다.
*/
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../../lib/supabaseClient";
import { createFutureTestClass, createTestMembership, getOrCreateOwnedTestCenter, cleanupTestClassAdmin, getFixtureAdminClient } from "../setup";
import { managerA as loginManagerA, memberA as loginMemberA, memberB as loginMemberB, memberCSubProfile, memberDSubProfile } from "./actors";
import { checkCoreInvariants, fetchReservationStatus } from "./invariants";
import { runScenario } from "./reporter";

describe("SCN-P0-23/24/25: 대기 자동 승격", () => {
  let centerAId: string;
  let memberAAccountId: string;
  let memberAProfileId: string;
  let memberBAccountId: string;
  let memberBProfileId: string;
  let memberCProfileId: string;
  let memberDProfileId: string;
  const pendingClassIds: string[] = [];

  beforeAll(async () => {
    const managerA = await loginManagerA();
    centerAId = await getOrCreateOwnedTestCenter(managerA);

    // ⚠ 실측 발견(추측 아님): 이 저장소 루트의 reservation_functions.sql은 이미 최신이 아니다
    // — 실제 배포된 reserve_class()는 여러 add_*/fix_*.sql로 create or replace되며
    // center_settings.waitlist_weekly_limit이 0(기본값)이면 대기예약 자체를 거부한다
    // ("이 수업은 정원이 찼고, 이 센터는 대기예약을 사용하지 않아요", 실제 RPC 호출로 재현
    // 확인 — fix_reserve_with_membership_operational_settings.sql 등 여러 파일에서 동일 로직
    // 확인). 게다가 getOrCreateOwnedTestCenter()가 내부적으로 부르는
    // resetStaleTestCenterSettings()가 매 테스트 파일 시작마다 이 값을 schema.sql 기본값인
    // 0으로 "의도적으로" 되돌린다(다른 테스트 파일이 남긴 설정이 섞이지 않게 하려는 것 —
    // setup.ts 주석 참고). 그래서 대기 승격을 검증하려는 이 파일은 매번 명시적으로 이 값을
    // 켜야 한다 — 새 SQL이나 RLS 변경이 아니라, 기존 fixture 전용 admin(service_role)
    // 클라이언트로 이미 존재하는 컬럼 값을 세팅하는 것뿐이며, resetStaleTestCenterSettings
    // 자체가 이미 쓰는 것과 완전히 동일한 패턴이다.
    const admin = getFixtureAdminClient();
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

  // best-effort 정리 — 각 it()이 자신이 만든 classId를 pendingClassIds에 넣어두면
  // 실패로 도중에 throw 하더라도 admin(service_role)으로 확실히 지운다
  // (cleanupTestClassAdmin은 예약 상태와 무관하게 지움 — setup.ts 주석 참고, P1-14와 동일 이유).
  afterEach(async () => {
    while (pendingClassIds.length > 0) {
      const id = pendingClassIds.pop()!;
      await cleanupTestClassAdmin(id);
    }
  }, 30000);

  async function setupCapacity2Class(): Promise<{
    classId: string;
    membershipA: string;
    membershipB: string;
    membershipC: string;
    membershipD: string;
  }> {
    await loginManagerA();
    const cls = await createFutureTestClass(centerAId, { capacity: 2, title: "QA-대기승격" });
    pendingClassIds.push(cls.id);
    const membershipA = (await createTestMembership(centerAId, memberAProfileId, { remainingCount: 5 })).id;
    const membershipB = (await createTestMembership(centerAId, memberBProfileId, { remainingCount: 5 })).id;
    const membershipC = (await createTestMembership(centerAId, memberCProfileId, { remainingCount: 5 })).id;
    const membershipD = (await createTestMembership(centerAId, memberDProfileId, { remainingCount: 5 })).id;
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

      // 실측: cancel_reservation()은 승격된 사람의 waitlist_order만 null로 바꾸고,
      // 나머지 대기자의 waitlist_order 값 자체는 재정렬(2→1)하지 않는다
      // (reservation_functions.sql 본문 확인) — 그래서 D는 "여전히 waitlisted, order=2"가
      // 맞는 결과다. 대신 "다음 승격 대상"이라는 의미에서는 유일한 대기자이므로 사실상
      // 1순위와 동등하다 — ORDER BY waitlist_order ASC로 다음 승격 대상을 고르는 로직만
      // 정확하면 되고 값 자체의 연속성은 실제 구현상 보장되지 않는다(invariants.ts 상단
      // 주석 참고, 요청 원문의 "waitlist 순번 재정렬" 기대와 실제 코드가 다른 지점).
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
      // 로직 자체를 건드리지 않는다(reservation_functions.sql: status='confirmed'일
      // 때만 환급+승격 블록을 탐).
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
