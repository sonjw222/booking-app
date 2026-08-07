/*
  P2(social-auth-notifications 배치): 매니저 알림의 센터 간 격리(cross-center isolation) 검증.

  기존 구조 감사 결과: add_notification_triggers.sql의 트리거들은 항상 "그 예약이 속한 센터의
  활성 매니저"만 대상으로 push_notification()을 호출하고(manager_centers where center_id=...
  and status='active'), notifications 테이블 RLS는 select를 recipient_account_id=my_account_id()
  로만 제한한다 — 설계상 다른 센터로 알림이 샐 경로가 없음을 코드로 확인했다. 이 테스트는 그
  설계가 실제로 지켜지는지 실제 DB로 한 번 더 못박는 회귀 가드다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  signOutTestSession,
  type TestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  createTestMembership,
  cleanupTestClass,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };

let managerA: TestUser;
let managerB: TestUser;
let centerAId: string;
const createdClassIds: string[] = [];

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  await getOrCreateOwnedTestCenter(managerB); // centerB 존재 및 managerB의 활성 오너 상태 보장
}, 30000);

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  for (const classId of createdClassIds) {
    try { await cleanupTestClass(classId, []); } catch { /* 무시 */ }
  }
  await signOutTestSession();
}, 30000);

describe("매니저 알림 센터 간 격리", () => {
  it("centerA에서 발생한 new_reservation 알림을 centerB의 매니저는 볼 수 없다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const cls = await createFutureTestClass(centerAId, { title: "P2 알림격리-신규예약", hoursFromNow: 240 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("reserve_class", {
      p_class_id: cls.id, p_profile_id: managerA.profileId,
    });
    expect(error).toBeNull();
    const reservationId = (data as any).reservation_id as string;

    // centerA의 매니저(managerA 본인)에게는 정상적으로 알림이 생겼는지 대조군으로 확인.
    const { data: ownNotis } = await supabase
      .from("notifications")
      .select("id, kind, center_id, data")
      .eq("kind", "new_reservation")
      .order("created_at", { ascending: false })
      .limit(20);
    const ownMatch = (ownNotis ?? []).find((n: any) => n.data?.reservation_id === reservationId);
    expect(ownMatch).toBeTruthy();
    expect((ownMatch as any).center_id).toBe(centerAId);

    // centerB의 매니저는 이 알림을 절대 볼 수 없어야 한다(RLS: recipient_account_id로만 필터).
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data: otherNotis } = await supabase
      .from("notifications")
      .select("id, kind, center_id, data")
      .eq("kind", "new_reservation")
      .order("created_at", { ascending: false })
      .limit(50);
    const leaked = (otherNotis ?? []).find((n: any) => n.data?.reservation_id === reservationId);
    expect(leaked).toBeUndefined();
  });
});
