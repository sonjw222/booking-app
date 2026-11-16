// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ getSession: vi.fn(), listener: vi.fn(), load: vi.fn(), open: vi.fn(), dispose: vi.fn() }));
vi.mock("../../lib/supabaseClient", () => ({ supabase: { auth: { getSession: fake.getSession, onAuthStateChange: fake.listener } } }));
vi.mock("../../lib/payments/nicepaySubscriptionReviewWindow", () => ({ loadRegistrationSdk: fake.load, openRegistrationWindow: fake.open }));
import NicepaySubscriptionReview from "../../app/components/NicepaySubscriptionReview";
import { SUBSCRIPTION_REVIEW_CENTER } from "../../lib/payments/nicepaySubscriptionReviewProtocol";
import { prepareRegistration } from "../../lib/payments/server/nicepay/subscriptionReview";
import { runBack } from "../../lib/backPolicy";
import { updateRootNavState } from "../../lib/navState";

let root: Root, container: HTMLDivElement;
const token = "offline-ui-jwt";
const params = () => prepareRegistration({ origin: window.location.origin, hostedEnabled: true }, { kind: "nicepay-subscription-registration", mid: "fixtur00m1", merchantKey: "A".repeat(86) + "==", stateSecret: "offline-only-".repeat(4) });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
beforeEach(() => {
  vi.clearAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fake.getSession.mockResolvedValue({ data: { session: { access_token: token } } });
  fake.listener.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  fake.load.mockResolvedValue(undefined); fake.open.mockReturnValue(fake.dispose);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function network(allowed: boolean, hosted = false) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return Response.json({ allowed, hostedAvailable: hosted, ...(body.action === "open" ? { params: params() } : {}) });
  }));
}
describe("review UI authorization and safe state", () => {
  it("hides the subscription entry without server eligibility or for a different center", async () => {
    network(false);
    await act(async () => root.render(createElement(NicepaySubscriptionReview, { centerId: SUBSCRIPTION_REVIEW_CENTER, entry: true }))); await flush();
    expect(container.querySelector("a")).toBeNull();
    await act(async () => root.render(createElement(NicepaySubscriptionReview, { centerId: "other", entry: true }))); await flush();
    expect(container.querySelector("a")).toBeNull(); expect(fake.load).not.toHaveBeenCalled();
  });
  it("shows an authorized entry while hosted access remains OFF, without loading PG SDK", async () => {
    network(true);
    await act(async () => root.render(createElement(NicepaySubscriptionReview, { entry: true }))); await flush();
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/manager/subscription/nicepay-review");
    expect(container.textContent).toBe("카드 등록 심사용 확인"); expect(fake.load).not.toHaveBeenCalled();
  });
  it("keeps the hosted CTA disabled with no card entry and explains no charging", async () => {
    network(true);
    await act(async () => root.render(createElement(NicepaySubscriptionReview))); await flush();
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(container.textContent).toContain("잠겨 있어요"); expect(container.textContent).toContain("39,000원"); expect(container.textContent).toContain("카드번호와 카드 인증정보를 입력하지 마세요");
    expect(container.querySelector("input")).toBeNull(); expect(fake.load).not.toHaveBeenCalled();
  });
  it("opens only the dedicated server-prepared protocol in an SDK stub and blocks double clicks", async () => {
    network(true, true);
    await act(async () => root.render(createElement(NicepaySubscriptionReview))); await flush();
    await act(async () => container.querySelector("button")!.click()); await flush();
    expect(fake.load).toHaveBeenCalledTimes(1); expect(fake.open).toHaveBeenCalledTimes(1);
    expect(fake.open.mock.calls[0][0]).toMatchObject({ BillAuthYN: "Y", Amt: "1000", PayMethod: "CARD" });
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toBe("/api/billing/nicepay/registration-review");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await act(async () => fake.open.mock.calls[0][3]()); expect(container.textContent).toContain("카드등록과 청구는 진행하지 않았습니다");
  });
  it("revokes UI eligibility on logout and disposes any open review", async () => {
    network(true, true);
    await act(async () => root.render(createElement(NicepaySubscriptionReview))); await flush();
    await act(async () => container.querySelector("button")!.click()); await flush();
    fake.getSession.mockResolvedValue({ data: { session: null } });
    await act(async () => { fake.listener.mock.calls[0][0]("SIGNED_OUT"); }); await flush();
    expect(fake.dispose).toHaveBeenCalledTimes(1); expect(container.querySelector("button")?.disabled).toBe(true);
  });
  it("resets a BFCache-restored mobile page and rechecks permission without reopening PG", async () => {
    network(true, true);
    await act(async () => root.render(createElement(NicepaySubscriptionReview))); await flush();
    await act(async () => container.querySelector("button")!.click()); await flush();
    const event = new Event("pageshow"); Object.defineProperty(event, "persisted", { value: true });
    await act(async () => window.dispatchEvent(event)); await flush();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(fake.open).toHaveBeenCalledTimes(1);
    expect(container.querySelector("button")?.disabled).toBe(false);
    expect(container.textContent).toContain("확인 화면으로 돌아왔습니다");
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual(["check", "open", "check"]);
  });
  it("native/back cancels preparation without moving the background or accepting a late response", async () => {
    let respond: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (JSON.parse(String(init.body)).action === "check") return Response.json({ allowed: true, hostedAvailable: true });
      return new Promise<Response>(resolve => { respond = resolve; });
    }));
    await act(async () => root.render(createElement(NicepaySubscriptionReview))); await flush();
    await act(async () => container.querySelector("button")!.click()); await flush();
    const router = { back: vi.fn(), push: vi.fn() }; updateRootNavState("/manager/subscription/nicepay-review");
    await act(async () => { expect(runBack(router, "/manager/subscription/nicepay-review")).toBe("close-overlay"); });
    expect(router.back).not.toHaveBeenCalled(); expect(router.push).not.toHaveBeenCalled();
    await act(async () => respond!(Response.json({ allowed: true, hostedAvailable: true, params: params() }))); await flush();
    expect(fake.load).not.toHaveBeenCalled(); expect(fake.open).not.toHaveBeenCalled();
    expect(container.textContent).toContain("준비를 취소했습니다");
  });
});
