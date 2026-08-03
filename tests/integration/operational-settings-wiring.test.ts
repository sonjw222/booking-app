/*
  실브라우저 QA에서 "당일 예약 OFF가 여전히 작동하지 않는다"는 보고를 받고 재검증하는 통합
  테스트다. 이전 배치에서는 SQL 코드를 눈으로 읽고 "reserve_class()에 배선돼 있다"로 결론
  냈을 뿐, 실제로 lib/settings.ts의 saveSettings()(관리자 설정 화면이 호출하는 것과 동일한
  경로)로 저장한 값이 reserve_class()에서 정말로 읽히는지를 자동 테스트로 검증한 적이
  없었다 — 이 파일이 그 공백을 메운다.

  raw SQL로 center_settings를 직접 UPDATE하지 않고, 반드시 fetchSettings/saveSettings(관리자
  설정 화면이 실제로 쓰는 함수)만 사용한다 — "테스트가 DB 값을 직접 넣어 UI 저장 버그를
  놓친 것"이 되지 않도록 하기 위함이다.
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

describe("운영설정 재검증: 관리자 설정 화면과 동일한 저장 경로(saveSettings)로 당일 예약 허용을 껐을 때", () => {
  it("당일 수업 예약이 실제로 차단된다", async () => {
    // 예약 마감(booking) 자체가 먼저 걸리지 않도록 그룹 예약 오픈/마감을 넉넉히 열어둔다 —
    // 이 테스트가 검증하려는 건 "당일 예약 허용" 플래그 하나뿐이다.
    await saveSettings(centerAId, {
      ...defaultSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59",
      allowSameDayBooking: false,
    });
    const cls = await createFutureTestClass(centerAId, { title: "SETTINGS-REAUDIT 당일예약OFF", hoursFromNow: 3 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("당일 예약은 허용되지 않아요");
  });

  it("(대조군) 당일 예약 허용을 켜두면 같은 조건에서 정상 예약된다", async () => {
    await saveSettings(centerAId, {
      ...defaultSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59",
      allowSameDayBooking: true,
    });
    const cls = await createFutureTestClass(centerAId, { title: "SETTINGS-REAUDIT 당일예약ON", hoursFromNow: 3 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).toBeNull();
    expect((data as any).status).toBe("confirmed");
  });
});

describe("운영설정 재검증: 예약 오픈 시점(그룹)이 취소 마감 설정이 아니라 진짜 오픈 설정을 쓴다", () => {
  // ⚠️ 이 describe 전체의 테스트 값 설계 메모(재작성, 2026-08-03):
  //   calc_deadline()의 "N일 전" 필드는 전부 "그 시점부터 조건이 성립"이 아니라
  //   "수업일 - N일" = 하나의 절대 기준 시각을 만드는 것뿐이다. book/cancel은
  //   "그 시각을 지나면 막힘", open은 정반대로 "그 시각에 도달하기 전까지 막힘"이라는
  //   차이만 있다. 그래서:
  //     - book_days_before를 크게 주면 마감 시각이 더 과거로 당겨져 오히려 더 쉽게 막힌다
  //       (0으로 고정해야 "수업 당일까지 마감 없음"이 되어 book 체크를 통과시킬 수 있다).
  //     - open_days_before가 수업까지 남은 일수보다 크면(오픈 시각이 이미 지난 과거가 됨)
  //       허용되고, 남은 일수보다 작으면(오픈 시각이 아직 안 온 미래임) 차단된다 — "큰
  //       숫자 = 더 관대함"이라는 직관과 반대다.
  //   처음 작성 시 이 방향을 반대로 가정해 실제로는 항상 "허용"되는 값들로 "차단"을
  //   기대하는 잘못된 테스트를 만들었던 적이 있다 — 아래는 그 수정본이다. 수업을 항상
  //   30일 뒤로 잡고, 오픈 기준을 10일 전(아직 20일 남아 차단)과 60일 전(이미 30일 지나
  //   허용) 두 값으로 명확히 대비시킨다.

  it("오픈 기한을 10일 전으로 저장하면, 30일 뒤 수업은 아직 예약이 열리지 않았다고 차단된다", async () => {
    // ⚠️ calc_deadline()이 'open' kind를 처리하지 못하던 버그(fix_calc_deadline_open_kind_draft_proposed.sql
    // 적용 전)에서는 'open' 호출이 조용히 group_cancel_days_before(기본 1일 전)로 대체돼,
    // 30일 뒤 수업이 "이미 열림"으로 잘못 판정되어 이 테스트가 의도적으로 FAIL한다.
    await saveSettings(centerAId, {
      ...defaultSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59", // 수업 당일까지 마감 없음 → book 체크 통과
      groupOpenDaysBefore: 10, groupOpenTime: "15:00", // 오픈 시각 = 수업일-10일 = 지금부터 20일 뒤(미래) → 아직 안 열림
      groupCancelDaysBefore: 1, groupCancelTime: "22:00", // 오픈 설정과 값이 겹치지 않도록 확실히 다르게
    });
    const cls = await createFutureTestClass(centerAId, { title: "SETTINGS-REAUDIT 오픈시점", hoursFromNow: 30 * 24 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("아직 예약이 열리지 않았어요");
  });

  it("(대조군) 오픈 기한을 60일 전으로 저장하면, 30일 뒤 수업은 정상 예약된다", async () => {
    await saveSettings(centerAId, {
      ...defaultSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59",
      groupOpenDaysBefore: 60, groupOpenTime: "00:00", // 오픈 시각 = 수업일-60일 = 30일 전(이미 지남) → 이미 열림
      groupCancelDaysBefore: 1, groupCancelTime: "22:00",
    });
    const cls = await createFutureTestClass(centerAId, { title: "SETTINGS-REAUDIT 오픈시점정상", hoursFromNow: 30 * 24 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).toBeNull();
    expect((data as any).status).toBe("confirmed");
  });

  it("프라이빗 수업도 그룹과 별개의 오픈 설정(private_open_*)을 쓴다", async () => {
    // group과 다른 값으로 설정해, private 분기가 실제로 group 설정을 잘못 읽어오지 않는지도
    // 함께 검증한다. group_open_days_before은 반대로(이미 열림) 설정해 두 값이 뒤섞이면
    // 이 테스트가(차단을 기대하는데 허용돼) 바로 드러나게 한다.
    await saveSettings(centerAId, {
      ...defaultSettings,
      privateBookDaysBefore: 0, privateBookTime: "23:59",
      privateOpenDaysBefore: 10, privateOpenTime: "15:00", // 수업일-10일 = 아직 20일 남음 → 차단돼야 함
      privateCancelDaysBefore: 1, privateCancelTime: "22:00",
      groupOpenDaysBefore: 60, groupOpenTime: "00:00", // group 설정이 잘못 섞이면 이미 열림으로 통과해버림
    });
    const { data: cls, error: clsErr } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId, title: "SETTINGS-REAUDIT 프라이빗오픈시점",
        start_time: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        end_time: new Date(Date.now() + 30 * 24 * 3600 * 1000 + 3600 * 1000).toISOString(),
        capacity: 1, class_format: "private",
      })
      .select("id").single();
    if (clsErr || !cls) throw new Error("프라이빗 수업 생성 실패: " + clsErr?.message);
    createdClassIds.push((cls as any).id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { error } = await supabase.rpc("reserve_class", { p_class_id: (cls as any).id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("아직 예약이 열리지 않았어요");
  });

  it("KST 자정 경계: 수업 시작이 KST 00:30이어도 오픈 마감은 그 수업의 KST 달력 날짜 기준으로 계산된다", async () => {
    // UTC 기준으로는 전날 15:30인 시각(KST 00:30)을 수업 시작으로 잡는다 — calc_deadline()이
    // p_start_time을 'Asia/Seoul'로 변환한 날짜를 쓰는지, 서버 UTC 날짜를 그대로 쓰는지를
    // 구분해서 검증한다. 수업을 30일 뒤로, 오픈 기준을 10일 전(아직 20일 남음 → 차단)으로
    // 잡아 시(분) 단위 오차와 무관하게 여유 있는 마진으로 차단이 재현되게 한다.
    await saveSettings(centerAId, {
      ...defaultSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59",
      groupOpenDaysBefore: 10, groupOpenTime: "00:00",
      groupCancelDaysBefore: 1, groupCancelTime: "22:00",
    });

    const target = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const y = target.getUTCFullYear();
    const m = String(target.getUTCMonth() + 1).padStart(2, "0");
    const d = String(target.getUTCDate()).padStart(2, "0");
    // KST 00:30 == UTC 전날 15:30
    const startTimeIso = new Date(`${y}-${m}-${d}T00:30:00+09:00`).toISOString();

    const cls = await createFutureTestClass(centerAId, {
      title: "SETTINGS-REAUDIT KST경계", hoursFromNow: (new Date(startTimeIso).getTime() - Date.now()) / 3600000,
    });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const { error } = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: managerA.profileId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("아직 예약이 열리지 않았어요");
  });
});
