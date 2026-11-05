// @vitest-environment jsdom
/* 실제 checkout 페이지(app/checkout/page.tsx)를 jsdom 에 렌더하고 getSession 응답을 지연시켜, 계정 판별 중(resolving)에도
   실제 카드 결제(주문 생성·PG 준비)가 열리지 않는지, 일반 회원으로 확정되면 정상 동작하는지 상호작용으로 검증한다. 외부 네트워크·실제 결제는 없다(전부 mock). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  sessionGate: null as null | Promise<void>, sessionEmail: "niceqa@mwhabit.com" as string | null, sessionFail: false,
  reviewAccess: true, pg: false, createOrder: vi.fn(), createPayment: vi.fn(), returnToken: vi.fn(), fetch: vi.fn(),
  product: { id: "33333333-3333-4333-8333-333333333333", name: "1회 이용권", price: 15000, kind: "pass", totalCount: 1, unlimited: false, validDays: 30, description: null, sizes: null, autoBookDays: null, groupLabel: null, remaining: null, couponEligible: false, weekdaySelectable: false, timeSelectable: false, countSelectable: false, countPrices: [], minCount: null, maxCount: null, minTierPrice: null, periodSource: null },
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("center=1c02c063-8da4-43b5-b88a-514434371c46&product=33333333-3333-4333-8333-333333333333") }));
vi.mock("../../lib/supabaseClient", () => ({ supabase: { auth: {
  getSession: async () => { if (h.sessionGate) await h.sessionGate; if (h.sessionFail) throw new Error("session"); return { data: { session: h.sessionEmail ? { access_token: "jwt", user: { id: "u1", email: h.sessionEmail } } : null } }; },
  getUser: async () => ({ data: { user: { id: "u1", email: h.sessionEmail } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
} } }));
vi.mock("../../lib/authAccount", () => ({ fetchMyPgCheckoutOverride: async () => false, fetchMyNicepayReviewAccess: async () => h.reviewAccess }));
vi.mock("../../lib/center", () => ({
  fetchCenterDetail: async () => ({ name: "모하빗 스튜디오 (테스트 센터)", payMethods: null }),
  fetchCenterProductsForPurchase: async () => [h.product], fetchPurchaseScheduleOptions: async () => null,
}));
vi.mock("../../lib/orders", () => ({ createOrder: (...a: unknown[]) => h.createOrder(...a), cancelMyPendingOrderQuietly: async () => {} }));
vi.mock("../../lib/payments", () => ({
  getPaymentService: () => ({ createPayment: (...a: unknown[]) => h.createPayment(...a) }), resolveProviderName: () => "nicepay",
  isOnlinePgCheckoutAvailable: () => true, get PG_CHECKOUT_ENABLED() { return h.pg; },
}));
vi.mock("../../lib/payments/tossPaymentApi", () => ({ requestReturnToken: (...a: unknown[]) => h.returnToken(...a) }));
vi.mock("../../lib/payments/returnApi", () => ({ clearPendingPgOrder: () => {}, readPendingPgOrder: () => null, savePendingPgOrder: () => {} }));
vi.mock("../../lib/profiles", () => ({ fetchProfiles: async () => [] }));
vi.mock("../../lib/reviews", () => ({ fetchMyPoints: async () => 0, usePoints: async () => {} }));
vi.mock("../../lib/coupons", () => ({ fetchApplicableCoupons: async () => [], previewDiscount: () => 0 }));
vi.mock("../../lib/nativeHaptics", () => ({ hapticSuccess: () => {} }));
import CheckoutPage from "../../app/checkout/page";

let root: Root, host: HTMLDivElement;
const payBtn = () => host.querySelector("button.checkout-pay-btn") as HTMLButtonElement;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const render = async () => { await act(async () => root.render(createElement(CheckoutPage))); await flush(); await flush(); };
const click = (b: Element | null) => act(async () => { b!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  h.pg = false; h.sessionGate = null; h.sessionEmail = "niceqa@mwhabit.com"; h.sessionFail = false; h.reviewAccess = true;
  h.createOrder.mockResolvedValue("order-1"); h.returnToken.mockResolvedValue("rt"); h.createPayment.mockResolvedValue({ redirected: true });
  h.fetch.mockImplementation(async (_u: string, init: RequestInit) => ({ ok: true, json: async () => (JSON.parse(String(init.body)).action === "check" ? { allowed: true } : { allowed: false }) }));
  vi.stubGlobal("fetch", h.fetch);
  (window as unknown as { scrollTo: () => void }).scrollTo = () => {};
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const wait = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe("실제 checkout — getSession 지연 중에도 실제 카드 결제가 열리지 않는다", () => {
  it("지연 중: 결제 버튼 disabled, 눌러도 주문 생성·PG 준비·결제창 호출이 없다 → 지정 계정으로 확정돼도 잠김 유지", async () => {
    let release!: () => void; h.sessionGate = new Promise<void>((r) => { release = r; });
    await render();
    expect(payBtn()).toBeTruthy(); expect(payBtn().disabled).toBe(true); expect(payBtn().textContent).toContain("결제창 확인");
    await click(payBtn());                                                           // 사용자가 지연 중에 눌러 봐도
    expect(h.createOrder).not.toHaveBeenCalled(); expect(h.returnToken).not.toHaveBeenCalled(); expect(h.createPayment).not.toHaveBeenCalled();
    await act(async () => { release(); }); await wait(); await wait();              // 세션 확정(niceqa) + 권한 확인 완료
    expect(host.textContent).toContain("카드 결제창 확인"); expect(payBtn().disabled).toBe(true);
    await click(payBtn()); expect(h.createOrder).not.toHaveBeenCalled(); expect(h.createPayment).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls.every((c: unknown[]) => c[0] === "/api/payments/nicepay/review-window")).toBe(true);   // 테스트 경로만 호출
  });
  it("일반 회원(전역 카드 결제가 켜진 환경)도 판별 중에는 카드 결제가 잠기고, 일반 회원으로 확정되면 잠금이 풀려 정상 접수된다", async () => {
    h.pg = true; h.reviewAccess = false; h.sessionEmail = "member@example.com";
    let release!: () => void; h.sessionGate = new Promise<void>((r) => { release = r; });
    await render();
    expect(payBtn().disabled).toBe(true);                                           // 판별 중: 아직 일반 회원 여부를 모른다 → 카드 결제 잠김
    await click(payBtn()); expect(h.createOrder).not.toHaveBeenCalled(); expect(h.createPayment).not.toHaveBeenCalled();
    await act(async () => { release(); }); await wait(); await wait();
    expect(payBtn().disabled).toBe(false); expect(payBtn().textContent).not.toContain("결제창 확인");
    expect(host.textContent).not.toContain("카드 결제창 확인"); expect(h.fetch).not.toHaveBeenCalled();   // 테스트 UI 는 일반 회원에게 보이지 않는다
    await click(payBtn()); expect(h.createOrder).toHaveBeenCalledTimes(1);          // 확정 후에는 기존 결제 흐름 그대로
  });
  it("일반 회원의 직접결제(카드 아님)는 판별 중에도 막지 않는다 — 기존 직접결제 동작 유지", async () => {
    h.reviewAccess = false; h.sessionEmail = "member@example.com";
    let release!: () => void; h.sessionGate = new Promise<void>((r) => { release = r; });
    await render();
    expect(payBtn().disabled).toBe(false); await click(payBtn()); expect(h.createOrder).toHaveBeenCalledTimes(1); expect(h.createPayment).not.toHaveBeenCalled();
    await act(async () => { release(); });
  });
  it("세션 조회가 실패하면 일반 회원으로 보지 않고 카드 결제를 잠근다", async () => {
    h.sessionFail = true; await render(); await wait();
    expect(payBtn().disabled).toBe(true); await click(payBtn()); expect(h.createOrder).not.toHaveBeenCalled();
  });
  it("지정 계정은 직접결제를 고르면(카드 아님) 기존대로 주문 접수가 가능하다 — 직접결제 동작은 유지", async () => {
    await render(); await wait();
    const direct = Array.from(host.querySelectorAll("button, label, div")).find((el) => el.textContent?.trim().startsWith("직접결제") && (el.getAttribute("role") === "radio" || el.tagName === "BUTTON" || el.className.includes?.("pay-method")));
    expect(direct).toBeTruthy(); await click(direct!);
    expect(payBtn().disabled).toBe(false); await click(payBtn()); expect(h.createOrder).toHaveBeenCalledTimes(1);
    expect(h.createPayment).not.toHaveBeenCalled();
  });
});
