/*
  P1-12 회귀 테스트 — center_settings의 일부 필드(당일예약 허용/일일예약 한도/주간
  대기예약 한도/예약 오픈 시각)가 reserve_class()에서 실제로 반영되는지 검증한다.

  ⚠️ 이 파일은 fix_settings_wire_reservation_logic_draft_proposed.sql이 실제로
  Supabase에 적용되기 전에는 의도적으로 FAIL해야 합니다(현재 reserve_class()는 이
  설정들을 전혀 읽지 않음). 승인 후 실행하면 이 파일이 green이 되어야 정상입니다.

  이 SQL은 P0-6(fix_holiday_membership_restore_draft_proposed.sql)보다 위험도가 높은
  변경(앱에서 가장 많이 호출되는 reserve_class() 자체를 확장)이라 별도로 더 신중하게
  검토된 뒤 승인·실행되는 것을 권장합니다 — docs/24_P1_12_Settings_Audit.md 참고.

  범위: 26개 설정 전부가 아니라, 이번에 실제로 배선한 4개(예약 오픈 시각/당일예약 허용/
  일일예약 한도/주간 대기예약 한도)만 다룬다. 나머지는 스케줄러가 필요하거나 대응 UI가
  아예 없어 이번 배치에서 손대지 않았다(감사 문서에 사유 기록).

  Fixture: TEST_MANAGER_A만 사용(자기 센터 소유 + 자기 프로필로 직접 예약, 새 계정 불필요).
  이 파일이 만든 모든 행은 afterAll에서 성공·실패와 무관하게 정리하고, 설정은 원래
  기본값으로 되돌린다.
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
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
const createdMembershipIds: string[] = [];

async function resetSettings() {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  await saveSettings(centerAId, defaultSettings);
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  defaultSettings = await fetchSettings(centerAId);

  // reserve_class()는 centers.status='approved'를 요구한다. getOrCreateOwnedTestCenter가 새로
  // 만드는 테스트 센터는 기본 'pending'인데, trg_guard_center_status가 is_platform_admin()이
  // 아니면 service_role(admin client)의 UPDATE도 막는다 — 이 저장소의 통합 테스트 계정
  // (TEST_USER_A/B, TEST_MANAGER_A/B) 중 플랫폼 운영자 자격을 가진 계정이 없어 이 파일이
  // 자체적으로 센터를 승인 처리할 방법이 없다. 이 배치 전에는 어떤 통합 테스트도 회원
  // 셀프예약 RPC(reserve_class)를 직접 호출하지 않아 드러나지 않았던 테스트 인프라 gap이다
  // (docs/TODO.md 참고). 아래 UPDATE는 의도적으로 시도하고 실패 시 원인을 명확히 남긴다 —
  // Supabase에서 TEST_MANAGER_A의 테스트 센터를 수동으로 status='approved'로 바꾸거나, 플랫폼
  // 운영자 테스트 계정을 추가하기 전까지 이 파일은 계속 이 지점에서 막힌다(회귀가 아님).
  const admin = getFixtureAdminClient();
  const { error: approveErr } = await admin.from("centers").update({ status: "approved" }).eq("id", centerAId);
  if (approveErr) {
    throw new Error(
      "[테스트 인프라 gap, docs/TODO.md 참고] 테스트 센터를 승인 상태로 바꿀 수 없어요: " +
        approveErr.message +
        " — TEST_MANAGER_A의 테스트 센터를 Supabase에서 수동으로 status='approved'로 변경하거나" +
        " 플랫폼 운영자 테스트 계정을 준비해주세요."
    );
  }
}, 30000);

afterEach(async () => {
  await resetSettings();
});

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];

  // reservations/classes는 service_role GRANT가 없어(P2-13) admin client 대신 managerA 세션
  // RLS로 정리하는 cleanupTestClass()를 재사용한다(admin-assignment-security.test.ts와 동일 관례).
  for (const classId of createdClassIds) {
    try {
      await cleanupTestClass(classId, []);
    } catch (e: any) {
      errors.push(`class 정리 실패(id=${classId}): ${e.message}`);
    }
  }
  // memberships는 매니저가 delete할 수 있는 RLS 정책이 없고 service_role GRANT도 없어(P2-13과
  // 같은 패턴) 삭제하지 않는다 — payments/orders와 동일하게 테스트 수강권 fixture는 공유 개발
  // DB에 잔존한다(의도된 기존 관례, holiday-membership-restore.test.ts와 동일).
  try {
    await resetSettings();
  } catch (e: any) {
    errors.push(`설정 원복 실패: ${e.message}`);
  }

  if (errors.length > 0) {
    throw new Error(`P1-12 fixture cleanup 실패 — 공유 개발 DB에 잔여 데이터가 남았을 수 있습니다:\n${errors.join("\n")}`);
  }
}, 30000);

describe("P1-12: 당일 예약 허용 여부(allow_same_day_booking)", () => {
  it("꺼져 있으면 오늘(KST) 수업 예약이 차단된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1-12 당일예약 테스트", hoursFromNow: 2 });
    createdClassIds.push(cls.id);
    const membership = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    createdMembershipIds.push(membership.id);

    await saveSettings(centerAId, { ...defaultSettings, allowSameDayBooking: false });

    const { error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("당일 예약은 허용되지 않아요");
  });

  it("켜져 있으면(기본값) 오늘(KST) 수업도 정상 예약된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1-12 당일예약 허용 테스트", hoursFromNow: 2 });
    createdClassIds.push(cls.id);
    const membership = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    createdMembershipIds.push(membership.id);

    const { data, error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).toBeNull();
    expect((data as any).status).toBe("confirmed");
  });
});

describe("P1-12: 일일 예약 가능 횟수(daily_book_limit)", () => {
  it("한도를 켜고 1로 설정하면 같은 날 두 번째 예약은 차단된다", async () => {
    const classA = await createFutureTestClass(centerAId, { title: "P1-12 일일한도 A", hoursFromNow: 50 });
    const classB = await createFutureTestClass(centerAId, { title: "P1-12 일일한도 B", hoursFromNow: 52 });
    createdClassIds.push(classA.id, classB.id);
    const kstDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(iso));
    if (kstDate(classA.startTime) !== kstDate(classB.startTime)) {
      throw new Error("테스트 전제 실패: classA/classB가 같은 KST 날짜여야 합니다");
    }
    const memA = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    const memB = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    createdMembershipIds.push(memA.id, memB.id);

    await saveSettings(centerAId, { ...defaultSettings, dailyBookLimitEnabled: true, dailyBookLimit: 1 });

    const first = await supabase.rpc("reserve_class", { p_class_id: classA.id, p_profile_id: managerA.profileId });
    expect(first.error).toBeNull();

    const second = await supabase.rpc("reserve_class", { p_class_id: classB.id, p_profile_id: managerA.profileId });
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toContain("하루 예약 가능 횟수");
  });
});

describe("P1-12: 주간 대기예약 가능 횟수(waitlist_weekly_limit)", () => {
  it("0(기본값)이면 정원이 찬 수업은 대기 없이 즉시 거부된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1-12 대기0 테스트", hoursFromNow: 50, capacity: 0 });
    createdClassIds.push(cls.id);
    const membership = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    createdMembershipIds.push(membership.id);

    const { error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("대기예약을 사용하지 않아요");
  });

  it("1로 설정하면 정원 찬 수업에 대기예약이 성공한다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1-12 대기1 테스트", hoursFromNow: 50, capacity: 0 });
    createdClassIds.push(cls.id);
    const membership = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    createdMembershipIds.push(membership.id);

    await saveSettings(centerAId, { ...defaultSettings, waitlistWeeklyLimit: 1 });

    const { data, error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).toBeNull();
    expect((data as any).status).toBe("waitlisted");
  });
});

describe("P1-12: 예약 오픈 시각(group_open_days_before/time)", () => {
  it("아직 오픈 전이면(오픈 기준일이 수업일보다 뒤) 예약이 차단된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1-12 오픈전 테스트", hoursFromNow: 50 });
    createdClassIds.push(cls.id);
    const membership = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    createdMembershipIds.push(membership.id);

    // 수업은 ~2일 뒤인데 "10일 전부터 오픈"으로 설정 → 아직 오픈 안 됨
    await saveSettings(centerAId, { ...defaultSettings, groupOpenDaysBefore: 10, groupOpenTime: "00:00" });

    const { error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("아직 예약이 열리지 않았어요");
  });

  it("기본값(60일 전 오픈)에서는 며칠 뒤 수업도 이미 오픈된 상태라 정상 예약된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1-12 오픈됨 테스트", hoursFromNow: 50 });
    createdClassIds.push(cls.id);
    const membership = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    createdMembershipIds.push(membership.id);

    const { data, error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).toBeNull();
    expect((data as any).status).toBe("confirmed");
  });
});
