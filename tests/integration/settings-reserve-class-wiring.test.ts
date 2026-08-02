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
  createFutureTestClass,
  createTestMembership,
  cleanupTestClass,
  type TestUser,
} from "./setup";
import { fetchSettings, saveSettings, type CenterSettings } from "../../lib/settings";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };

// "당일(오늘)" 테스트는 hoursFromNow를 고정값(예: 2)으로 쓰면 실행 시각이 KST 자정에 가까울 때
// 자정을 넘겨 "내일"이 돼버려 same-day 체크 자체가 스킵되는 문제가 있었다(실제로 CI에서 재현됨).
// KST 자정까지 남은 시간을 계산해 항상 "오늘 안"으로 들어가도록 안전 마진을 두고 클램프한다.
function hoursUntilKstMidnight(): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return 24 - (get("hour") + get("minute") / 60 + get("second") / 3600);
}
const SAME_DAY_HOURS = Math.max(0.05, Math.min(2, hoursUntilKstMidnight() - 0.1));

// daily_book_limit/waitlist_weekly_limit은 프로필의 그 날짜(또는 그 주) 전체 예약을 합산하는
// 검증이라, 이 파일을 반복 실행(CI 재실행 등)하면 이전 실행이 만든 잔여 예약이 그대로 남아있을
// 때 이후 실행의 판정을 오염시킬 수 있다(실제로 CI에서 재현됨 — 몇 분 간격 재실행이 같은
// hoursFromNow 계산으로 거의 같은 날짜에 몰림).
//
// 삭제가 아니라 "취소"로 정리하는 이유: reservations의 DELETE RLS 정책
// ("매니저 취소예약 정리", reservation_functions.sql)은 status가 'cancelled'/'no_show'인
// 행만 삭제를 허용한다 — confirmed/waitlisted 상태인 채로 직접 delete를 시도하면 RLS가
// 조용히 0건을 지우고 에러도 내지 않는다(바로 이것이 오염의 실제 원인이었다: 기존
// cleanupTestClass()도 이 문제를 그대로 갖고 있었다). 그래서 이 헬퍼는 남아있는 확정/대기
// 예약을 cancel_reservation()으로 먼저 취소한다 — 이러면 daily-limit/waitlist 카운트
// 쿼리(status in ('confirmed','waitlisted')만 집계)에서 자동으로 제외되고, 수강권도
// 정상적으로 복구된다(기존 예약 취소 경로 그대로 재사용).
async function clearFutureReservationsForManagerA(centerId: string, profileId: string) {
  // classes를 먼저 조회해 id 배열을 만들고 .in()으로 넘기면, 이 테스트 센터에 오늘까지 쌓인
  // 수백 건의 클래스(반복 CI 재실행 산물)를 URL 쿼리 파라미터로 통째로 실어보내다가 PostgREST가
  // "Bad Request"로 거부한다(실제로 CI에서 재현됨) — 대신 classes!inner 임베디드 조인으로
  // 서버 쪽에서 필터링해 ID 목록을 왕복시키지 않는다.
  const { data: staleReservations, error: resErr } = await supabase
    .from("reservations")
    .select("id, classes!inner(center_id, start_time)")
    .eq("profile_id", profileId)
    .eq("classes.center_id", centerId)
    .gt("classes.start_time", new Date().toISOString())
    .in("status", ["confirmed", "waitlisted"]);
  if (resErr) throw new Error("잔여 예약 조회 실패: " + resErr.message);

  for (const r of staleReservations ?? []) {
    const { error } = await supabase.rpc("cancel_reservation", { p_reservation_id: (r as any).id });
    if (error) throw new Error(`잔여 예약 취소 실패(id=${(r as any).id}): ${error.message}`);
  }
}

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

  // reserve_class()는 centers.status='approved'를 요구한다. getOrCreateOwnedTestCenter()는
  // 이제 새 센터를 'approved'로 insert하지만(P2-15 수정 — guard_center_status_change 트리거는
  // UPDATE만 막고 INSERT는 막지 않음), TEST_MANAGER_A처럼 과거 배치에서 이미 'pending'으로
  // 만들어진 기존 센터를 재사용하는 계정은 fix_test_center_approval_draft_proposed.sql이
  // 실행되기 전까지 여전히 막힐 수 있다. 여기서는 현재 상태를 읽기만 하고, 아직 pending이면
  // 그 SQL을 가리키는 명확한 에러로 실패한다(회귀가 아님).
  const { data: centerRow, error: centerReadErr } = await supabase
    .from("centers")
    .select("status")
    .eq("id", centerAId)
    .single();
  if (centerReadErr) throw new Error("테스트 센터 상태 조회 실패: " + centerReadErr.message);
  if ((centerRow as { status: string }).status !== "approved") {
    throw new Error(
      "[테스트 인프라 gap, docs/TODO.md P2-15 참고] 테스트 센터가 아직 'approved'가 아니에요 " +
        `(현재: ${(centerRow as { status: string }).status}). ` +
        "fix_test_center_approval_draft_proposed.sql을 Supabase에서 실행해주세요."
    );
  }

  await clearFutureReservationsForManagerA(centerAId, managerA.profileId);
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
  // 기본 group_book_days_before=1/group_book_time=22:00이면 "당일" 수업은 이 테스트가 검증하려는
  // allow_same_day_booking 체크에 도달하기도 전에 기존 예약 마감시간 체크("어제 22:00까지")에서
  // 항상 막힌다 — 그래서 두 테스트 모두 book_days_before=0/book_time=23:59로 겹침 없이 마감시간을
  // 오늘 자정 직전까지로 넉넉히 열어, 실제로 테스트하려는 same-day 체크만 단독으로 노출시킨다.
  const bookOverride = { groupBookDaysBefore: 0, groupBookTime: "23:59" };

  it("꺼져 있으면 오늘(KST) 수업 예약이 차단된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1-12 당일예약 테스트", hoursFromNow: SAME_DAY_HOURS});
    createdClassIds.push(cls.id);
    const membership = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    createdMembershipIds.push(membership.id);

    await saveSettings(centerAId, { ...defaultSettings, ...bookOverride, allowSameDayBooking: false });

    const { error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("당일 예약은 허용되지 않아요");
  });

  it("켜져 있으면(기본값) 오늘(KST) 수업도 정상 예약된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1-12 당일예약 허용 테스트", hoursFromNow: SAME_DAY_HOURS});
    createdClassIds.push(cls.id);
    const membership = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    createdMembershipIds.push(membership.id);

    await saveSettings(centerAId, { ...defaultSettings, ...bookOverride });

    const { data, error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).toBeNull();
    expect((data as any).status).toBe("confirmed");
  });
});

describe("P1-12: 일일 예약 가능 횟수(daily_book_limit)", () => {
  it("한도를 켜고 1로 설정하면 같은 날 두 번째 예약은 차단된다", async () => {
    // daily_book_limit은 같은 프로필의 그 날짜 전체 예약을 합산하므로, 다른 describe 블록(대기/
    // 오픈시각) 및 다른 통합 테스트 파일이 흔히 쓰는 48~96시간대와 겹치지 않도록 날짜를 충분히
    // 떨어뜨린다(약 16일 뒤) — 그렇지 않으면 이 블록의 판정이 다른 fixture 잔여 예약에 오염된다.
    const classA = await createFutureTestClass(centerAId, { title: "P1-12 일일한도 A", hoursFromNow: 380 });
    const classB = await createFutureTestClass(centerAId, { title: "P1-12 일일한도 B", hoursFromNow: 382 });
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
  // daily_book_limit 블록(약 16일 뒤)과 겹치지 않도록 약 19일 뒤로 분리한다(사유는 위 블록 주석 참고).
  it("0(기본값)이면 정원이 찬 수업은 대기 없이 즉시 거부된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1-12 대기0 테스트", hoursFromNow: 450, capacity: 0 });
    createdClassIds.push(cls.id);
    const membership = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    createdMembershipIds.push(membership.id);

    const { error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("대기예약을 사용하지 않아요");
  });

  it("1로 설정하면 정원 찬 수업에 대기예약이 성공한다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1-12 대기1 테스트", hoursFromNow: 452, capacity: 0 });
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
  // waitlist 블록(약 19일 뒤)과 겹치지 않도록 약 25일/28일 뒤로 분리한다(사유는 daily_book_limit
  // 블록 주석 참고). "아직 오픈 전" 케이스는 수업일이 groupOpenDaysBefore보다 더 멀리 있어야
  // 실제로 "아직 오픈 안 됨" 상태가 된다 — 수업이 10일 전부터 오픈인데 수업 자체가 2일 뒤면
  // 오픈 시점(10일 전)이 이미 지나 있어 오히려 "이미 열림"이 되므로, 25일 뒤 수업 + 15일 전
  // 오픈으로 오픈 시점(수업 10일 전 = 지금부터 10일 뒤)이 아직 미래이도록 잡는다.
  it("아직 오픈 전이면(오픈 기준일이 수업일보다 뒤) 예약이 차단된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1-12 오픈전 테스트", hoursFromNow: 600 });
    createdClassIds.push(cls.id);
    const membership = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    createdMembershipIds.push(membership.id);

    await saveSettings(centerAId, { ...defaultSettings, groupOpenDaysBefore: 15, groupOpenTime: "00:00" });

    const { error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("아직 예약이 열리지 않았어요");
  });

  it("기본값(60일 전 오픈)에서는 며칠 뒤 수업도 이미 오픈된 상태라 정상 예약된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1-12 오픈됨 테스트", hoursFromNow: 670 });
    createdClassIds.push(cls.id);
    const membership = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });
    createdMembershipIds.push(membership.id);

    const { data, error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).toBeNull();
    expect((data as any).status).toBe("confirmed");
  });
});
