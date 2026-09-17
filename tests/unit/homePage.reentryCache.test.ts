/*
  릴리스 폴리시 배치 7차(2026-09-17) — 성능 조사: Next.js App Router는 레이아웃(BottomNav
  등)은 탭 전환 사이 유지하지만 페이지 컴포넌트(app/page.tsx의 Home())는 다른 탭에
  갔다가 돌아올 때마다 매번 새로 마운트한다 — 그래서 홈 재진입마다 센터/클래스/배너/
  카테고리 목록이 잠깐 비었다가 다시 채워지는 게 보였다("탭 진입 시 순간적으로 다시
  그려지는 느낌"). 또한 위치 권한을 매번 getCurrentPosition()으로 다시 기다리느라
  (최대 4초 타임아웃) 재진입마다 데이터 fetch 자체가 늦게 시작됐다.

  이 테스트는 컴포넌트 렌더링 도구가 없는 이 프로젝트의 기존 관례(순수 함수/소스 구조
  고정)를 따라, homeDataCache/lastKnownPosition 캐시 구조와 그 사용 방식이 소스에
  그대로 있는지 고정한다 — 데이터 정확성(매번 새로 fetch)은 그대로 유지하면서 재진입
  시 마지막 결과를 먼저 보여주는 것과, 위치 fetch가 더 이상 데이터 fetch를 막지
  않는다는 것을 확인한다.
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

describe("app/page.tsx — 위치 캐시(lastKnownPosition)가 데이터 fetch 시작을 막지 않는다", () => {
  it("마지막으로 구한 위치가 있으면 getCurrentPosition을 기다리지 않고 바로 쓴다", () => {
    expect(source).toContain("let lat: number | undefined = lastKnownPosition?.lat;");
    expect(source).toContain("let lng: number | undefined = lastKnownPosition?.lng;");
  });

  it("위치를 구하면 다음 재진입을 위해 lastKnownPosition을 갱신한다", () => {
    expect(source).toContain("lastKnownPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };");
  });

  it("캐시된 위치가 없을 때만 새 위치를 기다린 뒤 fetch를 시작한다(최초 진입 기존 동작 유지)", () => {
    const idx = source.indexOf("if (lat == null || lng == null) {");
    expect(idx).toBeGreaterThan(-1);
    const after = source.slice(idx, idx + 150);
    expect(after).toContain("await freshPositionPromise");
  });
});
