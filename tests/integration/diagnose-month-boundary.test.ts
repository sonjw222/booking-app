/*
  진단 전용(코드 수정 없음) — "수강권 구매 직후 예약 캘린더에 일부 수업만 보인다"는 보고의
  실제 원인을 실제 라이브 dev Supabase 데이터로 검증한다.

  가설: fetchMonthData()가 월 경계를 만들 때
    monthStart = "${year}-${month}-01"  (타임존 표기 없는 순수 날짜 문자열)
    nextMonth  = "${year}-${month+1}-01"
  를 그대로 timestamptz 컬럼(classes.start_time)과 .gte()/.lt()로 비교한다. PostgREST/Postgres는
  타임존 표기가 없는 날짜 문자열을 DB 세션 타임존(Supabase 기본 UTC) 기준으로 해석하므로,
  이 두 문자열은 실제로는 "그 달 1일 00:00 UTC"를 뜻하게 된다 — 회원이 보는 화면은 KST
  기준 "8월"인데, 쿼리는 "UTC 기준 8월"을 가져오는 것이다.

  UTC와 KST는 9시간 차이이므로, KST 기준 그 달 1일 00:00~08:59에 시작하는 수업은 UTC로는
  아직 "전달 마지막날"이라 gte(monthStart) 조건에 걸려 빠진다 — 이 테스트가 그 정확한
  경계를 실제 데이터로 재현한다.

  이 테스트는 lib/reservations.ts를 전혀 수정하지 않고, 실제 프로덕션 함수
  fetchMonthData()를 그대로 호출해 관찰한다. 실패하면 가설이 맞다는 뜻이고, 통과하면
  가설이 틀렸다는 뜻이다 — 어느 쪽이든 결과를 있는 그대로 보고한다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { fetchMonthData } from "../../lib/reservations";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createTestMembership,
  type TestUser,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };

let managerA: TestUser;
let centerAId: string;
const createdClassIds: string[] = [];

// 오늘로부터 2개월 뒤를 대상 월로 잡는다(과거/이번 달 관련 다른 부작용 방지, 넉넉한 미래).
const target = new Date();
target.setUTCMonth(target.getUTCMonth() + 2, 1);
const TARGET_YEAR = target.getUTCFullYear();
const TARGET_MONTH = target.getUTCMonth() + 1; // 1-12

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  await createTestMembership(centerAId, managerA.profileId, { remainingCount: 5 });
}, 30000);

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  for (const id of createdClassIds) {
    try { await supabase.from("classes").delete().eq("id", id); } catch { /* best-effort */ }
  }
}, 30000);

describe("진단: 월 경계(KST) 근처 수업이 fetchMonthData()에서 누락되는가", () => {
  it("경계 케이스(KST 1일 03:00)와 대조군(KST 15일 12:00)을 만들고 raw DB 조회 결과를 확인한다", async () => {
    const boundaryIso = new Date(`${TARGET_YEAR}-${pad2(TARGET_MONTH)}-01T03:00:00+09:00`).toISOString();
    const controlIso = new Date(`${TARGET_YEAR}-${pad2(TARGET_MONTH)}-15T12:00:00+09:00`).toISOString();

    const { data: boundaryCls, error: e1 } = await supabase.from("classes").insert({
      center_id: centerAId, title: "DIAG-경계 KST01일03시", capacity: 8,
      start_time: boundaryIso, end_time: new Date(new Date(boundaryIso).getTime() + 3600000).toISOString(),
    }).select("id").single();
    if (e1 || !boundaryCls) throw new Error("경계 수업 생성 실패: " + e1?.message);
    createdClassIds.push((boundaryCls as any).id);

    const { data: controlCls, error: e2 } = await supabase.from("classes").insert({
      center_id: centerAId, title: "DIAG-대조군 KST15일12시", capacity: 8,
      start_time: controlIso, end_time: new Date(new Date(controlIso).getTime() + 3600000).toISOString(),
    }).select("id").single();
    if (e2 || !controlCls) throw new Error("대조군 수업 생성 실패: " + e2?.message);
    createdClassIds.push((controlCls as any).id);

    // ---- STEP A: fetchMonthData()와 완전히 동일한 raw 쿼리(필터 이전 단계)를 직접 재현 ----
    const monthStart = `${TARGET_YEAR}-${pad2(TARGET_MONTH)}-01`;
    const nextMonth = TARGET_MONTH === 12
      ? `${TARGET_YEAR + 1}-01-01`
      : `${TARGET_YEAR}-${pad2(TARGET_MONTH + 1)}-01`;

    const { data: rawRows, error: rawErr } = await supabase
      .from("classes")
      .select("id, center_id, title, start_time, status, class_format, capacity")
      .eq("center_id", centerAId)
      .gte("start_time", monthStart)
      .lt("start_time", nextMonth)
      .order("start_time");
    if (rawErr) throw new Error("raw 조회 실패: " + rawErr.message);

    const rawTitles = (rawRows ?? []).map((r: any) => r.title);
    const rawHasBoundary = rawTitles.includes("DIAG-경계 KST01일03시");
    const rawHasControl = rawTitles.includes("DIAG-대조군 KST15일12시");

    // ---- STEP B: 실제 프로덕션 함수 fetchMonthData()를 그대로 호출 ----
    const { classes } = await fetchMonthData(TARGET_YEAR, TARGET_MONTH, managerA.accountId);
    const finalTitles = classes.filter((c) => c.centerId === centerAId).map((c) => c.title);
    const finalHasBoundary = finalTitles.includes("DIAG-경계 KST01일03시");
    const finalHasControl = finalTitles.includes("DIAG-대조군 KST15일12시");

    // 진단 결과를 실패 메시지에 그대로 남겨(assertion 실패 시 CI 로그에 정확히 찍힘) 근거로 삼는다.
    const report = {
      targetYear: TARGET_YEAR, targetMonth: TARGET_MONTH,
      monthStartFilterUsed: monthStart, nextMonthFilterUsed: nextMonth,
      boundaryClassStartTimeIso: boundaryIso, controlClassStartTimeIso: controlIso,
      rawRowCount: (rawRows ?? []).length,
      rawHasBoundary, rawHasControl,
      finalClassCountThisCenter: finalTitles.length,
      finalHasBoundary, finalHasControl,
      rawTitles, finalTitles,
    };

    // 대조군은 raw든 최종이든 항상 포함돼야 한다(모호하지 않은 정중앙 시각).
    expect(rawHasControl, JSON.stringify(report, null, 2)).toBe(true);
    expect(finalHasControl, JSON.stringify(report, null, 2)).toBe(true);

    // 경계 케이스가 raw 단계부터 이미 빠진다면 = DB 쿼리(월 경계 문자열의 타임존 해석)가 원인.
    // raw엔 있는데 final엔 없다면 = 이후 JS 필터(센터/휴무일) 단계가 원인.
    // 이 assertion은 "가설이 맞다면 실패"하도록 일부러 true를 기대한다 — 실패 메시지의 JSON이
    // 바로 이번 조사의 답이다.
    expect(rawHasBoundary, JSON.stringify(report, null, 2)).toBe(true);
    expect(finalHasBoundary, JSON.stringify(report, null, 2)).toBe(true);
  });
});
