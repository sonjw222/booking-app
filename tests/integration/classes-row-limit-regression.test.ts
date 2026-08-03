/*
  회귀 테스트(원래 진단 전용 diagnose-classes-row-limit.test.ts를 여기로 정리) — "8/4 이후
  수업이 회원 화면에서 대부분 안 보인다"는 보고의 실제 원인이었던 fetchMonthData()의
  PostgREST 응답 행 수 제한 문제 수정 검증.

  원인: 원시 classes 쿼리(lib/reservations.ts, 수정 전)는 center_id 조건도 .range()/
  .limit()도 없이 "이 달의 모든 센터" 수업을 한 번에 가져온 뒤 클라이언트에서
  myMembershipCenters로 필터링했다. 그 전체 집계 행 수가 Supabase 프로젝트의 PostgREST
  기본 응답 행 수 제한을 넘으면 start_time 오름차순 정렬 특성상 월 후반부 수업이 통째로
  잘렸다 — 진단 테스트로 실측 확인(1200개 중 1000개만 반환, truncated: true, 마지막
  반환 행이 월말이 아니라 그 달 25일). 관리자용 fetchClasses(lib/classes.ts)는
  center_id로 이미 좁혀 조회해 이 문제에 걸리지 않았다 — 이게 "관리자 화면엔 정상
  표시, 회원 화면만 일부 누락"의 실제 원인이었다.

  수정: fetchMonthData()가 이제 classes 쿼리 자체를 .in("center_id", 회원의 활성 수강권
  보유 센터)로 좁히고, .range()로 페이지 단위 반복 조회한다. 이 테스트는 그 수정을 실제
  프로덕션 함수 fetchMonthData()를 그대로 호출해 검증한다 — 함수 내부를 재구현하지 않는다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { fetchMonthData } from "../../lib/reservations";
import { getKstMonthUtcRange } from "../../lib/kst";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  createTestMembership,
  type TestUser,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };

// 다른 테스트 파일과 겹치지 않는 전용 회귀 테스트용 월(먼 미래)
const YEAR = 2031;
const MONTH = 7; // 31일
// 내 센터(centerA)는 PostgREST 기본 응답 행 수 제한(1000)을 확실히 넘도록 1300개 생성 —
// .range() 페이지 반복 조회가 페이지 경계(999/1000/1001)에서 빠짐/중복 없이 이어붙는지도 검증.
const ROWS_A = 1300;
// 다른 센터(centerB)는 이 회원이 수강권이 없는 센터 — "다른 센터 수업 제외" 회귀 검증용.
// 총합(2000)도 여전히 PostgREST 제한을 넘기므로, 수정 전 방식(전체 조회 후 클라이언트
// 필터링)이었다면 이 경우에도 잘렸을 물량이다.
const ROWS_B = 700;
const TITLE_A = "ROWLIMIT-FIX-A-";
const TITLE_B = "ROWLIMIT-FIX-B-";

let managerA: TestUser;
let managerB: TestUser;
let centerAId: string;
let centerBId: string;
let origStatusA: string;
let origStatusB: string;

async function deleteFixtureRows() {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  await supabase.from("classes").delete().eq("center_id", centerAId).like("title", `${TITLE_A}%`);
  await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  await supabase.from("classes").delete().eq("center_id", centerBId).like("title", `${TITLE_B}%`);
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  centerBId = await getOrCreateOwnedTestCenter(managerB);

  const admin = getFixtureAdminClient();
  const { data: rowsStatus, error: statusErr } = await admin
    .from("centers").select("id, status").in("id", [centerAId, centerBId]);
  if (statusErr || !rowsStatus) throw new Error("센터 상태 조회 실패: " + statusErr?.message);
  origStatusA = rowsStatus.find((r: any) => r.id === centerAId)!.status;
  origStatusB = rowsStatus.find((r: any) => r.id === centerBId)!.status;

  // centerB를 승인 상태로 바꿔, "RLS라서 못 본다"가 아니라 "멤버십이 없어서 제외한다"는
  // fetchMonthData 자체의 필터를 정확히 검증한다(둘 다 승인돼도 안 보여야 진짜 회귀 검증).
  const { error: approveErr } = await admin.from("centers")
    .update({ status: "approved" }).in("id", [centerAId, centerBId]);
  if (approveErr) throw new Error("센터 승인 처리 실패(테스트용): " + approveErr.message);

  await deleteFixtureRows(); // 이전 실행이 중간에 실패해 남긴 행이 있으면 먼저 정리

  // managerA 본인 프로필로 centerA 수강권 보유(활성) — fetchMonthData(managerA.accountId)가
  // "이 회원"의 시점이 되게 함. centerB는 의도적으로 수강권을 만들지 않는다.
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  await createTestMembership(centerAId, managerA.profileId, { remainingCount: 999 });

  const { startUtcIso } = getKstMonthUtcRange(YEAR, MONTH);
  const anchor = new Date(startUtcIso).getTime();
  const spacingMs = 30 * 60 * 1000; // 30분 간격 — 1300개면 월초~월 중후반까지 고르게 분포

  const rowsA = Array.from({ length: ROWS_A }, (_, i) => {
    const start = new Date(anchor + i * spacingMs);
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    return {
      center_id: centerAId, title: `${TITLE_A}${i}`,
      start_time: start.toISOString(), end_time: end.toISOString(), capacity: 8,
    };
  });
  const { error: insAErr } = await supabase.from("classes").insert(rowsA);
  if (insAErr) throw new Error("centerA 대량 생성 실패: " + insAErr.message);

  await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  const rowsB = Array.from({ length: ROWS_B }, (_, i) => {
    const start = new Date(anchor + i * spacingMs + 15 * 60 * 1000); // A와 어긋나게 배치
    const end = new Date(start.getTime() + 10 * 60 * 1000);
    return {
      center_id: centerBId, title: `${TITLE_B}${i}`,
      start_time: start.toISOString(), end_time: end.toISOString(), capacity: 8,
    };
  });
  const { error: insBErr } = await supabase.from("classes").insert(rowsB);
  if (insBErr) throw new Error("centerB 대량 생성 실패: " + insBErr.message);
}, 60000);

afterAll(async () => {
  const errors: string[] = [];
  try { await deleteFixtureRows(); } catch (e: any) { errors.push(e.message); }
  try {
    const admin = getFixtureAdminClient();
    await admin.from("centers").update({ status: origStatusA }).eq("id", centerAId);
    await admin.from("centers").update({ status: origStatusB }).eq("id", centerBId);
  } catch (e: any) { errors.push(e.message); }
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 60000);

describe("classes 행 수 제한 회귀 테스트: fetchMonthData()가 PostgREST 기본 행 수 제한과 무관하게 정확하다", () => {
  it("내 센터(centerA)의 1300개 수업이 페이지 경계(999/1000/1001) 포함 전부 반환된다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const { classes } = await fetchMonthData(YEAR, MONTH, managerA.accountId);
    const titles = new Set(classes.map((c) => c.title));

    const report = {
      totalReturned: classes.length,
      expectedFromCenterA: ROWS_A,
      hasFirst: titles.has(`${TITLE_A}0`),
      hasIndex999: titles.has(`${TITLE_A}999`),
      hasIndex1000: titles.has(`${TITLE_A}1000`),
      hasIndex1001: titles.has(`${TITLE_A}1001`),
      hasLast: titles.has(`${TITLE_A}${ROWS_A - 1}`),
      anyFromCenterB: classes.some((c) => c.title.startsWith(TITLE_B)),
    };

    // 월초
    expect(titles.has(`${TITLE_A}0`), JSON.stringify(report)).toBe(true);
    // 페이지 경계 직전·직후(수정 전이었다면 정확히 이 부근에서 잘렸을 지점)
    expect(titles.has(`${TITLE_A}999`), JSON.stringify(report)).toBe(true);
    expect(titles.has(`${TITLE_A}1000`), JSON.stringify(report)).toBe(true);
    expect(titles.has(`${TITLE_A}1001`), JSON.stringify(report)).toBe(true);
    // 월말 쪽(1300번째, 마지막 행)
    expect(titles.has(`${TITLE_A}${ROWS_A - 1}`), JSON.stringify(report)).toBe(true);
    // centerA 수업 총 1300개가 전부 반환됨(중간에 안 잘림)
    expect(classes.filter((c) => c.title.startsWith(TITLE_A)).length, JSON.stringify(report)).toBe(ROWS_A);
  }, 30000);

  it("수강권이 없는 다른 센터(centerB)의 수업은 여전히 제외된다(둘 다 승인 상태여도)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const { classes } = await fetchMonthData(YEAR, MONTH, managerA.accountId);
    expect(classes.some((c) => c.title.startsWith(TITLE_B))).toBe(false);
  }, 30000);
});
