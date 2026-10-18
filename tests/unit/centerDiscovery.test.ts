import { describe, expect, it } from "vitest";
import {
  activeFilterCount, aggregateRatings, applyDiscovery, DEFAULT_DISCOVERY, distanceKmTo, formatDistance, matchesQuery,
  parseDiscoveryParams, serializeDiscoveryParams, sortAvailability, summarizeAddress, type DiscoverableCenter, type DiscoveryState,
} from "../../lib/centerDiscovery";

const HERE = { lat: 37.5665, lng: 126.978 };   // 서울시청
const mk = (id: string, name: string, lat: number | null, lng: number | null, extra: Partial<DiscoverableCenter> = {}): DiscoverableCenter =>
  ({ id, name, latitude: lat, longitude: lng, address: null, intro: null, ...extra });
// 시청에서 대략: a≈0.9km, b≈4.4km(강남 방향 아님, 임의), c≈8.5km, d 좌표 없음
const centers = [
  mk("a", "하늘 요가", 37.5745, 126.9780),
  mk("b", "가람 요가", 37.6060, 126.9780),
  mk("c", "나무 요가", 37.6430, 126.9780),
  mk("d", "다온 요가", null, null),
];
const st = (patch: Partial<DiscoveryState>): DiscoveryState => ({ ...DEFAULT_DISCOVERY, ...patch });
const ids = (r: ReturnType<typeof applyDiscovery>) => r.rows.map((x) => x.center.id);

describe("URL 직렬화", () => {
  it("기본값은 쿼리에서 생략하고, 왕복해도 같은 상태가 된다", () => {
    expect(serializeDiscoveryParams(DEFAULT_DISCOVERY)).toBe("");
    const s = st({ query: " 요가 ", radiusKm: 5, sort: "rating" });
    const qs = serializeDiscoveryParams(s);
    expect(qs).toBe("q=%EC%9A%94%EA%B0%80&r=5&s=rating");
    expect(parseDiscoveryParams(new URLSearchParams(qs))).toEqual({ ...s, query: "요가" });
  });
  it("잘못된 값은 기본값으로 되돌린다(허용 목록 밖의 거리, 알 수 없는 정렬)", () => {
    expect(parseDiscoveryParams(new URLSearchParams("r=7&s=hack&q=" + "가".repeat(300)))).toEqual({ query: "가".repeat(100), radiusKm: null, sort: "recommended" });
    expect(parseDiscoveryParams(new URLSearchParams("r=0"))).toMatchObject({ radiusKm: null });
    expect(parseDiscoveryParams(new URLSearchParams("r=-5"))).toMatchObject({ radiusKm: null });
  });
  it("활성 조건 수", () => {
    expect(activeFilterCount(DEFAULT_DISCOVERY)).toBe(0);
    expect(activeFilterCount(st({ query: "a", radiusKm: 1, sort: "name" }))).toBe(3);
  });
});

describe("거리 계산", () => {
  it("좌표가 없거나 잘못되면 null (0으로 오해하지 않는다)", () => {
    expect(distanceKmTo(HERE, { latitude: null, longitude: null })).toBeNull();
    expect(distanceKmTo(null, { latitude: 37, longitude: 127 })).toBeNull();
    expect(distanceKmTo(HERE, { latitude: 999, longitude: 0 })).toBeNull();
    expect(distanceKmTo(HERE, { latitude: NaN, longitude: 0 })).toBeNull();
    expect(distanceKmTo(HERE, { latitude: 37.5745, longitude: 126.978 })!).toBeCloseTo(0.89, 1);
  });
  it("표기: 1km 미만은 m, 10km 미만은 소수 1자리, 이상은 정수", () => {
    expect(formatDistance(0.42)).toBe("420m"); expect(formatDistance(0.004)).toBe("10m");
    expect(formatDistance(1.234)).toBe("1.2km"); expect(formatDistance(12.6)).toBe("13km");
  });
});

describe("applyDiscovery — 거리 범위", () => {
  it("범위 안의 센터만 남기고, 좌표 없는 센터는 제외 수로 알려준다", () => {
    const r = applyDiscovery(centers, st({ radiusKm: 5 }), HERE, {});
    expect(ids(r)).toEqual(["a", "b"]);
    expect(r.excludedNoDistance).toBe(1);
    expect(r.locationNeeded).toBe(false);
  });
  it("경계: 범위 밖 센터(c≈8.5km)는 5km에서 빠지고 10km에서 들어온다", () => {
    expect(ids(applyDiscovery(centers, st({ radiusKm: 10 }), HERE, {}))).toEqual(["a", "b", "c"]);
    expect(ids(applyDiscovery(centers, st({ radiusKm: 1 }), HERE, {}))).toEqual(["a"]);
  });
  it("위치를 모르면 거리 조건을 적용하지 않고(전체 표시) 위치가 필요하다고 알린다", () => {
    const r = applyDiscovery(centers, st({ radiusKm: 3 }), null, {});
    expect(ids(r)).toEqual(["a", "b", "c", "d"]);
    expect(r.locationNeeded).toBe(true); expect(r.excludedNoDistance).toBe(0);
  });
  it("전체(null)는 좌표 없는 센터도 포함", () => {
    expect(ids(applyDiscovery(centers, DEFAULT_DISCOVERY, HERE, {}))).toEqual(["a", "b", "c", "d"]);
  });
});

describe("applyDiscovery — 정렬", () => {
  it("거리순: 가까운 순, 거리 모르는 센터는 맨 뒤", () => {
    expect(ids(applyDiscovery([centers[2], centers[3], centers[0], centers[1]], st({ sort: "distance" }), HERE, {}))).toEqual(["a", "b", "c", "d"]);
  });
  it("이름순(가나다)", () => {
    expect(ids(applyDiscovery(centers, st({ sort: "name" }), HERE, {}))).toEqual(["b", "c", "d", "a"]);
  });
  it("평점순: 평균 → 후기 수, 평점 없는 센터는 뒤(추천순 유지) — 가짜 평점을 만들지 않는다", () => {
    const ratings = { a: { average: 4.5, count: 3 }, b: { average: 4.5, count: 10 }, c: { average: 3.9, count: 50 } };
    const r = applyDiscovery(centers, st({ sort: "rating" }), HERE, ratings);
    expect(ids(r)).toEqual(["b", "a", "c", "d"]);
    expect(r.rows[3].rating).toBeNull();
  });
  it("추천순은 서버가 준 순서 그대로, 검색어는 이름·주소·소개에서 공백/대소문자 무시", () => {
    expect(ids(applyDiscovery(centers, DEFAULT_DISCOVERY, null, {}))).toEqual(["a", "b", "c", "d"]);
    const withAddr = [mk("x", "Moha Yoga", 1, 1, { address: "서울 강남구 테헤란로 1" }), mk("y", "필라", 1, 1, { intro: "요가도 해요" })];
    expect(matchesQuery(withAddr[0], "강남")).toBe(true);
    expect(matchesQuery(withAddr[0], " moha  yoga ")).toBe(true);
    expect(ids(applyDiscovery(withAddr, st({ query: "요가" }), null, {}))).toEqual(["y"]);
    expect(ids(applyDiscovery(withAddr, st({ query: "없는검색어" }), null, {}))).toEqual([]);
  });
  it("검색어 + 거리 + 정렬은 한 번에 일관되게 적용", () => {
    const r = applyDiscovery(centers, st({ query: "요가", radiusKm: 10, sort: "name" }), HERE, {});
    expect(ids(r)).toEqual(["b", "c", "a"]);
  });
});

describe("정렬 옵션 사용 가능 여부(비활성 사유)", () => {
  it("거리순은 위치 필요, 평점순은 평점 데이터 필요", () => {
    expect(sortAvailability("distance", { hasPosition: false, ratingsLoaded: true, anyRated: true }).enabled).toBe(false);
    expect(sortAvailability("distance", { hasPosition: true, ratingsLoaded: true, anyRated: false }).enabled).toBe(true);
    expect(sortAvailability("rating", { hasPosition: true, ratingsLoaded: true, anyRated: false })).toEqual({ enabled: false, reason: "아직 등록된 평점이 없어요" });
    expect(sortAvailability("rating", { hasPosition: true, ratingsLoaded: false, anyRated: false }).reason).toMatch(/불러오지 못했어요/);
    expect(sortAvailability("name", { hasPosition: false, ratingsLoaded: false, anyRated: false }).enabled).toBe(true);
    expect(sortAvailability("recommended", { hasPosition: false, ratingsLoaded: false, anyRated: false }).enabled).toBe(true);
  });
});

describe("평점 집계 / 주소 요약", () => {
  it("평균은 소수 1자리, 범위 밖 값 무시, 후기 없는 센터는 항목 자체가 없다", () => {
    expect(aggregateRatings([
      { center_id: "a", rating: 5 }, { center_id: "a", rating: 4 }, { center_id: "a", rating: 4 },
      { center_id: "b", rating: 0 }, { center_id: "b", rating: 6 }, { center_id: "c", rating: 3 },
    ])).toEqual({ a: { average: 4.3, count: 3 }, c: { average: 3, count: 1 } });
    expect(aggregateRatings([])).toEqual({});
  });
  it("주소는 앞 두 단어만", () => {
    expect(summarizeAddress("서울 강남구 테헤란로 1")).toBe("서울 강남구");
    expect(summarizeAddress("서울")).toBe("서울");
    expect(summarizeAddress("  ")).toBeNull(); expect(summarizeAddress(null)).toBeNull();
  });
});
