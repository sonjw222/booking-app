/*
  MWHABIT Business Logic Fix Batch(2026-09-18) — 위치 반경 필터 regression test.

  이전 버전(Automated Business Scenario E2E Phase 3)은 "BUG reproduction" 성격으로
  작성됐다 — 당시 lib/home.ts의 fetchHomeCenters()에는 거리순 정렬만 있고 반경 컷오프가
  없어서 요청 원문의 "반경 내 센터만 표시" 기대와 실제 코드가 달랐다. 이번 Fix Batch에서
  lib/home.ts에 NEARBY_RADIUS_KM 기반 반경 필터를 실제로 구현했으므로, 이 파일은 이제
  "expected behavior PASS" regression test로 전환한다 — expectation을 약화해 버그를
  숨기지 않고, 실제 수정된 동작(반경 밖 제외)을 있는 그대로 검증한다.

  요청 원문의 정확한 fixture를 그대로 쓴다: 센터1 서울, 센터2 강원도, 센터3 제주도,
  센터4 부산 — 회원 위치=제주도 → 제주 반경 내 센터3만 표시, 나머지 제외.

  ⚠ 격리 전략(기존과 동일): 기존 43개 파일이 공유하는 managerA 소유
  "통합테스트센터-%"를 건드리지 않고, 이 파일 전용의 새 센터를 만들어 쓴다
  (status='approved'로 직접 설정). centers insert 시 DB 트리거가 center_roles를
  자동 생성하므로, 정리 시 center_roles를 먼저 지운다(실측 발견, Phase 3에서 확인).
*/
import { afterEach, describe, expect, it } from "vitest";
import { fetchHomeCenters, NEARBY_RADIUS_KM } from "../../../lib/home";
import { getFixtureAdminClient } from "../setup";
import { runScenario } from "./reporter";

function newRunId(): string {
  return `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// 실제 도시 좌표(대략치) — 요청 원문의 "서울/강원도/제주도/부산" fixture 그대로.
const SEOUL = { lat: 37.5665, lng: 126.978 };
const GANGWON = { lat: 37.8813, lng: 127.7298 }; // 춘천 인근
const JEJU = { lat: 33.4996, lng: 126.5312 };
const BUSAN = { lat: 35.1796, lng: 129.0756 };

describe("위치 기반 '내 주변 센터' 반경 필터(수정 후 regression)", () => {
  const pendingCenterIds: string[] = [];

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

  it("요청 원문 fixture 그대로: 회원 위치=제주 → 제주 센터만 표시, 서울/강원/부산 제외", async () => {
    const runId = newRunId();
    const seoulId = await makeApprovedCenter(`QA-반경-서울-${runId}`, SEOUL.lat, SEOUL.lng);
    const gangwonId = await makeApprovedCenter(`QA-반경-강원-${runId}`, GANGWON.lat, GANGWON.lng);
    const jejuId = await makeApprovedCenter(`QA-반경-제주-${runId}`, JEJU.lat, JEJU.lng);
    const busanId = await makeApprovedCenter(`QA-반경-부산-${runId}`, BUSAN.lat, BUSAN.lng);

    await runScenario("SCN-LOC-FIX-01", ["anonymous(location=jeju)"], async (assertions) => {
      const result = await fetchHomeCenters(JEJU.lat, JEJU.lng);
      const ids = result.map((c) => c.id);

      assertions.push({ name: "제주 센터는 포함됨", passed: ids.includes(jejuId), detail: JSON.stringify(ids) });
      expect(ids).toContain(jejuId);

      assertions.push({
        name: "서울/강원/부산 센터는 반경(20km) 밖이라 전부 제외됨",
        passed: !ids.includes(seoulId) && !ids.includes(gangwonId) && !ids.includes(busanId),
        detail: JSON.stringify({ ids, seoulId, gangwonId, busanId }),
      });
      expect(ids).not.toContain(seoulId);
      expect(ids).not.toContain(gangwonId);
      expect(ids).not.toContain(busanId);

      const jejuEntry = result.find((c) => c.id === jejuId)!;
      assertions.push({ name: "제주 센터의 distanceKm은 반경 이내", passed: jejuEntry.distanceKm! <= NEARBY_RADIUS_KM });
      expect(jejuEntry.distanceKm!).toBeLessThanOrEqual(NEARBY_RADIUS_KM);
    });
  }, 30000);

  it("회원 위치=서울 → 서울 센터만 표시", async () => {
    const runId = newRunId();
    const seoulId = await makeApprovedCenter(`QA-반경-서울2-${runId}`, SEOUL.lat, SEOUL.lng);
    const busanId = await makeApprovedCenter(`QA-반경-부산2-${runId}`, BUSAN.lat, BUSAN.lng);

    await runScenario("SCN-LOC-FIX-02", ["anonymous(location=seoul)"], async (assertions) => {
      const result = await fetchHomeCenters(SEOUL.lat, SEOUL.lng);
      const ids = result.map((c) => c.id);
      assertions.push({ name: "서울 센터 포함, 부산 센터 제외", passed: ids.includes(seoulId) && !ids.includes(busanId), detail: JSON.stringify(ids) });
      expect(ids).toContain(seoulId);
      expect(ids).not.toContain(busanId);
    });
  }, 30000);

  it("회원 위치=부산 → 부산 센터만 표시", async () => {
    const runId = newRunId();
    const busanId = await makeApprovedCenter(`QA-반경-부산3-${runId}`, BUSAN.lat, BUSAN.lng);
    const seoulId = await makeApprovedCenter(`QA-반경-서울3-${runId}`, SEOUL.lat, SEOUL.lng);

    await runScenario("SCN-LOC-FIX-03", ["anonymous(location=busan)"], async (assertions) => {
      const result = await fetchHomeCenters(BUSAN.lat, BUSAN.lng);
      const ids = result.map((c) => c.id);
      assertions.push({ name: "부산 센터 포함, 서울 센터 제외", passed: ids.includes(busanId) && !ids.includes(seoulId), detail: JSON.stringify(ids) });
      expect(ids).toContain(busanId);
      expect(ids).not.toContain(seoulId);
    });
  }, 30000);

  it("반경 경계값: 반경 바로 안쪽(~18.9km)은 포함, 바로 바깥(~21.1km)은 제외", async () => {
    const runId = newRunId();
    // 위도 1도 ≈ 111.32km(경도는 안 건드려 순수 위도차만으로 예측 가능한 거리를 만듦).
    const justInside = JEJU.lat + 18.9 / 111.32; // ≈ 18.9km
    const justOutside = JEJU.lat + 21.1 / 111.32; // ≈ 21.1km
    const insideId = await makeApprovedCenter(`QA-반경-경계안-${runId}`, justInside, JEJU.lng);
    const outsideId = await makeApprovedCenter(`QA-반경-경계밖-${runId}`, justOutside, JEJU.lng);

    await runScenario("SCN-LOC-FIX-04", ["anonymous(location=jeju)"], async (assertions) => {
      const result = await fetchHomeCenters(JEJU.lat, JEJU.lng);
      const inside = result.find((c) => c.id === insideId);
      const outside = result.find((c) => c.id === outsideId);
      assertions.push({
        name: `반경(${NEARBY_RADIUS_KM}km) 바로 안쪽은 포함, 바로 바깥은 제외`,
        passed: !!inside && !outside,
        detail: JSON.stringify({ insideDistance: inside?.distanceKm, outsideFound: !!outside }),
      });
      expect(inside).toBeTruthy();
      expect(inside!.distanceKm!).toBeLessThanOrEqual(NEARBY_RADIUS_KM);
      expect(outside).toBeUndefined();
    });
  }, 30000);

  it("반경 안에 여러 센터가 있으면 거리 오름차순으로 정렬된다", async () => {
    const runId = newRunId();
    const nearId = await makeApprovedCenter(`QA-반경-근접-${runId}`, JEJU.lat + 2 / 111.32, JEJU.lng); // ~2km
    const midId = await makeApprovedCenter(`QA-반경-중간-${runId}`, JEJU.lat + 8 / 111.32, JEJU.lng); // ~8km
    const farId = await makeApprovedCenter(`QA-반경-원거리-${runId}`, JEJU.lat + 15 / 111.32, JEJU.lng); // ~15km

    await runScenario("SCN-LOC-FIX-05", ["anonymous(location=jeju)"], async (assertions) => {
      const result = await fetchHomeCenters(JEJU.lat, JEJU.lng);
      const nearIdx = result.findIndex((c) => c.id === nearId);
      const midIdx = result.findIndex((c) => c.id === midId);
      const farIdx = result.findIndex((c) => c.id === farId);
      assertions.push({
        name: "셋 다 반경 안에 포함되고 거리 오름차순으로 정렬됨",
        passed: nearIdx !== -1 && midIdx !== -1 && farIdx !== -1 && nearIdx < midIdx && midIdx < farIdx,
        detail: JSON.stringify({ nearIdx, midIdx, farIdx, distances: result.map((c) => ({ id: c.id, d: c.distanceKm })) }),
      });
      expect(nearIdx).toBeGreaterThanOrEqual(0);
      expect(nearIdx).toBeLessThan(midIdx);
      expect(midIdx).toBeLessThan(farIdx);
    });
  }, 30000);

  it("좌표가 없는 센터는 반경 안이어도 안전하게 제외된다(거리를 알 수 없으므로)", async () => {
    const runId = newRunId();
    const noCoordsId = await makeApprovedCenter(`QA-반경-좌표없음-${runId}`, null, null);
    const jejuId = await makeApprovedCenter(`QA-반경-대조-${runId}`, JEJU.lat, JEJU.lng);

    await runScenario("SCN-LOC-FIX-06", ["anonymous(location=jeju)"], async (assertions) => {
      const result = await fetchHomeCenters(JEJU.lat, JEJU.lng);
      const ids = result.map((c) => c.id);
      assertions.push({
        name: "좌표 없는 센터는 제외, 좌표 있는 제주 센터는 포함",
        passed: !ids.includes(noCoordsId) && ids.includes(jejuId),
        detail: JSON.stringify(ids),
      });
      expect(ids).not.toContain(noCoordsId);
      expect(ids).toContain(jejuId);
    });
  }, 30000);

  it("잘못된 좌표(범위 밖 숫자)를 가진 센터가 섞여 있어도 전체 조회는 실패하지 않고 그 센터만 제외된다", async () => {
    const runId = newRunId();
    // 위도/경도 유효 범위(-90~90 / -180~180)를 벗어난 방어적 케이스 — DB 컬럼
    // 자체는 numeric(9,6)이라 이런 값도 저장은 되므로, 애플리케이션 레벨에서
    // 반드시 걸러야 한다(schema.sql 확인).
    const invalidId = await makeApprovedCenter(`QA-반경-잘못된좌표-${runId}`, 999, 999);
    const jejuId = await makeApprovedCenter(`QA-반경-대조2-${runId}`, JEJU.lat, JEJU.lng);

    await runScenario("SCN-LOC-FIX-07", ["anonymous(location=jeju)"], async (assertions) => {
      let result: Awaited<ReturnType<typeof fetchHomeCenters>> = [];
      let threw = false;
      try {
        result = await fetchHomeCenters(JEJU.lat, JEJU.lng);
      } catch {
        threw = true;
      }
      assertions.push({ name: "잘못된 좌표가 섞여 있어도 전체 조회가 예외를 던지지 않음", passed: !threw });
      expect(threw).toBe(false);

      const ids = result.map((c) => c.id);
      assertions.push({
        name: "잘못된 좌표를 가진 센터는 결과에서 제외되고, 정상 센터는 그대로 포함됨",
        passed: !ids.includes(invalidId) && ids.includes(jejuId),
        detail: JSON.stringify(ids),
      });
      expect(ids).not.toContain(invalidId);
      expect(ids).toContain(jejuId);
    });
  }, 30000);

  it("위치 권한이 없으면(undefined) 기존 fallback UX 유지 — 반경 필터 없이 최신 승인순 그대로 반환", async () => {
    const runId = newRunId();
    const centerId = await makeApprovedCenter(`QA-반경-무위치-${runId}`, JEJU.lat, JEJU.lng);

    await runScenario("SCN-LOC-FIX-08", ["anonymous(no-permission)"], async (assertions) => {
      const result = await fetchHomeCenters();
      const allNull = result.every((c) => c.distanceKm === null);
      assertions.push({ name: "위치 없이 호출 시 distanceKm 전부 null(반경 필터 미적용, 기존 동작 유지)", passed: allNull });
      expect(allNull).toBe(true);
      const entry = result.find((c) => c.id === centerId);
      assertions.push({ name: "방금 만든 센터도 반경 필터 없이 그대로 포함됨(최신순)", passed: !!entry });
      expect(entry).toBeTruthy();
    });
  }, 30000);

  it("stale GPS 캐시 시뮬레이션: 이전 위치로 조회한 뒤 새 위치로 다시 조회하면 결과가 새 위치 기준으로 완전히 갱신된다", async () => {
    // fetchHomeCenters()는 그 자체로 상태를 갖지 않는 순수 함수다(내부 캐시/메모이제이션
    // 없음 — lib/home.ts 확인) — "stale GPS 캐시" 문제는 실제로는 호출자(app/page.tsx의
    // lastKnownPosition 모듈 캐시, Batch 7~QA에서 이미 확인된 브라우저 상태)의 몫이라
    // Shared(Layer A, Node 기반) 레이어에서 그 UI 캐시 자체를 재현할 수는 없다(기존
    // registry.ts의 SCN-P2-60류와 동일한 한계). 대신 이 테스트는 그 UI 캐시가 새 위치를
    // 받았을 때 실제로 새로고침되면 "함수 자체는 이전 호출 결과에 절대 고착되지 않는다"는
    // 전제 조건을 검증한다 — 제주 위치로 호출 → 서울 위치로 재호출 시 결과가 완전히
    // 달라지는지(제주 결과가 유령처럼 남지 않는지) 확인.
    const runId = newRunId();
    const jejuId = await makeApprovedCenter(`QA-반경-stale-제주-${runId}`, JEJU.lat, JEJU.lng);
    const seoulId = await makeApprovedCenter(`QA-반경-stale-서울-${runId}`, SEOUL.lat, SEOUL.lng);

    await runScenario("SCN-LOC-FIX-09", ["anonymous(location changes)"], async (assertions) => {
      const staleResult = await fetchHomeCenters(JEJU.lat, JEJU.lng);
      const staleIds = staleResult.map((c) => c.id);
      assertions.push({ name: "(이전) 제주 위치 조회 시 제주 센터 포함, 서울 센터 제외", passed: staleIds.includes(jejuId) && !staleIds.includes(seoulId) });
      expect(staleIds).toContain(jejuId);
      expect(staleIds).not.toContain(seoulId);

      const freshResult = await fetchHomeCenters(SEOUL.lat, SEOUL.lng);
      const freshIds = freshResult.map((c) => c.id);
      assertions.push({
        name: "(새 위치) 서울로 재조회하면 결과가 완전히 갱신됨 — 서울 센터 포함, 제주 센터는 더 이상 안 보임",
        passed: freshIds.includes(seoulId) && !freshIds.includes(jejuId),
        detail: JSON.stringify({ staleIds, freshIds }),
      });
      expect(freshIds).toContain(seoulId);
      expect(freshIds).not.toContain(jejuId);
    });
  }, 30000);
});
