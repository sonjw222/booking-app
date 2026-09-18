/*
  릴리스 폴리시 배치 8차(2026-09-17/18) — 추가 시나리오(위치 기반 내 주변 센터 검색) 회귀
  가드. 이 worktree 기준으로는 반경 필터가 미구현이었어서(lib/home.ts 상단 NEARBY_RADIUS_KM
  주석 참고) 최소 구현을 추가했다 — 병렬로 진행 중인 다른 세션(Business Logic Fix Batch)이
  같은 영역을 더 정교하게 다룰 수 있어 merge 시 조정이 필요할 수 있다(최종 보고 참고).

  haversineKm()은 순수 함수라 네트워크 없이 서울/제주/부산/강원 같은 실제로 먼 좌표
  쌍으로 정확도와 경계값을 검증할 수 있다.
*/
import { describe, expect, it } from "vitest";
import { haversineKm, NEARBY_RADIUS_KM } from "../../lib/home";

// 대략적인 실제 좌표(추가 시나리오가 예시로 든 지역들)
const SEOUL = { lat: 37.5665, lng: 126.978 };
const GANGWON_CHUNCHEON = { lat: 37.8813, lng: 127.7298 };
const JEJU = { lat: 33.4996, lng: 126.5312 };
const BUSAN = { lat: 35.1796, lng: 129.0756 };

describe("haversineKm", () => {
  it("같은 좌표는 거리 0", () => {
    expect(haversineKm(SEOUL.lat, SEOUL.lng, SEOUL.lat, SEOUL.lng)).toBeCloseTo(0, 3);
  });

  it("서울-부산은 NEARBY_RADIUS_KM(20km)보다 훨씬 멀다(약 325km)", () => {
    const d = haversineKm(SEOUL.lat, SEOUL.lng, BUSAN.lat, BUSAN.lng);
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(350);
  });

  it("서울-제주는 반경보다 훨씬 멀다(약 450km 이상)", () => {
    const d = haversineKm(SEOUL.lat, SEOUL.lng, JEJU.lat, JEJU.lng);
    expect(d).toBeGreaterThan(400);
  });

  it("서울-춘천(강원)도 반경(20km)보다 멀다(약 70km대)", () => {
    const d = haversineKm(SEOUL.lat, SEOUL.lng, GANGWON_CHUNCHEON.lat, GANGWON_CHUNCHEON.lng);
    expect(d).toBeGreaterThan(NEARBY_RADIUS_KM);
  });

  it("반경 경계값 — 반경 바로 안쪽은 포함, 바로 바깥은 제외되는 판정 기준(<=)과 일치", () => {
    // 위도 1도 ≈ 111km → 20km는 대략 0.18도. 서울 기준 북쪽으로 살짝 이동한 두 지점으로
    // "반경 안" / "반경 밖" 경계를 만든다.
    const justInside = { lat: SEOUL.lat + 0.15, lng: SEOUL.lng }; // 대략 16~17km
    const justOutside = { lat: SEOUL.lat + 0.30, lng: SEOUL.lng }; // 대략 33km
    const dIn = haversineKm(SEOUL.lat, SEOUL.lng, justInside.lat, justInside.lng);
    const dOut = haversineKm(SEOUL.lat, SEOUL.lng, justOutside.lat, justOutside.lng);
    expect(dIn).toBeLessThanOrEqual(NEARBY_RADIUS_KM);
    expect(dOut).toBeGreaterThan(NEARBY_RADIUS_KM);
  });
});
