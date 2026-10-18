import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAppHistoryForTests, hasInAppBackTarget, trackAppHistory } from "../../lib/appHistory";

/* 뒤로가기 목적지 판단: 같은 문서 안 앱 내 이동, 새로고침(같은 탭 sessionStorage), 직접 진입(다른 경로로 새로 시작)을 구분한다. */
function stubBrowser(pathname: string, store: Record<string, string>) {
  vi.stubGlobal("window", { location: { pathname }, addEventListener: () => {} });
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
}
beforeEach(() => { vi.unstubAllGlobals(); });

describe("appHistory", () => {
  it("처음 문서에서는 뒤로 갈 앱 내 화면이 없고, 경로가 바뀌면(SPA 이동) 있다", () => {
    const store: Record<string, string> = {}; stubBrowser("/category/요가", store); __resetAppHistoryForTests();
    trackAppHistory("/category/요가"); expect(hasInAppBackTarget()).toBe(false);
    trackAppHistory("/center/c1"); expect(hasInAppBackTarget()).toBe(true);
  });
  it("새로고침: 같은 경로로 문서가 다시 만들어져도(직전 화면 기록 보존) 뒤로 갈 곳이 있다", () => {
    const store: Record<string, string> = {}; stubBrowser("/category/요가", store); __resetAppHistoryForTests();
    trackAppHistory("/category/요가"); trackAppHistory("/center/c1");
    // 새로고침 = 모듈 상태 초기화(메모리) + sessionStorage 유지
    stubBrowser("/center/c1", store);
    __resetAppHistoryForTests();
    store["mwhabit_nav_trail"] = JSON.stringify({ prev: "/category/요가", current: "/center/c1" });
    trackAppHistory("/center/c1");
    expect(hasInAppBackTarget()).toBe(true);
  });
  it("직접 진입(주소 입력/외부 링크로 다른 경로를 새로 연 경우)은 이전 기록을 쓰지 않는다", () => {
    const store: Record<string, string> = { mwhabit_nav_trail: JSON.stringify({ prev: "/category/요가", current: "/center/c1" }) };
    stubBrowser("/center/c2", store); __resetAppHistoryForTests();
    store["mwhabit_nav_trail"] = JSON.stringify({ prev: "/category/요가", current: "/center/c1" });
    trackAppHistory("/center/c2");
    expect(hasInAppBackTarget()).toBe(false);
    expect(JSON.parse(store["mwhabit_nav_trail"])).toEqual({ prev: null, current: "/center/c2" });
  });
  it("sessionStorage를 못 쓰는 환경(사생활 모드)에서도 예외 없이 메모리 기준으로 동작한다", () => {
    vi.stubGlobal("window", { location: { pathname: "/a" }, addEventListener: () => {} });
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    __resetAppHistoryForTests(); trackAppHistory("/a"); expect(hasInAppBackTarget()).toBe(false); trackAppHistory("/b"); expect(hasInAppBackTarget()).toBe(true);
  });
});
