/*
  Automated Business Scenario E2E Batch(2026-09-18) — Phase 4: P2 알림(§17).

  ⚠ 실제 코드 기준(git 시간순 최종본 add_admin_assignment.sql의 trg_notify_reservation_
  insert/update 트리거 본문 확인): 예약/취소/대기승격은 DB 트리거가 자동으로
  notifications 테이블에 행을 insert한다(push_notification() 함수, 순수 INSERT 하나뿐
  — 실제 푸시/SMS/알림톡 발송 코드가 전혀 없음, 발송은 별도 백그라운드 job/엣지함수의
  몫으로 추정되며 이 트리거 자체는 "큐잉"만 한다). 그래서 이 시나리오는 요청 원칙("실제
  외부 SMS/알림톡 발송 금지, queue/event 생성만 확인")에 정확히 부합한다 — 알림 큐
  행이 올바른 kind로 생성되는지만 검증하고, 실제 발송 여부는 검증 대상이 아니다(발송은
  이 함수 밖의 일이라 이 트리거만으로는 확인할 수 없음).

  확인하는 kind: reservation_confirmed(확정), reservation_waitlisted(대기 등록),
  waitlist_promoted(대기→확정 승격), reservation_canceled(취소).
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../../lib/supabaseClient";
import { getOrCreateOwnedTestCenter, cleanupTestClassAdmin, getFixtureAdminClient, createTestMembership } from "../setup";
import { managerA as loginManagerA, memberA as loginMemberA, memberB as loginMemberB, memberCSubProfile } from "./actors";
import { runScenario } from "./reporter";

function newRunId(): string {
  return `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe("SCN-P2-50: 예약 관련 알림 큐 생성(발송 아님)", () => {
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

  async function findNotification(accountId: string, kind: string, reservationId: string) {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin
      .from("notifications")
      .select("id, kind, title, body, data")
      .eq("recipient_account_id", accountId)
      .eq("kind", kind)
      .contains("data", { reservation_id: reservationId })
      .limit(1);
    if (error) throw new Error(`알림 조회 실패: ${error.message}`);
    return (data ?? [])[0] ?? null;
  }

  it("예약 확정/대기/취소/승격마다 올바른 kind의 notifications 행이 생성된다(실제 발송 없이 큐잉만)", async () => {
    const runId = newRunId();
    await loginManagerA();
    const { data: cls, error: clsErr } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId,
        title: `QA-알림-${runId}`,
        start_time: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        end_time: new Date(Date.now() + 49 * 3600 * 1000).toISOString(),
        capacity: 1,
        class_format: "group",
      })
      .select("id")
      .single();
    if (clsErr || !cls) throw new Error(`수업 생성 실패: ${clsErr?.message}`);
    const classId = (cls as any).id;
    pendingClassIds.push(classId);

    await issueMembership(memberAProfileId);
    await issueMembership(memberBProfileId);

    await runScenario("SCN-P2-50", ["memberA", "memberB(waitlist)"], async (assertions) => {
      await loginMemberA();
      const rA = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: null });
      expect((rA.data as any).status).toBe("confirmed");
      const aReservationId = (rA.data as any).reservation_id as string;

      const confirmedNotif = await findNotification(memberAAccountId, "reservation_confirmed", aReservationId);
      assertions.push({ name: "A 예약 확정 시 reservation_confirmed 알림 큐 생성됨", passed: !!confirmedNotif, detail: JSON.stringify(confirmedNotif) });
      expect(confirmedNotif).toBeTruthy();

      // memberB(capacity=1이라 대기)
      const memberB = await loginMemberB();
      const rB = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: null });
      expect((rB.data as any).status).toBe("waitlisted");
      const bReservationId = (rB.data as any).reservation_id as string;

      const waitlistedNotif = await findNotification(memberB.accountId, "reservation_waitlisted", bReservationId);
      assertions.push({ name: "B 대기 등록 시 reservation_waitlisted 알림 큐 생성됨", passed: !!waitlistedNotif, detail: JSON.stringify(waitlistedNotif) });
      expect(waitlistedNotif).toBeTruthy();

      // A 취소 → B 승격
      await loginMemberA();
      const cancelRes = await supabase.rpc("cancel_reservation", { p_reservation_id: aReservationId });
      expect((cancelRes.data as any).waitlist_promoted).toBe(true);

      const canceledNotif = await findNotification(memberAAccountId, "reservation_canceled", aReservationId);
      assertions.push({ name: "A 취소 시 reservation_canceled 알림 큐 생성됨", passed: !!canceledNotif, detail: JSON.stringify(canceledNotif) });
      expect(canceledNotif).toBeTruthy();

      const promotedNotif = await findNotification(memberB.accountId, "waitlist_promoted", bReservationId);
      assertions.push({ name: "B 승격 시 waitlist_promoted 알림 큐 생성됨", passed: !!promotedNotif, detail: JSON.stringify(promotedNotif) });
      expect(promotedNotif).toBeTruthy();

      // 실제 발송 여부는 이 트리거 밖의 일이라 검증 대상이 아님을 명시 — notifications
      // 행 존재 자체가 "큐잉됨"의 증거이고, 그 이상(실제 push/SMS 발송)은 이 배치의
      // 안전 원칙(요청 29번: "실제 고객 알림톡/SMS 발송 금지")상 건드리지 않는다.
    });
  }, 60000);
});
