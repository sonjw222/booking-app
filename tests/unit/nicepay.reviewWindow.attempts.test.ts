// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const h = vi.hoisted(() => ({ open: vi.fn(), cleanup: vi.fn(), params: { MID: "nicepay00m", Moid: "33333333-3333-4333-8333-333333333333", Amt: "15000", GoodsName: "상품", EdiDate: "20261105140000", SignData: "a".repeat(64), ReturnURL: "https://mwhabit.com/api/payments/nicepay/review-window/return?rt=fake", PayMethod: "CARD", CharSet: "utf-8" } }));
vi.mock("../../lib/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "jwt", user: { email: "niceqa@mwhabit.com" } } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }) } } }));
vi.mock("../../lib/payments/nicepayV3Window", () => ({ NICEPAY_V3_SDK_URL: "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js", openNicepayV3Window: h.open }));
vi.mock("../../lib/payments/reviewWindowClient", () => ({ validateReviewWindowParams: (p: unknown) => p }));
import NicepayReviewWindow, { REVIEW_REQUEST_TIMEOUT_MS } from "../../app/components/NicepayReviewWindow";

type Pending = { action: string; signal: AbortSignal; resolve: (v: unknown) => void; reject: (e: unknown) => void };
let root: Root, host: HTMLDivElement, pending: Pending[], honorAbort: boolean;
const PID = "33333333-3333-4333-8333-333333333333";
const ok = (body: unknown) => ({ ok: true, json: async () => body });
const openReq = () => pending.filter((p) => p.action === "open");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks(); pending = []; honorAbort = true; h.open.mockReturnValue(h.cleanup);
  (window as unknown as { goPay: () => void }).goPay = () => {};
  // check 는 즉시 허용, open 은 테스트가 직접 resolve/reject 한다. honorAbort=false 면 abort 되어도 응답이 도착하는 경쟁 상황을 흉내 낸다.
  vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => {
    const action = JSON.parse(String(init.body)).action as string;
    if (action === "check") return Promise.resolve(ok({ allowed: true }));
    return new Promise((resolve, reject) => {
      const signal = init.signal as AbortSignal; pending.push({ action, signal, resolve, reject });
      if (honorAbort) signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { vi.useRealTimers(); await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(createElement(NicepayReviewWindow, { productId: PID })));
const buttons = () => Array.from(host.querySelectorAll("button")) as HTMLButtonElement[];
const byText = (t: string) => buttons().find((b) => b.textContent?.includes(t));
const click = (b: HTMLButtonElement | undefined) => act(async () => { b!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

describe("review-window 요청 제한 시간·취소", () => {
  it("open 응답이 제한 시간 안에 오지 않으면 요청을 abort 하고 오류 + 다시 시도로 복구한다(goPay 호출 없음)", async () => {
    vi.useFakeTimers(); await render(); await click(byText("카드 결제창 확인")); expect(byText("결제창 준비 중")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(REVIEW_REQUEST_TIMEOUT_MS + 1); });
    expect(openReq()[0].signal.aborted).toBe(true); expect(h.open).not.toHaveBeenCalled();
    expect(host.querySelector("[role=alert]")?.textContent).toContain("너무 늦어요"); expect(byText("다시 시도")!.disabled).toBe(false);
  });
  it("권한 확인(check) 응답이 없으면 제한 시간 후 denied 로 잠근다(영구 확인 중에 갇히지 않음)", async () => {
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_r, reject) => { (init.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))); })));
    vi.useFakeTimers(); await render(); expect(host.textContent).toContain("확인하는 중");
    await act(async () => { await vi.advanceTimersByTimeAsync(REVIEW_REQUEST_TIMEOUT_MS + 1); });
    expect(host.textContent).toContain("실제 결제는 진행되지 않아요"); expect(host.querySelector("button")).toBeNull();
  });
  it("준비 중에도 '준비 취소'로 복구한다 — 요청이 abort 되고 안내가 보인다", async () => {
    await render(); await click(byText("카드 결제창 확인"));
    await click(byText("준비 취소")); expect(openReq()[0].signal.aborted).toBe(true);
    expect(host.textContent).toContain("준비를 취소했어요"); expect(byText("카드 결제창 확인 (승인 없음)")!.disabled).toBe(false);
  });
});

describe("늦게 도착한 이전 응답은 goPay 를 부르거나 새 상태를 덮어쓰지 않는다", () => {
  it("취소 후 응답이 도착해도(abort 무시 경쟁) goPay 를 호출하지 않고 상태는 처음으로 유지된다", async () => {
    honorAbort = false; await render(); await click(byText("카드 결제창 확인")); await click(byText("준비 취소"));
    await act(async () => { openReq()[0].resolve(ok({ allowed: true, params: h.params })); });
    expect(h.open).not.toHaveBeenCalled(); expect(host.textContent).toContain("준비를 취소했어요"); expect(host.textContent).not.toContain("열려 있어요");
  });
  it("취소 → 재시도 → 새 시도가 열림 → 이전 시도의 응답이 뒤늦게 와도 goPay 는 1번뿐이고 열림 상태가 유지된다", async () => {
    honorAbort = false; await render();
    await click(byText("카드 결제창 확인")); await click(byText("준비 취소"));        // 시도 1 취소
    await click(byText("카드 결제창 확인"));                                          // 시도 2
    await act(async () => { openReq()[1].resolve(ok({ allowed: true, params: h.params })); });
    expect(h.open).toHaveBeenCalledTimes(1); expect(byText("결제창이 열려 있어요")).toBeTruthy();
    await act(async () => { openReq()[0].resolve(ok({ allowed: true, params: h.params })); });   // 시도 1 의 늦은 응답
    expect(h.open).toHaveBeenCalledTimes(1); expect(byText("결제창이 열려 있어요")).toBeTruthy(); expect(h.cleanup).not.toHaveBeenCalled();
  });
  it("이전 시도의 늦은 실패(오류)가 새 시도의 상태를 오류로 덮어쓰지 않는다", async () => {
    honorAbort = false; await render();
    await click(byText("카드 결제창 확인")); await click(byText("준비 취소")); await click(byText("카드 결제창 확인"));   // 시도 2 진행 중
    await act(async () => { openReq()[0].reject(new Error("late network error")); });
    expect(host.querySelector("[role=alert]")).toBeNull(); expect(byText("결제창 준비 중")).toBeTruthy();
    await act(async () => { openReq()[1].resolve(ok({ allowed: true, params: h.params })); }); expect(h.open).toHaveBeenCalledTimes(1);
  });
  it("열림 상태 초기화 → 재시도: 이전 창의 닫기 콜백이 새 시도 상태를 닫음으로 바꾸지 않는다", async () => {
    honorAbort = false; await render(); await click(byText("카드 결제창 확인"));
    await act(async () => { openReq()[0].resolve(ok({ allowed: true, params: h.params })); }); expect(h.open).toHaveBeenCalledTimes(1);
    const staleClosed = h.open.mock.calls[0][1].onClosedBeforeSubmit as () => void;
    await click(byText("상태 초기화")); await click(byText("카드 결제창 확인"));
    await act(async () => { openReq()[1].resolve(ok({ allowed: true, params: h.params })); }); expect(h.open).toHaveBeenCalledTimes(2);
    await act(async () => staleClosed());
    expect(byText("결제창이 열려 있어요")).toBeTruthy(); expect(host.textContent).not.toContain("테스트 결제창을 닫았습니다");
  });
  it("준비 중 더블 클릭은 요청을 1번만 보낸다", async () => {
    await render(); const b = byText("카드 결제창 확인")!;
    await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openReq()).toHaveLength(1);
  });
});
