/*
  운영설정 재검증: 일일 예약 횟수 제한(daily_book_limit) — 저장 → DB 값 → RPC 결과가
  일치하는지 실측으로 확인. reserve_class()는 daily_book_limit_enabled/daily_book_limit을
  RPC 파라미터로 받지 않고 함수 본문 안에서 center_settings를 직접 읽는다
  (reservation_functions.sql) — 그래서 "RPC가 읽는 값"은 곧 지금 DB에 들어있는 값과 같아야
  한다. saveSettings(관리자 화면과 동일 경로)로 저장한 뒤, admin raw select로 교차 확인하고,
  실제 reserve_class() 호출 결과로 최종 검증한다.

  이 파일 통합 전 이력: 원래 diagnose-settings-live-values.test.ts라는 이름으로 "당일예약
  OFF/일일한도가 실제 브라우저에서 안 된다"는 반복 보고를 진단하기 위한 1회성 진단 목적으로
  작성됐다. 당일예약 부분은 operational-settings-wiring.test.ts가 이미 동일 경로를
  검증하고 있어(저장→DB→RPC) 완전히 중복이라 제거했고, 일일한도 부분은 이 저장소에서
  유일한 daily_book_limit 통합 테스트 커버리지라 이 파일로 남기며 이름을 실제 성격(1회성
  진단이 아니라 상시 회귀 테스트)에 맞게 바꿨다. 원래 cleanupTestClass()(매니저 세션 RLS
  기준)를 썼는데, "매니저 취소예약 정리" RLS 정책이 confirmed 상태 예약의 delete를 조용히
  0건으로 실패시켜(private-class-capacity.test.ts에서 이미 확인된 것과 동일 원인)
  reservations/classes가 매 실행 남았다 — TEST-004(#45) 누적의 실제 기여 요인 중 하나였다.
  admin(service_role) 기반 cleanupTestClassAdmin()으로 교체해 이 leak을 근본적으로
  막았다(추가로 tests/integration/setup.ts의 getOrCreateOwnedTestCenter() 자체에 붙은
  self-healing sweep이 CI 취소 등으로 그래도 남는 경우까지 다음 실행에서 정리한다).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  createKstSameDayFutureClass,
  createTestMembership,
  cleanupTestClassAdmin,
  type TestUser,
} from "./setup";
import { fetchSettings, saveSettings, type CenterSettings } from "../../lib/settings";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const USER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];

async function readRawCenterSettings(centerId: string): Promise<Record<string, unknown> | null> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin.from("center_settings").select("*").eq("center_id", centerId).maybeSingle();
  if (error) throw new Error("center_settings raw 조회 실패: " + error.message);
  return data;
}

function kstDateStr(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(iso));
}

// [발견, 2026-08-21] 이 파일은 하루 예약 "2회"가 딱 맞아야 통과하는 테스트라 특히 취약하다 —
// centerAId는 여러 통합 테스트 파일/세션이 공유하는 fixture 센터(P2-22 참고, leftover
// 누적 이력이 이미 있는 센터)라, USER_A가 오늘 날짜로 이미 확정/대기 예약을 갖고 있으면
// (다른 세션의 leftover, 또는 이 파일 자신의 이전 실행이 CI 취소 등으로 afterAll 전에
// 죽어서 남긴 것) 새로 만드는 1·2번째 예약까지 한도 초과로 거부된다. 실제로 CI에서 재현됨
// (auto-book-membership-security.test.ts의 AUTO-SEC-I와 같은 계열의 문제, P2-28 참고).
// 테스트 시작 전 USER_A의 "오늘"(KST) 예약을 이 센터에서 정리해 방어한다.
async function clearUserATodayReservations(centerId: string, profileId: string): Promise<void> {
  const admin = getFixtureAdminClient();
  const today = kstDateStr(new Date().toISOString());
  const { data, error } = await admin
    .from("reservations")
    .select("id, status, classes!inner(start_time, center_id)")
    .eq("profile_id", profileId)
    .eq("classes.center_id", centerId)
    .in("status", ["confirmed", "waitlisted", "attended"]);
  if (error) throw new Error(`USER_A 오늘 예약 조회 실패: ${error.message}`);
  const target = (data ?? []).filter((r: any) => kstDateStr(r.classes.start_time) === today);
  if (target.length === 0) return;
  const { error: delErr } = await admin.from("reservations").delete().in("id", target.map((r: any) => r.id));
  if (delErr) throw new Error(`USER_A leftover 예약 정리 실패: ${delErr.message}`);
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  originalSettings = await fetchSettings(centerAId);
  userA = await switchToTestUser(USER_A.email, USER_A.password);
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  await createTestMembership(centerAId, userA.profileId, { remainingCount: 10 });
}, 30000);

afterAll(async () => {
  const errors: string[] = [];
  for (const id of createdClassIds) {
    try { await cleanupTestClassAdmin(id); } catch (e: any) { errors.push(e.message); }
  }
  try {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveSettings(centerAId, originalSettings);
  } catch (e: any) { errors.push(e.message); }
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 30000);

describe("운영설정 재검증: 일일 예약 횟수 제한 — 저장 → DB 값 → RPC 결과를 실측으로 확인", () => {
  it("2회 제한 저장 → DB 반영 확인 → 1·2회 성공, 3회 차단 확인", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveSettings(centerAId, {
      ...originalSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59",
      allowSameDayBooking: true,
      dailyBookLimitEnabled: true,
      dailyBookLimit: 2,
    });

    const afterSaveViaFetch = await fetchSettings(centerAId);
    const afterSaveRaw = await readRawCenterSettings(centerAId);

    const classes = await Promise.all([
      createKstSameDayFutureClass(centerAId, { title: "DAILYLIMIT-WIRING 1", preferredMinutesFromNow: 60 }),
      createKstSameDayFutureClass(centerAId, { title: "DAILYLIMIT-WIRING 2", preferredMinutesFromNow: 90 }),
      createKstSameDayFutureClass(centerAId, { title: "DAILYLIMIT-WIRING 3", preferredMinutesFromNow: 120 }),
    ]);
    createdClassIds.push(...classes.map((c) => c.id));

    await clearUserATodayReservations(centerAId, userA.profileId);

    await switchToTestUser(USER_A.email, USER_A.password);
    const r1 = await supabase.rpc("reserve_class", { p_class_id: classes[0].id, p_profile_id: userA.profileId });
    const r2 = await supabase.rpc("reserve_class", { p_class_id: classes[1].id, p_profile_id: userA.profileId });
    const r3 = await supabase.rpc("reserve_class", { p_class_id: classes[2].id, p_profile_id: userA.profileId });

    const report = {
      step1_savedViaManagerSettingsPath: { dailyBookLimitEnabled: true, dailyBookLimit: 2 },
      step2_dbValueViaFetchSettings: {
        dailyBookLimitEnabled: afterSaveViaFetch.dailyBookLimitEnabled,
        dailyBookLimit: afterSaveViaFetch.dailyBookLimit,
      },
      step2_dbValueViaAdminRawSelect: {
        daily_book_limit_enabled: (afterSaveRaw as any)?.daily_book_limit_enabled,
        daily_book_limit: (afterSaveRaw as any)?.daily_book_limit,
      },
      step3_rpcResults: [
        { attempt: 1, data: r1.data, error: r1.error?.message ?? null },
        { attempt: 2, data: r2.data, error: r2.error?.message ?? null },
        { attempt: 3, data: r3.data, error: r3.error?.message ?? null },
      ],
    };

    expect(afterSaveViaFetch.dailyBookLimitEnabled, JSON.stringify(report)).toBe(true);
    expect(afterSaveViaFetch.dailyBookLimit, JSON.stringify(report)).toBe(2);
    expect((afterSaveRaw as any)?.daily_book_limit_enabled, JSON.stringify(report)).toBe(true);
    expect((afterSaveRaw as any)?.daily_book_limit, JSON.stringify(report)).toBe(2);

    expect(r1.error, JSON.stringify(report)).toBeNull();
    expect(r2.error, JSON.stringify(report)).toBeNull();
    expect(r3.error, JSON.stringify(report)).not.toBeNull();
    expect(r3.error?.message, JSON.stringify(report)).toContain("하루 예약 가능 횟수");
  }, 30000);
});
