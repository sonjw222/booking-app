// @vitest-environment jsdom
/* 홈 화면 렌더 회귀 — 심사관 전용 "수강권 및 결제 확인 센터" 섹션: 심사관에게만 보이고, 일반 회원·비로그인에게는 렌더되지 않으며 '심사용' 문구가 없다.
   서버(RLS·P2 격리)의 접근 판정은 별도(tests/sql PGlite, nicepayReviewScope 테스트)이고, 이 테스트는 화면이 그 판정 결과(fetchMyNicepayReviewAccess)를 그대로 따르는지만 본다. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  reviewer: false, session: true,
  centers: [{ id: "c-test", name: "모하빗 스튜디오 (테스트 센터)", address: "", distance: null, tags: [] }] as unknown[],
}));
vi.mock("../../lib/home", () => ({
  fetchMyProfileIds: vi.fn(async () => []), fetchHomeCenters: vi.fn(async () => h.centers), fetchHomeClasses: vi.fn(async () => []),
  fetchMyUpcomingClasses: vi.fn(async () => []), fetchNextReservation: vi.fn(async () => null),
}));
vi.mock("../../lib/operator", () => ({ fetchBanners: vi.fn(async () => []), fetchCategories: vi.fn(async () => []) }));
vi.mock("../../lib/manager", () => ({ fetchMyCenters: vi.fn(async () => []) }));
vi.mock("../../lib/authAccount", () => ({ fetchMyNicepayReviewAccess: vi.fn(async () => h.reviewer) }));
vi.mock("../../lib/notifications", () => ({ fetchUnreadCount: vi.fn(async () => 0), subscribeNotifications: vi.fn(async () => () => {}) }));
vi.mock("../../lib/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: h.session ? { user: { id: "u" } } : null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) } } }));
vi.mock("next/link", () => ({ default: (p: { href: string; children?: unknown; className?: string }) => createElement("a", { href: p.href, className: p.className }, p.children as never) }));
import Home from "../../app/page";

let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })); (window as unknown as { matchMedia: unknown }).matchMedia = (globalThis as unknown as { matchMedia: unknown }).matchMedia; host = document.createElement("div"); document.body.append(host); root = createRoot(host); h.reviewer = false; h.session = true; });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = async () => { await act(async () => { root.render(createElement(Home)); }); await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

describe("홈: NICEPAY 심사관 전용 섹션", () => {
  it("심사관: '수강권 및 결제 확인 센터' 섹션과 테스트 센터 행이 보이고 '심사용' 문구는 없다", async () => {
    h.reviewer = true; await render();
    const sec = host.querySelector('section[aria-label="수강권 및 결제 확인 센터"]'); expect(sec).not.toBeNull();
    expect(sec!.textContent).toContain("수강권 및 결제 확인 센터"); expect(sec!.textContent).toContain("모하빗 스튜디오 (테스트 센터)"); expect(sec!.textContent).toContain("테스트 센터 · 수강권 및 결제 과정 확인");
    expect(host.textContent).not.toMatch(/심사용|심사 전용|심사 안내|카드사 심사/);
  });
  it("일반 회원(심사 권한 없음): 같은 센터 목록이 와도 섹션이 없다", async () => {
    h.reviewer = false; await render();
    expect(host.querySelector('section[aria-label="수강권 및 결제 확인 센터"]')).toBeNull(); expect(host.textContent).not.toContain("수강권 및 결제 확인 센터"); expect(host.textContent).not.toMatch(/심사용|심사 전용/);
  });
  it("비로그인: 섹션이 없다(로그인 링크만)", async () => {
    h.session = false; h.reviewer = false; await render();
    expect(host.querySelector('section[aria-label="수강권 및 결제 확인 센터"]')).toBeNull(); expect(host.textContent).toContain("로그인");
  });
  it("심사관이어도 센터 목록이 비면 섹션을 만들지 않는다", async () => {
    h.reviewer = true; h.centers = []; await render();
    expect(host.querySelector('section[aria-label="수강권 및 결제 확인 센터"]')).toBeNull();
  });
});
