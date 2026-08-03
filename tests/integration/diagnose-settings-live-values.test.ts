/*
  [진단 전용] "당일예약 OFF/일일예약 제한이 실제 브라우저에서 여전히 안 된다"는 반복 보고에
  대해, Playwright(E2E) 세션 문제로 결론 내리기 전에 운영설정 기능 자체(저장 → DB 반영 →
  RPC가 그 값을 실제로 읽는지 → 예약 결과)를 코드+실제 DB 값으로 끝까지 추적한다.

  operational-settings-wiring.test.ts가 이미 이 경로를 검증하고 있지만(그리고 이번 세션
  내내 계속 green이었지만), 이번엔 "DB 값 → RPC 결과"의 각 단계 실제 값을 전부 로그로
  남겨 어느 단계에서도 값이 어긋나지 않는지 직접 눈으로 확인할 수 있게 한다. reserve_class()는
  allow_same_day_booking/daily_book_limit을 RPC 파라미터로 받지 않는다 — 함수 본문 안에서
  center_settings를 그 자리에서 직접 select한다(reservation_functions.sql). 그래서 "RPC
  입력값"은 실제로는 없고, 그 대신: (a) 저장 직후 실제 DB 값(관리자 설정 화면과 동일한
  saveSettings/fetchSettings 경로 + admin client로 raw 테이블 값 교차 확인), (b) 그 값이
  저장된 채로 RPC를 호출했을 때의 실제 결과를 나란히 로그로 남겨, "저장은 됐는데 RPC가
  다른 값을 보는" 것인지 "RPC 자체가 이상한 것"인지를 실측으로 가른다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  createKstSameDayFutureClass,
  createTestMembership,
  cleanupTestClass,
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

// center_settings 원본 행을 admin(service-role) client로 직접 읽는다 — fetchSettings()가
// 쓰는 것과 완전히 별개의 경로로, "fetchSettings 자체의 매핑 버그"까지 배제하기 위한
// 교차 확인용.
async function readRawCenterSettings(centerId: string): Promise<Record<string, unknown> | null> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin.from("center_settings").select("*").eq("center_id", centerId).maybeSingle();
  if (error) throw new Error("center_settings raw 조회 실패: " + error.message);
  return data;
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
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];
  for (const id of createdClassIds) {
    try { await cleanupTestClass(id, []); } catch (e: any) { errors.push(e.message); }
  }
  try { await saveSettings(centerAId, originalSettings); } catch (e: any) { errors.push(e.message); }
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 30000);

describe("[진단] 당일예약 허용: 저장 → DB 값 → RPC 결과를 전부 실측으로 로그", () => {
  it("OFF 저장 → DB 반영 확인 → 예약 차단 확인 → ON 저장 → DB 반영 확인 → 예약 성공 확인", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveSettings(centerAId, {
      ...originalSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59",
      dailyBookLimitEnabled: false,
      allowSameDayBooking: false,
    });

    // ① 저장 직후 DB 값 — fetchSettings(관리자 화면과 동일 경로) + admin raw 교차 확인
    const afterOffViaFetch = await fetchSettings(centerAId);
    const afterOffRaw = await readRawCenterSettings(centerAId);

    const classOff = await createKstSameDayFutureClass(centerAId, { title: "DIAG 당일예약OFF" });
    createdClassIds.push(classOff.id);

    // ② RPC 호출 — reserve_class는 allow_same_day_booking을 파라미터로 받지 않고 함수
    // 본문 안에서 center_settings를 직접 읽는다(reservation_functions.sql). 그래서
    // "RPC가 읽는 값"은 곧 지금 이 순간 DB에 들어있는 값과 같아야 한다 — 위에서 이미
    // 확인한 afterOffRaw.allow_same_day_booking이 그것이다.
    await switchToTestUser(USER_A.email, USER_A.password);
    const offResult = await supabase.rpc("reserve_class", { p_class_id: classOff.id, p_profile_id: userA.profileId });

    const offReport = {
      step1_savedViaManagerSettingsPath: { allowSameDayBooking: false },
      step2_dbValueViaFetchSettings: { allowSameDayBooking: afterOffViaFetch.allowSameDayBooking },
      step2_dbValueViaAdminRawSelect: { allow_same_day_booking: (afterOffRaw as any)?.allow_same_day_booking },
      step3_rpcCallResult: { data: offResult.data, error: offResult.error?.message ?? null },
    };
    // eslint-disable-next-line no-console
    console.log("[DIAG-SAMEDAY-OFF] " + JSON.stringify(offReport, null, 2));

    expect(afterOffViaFetch.allowSameDayBooking, JSON.stringify(offReport)).toBe(false);
    expect((afterOffRaw as any)?.allow_same_day_booking, JSON.stringify(offReport)).toBe(false);
    expect(offResult.error, JSON.stringify(offReport)).not.toBeNull();
    expect(offResult.error?.message, JSON.stringify(offReport)).toContain("당일 예약은 허용되지 않아요");

    // ③ 이제 ON으로 되돌려 반대 방향도 같은 방식으로 확인
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveSettings(centerAId, {
      ...originalSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59",
      dailyBookLimitEnabled: false,
      allowSameDayBooking: true,
    });
    const afterOnViaFetch = await fetchSettings(centerAId);
    const afterOnRaw = await readRawCenterSettings(centerAId);

    const classOn = await createKstSameDayFutureClass(centerAId, { title: "DIAG 당일예약ON" });
    createdClassIds.push(classOn.id);

    await switchToTestUser(USER_A.email, USER_A.password);
    const onResult = await supabase.rpc("reserve_class", { p_class_id: classOn.id, p_profile_id: userA.profileId });

    const onReport = {
      step1_savedViaManagerSettingsPath: { allowSameDayBooking: true },
      step2_dbValueViaFetchSettings: { allowSameDayBooking: afterOnViaFetch.allowSameDayBooking },
      step2_dbValueViaAdminRawSelect: { allow_same_day_booking: (afterOnRaw as any)?.allow_same_day_booking },
      step3_rpcCallResult: { data: onResult.data, error: onResult.error?.message ?? null },
    };
    // eslint-disable-next-line no-console
    console.log("[DIAG-SAMEDAY-ON] " + JSON.stringify(onReport, null, 2));

    expect(afterOnViaFetch.allowSameDayBooking, JSON.stringify(onReport)).toBe(true);
    expect((afterOnRaw as any)?.allow_same_day_booking, JSON.stringify(onReport)).toBe(true);
    expect(onResult.error, JSON.stringify(onReport)).toBeNull();
    expect((onResult.data as any)?.status, JSON.stringify(onReport)).toBe("confirmed");
  }, 30000);
});

describe("[진단] 일일 예약 횟수 제한: 저장 → DB 값 → RPC 결과를 전부 실측으로 로그", () => {
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
      createKstSameDayFutureClass(centerAId, { title: "DIAG 일일한도 1", preferredMinutesFromNow: 60 }),
      createKstSameDayFutureClass(centerAId, { title: "DIAG 일일한도 2", preferredMinutesFromNow: 90 }),
      createKstSameDayFutureClass(centerAId, { title: "DIAG 일일한도 3", preferredMinutesFromNow: 120 }),
    ]);
    createdClassIds.push(...classes.map((c) => c.id));

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
    // eslint-disable-next-line no-console
    console.log("[DIAG-DAILYLIMIT] " + JSON.stringify(report, null, 2));

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
