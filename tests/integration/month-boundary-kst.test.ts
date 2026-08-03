/*
  회귀 테스트(원래 진단 전용 diagnose-month-boundary.test.ts를 여기로 정리) — "수강권 구매
  직후 예약 캘린더에 일부 수업만 보인다"는 보고의 실제 원인이었던 fetchMonthData()의 월
  경계 계산 버그 수정 검증.

  원인: monthStart/nextMonth가 타임존 표기 없는 날짜 문자열("2026-10-01")이라, timestamptz
  컬럼(classes.start_time)과 .gte()/.lt() 비교 시 DB 세션 타임존(UTC) 기준으로 해석돼
  KST 기준 그 달 1일 00:00~08:59 수업이 누락되고(가장 먼저 실증됨), 반대쪽 경계에서는
  다음 달 1일 00:00~08:59 수업이 잘못 포함될 수 있었다.

  수정: lib/kst.ts의 getKstMonthUtcRange(year, month)로 KST 월 경계를 명시적 UTC ISO로
  변환해 사용(lib/reservations.ts). 이 테스트는 그 수정을 실제 프로덕션 함수
  fetchMonthData()를 그대로 호출해 검증한다 — 함수 내부를 재구현하지 않는다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { fetchMonthData } from "../../lib/reservations";
import { toKstIso } from "../../lib/kst";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createTestMembership,
  type TestUser,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };

let managerA: TestUser;
let centerAId: string;
const createdClassIds: string[] = []; // centerA 소속(managerA로 정리)
const createdOtherCenterClassIds: string[] = []; // centerB 소속(managerB로 정리해야 RLS 통과)
const createdHolidayKeys: { centerId: string; date: string }[] = [];

async function insertClass(centerId: string, title: string, kstDate: string, kstTime: string, hours = 1) {
  const startIso = new Date(toKstIso(kstDate, kstTime)).toISOString();
  const endIso = new Date(new Date(startIso).getTime() + hours * 3600000).toISOString();
  const { data, error } = await supabase
    .from("classes")
    .insert({ center_id: centerId, title, capacity: 8, start_time: startIso, end_time: endIso })
    .select("id").single();
  if (error || !data) throw new Error(`${title} 생성 실패: ` + error?.message);
  createdClassIds.push((data as any).id);
  return (data as any).id as string;
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  await createTestMembership(centerAId, managerA.profileId, { remainingCount: 20 });
}, 30000);

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  for (const id of createdClassIds) {
    try { await supabase.from("classes").delete().eq("id", id); } catch { /* best-effort */ }
  }
  for (const h of createdHolidayKeys) {
    try { await supabase.from("center_holidays").delete().eq("center_id", h.centerId).eq("holiday_date", h.date); } catch { /* best-effort */ }
  }
  if (createdOtherCenterClassIds.length > 0) {
    // centerB 소속 수업은 managerA가 지울 권한이 없다(RLS) — 반드시 managerB로 정리한다.
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    for (const id of createdOtherCenterClassIds) {
      try { await supabase.from("classes").delete().eq("id", id); } catch { /* best-effort */ }
    }
  }
}, 30000);

describe("월 경계(KST) 회귀 테스트: fetchMonthData()가 KST 기준 달력월과 정확히 일치한다", () => {
  it("1) KST 10월 1일 03:00 수업은 10월 조회에 포함된다", async () => {
    await insertClass(centerAId, "MB-10월1일03시", "2026-10-01", "03:00");
    const { classes } = await fetchMonthData(2026, 10, managerA.accountId);
    expect(classes.some((c) => c.title === "MB-10월1일03시")).toBe(true);
  });

  it("2) KST 9월 30일 23:59 수업은 10월 조회에서 제외된다(9월 조회에는 포함)", async () => {
    await insertClass(centerAId, "MB-9월30일23시59분", "2026-09-30", "23:59");
    const oct = await fetchMonthData(2026, 10, managerA.accountId);
    expect(oct.classes.some((c) => c.title === "MB-9월30일23시59분")).toBe(false);
    const sep = await fetchMonthData(2026, 9, managerA.accountId);
    expect(sep.classes.some((c) => c.title === "MB-9월30일23시59분")).toBe(true);
  });

  it("3) KST 11월 1일 00:30 수업은 10월 조회에서 제외된다(11월 조회에는 포함)", async () => {
    await insertClass(centerAId, "MB-11월1일00시30분", "2026-11-01", "00:30");
    const oct = await fetchMonthData(2026, 10, managerA.accountId);
    expect(oct.classes.some((c) => c.title === "MB-11월1일00시30분")).toBe(false);
    const nov = await fetchMonthData(2026, 11, managerA.accountId);
    expect(nov.classes.some((c) => c.title === "MB-11월1일00시30분")).toBe(true);
  });

  it("4) KST 10월 31일 23:59 수업은 10월 조회에 포함된다", async () => {
    await insertClass(centerAId, "MB-10월31일23시59분", "2026-10-31", "23:59");
    const { classes } = await fetchMonthData(2026, 10, managerA.accountId);
    expect(classes.some((c) => c.title === "MB-10월31일23시59분")).toBe(true);
  });

  it("5) 12월 -> 다음 해 1월 경계: 12/31 23:59는 12월에, 다음해 1/1 00:30은 1월에만 포함된다", async () => {
    await insertClass(centerAId, "MB-12월31일23시59분", "2026-12-31", "23:59");
    await insertClass(centerAId, "MB-1월1일00시30분(익년)", "2027-01-01", "00:30");

    const dec = await fetchMonthData(2026, 12, managerA.accountId);
    expect(dec.classes.some((c) => c.title === "MB-12월31일23시59분")).toBe(true);
    expect(dec.classes.some((c) => c.title === "MB-1월1일00시30분(익년)")).toBe(false);

    const jan = await fetchMonthData(2027, 1, managerA.accountId);
    expect(jan.classes.some((c) => c.title === "MB-1월1일00시30분(익년)")).toBe(true);
    expect(jan.classes.some((c) => c.title === "MB-12월31일23시59분")).toBe(false);
  });

  it("6) 윤년 2월(2028): 2/29 23:59는 2월에, 3/1 00:30은 3월에만 포함된다", async () => {
    await insertClass(centerAId, "MB-윤년2월29일23시59분", "2028-02-29", "23:59");
    await insertClass(centerAId, "MB-윤년다음3월1일00시30분", "2028-03-01", "00:30");

    const feb = await fetchMonthData(2028, 2, managerA.accountId);
    expect(feb.classes.some((c) => c.title === "MB-윤년2월29일23시59분")).toBe(true);
    expect(feb.classes.some((c) => c.title === "MB-윤년다음3월1일00시30분")).toBe(false);

    const mar = await fetchMonthData(2028, 3, managerA.accountId);
    expect(mar.classes.some((c) => c.title === "MB-윤년다음3월1일00시30분")).toBe(true);
  });

  it("7) 비윤년 2월(2029): 2/28 23:59는 2월에, 3/1 00:30은 3월에만 포함된다", async () => {
    await insertClass(centerAId, "MB-비윤년2월28일23시59분", "2029-02-28", "23:59");
    await insertClass(centerAId, "MB-비윤년다음3월1일00시30분", "2029-03-01", "00:30");

    const feb = await fetchMonthData(2029, 2, managerA.accountId);
    expect(feb.classes.some((c) => c.title === "MB-비윤년2월28일23시59분")).toBe(true);
    expect(feb.classes.some((c) => c.title === "MB-비윤년다음3월1일00시30분")).toBe(false);

    const mar = await fetchMonthData(2029, 3, managerA.accountId);
    expect(mar.classes.some((c) => c.title === "MB-비윤년다음3월1일00시30분")).toBe(true);
  });

  it("8) fetchMonthData() 실제 호출 기준: 한 달 안에서 안전한 정중앙 수업도 정상 포함된다(회귀 없음)", async () => {
    await insertClass(centerAId, "MB-10월15일정오", "2026-10-15", "12:00");
    const { classes } = await fetchMonthData(2026, 10, managerA.accountId);
    expect(classes.some((c) => c.title === "MB-10월15일정오")).toBe(true);
  });

  it("9) 휴무일 필터는 기존과 동일하게 동작한다(월 경계 수정과 무관하게 유지)", async () => {
    const holidayDate = "2026-10-20";
    await supabase.from("center_holidays").insert({ center_id: centerAId, holiday_date: holidayDate, reason: "MB 테스트 휴무" });
    createdHolidayKeys.push({ centerId: centerAId, date: holidayDate });
    await insertClass(centerAId, "MB-휴무일수업", "2026-10-20", "10:00");

    const { classes } = await fetchMonthData(2026, 10, managerA.accountId);
    expect(classes.some((c) => c.title === "MB-휴무일수업")).toBe(false);
  });

  it("10) 수강권 보유 센터 필터는 기존과 동일하게 동작한다(다른 매니저의 센터 수업은 안 보임)", async () => {
    const managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const centerBId = await getOrCreateOwnedTestCenter(managerB);

    // centerB에 수업을 만드는 건 그 센터의 오너(managerB)로 해야 RLS(매니저 수업 생성)를
    // 통과한다 — managerA는 애초에 이 센터의 수강권도, 관리 권한도 없다.
    if (centerBId !== centerAId) {
      const { data, error } = await supabase
        .from("classes")
        .insert({
          center_id: centerBId, title: "MB-다른센터수업", capacity: 8,
          start_time: new Date(toKstIso("2026-10-15", "12:00")).toISOString(),
          end_time: new Date(toKstIso("2026-10-15", "13:00")).toISOString(),
        })
        .select("id").single();
      if (error || !data) throw new Error("다른 센터 수업 생성 실패: " + error?.message);
      createdOtherCenterClassIds.push((data as any).id);
    }

    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const { classes } = await fetchMonthData(2026, 10, managerA.accountId);
    expect(classes.some((c) => c.title === "MB-다른센터수업")).toBe(false);
  });
});
