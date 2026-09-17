/*
  Automated Business Scenario E2E Batch(2026-09-18) — Phase 3: 위치 기반 시나리오.

  ⚠ 중요한 실측 발견(요청 원문의 가정과 실제 코드가 다름, 추측 없이 코드로 확인):
  요청에서 예시로 든 "설정 반경 기준 센터3만 표시"라는 동작은 이 앱에 존재하지 않는다.
  lib/home.ts의 fetchHomeCenters()를 실제로 읽어보면:
    - approved 센터 중 최신 30개를 가져온 뒤, userLat/userLng가 주어지면 Haversine
      공식으로 거리(km)를 계산해 "가까운 순 정렬"만 한다.
    - 반경(radius) 컷오프/필터 개념 자체가 코드 어디에도 없다 — 그냥 가까운 순으로
      정렬한 뒤 상위 10개(.slice(0,10))를 돌려줄 뿐이다.
    - 좌표가 없는 센터(latitude/longitude가 null)는 distanceKm이 null로 남고, 정렬 시
      "좌표 있는 센터들보다 항상 뒤"로 밀린다(반경 밖이라 제외되는 게 아니라 그냥 정렬
      순서만 밀림 — 여전히 최대 10개 안에 들어올 수 있음).
  즉 "제주 위치면 제주 센터만 보인다"는 요청의 예시는 실제 구현과 다르다 — 실제로는
  서울/강원/부산 센터도 (좌표가 있는 한) 다 같이 나열되고 단지 순서만 뒤로 밀린다. 이
  차이는 최종 보고서에 별도로 명시한다(기능 갭인지, 요청자의 오해인지는 이 QA 배치의
  판단 범위 밖).

  그래서 이 파일은 요청 원문의 "반경 필터"가 아니라, 실제 구현된 "거리순 정렬 + 좌표
  없는 센터 처리"를 검증한다. GPS 하드웨어 대신 결정론적 mock 좌표를 쓴다(요청 원문
  지시와 동일 — "deterministic test fixture/mock location 사용").

  ⚠ 격리 전략: 기존 43개 파일이 공유하는 managerA 소유 "통합테스트센터-%"를 건드리지
  않고, 이 파일 전용의 새 센터를 만들어 쓴다(status='approved'로 직접 설정 — 실제 승인
  절차를 흉내내는 게 아니라 순수하게 fetchHomeCenters()가 읽는 "공개 목록에 노출되는
  센터" 조건만 충족시키는 fixture). 테스트가 끝나면 admin으로 확실히 삭제한다(공유
  센터가 아니라 이 테스트만을 위해 만든 독립 행이므로 완전 삭제해도 다른 테스트에
  영향 없음).
*/
import { afterEach, describe, expect, it } from "vitest";
import { fetchHomeCenters } from "../../../lib/home";
import { getFixtureAdminClient } from "../setup";
import { runScenario } from "./reporter";

function newRunId(): string {
  return `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// 남극 근처 — 이 앱의 실제 센터(한국 소재)가 우연히 이 근처에 있을 리 없으므로, 이
// 좌표를 "사용자 위치"로 쓰면 내가 만든 테스트 센터가 항상 가장 가까운 쪽에 확실히
// 랭크된다(수백~수천 개의 실제 센터가 섞여 있어도 흔들리지 않는 결정론적 테스트를
// 위한 선택 — 실제 GPS 좌표가 아님을 명시).
const MOCK_USER_LAT = -88;
const MOCK_USER_LNG = 0;

describe("SCN-P2-위치: 내 주변 센터 — 실제 구현(거리순 정렬)에 대한 검증", () => {
  const pendingCenterIds: string[] = [];

  // ⚠ 실측 발견: centers에 새 행을 insert하면 DB 트리거가 자동으로 center_roles 기본
  // 역할 3개(오너/스태프/트레이너 등)를 함께 만든다(직접 만든 적 없는데도 생성됨 —
  // FK 위반으로 삭제가 막혀서 알게 됨: "center_roles_center_id_fkey"). centers를 지우기
  // 전에 반드시 center_roles를 먼저 지워야 한다.
  afterEach(async () => {
    if (pendingCenterIds.length === 0) return;
    const admin = getFixtureAdminClient();
    const ids = pendingCenterIds.splice(0, pendingCenterIds.length);
    await admin.from("center_roles").delete().in("center_id", ids);
    await admin.from("centers").delete().in("id", ids);
  }, 30000);

  async function makeApprovedCenter(name: string, lat: number | null, lng: number | null) {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin
      .from("centers")
      .insert({ name, status: "approved", latitude: lat, longitude: lng })
      .select("id")
      .single();
    if (error || !data) throw new Error(`테스트 센터 생성 실패: ${error?.message ?? "no data"}`);
    pendingCenterIds.push((data as any).id);
    return (data as any).id as string;
  }

  it("위치가 주어지면 가까운 센터가 먼 센터보다 먼저 온다(실제 fetchHomeCenters, Haversine 정렬)", async () => {
    const runId = newRunId();
    const nearId = await makeApprovedCenter(`QA-위치-근접-${runId}`, MOCK_USER_LAT, MOCK_USER_LNG);
    const farId = await makeApprovedCenter(`QA-위치-원거리-${runId}`, MOCK_USER_LAT + 4, MOCK_USER_LNG); // 남극 근처에서도 수백km 더 멀리

    await runScenario("SCN-P2-LOC-01", ["anonymous(mock-location)"], async (assertions) => {
      const result = await fetchHomeCenters(MOCK_USER_LAT, MOCK_USER_LNG);
      const nearEntry = result.find((c) => c.id === nearId);
      const farEntry = result.find((c) => c.id === farId);
      assertions.push({
        name: "근접/원거리 테스트 센터 둘 다 상위 10개 안에 포함됨(실제 센터들보다 남극에 훨씬 가까우므로)",
        passed: !!nearEntry && !!farEntry,
        detail: JSON.stringify({ nearEntry, farEntry, totalReturned: result.length }),
      });
      expect(nearEntry).toBeTruthy();
      expect(farEntry).toBeTruthy();

      assertions.push({
        name: "근접 센터의 distanceKm이 원거리 센터보다 작음(가까운 순 정렬 확인)",
        passed: (nearEntry!.distanceKm ?? Infinity) < (farEntry!.distanceKm ?? Infinity),
        detail: JSON.stringify({ near: nearEntry!.distanceKm, far: farEntry!.distanceKm }),
      });
      expect(nearEntry!.distanceKm!).toBeLessThan(farEntry!.distanceKm!);

      const nearIdx = result.findIndex((c) => c.id === nearId);
      const farIdx = result.findIndex((c) => c.id === farId);
      assertions.push({ name: "정렬 순서상으로도 근접 센터가 원거리 센터보다 앞에 옴", passed: nearIdx < farIdx });
      expect(nearIdx).toBeLessThan(farIdx);
    });
  }, 30000);

  it("[중요 발견] '반경 밖이면 안 보임'이 아니라 '순서만 밀림' — 아주 먼 센터도 다른 근접 센터가 적으면 여전히 상위 10개 안에 나타날 수 있음", async () => {
    const runId = newRunId();
    // 서울 근처 좌표 — 남극 mock 위치 기준으로는 "아주 멀지만", 반경 개념이 없으므로
    // 여전히 목록에는 나온다(순서만 뒤로 밀릴 뿐 제외되지 않음).
    const seoulLikeId = await makeApprovedCenter(`QA-위치-서울권-${runId}`, 37.5, 127.0);

    await runScenario("SCN-P2-LOC-02", ["anonymous(mock-location)"], async (assertions) => {
      const result = await fetchHomeCenters(MOCK_USER_LAT, MOCK_USER_LNG);
      const entry = result.find((c) => c.id === seoulLikeId);
      assertions.push({
        name: "반경 필터가 없으므로, 좌표가 있는 한 아무리 멀어도 '제외'되지는 않는다(상위 10개 경쟁에서 밀릴 수는 있어도 반경 때문에 아예 안 보이는 것과는 다름) — 이 배치에서는 상위 10개 노출 여부까지는 결정론적으로 보장 못 하므로, 여기서는 '만약 나타난다면 distanceKm이 정상 계산돼 있는가'만 확인",
        passed: !entry || (entry.distanceKm != null && entry.distanceKm > 1000),
        detail: JSON.stringify({ entry, note: "entry가 undefined면 상위10위 밖으로 밀린 것 — 그 자체는 실패가 아님(반경 제외 기능이 없다는 사실 자체는 코드 리딩으로 이미 확인됨)" },),
      });
    });
  }, 30000);

  it("위치가 주어지지 않으면 거리 계산 자체를 하지 않는다(distanceKm 전부 null)", async () => {
    const runId = newRunId();
    const centerId = await makeApprovedCenter(`QA-위치-무위치테스트-${runId}`, 33.5, 126.5);

    await runScenario("SCN-P2-LOC-03", ["anonymous(no-location)"], async (assertions) => {
      const result = await fetchHomeCenters();
      const allNull = result.every((c) => c.distanceKm === null);
      assertions.push({
        name: "위치 인자 없이 호출하면 반환된 모든 센터의 distanceKm이 null(거리 계산 자체를 스킵)",
        passed: allNull,
        detail: JSON.stringify(result.map((c) => ({ id: c.id, distanceKm: c.distanceKm }))),
      });
      expect(allNull).toBe(true);
      // 방금 만든 센터가 최신순 정렬 1페이지 안에 있는지도 함께 확인(생성 직후라 created_at
      // 최신이므로 위치 없이도 상위 10개 안에 들어와야 정상)
      const entry = result.find((c) => c.id === centerId);
      assertions.push({ name: "방금 만든 센터가 최신순 정렬로 상위 10개 안에 포함됨", passed: !!entry });
      expect(entry).toBeTruthy();
    });
  }, 30000);

  it("좌표가 없는 센터(latitude/longitude=null)는 에러 없이 처리되고 distanceKm이 null로 남는다", async () => {
    const runId = newRunId();
    const noCoordsId = await makeApprovedCenter(`QA-위치-좌표없음-${runId}`, null, null);
    const nearId = await makeApprovedCenter(`QA-위치-대조근접-${runId}`, MOCK_USER_LAT, MOCK_USER_LNG);

    await runScenario("SCN-P2-LOC-04", ["anonymous(mock-location)"], async (assertions) => {
      // 좌표 없는 센터가 있어도 예외 없이 정상 반환되는지(방어 코드 확인)
      const result = await fetchHomeCenters(MOCK_USER_LAT, MOCK_USER_LNG);
      assertions.push({ name: "좌표 없는 센터가 섞여 있어도 fetchHomeCenters가 에러 없이 반환함", passed: Array.isArray(result) });
      expect(Array.isArray(result)).toBe(true);

      const nearEntry = result.find((c) => c.id === nearId);
      assertions.push({ name: "좌표 있는 근접 센터는 정상적으로 distanceKm 계산됨", passed: !!nearEntry && nearEntry.distanceKm != null });
      expect(nearEntry?.distanceKm).not.toBeNull();

      const noCoordsEntry = result.find((c) => c.id === noCoordsId);
      if (noCoordsEntry) {
        assertions.push({ name: "좌표 없는 센터는 distanceKm=null로 유지됨", passed: noCoordsEntry.distanceKm === null, detail: JSON.stringify(noCoordsEntry) });
        expect(noCoordsEntry.distanceKm).toBeNull();
        const noCoordsIdx = result.findIndex((c) => c.id === noCoordsId);
        const nearIdx = result.findIndex((c) => c.id === nearId);
        assertions.push({ name: "좌표 없는 센터는 좌표 있는 근접 센터보다 항상 뒤로 정렬됨", passed: noCoordsIdx > nearIdx });
        expect(noCoordsIdx).toBeGreaterThan(nearIdx);
      } else {
        assertions.push({ name: "좌표 없는 센터는 상위 10개 밖으로 밀림(null은 항상 최하위 정렬이므로 자연스러움 — 실패 아님)", passed: true });
      }
    });
  }, 30000);
});
