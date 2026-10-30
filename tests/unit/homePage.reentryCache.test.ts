/*
  홈 재진입 목록 캐시와 사용자 선택형 내 주변 20km 검색 조건에 대한 구조 회귀 테스트.
  홈은 GPS를 자동 요청하거나 반경으로 센터를 제외하지 않고, 검색 버튼에서만 요청한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/page.tsx"), "utf-8");

describe("app/page.tsx — 홈 재진입 캐시(homeDataCache)", () => {
  it("모듈 레벨 캐시와 TTL이 정의돼 있다", () => {
    expect(source).toContain("let homeDataCache:");
    expect(source).toContain("const HOME_CACHE_TTL_MS = 30_000;");
  });

  it("effect 시작 시 TTL 이내면 캐시된 값으로 먼저 state를 채운다", () => {
    const idx = source.indexOf("if (homeDataCache && Date.now() - homeDataCache.at < HOME_CACHE_TTL_MS)");
    expect(idx).toBeGreaterThan(-1);
    const after = source.slice(idx, idx + 300);
    expect(after).toContain("setCenters(homeDataCache.centers)");
    expect(after).toContain("setClasses(homeDataCache.classes)");
    expect(after).toContain("setBanners(homeDataCache.banners)");
    expect(after).toContain("setCatList(homeDataCache.categories)");
  });

  it("fetch가 끝나면 항상 캐시를 최신 결과로 갱신한다(신선도 유지 — 캐시가 fetch를 대신하지 않음)", () => {
    expect(source).toContain("homeDataCache = { centers: cs, classes: cl, banners: bn, categories: ct, at: Date.now() };");
  });
});

describe("app/page.tsx — 홈의 위치 필터는 자동 적용하지 않는다", () => {
  it("홈에서는 GPS 위치를 자동 요청하지 않는다", () => {
    expect(source).not.toContain("navigator.geolocation.getCurrentPosition(");
    expect(source).not.toContain("lastKnownPosition");
  });

  it("홈 센터 목록은 거리 제한 없는 기본 조회를 사용한다", () => {
    expect(source).toContain("fetchHomeCenters(), fetchHomeClasses()");
    expect(source).not.toMatch(/fetchHomeCenters\(lat\s*,\s*lng\)/);
  });

  it("NICEPAY 전용 바로가기는 심사관에게만 노출한다", () => {
    expect(source).toContain("isNicepayReviewer && centers.length > 0");
    expect(source).toContain('aria-label="NICEPAY 심사 전용 센터"');
  });
});

describe("app/search/page.tsx — 20km 반경은 사용자 선택 필터", () => {
  const searchSource = readFileSync(join(__dirname, "../../app/search/page.tsx"), "utf-8");

  it("내 주변 필터는 기본 OFF로 시작한다", () => {
    expect(searchSource).toContain("const [nearOnly, setNearOnly] = useState(false)");
  });

  it("사용자가 주변 필터를 누를 때 위치 요청이 시작된다", () => {
    expect(searchSource).toContain("function toggleNearby()");
    expect(searchSource).toContain("navigator.geolocation.getCurrentPosition(");
    expect(searchSource).toContain('onClick={toggleNearby}');
  });
});
