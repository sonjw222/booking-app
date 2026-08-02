/*
  NOTIF-001 (E-4/E-5) 회귀 테스트 — 휴무일 강제취소가 예약/수업을 삭제하지 않고 이력을
  보존하며, 영향받은 회원에게 알림을 생성하는지 검증한다.

  ⚠️ 이 파일은 다음 SQL이 모두 적용되기 전에는 의도적으로 FAIL해야 합니다(순서대로):
    1. fix_reservation_cancel_source_column_draft_proposed.sql
    2. fix_holiday_history_and_notification_draft_proposed.sql
  (전제조건: fix_holiday_membership_restore_draft_proposed.sql, fix_admin_action_logs_class_id_fk_draft_proposed.sql는
  이미 실행됐다고 가정 — PR #32에서 승인·실행 완료됨)
  적용 후 green이 되어야 정상입니다.

  Fixture: TEST_MANAGER_A만 사용, admin_assign_reservation()으로 실제 예약을 만든다(raw insert
  아님 — service_role이 reservations/memberships에 GRANT가 없어 admin client로 직접 만들 수
  없다는 게 이전 배치에서 확인된 사실, docs/TODO.md P2-13).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  createTestMembership,
  fetchMembershipRemaining,
  cleanupTestClass,
  type TestUser,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };

function kstDateOf(isoStart: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(isoStart));
}

let managerA: TestUser;
let centerAId: string;
let holidayDate: string;
let classId: string;
let membershipId: string;
let reservationId: string;
let createdHoliday = false;

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  const cls = await createFutureTestClass(centerAId, { title: "NOTIF-001 휴무일 이력 테스트", hoursFromNow: 500 });
  classId = cls.id;
  holidayDate = kstDateOf(cls.startTime);

  const mem = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
  membershipId = mem.id;

  const { data, error } = await supabase.rpc("admin_assign_reservation", {
    p_class_id: classId, p_profile_id: managerA.profileId,
    p_assignment_type: "ADMIN_ASSIGNMENT", p_membership_id: membershipId,
  });
  if (error) throw new Error("예약 fixture 생성 실패: " + error.message);
  reservationId = (data as any).reservation_id;
}, 30000);

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];
  try { await cleanupTestClass(classId, []); } catch (e: any) { errors.push(e.message); }
  if (createdHoliday) {
    try {
      await supabase.from("center_holidays").delete().eq("center_id", centerAId).eq("holiday_date", holidayDate);
    } catch (e: any) { errors.push(e.message); }
  }
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 30000);

describe("NOTIF-001 E-4/E-5: 휴무일 강제취소는 삭제 대신 이력을 남기고 알림을 보낸다", () => {
  it("force=true로 휴무일 지정 후 예약 행이 삭제되지 않고 cancelled로 남는다", async () => {
    const { data, error } = await supabase.rpc("add_holiday_safe", {
      p_center_id: centerAId, p_date: holidayDate, p_reason: "NOTIF-001 통합테스트 휴무", p_force: true,
    });
    expect(error).toBeNull();
    expect((data as any).needs_confirm).toBe(false);
    createdHoliday = true;

    const { data: res, error: resErr } = await supabase
      .from("reservations")
      .select("status, cancel_reason, cancel_source, cancelled_by, cancelled_at")
      .eq("id", reservationId)
      .single();
    expect(resErr).toBeNull();
    expect((res as any).status).toBe("cancelled"); // 삭제되지 않고 취소 상태로 존재
    expect((res as any).cancel_reason).toBe("NOTIF-001 통합테스트 휴무");
    expect((res as any).cancel_source).toBe("HOLIDAY");
    expect((res as any).cancelled_by).not.toBeNull();
    expect((res as any).cancelled_at).not.toBeNull();
  });

  it("수업 행도 삭제되지 않고 status='cancelled'(폐강)로 남는다", async () => {
    const { data, error } = await supabase.from("classes").select("status").eq("id", classId).single();
    expect(error).toBeNull();
    expect((data as any).status).toBe("cancelled");
  });

  it("수강권 잔여횟수가 정확히 복구된다(3→2 소모→3 복구)", async () => {
    expect(await fetchMembershipRemaining(membershipId)).toBe(3);
  });

  it("내 예약 이력(fetchMyPage 기반 쿼리)에서 이 예약이 여전히 조회되고 취소 출처가 보인다", async () => {
    const { data, error } = await supabase
      .from("reservations")
      .select("id, status, cancel_source, classes(title)")
      .eq("id", reservationId)
      .single();
    expect(error).toBeNull();
    expect((data as any).status).toBe("cancelled");
    expect((data as any).cancel_source).toBe("HOLIDAY");
    expect((data as any).classes?.title).toBe("NOTIF-001 휴무일 이력 테스트");
  });

  it("영향받은 회원에게 휴무일 취소 알림이 생성되고 문구에 수업명·취소사유·복구 안내가 포함된다", async () => {
    const { data, error } = await supabase
      .from("notifications")
      .select("title, body, data")
      .eq("kind", "reservation_canceled")
      .contains("data", { reservation_id: reservationId })
      .order("created_at", { ascending: false })
      .limit(5);
    expect(error).toBeNull();
    const holidayNotis = (data ?? []).filter((n: any) => n.data?.cancel_source === "HOLIDAY");
    expect(holidayNotis.length).toBe(1); // 정확히 1건(중복 알림 없음)
    const n = holidayNotis[0] as any;
    expect(n.title).toContain("휴무일");
    expect(n.body).toContain("NOTIF-001 휴무일 이력 테스트"); // 수업명
    expect(n.body).toContain("NOTIF-001 통합테스트 휴무"); // 취소사유
    expect(n.body).toContain("복구"); // 수강권 복구 안내
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
