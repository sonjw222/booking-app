/*
  [진단 전용] "8/4 이후 수업이 회원 화면에서 대부분 안 보인다" 재조사 — 3차.

  이전 조사에서 배제된 것: month-boundary(UTC/KST) 버그 아님, classes RLS는 날짜 기준
  필터가 아님, lib/reservations.ts:113의 멤버십-센터 필터는 센터 단위 all-or-nothing이라
  "같은 센터 안에서 특정 날짜부터만" 빠지는 현재 증상(8/3~8/4는 보이고 8/9부터 안 보임,
  center_id 동일)을 설명하지 못함.

  이번에 검증하는 가설: fetchMonthData()의 원시 classes 쿼리(lib/reservations.ts:104-109)는
    - center_id 조건이 전혀 없이 "이 달의 모든 센터의 모든 수업"을 한 번에 조회하고
    - .range()/.limit()이 없다
  → Supabase 프로젝트의 PostgREST 기본 응답 행 수 제한에 걸리면, start_time 오름차순 정렬
  특성상 "월 후반부(늦은 날짜) 수업만 조용히 잘리는" 증상이 나타날 수 있다. 반면 관리자용
  fetchClasses()(lib/classes.ts:31-38)는 .eq("center_id", centerId)로 범위를 좁혀 조회하므로,
  센터 하나의 수업 수가 그 제한보다 적으면 잘리지 않는다.

  이 파일은 그 가설을 실측하기 위한 진단 테스트다. 운영 코드는 전혀 건드리지 않는다 —
  fetchMonthData()가 실제로 실행하는 것과 동일한 쿼리 형태(select/gte/lt/order)를
  { count: "exact" }만 추가해 그대로 재현한 뒤, 실제 반환된 행 수(data.length)와 서버가
  집계한 전체 일치 행 수(count)를 비교한다. 원인이 확인되면 이 파일은 별도 지시에 따라
  정식 회귀 테스트로 전환하거나 삭제한다(diagnose-month-boundary.test.ts 때와 동일한 절차).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { getKstMonthUtcRange } from "../../lib/kst";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  type TestUser,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };
const USER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };

// 다른 테스트 파일과 절대 겹치지 않는 전용 진단용 월(먼 미래) — 이 달의 총 행 수를
// 우리가 직접 통제해서 "몇 개를 넣었더니 몇 개가 돌아왔는지"를 정확히 측정하기 위함.
const DIAG_YEAR = 2031;
const DIAG_MONTH = 6; // 30일 → 600개를 72분 간격으로 깔면 정확히 한 달을 채움
const ROWS_PER_CENTER = 600;
const TITLE_PREFIX_A = "ROWLIMIT-DIAG-A-";
const TITLE_PREFIX_B = "ROWLIMIT-DIAG-B-";

let managerA: TestUser;
let managerB: TestUser;
let centerAId: string;
let centerBId: string;
let origStatusA: string;
let origStatusB: string;

async function deleteDiagRows() {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  await supabase.from("classes").delete().eq("center_id", centerAId).like("title", `${TITLE_PREFIX_A}%`);
  await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  await supabase.from("classes").delete().eq("center_id", centerBId).like("title", `${TITLE_PREFIX_B}%`);
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

  // 실제 회원이 겪는 것과 동일한 RLS 경로("승인된 센터만 조회")로 진단하기 위해, 이 진단
  // 동안만 두 센터를 승인 상태로 바꾼다 — afterAll에서 반드시 원래 상태로 되돌린다.
  const { error: approveErr } = await admin.from("centers")
    .update({ status: "approved" }).in("id", [centerAId, centerBId]);
  if (approveErr) throw new Error("센터 승인 처리 실패(진단용): " + approveErr.message);

  // 혹시 이전 실행이 중간에 실패해 남겨둔 진단용 행이 있으면 먼저 정리(중복 누적 방지)
  await deleteDiagRows();

  const { startUtcIso } = getKstMonthUtcRange(DIAG_YEAR, DIAG_MONTH);
  const anchor = new Date(startUtcIso).getTime();
  const spacingMs = 72 * 60 * 1000; // 72분 간격 × 600 = 정확히 30일(6월)

  const rowsA = Array.from({ length: ROWS_PER_CENTER }, (_, i) => {
    const start = new Date(anchor + i * spacingMs);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    return {
      center_id: centerAId,
      title: `${TITLE_PREFIX_A}${i}`,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      capacity: 8,
    };
  });
  const rowsB = Array.from({ length: ROWS_PER_CENTER }, (_, i) => {
    // centerA와 36분 어긋나게 배치해, 전체(unscoped) 조회 시 start_time 정렬 결과가
    // 두 센터의 행이 서로 섞여서 나오게 한다(한쪽 센터가 통째로 먼저/나중에 몰리지 않도록).
    const start = new Date(anchor + i * spacingMs + 36 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    return {
      center_id: centerBId,
      title: `${TITLE_PREFIX_B}${i}`,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      capacity: 8,
    };
  });

  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const { error: insAErr } = await supabase.from("classes").insert(rowsA);
  if (insAErr) throw new Error("centerA 진단용 수업 대량 생성 실패: " + insAErr.message);

  await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  const { error: insBErr } = await supabase.from("classes").insert(rowsB);
  if (insBErr) throw new Error("centerB 진단용 수업 대량 생성 실패: " + insBErr.message);
}, 60000);

afterAll(async () => {
  const errors: string[] = [];
  try { await deleteDiagRows(); } catch (e: any) { errors.push(e.message); }
  try {
    const admin = getFixtureAdminClient();
    await admin.from("centers").update({ status: origStatusA }).eq("id", centerAId);
    await admin.from("centers").update({ status: origStatusB }).eq("id", centerBId);
  } catch (e: any) { errors.push(e.message); }
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 60000);

describe("[진단] classes 원시 쿼리의 PostgREST 응답 행 수 제한 실측", () => {
  it(
    "회원과 동일한 RLS 경로(승인된 센터)로, 무제한 집계(count:exact) vs 실제 반환 행 수를 비교한다",
    async () => {
      await switchToTestUser(USER_A.email, USER_A.password);
      const { startUtcIso, endUtcIso } = getKstMonthUtcRange(DIAG_YEAR, DIAG_MONTH);

      // fetchMonthData()의 원시 쿼리(lib/reservations.ts:104-109)와 완전히 동일한 형태 +
      // { count: "exact" }만 추가 — 운영 코드는 건드리지 않고 그 쿼리를 그대로 재현한다.
      const unscoped = await supabase
        .from("classes")
        .select("id, center_id, title, start_time, end_time, capacity, allow_goods, class_format, centers(id, name, categories)", { count: "exact" })
        .gte("start_time", startUtcIso)
        .lt("start_time", endUtcIso)
        .order("start_time");
      if (unscoped.error) throw new Error("unscoped 쿼리 실패: " + unscoped.error.message);

      // 관리자용 fetchClasses()(lib/classes.ts:31-38)와 동일하게 center_id로 좁힌 버전
      const scopedA = await supabase
        .from("classes")
        .select("id, center_id, title, start_time", { count: "exact" })
        .eq("center_id", centerAId)
        .gte("start_time", startUtcIso)
        .lt("start_time", endUtcIso)
        .order("start_time");
      if (scopedA.error) throw new Error("centerA 스코프 쿼리 실패: " + scopedA.error.message);

      const scopedB = await supabase
        .from("classes")
        .select("id, center_id, title, start_time", { count: "exact" })
        .eq("center_id", centerBId)
        .gte("start_time", startUtcIso)
        .lt("start_time", endUtcIso)
        .order("start_time");
      if (scopedB.error) throw new Error("centerB 스코프 쿼리 실패: " + scopedB.error.message);

      const data = unscoped.data ?? [];
      const report = {
        insertedTotal: ROWS_PER_CENTER * 2,
        insertedPerCenter: ROWS_PER_CENTER,
        unscoped: {
          exactCountFromServer: unscoped.count,
          actualReturnedRows: data.length,
          truncated: (unscoped.count ?? 0) > data.length,
          firstReturnedStartTime: data[0]?.start_time ?? null,
          lastReturnedStartTime: data[data.length - 1]?.start_time ?? null,
        },
        scopedCenterA: {
          exactCountFromServer: scopedA.count,
          actualReturnedRows: (scopedA.data ?? []).length,
          truncated: (scopedA.count ?? 0) > (scopedA.data ?? []).length,
        },
        scopedCenterB: {
          exactCountFromServer: scopedB.count,
          actualReturnedRows: (scopedB.data ?? []).length,
          truncated: (scopedB.count ?? 0) > (scopedB.data ?? []).length,
        },
      };
      // eslint-disable-next-line no-console
      console.log("[ROWLIMIT-DIAG] " + JSON.stringify(report, null, 2));

      // 데이터가 실제로 의도한 대로 생성됐는지에 대한 최소한의 위생 점검(행 제한 가설 자체에
      // 대한 단정은 하지 않는다 — 위 콘솔 출력이 이번 진단의 실제 결론 자료).
      expect(unscoped.count, JSON.stringify(report)).toBe(ROWS_PER_CENTER * 2);
      expect(scopedA.count, JSON.stringify(report)).toBe(ROWS_PER_CENTER);
      expect(scopedB.count, JSON.stringify(report)).toBe(ROWS_PER_CENTER);
    },
    30000
  );
});
