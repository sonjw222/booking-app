/*
  Archived-backlog cross-check(2026-09-19)에서 발견된 실제 버그의 회귀 테스트.

  fetchPoints()(lib/sales.ts)가 예전엔 point_transactions를 오래된 순으로 정렬한 뒤
  .limit(300)만 걸어서, 센터 누적 포인트 거래가 300건을 넘으면 오래된 300건만 가져오고
  그 뒤 모든 거래(가장 최근 거래 포함)가 조회 자체에서 통째로 빠졌다 — 화면에 최신
  내역이 안 보이는 것은 물론, 남은 300건만으로 누적 잔액(balanceAfter)을 계산해 잔액
  자체도 틀리게 나왔다. lib/classes.ts의 fetchClasses() 등이 이미 쓰는 .range() 페이지
  단위 반복 조회(PAGE_SIZE=1000)로 고쳤다.

  이 테스트는 PAGE_SIZE(1000) 경계를 실제로 넘는 1,050건을 한 번에 삽입해, 예전 버그가
  잘라내던 300건 선은 물론 새 코드의 페이지 경계(1000건)까지 실제로 넘어서도 전부
  빠짐없이 돌아오는지 확인한다. 절대 잔액값에 의존하지 않고(이 센터는 다른 파일들이
  공유하는 통합테스트센터라 사전 포인트 내역이 있을 수 있음), 이번에 삽입한 태그된
  거래들끼리의 상대적 balanceAfter 증가폭(+1씩)만 검증한다 — 사전 데이터가 몇 건이든
  항상 성립하는 불변식이라 안전하다.
*/
import { afterAll, describe, expect, it } from "vitest";
import { fetchPoints } from "../../../lib/sales";
import { getOrCreateOwnedTestCenter, getFixtureAdminClient } from "../setup";
import { managerA as loginManagerA, memberA as loginMemberA } from "./actors";
import { runScenario } from "./reporter";

function newRunId(): string {
  return `qa_points_pg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe("포인트 내역 페이지네이션 버그 회귀 — fetchPoints()가 1,000건 경계를 넘겨도 전부 반환", () => {
  const reasonTag = newRunId();

  afterAll(async () => {
    const admin = getFixtureAdminClient();
    await admin.from("point_transactions").delete().eq("reason", reasonTag);
  }, 30000);

  it("1,050건을 삽입해도 fetchPoints()가 전부 반환하고, balanceAfter가 삽입 순서대로 +1씩 정확히 누적된다", async () => {
    const managerA = await loginManagerA();
    const centerId = await getOrCreateOwnedTestCenter(managerA);
    const memberA = await loginMemberA();
    const admin = getFixtureAdminClient();

    const N = 1050;
    const base = Date.now();
    const rows = Array.from({ length: N }, (_, i) => ({
      center_id: centerId,
      profile_id: memberA.profileId,
      amount: 1,
      reason: reasonTag,
      // 순서를 확정적으로 만들기 위해 1ms씩 명시적으로 증가시킨 타임스탬프 사용.
      created_at: new Date(base + i).toISOString(),
    }));

    await runScenario("SCN-POINTS-PG-01", ["manager(centerA)"], async (assertions) => {
      // 1,050건을 한 번에 bulk insert(개별 round-trip 1,050번 대신).
      const { error: insertErr } = await admin.from("point_transactions").insert(rows);
      if (insertErr) throw new Error(`포인트 거래 대량 삽입 실패: ${insertErr.message}`);

      const result = await fetchPoints(centerId);
      // fetchPoints()는 최신순(내림차순)으로 반환 — 시간순으로 되돌리기 위해 뒤집는다.
      const tagged = result.filter((r) => r.reason === reasonTag).slice().reverse();

      assertions.push({
        name: `삽입한 ${N}건이 전부 반환됨(예전엔 오래된 300건만 반환되고 나머지는 조회에서 통째로 누락됐음)`,
        passed: tagged.length === N,
        detail: `반환된 태그 행 수: ${tagged.length} / 기대: ${N}`,
      });
      expect(tagged.length).toBe(N);

      let allSequential = true;
      for (let i = 1; i < tagged.length; i++) {
        if (tagged[i].balanceAfter !== tagged[i - 1].balanceAfter + 1) {
          allSequential = false;
          break;
        }
      }
      assertions.push({
        name: "삽입 순서대로 balanceAfter가 +1씩 정확히 누적됨(잘려나간 거래 없이 전체가 순서대로 집계됨)",
        passed: allSequential,
        detail: `first balanceAfter=${tagged[0]?.balanceAfter}, last balanceAfter=${tagged[tagged.length - 1]?.balanceAfter}`,
      });
      expect(allSequential).toBe(true);

      // 가장 마지막(1,050번째)에 넣은 거래가 실제로 반환됐는지 — 예전 버그(오래된 순
      // 300건만 가져옴)였다면 이 거래는 조회 결과에 아예 없었을 것.
      const lastBalance = tagged[tagged.length - 1]?.balanceAfter;
      const firstBalance = tagged[0]?.balanceAfter;
      assertions.push({
        name: "가장 마지막(1,050번째)에 넣은 거래가 결과에 포함됨(잔액이 정확히 N-1만큼 더 큼)",
        passed: lastBalance === firstBalance + (N - 1),
        detail: `firstBalance=${firstBalance}, lastBalance=${lastBalance}, N=${N}`,
      });
      expect(lastBalance).toBe(firstBalance + (N - 1));
    });
  }, 60000);
});
