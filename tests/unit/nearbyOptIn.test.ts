import { describe, expect, it } from "vitest";
import { computeSearchView } from "../../lib/searchView";
import { haversineKm, NEARBY_RADIUS_KM } from "../../lib/home";

const near = { latitude: 37.5665, longitude: 126.978 };
const far = { latitude: 35.1796, longitude: 129.0756 };
const missing = { latitude: null, longitude: null };
const input = {
  centers: [near, far, missing],
  classes: [],
  categories: [],
  scope: "centers" as const,
  todayOnly: false,
  today: "2026-10-30",
  position: { lat: near.latitude, lng: near.longitude },
  radiusKm: NEARBY_RADIUS_KM,
  distanceKm: haversineKm,
};

describe("내 주변 20km 검색 조건", () => {
  it("필터를 끄면 먼 센터와 좌표 없는 센터도 검색에 남는다", () => {
    const result = computeSearchView({ ...input, nearOnly: false });
    expect(result.centers).toEqual([near, far, missing]);
  });

  it("필터를 켜면 20km 밖과 좌표 없는 센터만 제외한다", () => {
    const result = computeSearchView({ ...input, nearOnly: true });
    expect(result.centers).toEqual([near]);
  });

  it("필터를 다시 끄면 제외된 센터가 복원된다", () => {
    const enabled = computeSearchView({ ...input, nearOnly: true });
    const disabled = computeSearchView({ ...input, nearOnly: false });
    expect(enabled.centers).toHaveLength(1);
    expect(disabled.centers).toHaveLength(3);
  });
});
