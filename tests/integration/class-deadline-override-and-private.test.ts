/*
  CLASS-001 회귀 테스트 — 개별 수업 예약마감 우선순위(D-1) + 프라이빗 수업 정원 강제(D-2).

  ⚠️ 이 파일은 다음 SQL 적용 전에는 의도적으로 FAIL해야 합니다:
    - D-1 테스트: fix_class_booking_deadline_override_draft_proposed.sql
    - D-2 테스트: fix_private_class_capacity_constraint_draft_proposed.sql
  적용 후 green이 되어야 정상입니다.
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  createTestMembership,
  cleanupTestClass,
  type TestUser,
} from "./setup";
import { fetchSettings, saveSettings, type CenterSettings } from "../../lib/settings";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };

let managerA: TestUser;
let centerAId: string;
let defaultSettings: CenterSettings;
const createdClassIds: string[] = [];

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  defaultSettings = await fetchSettings(centerAId);
}, 30000);

afterEach(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  await saveSettings(centerAId, defaultSettings);
});

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];
  for (const classId of createdClassIds) {
    try { await cleanupTestClass(classId, []); } catch (e: any) { errors.push(e.message); }
  }
  try { await saveSettings(centerAId, defaultSettings); } catch (e: any) { errors.push(e.message); }
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 30000);

describe("CLASS-001 D-1: 개별 수업 예약마감이 운영설정보다 우선한다", () => {
  it("운영설정상 마감이 지나지 않은 수업도, 개별 수업 마감을 0분(즉시)으로 지정하면 예약이 막힌다", async () => {
    // 운영설정 기본값(1일 전 22:00)으로는 며칠 뒤 수업 예약이 아직 열려 있지만, 이 수업 하나만
    // booking_deadline_min=0(수업 시작 직전까지)이 아니라 아주 큰 값(예: 100일)으로 지정해
    // "이미 마감"을 재현한다 — 0분은 오히려 "더 늦게까지 허용"이라 헷갈리므로 큰 값을 쓴다.
    const { data: cls, error: clsErr } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId, title: "CLASS-001 개별마감 테스트",
        start_time: new Date(Date.now() + 240 * 3600 * 1000).toISOString(),
        end_time: new Date(Date.now() + 241 * 3600 * 1000).toISOString(),
        capacity: 8,
        booking_deadline_min: 100 * 24 * 60, // 100일 전까지만 — 지금은 이미 지남
      })
      .select("id").single();
    if (clsErr || !cls) throw new Error("수업 생성 실패: " + clsErr?.message);
    createdClassIds.push((cls as any).id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { error } = await supabase.rpc("reserve_class", { p_class_id: (cls as any).id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("예약 마감시간이 지났어요");
  });

  it("개별 수업 마감을 지정하지 않으면(null) 운영설정 기본값을 그대로 쓴다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "CLASS-001 기본값사용", hoursFromNow: 240 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).toBeNull();
    expect((data as any).status).toBe("confirmed");
  });
});

describe("CLASS-001 D-2: 프라이빗 수업 정원=1 서버 강제", () => {
  it("class_format='private'인데 capacity가 1이 아니면 DB CHECK 제약으로 생성이 거부된다", async () => {
    const { error } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId, title: "CLASS-001 프라이빗 정원위반",
        start_time: new Date(Date.now() + 240 * 3600 * 1000).toISOString(),
        end_time: new Date(Date.now() + 241 * 3600 * 1000).toISOString(),
        capacity: 5, class_format: "private",
      });
    expect(error).not.toBeNull();
  });

  it("class_format='private' + capacity=1은 정상 생성된다", async () => {
    const { data, error } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId, title: "CLASS-001 프라이빗 정상",
        start_time: new Date(Date.now() + 240 * 3600 * 1000).toISOString(),
        end_time: new Date(Date.now() + 241 * 3600 * 1000).toISOString(),
        capacity: 1, class_format: "private",
      })
      .select("id").single();
    expect(error).toBeNull();
    if (data) createdClassIds.push((data as any).id);
  });
});
