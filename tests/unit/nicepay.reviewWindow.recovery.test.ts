// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const h = vi.hoisted(() => ({ session: { wait: null as null | Promise<void>, fail: false }, token: "jwt", callback: null as null | (() => void), open: vi.fn(), fetch: vi.fn(), cleanup: vi.fn(), params: { MID: "nicepay00m", Moid: "33333333-3333-4333-8333-333333333333", Amt: "15000", GoodsName: "상품", EdiDate: "20261105140000", SignData: "a".repeat(64), ReturnURL: "https://mwhabit.com/api/payments/nicepay/review-window/return?rt=fake", PayMethod: "CARD", CharSet: "utf-8" } }));
vi.mock("../../lib/supabaseClient", () => ({ supabase: { auth: { getSession: async () => { if (h.session.fail) throw new Error("session"); if (h.session.wait) await h.session.wait; return { data: { session: h.token ? { access_token: h.token, user: { email: h.token === "jwt" ? "niceqa@mwhabit.com" : "other@test.invalid" } } : null } }; }, onAuthStateChange: (f: () => void) => { h.callback = f; return { data: { subscription: { unsubscribe: vi.fn() } } }; } } } }));
vi.mock("../../lib/payments/nicepayV3Window", () => ({ NICEPAY_V3_SDK_URL: "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js", openNicepayV3Window: h.open }));
vi.mock("../../lib/payments/reviewWindowClient", () => ({ validateReviewWindowParams: (p: unknown) => p }));
import NicepayReviewWindow, { type ReviewWindowStatus } from "../../app/components/NicepayReviewWindow";
let root: Root, host: HTMLDivElement;
const response = (body: unknown) => ({ ok: true, json: async () => body });
const PID = "33333333-3333-4333-8333-333333333333";
const actionOf = (init: RequestInit) => JSON.parse(String(init.body)).action as string;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks(); h.token = "jwt"; h.callback = null; h.session.wait = null; h.session.fail = false; h.open.mockReturnValue(h.cleanup);
  h.fetch.mockImplementation(async (_u: string, init: RequestInit) => response(actionOf(init) === "check" ? { allowed: true } : { allowed: true, params: h.params }));
  vi.stubGlobal("fetch", h.fetch); (window as unknown as { goPay: () => void }).goPay = () => {};
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(onStatusChange?: (s: ReviewWindowStatus) => void) { await act(async () => root.render(createElement(NicepayReviewWindow, { productId: PID, onStatusChange }))); }
const mainButton = () => host.querySelector("button") as HTMLButtonElement;
async function click(b = mainButton()) { await act(async () => b.dispatchEvent(new MouseEvent("click", { bubbles: true }))); }
function setVisibility(v: "hidden" | "visible") { Object.defineProperty(document, "visibilityState", { configurable: true, value: v }); document.dispatchEvent(new Event("visibilitychange")); }

describe("권한 상태 전달 — 지정 계정은 확인 중·실패에도 실제 결제로 넘어가지 않는다", () => {
  it("지정 계정: checking → allowed 를 알린다", async () => {
    const seen: ReviewWindowStatus[] = []; await render((s) => seen.push(s));
    expect(seen).toContain("checking"); expect(seen[seen.length - 1]).toBe("allowed");
  });
  it("확인 응답이 거부되면 denied(버튼 없음, 실제 결제 불가 안내)", async () => {
    h.fetch.mockImplementation(async () => response({ allowed: false }));
    const seen: ReviewWindowStatus[] = []; await render((s) => seen.push(s));
    expect(seen[seen.length - 1]).toBe("denied"); expect(host.querySelector("button")).toBeNull(); expect(host.textContent).toContain("실제 결제는 진행되지 않아요");
  });
  it("확인 요청이 실패(네트워크 오류)해도 denied — hidden 으로 돌아가 실제 결제가 열리지 않는다", async () => {
    h.fetch.mockImplementation(async () => { throw new Error("network"); });
    const seen: ReviewWindowStatus[] = []; await render((s) => seen.push(s));
    expect(seen[seen.length - 1]).toBe("denied");
  });
  it("지정 계정이 아니면 판별 중(resolving) 뒤에 hidden 으로 확정하고 요청하지 않는다", async () => {
    h.token = "other"; const seen: ReviewWindowStatus[] = []; await render((s) => seen.push(s));
    expect(seen[0]).toBe("resolving"); expect(seen[seen.length - 1]).toBe("hidden"); expect(seen).not.toContain("checking"); expect(h.fetch).not.toHaveBeenCalled(); expect(host.innerHTML).toBe("");
  });
  it("세션 조회가 끝나기 전에는 hidden 이 아니라 resolving 만 알린다(일반 회원과 구분)", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); h.session.wait = gate;
    const seen: ReviewWindowStatus[] = []; await render((s) => seen.push(s));
    expect(seen.length).toBeGreaterThan(0); expect(seen.every((x) => x === "resolving")).toBe(true);
    await act(async () => { release(); await gate; });
    expect(seen[seen.length - 1]).toBe("allowed");
  });
  it("세션 조회가 실패하면 일반 회원으로 보지 않고 denied 로 잠근다", async () => {
    h.session.fail = true; const seen: ReviewWindowStatus[] = []; await render((s) => seen.push(s));
    expect(seen[seen.length - 1]).toBe("denied"); expect(seen).not.toContain("hidden");
  });
  it("로그인 변경 시 hidden 으로 되돌린다", async () => {
    const seen: ReviewWindowStatus[] = []; await render((s) => seen.push(s)); h.token = "other";
    await act(async () => { h.callback!(); }); expect(seen[seen.length - 1]).toBe("hidden"); expect(host.querySelector("button")).toBeNull();
  });
});

describe("창 상태 복구 — 타이머로 성공 처리하지 않는다", () => {
  it("열림 → 앱/탭이 숨겨졌다 돌아오면 복귀 안내와 함께 다시 누를 수 있다(성공 표시 없음)", async () => {
    await render(); await click(); expect(h.open).toHaveBeenCalledTimes(1);
    expect(mainButton().disabled).toBe(true); expect(mainButton().textContent).toContain("열려 있어요");
    await act(async () => setVisibility("hidden")); await act(async () => setVisibility("visible"));
    expect(host.textContent).toContain("돌아왔어요"); expect(host.textContent).toContain("생성되지 않았습니다"); expect(host.textContent).not.toMatch(/완료|성공/);
    expect(h.cleanup).toHaveBeenCalled(); expect(mainButton().disabled).toBe(false);
    expect(h.open).toHaveBeenCalledTimes(1);   // 복구만 하고 자동으로 다시 열지 않는다
  });
  it("숨김 없이 보이기만 한 이벤트로는 복구하지 않는다(창이 같은 화면 위에 열려 있는 PC)", async () => {
    await render(); await click(); await act(async () => setVisibility("visible"));
    expect(mainButton().disabled).toBe(true);
  });
  it("bfcache 복귀(pageshow persisted)에서도 복구한다", async () => {
    await render(); await click();
    await act(async () => { const e = new Event("pageshow") as PageTransitionEvent; Object.defineProperty(e, "persisted", { value: true }); window.dispatchEvent(e); });
    expect(host.textContent).toContain("돌아왔어요"); expect(mainButton().disabled).toBe(false);
  });
  it("열림 상태에서 '상태 초기화' 버튼으로 수동 복구할 수 있다", async () => {
    await render(); await click(); const reset = host.querySelectorAll("button")[1] as HTMLButtonElement; expect(reset.textContent).toContain("상태 초기화");
    await click(reset); expect(mainButton().disabled).toBe(false); expect(host.textContent).toContain("초기화했어요");
  });
  it("서명 발급 응답이 비정상이면 오류를 보이고(숨기지 않음) '다시 시도'로 복구한다", async () => {
    let n = 0; h.fetch.mockImplementation(async (_u: string, init: RequestInit) => response(actionOf(init) === "check" ? { allowed: true } : (++n === 1 ? { allowed: true } : { allowed: true, params: h.params })));
    await render(); await click();
    expect(h.open).not.toHaveBeenCalled(); expect(host.querySelector("[role=alert]")?.textContent).toContain("확인할 수 없어요"); expect(mainButton().textContent).toContain("다시 시도"); expect(mainButton().disabled).toBe(false);
    await click(); expect(h.open).toHaveBeenCalledTimes(1);
  });
  it("창 열기가 예외를 던져도 오류로 복구된다(준비 중에 갇히지 않음)", async () => {
    h.open.mockImplementationOnce(() => { throw new Error("결제창을 불러오지 못했어요"); });
    await render(); await click(); expect(host.querySelector("[role=alert]")?.textContent).toContain("결제창을 불러오지 못했어요"); expect(mainButton().disabled).toBe(false);
  });
  it("닫기 콜백은 닫음 안내로 복구한다(주문·이용권 없음)", async () => {
    await render(); await click(); await act(async () => h.open.mock.calls[0][1].onClosedBeforeSubmit());
    expect(host.textContent).toContain("주문과 이용권을 생성하지 않았습니다"); expect(mainButton().disabled).toBe(false);
  });
  it("준비 중 더블 클릭은 서명 발급 요청을 1번만 보낸다", async () => {
    await render(); const b = mainButton();
    await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(h.fetch.mock.calls.filter((c: unknown[]) => actionOf(c[1] as RequestInit) === "open")).toHaveLength(1); expect(h.open).toHaveBeenCalledTimes(1);
  });
  it("테스트 경로는 review-window 경로만 호출한다(주문·승인 경로 없음)", async () => {
    await render(); await click(); await act(async () => h.open.mock.calls[0][1].onClosedBeforeSubmit());
    expect(h.fetch.mock.calls.every((c: unknown[]) => c[0] === "/api/payments/nicepay/review-window")).toBe(true);
  });
});

describe("결제 화면 — 테스트 CTA 와 실제 결제 CTA 충돌 방지(정적 계약)", () => {
  const src = readFileSync(join(__dirname, "../../app/checkout/page.tsx"), "utf-8");
  it("상태를 받아 실제 결제 버튼을 잠근다(직접결제는 제외)", () => {
    expect(src).toContain("onStatusChange={onReviewWindowStatus}");
    expect(src).toContain('useState<ReviewWindowStatus>("resolving")');   // 초기값은 판별 중 — hidden 으로 시작하지 않는다
    expect(src).toContain('const reviewCardLock = reviewWindowStatus !== "hidden" && effectivePayMethodUi !== "direct";');
    expect(src).toMatch(/disabled=\{busy \|\| pgUnresolved \|\| reviewCardLock/);
  });
  it("handlePay 는 주문 생성(createOrder)·PG 준비보다 먼저 지정 계정의 카드 결제를 막는다", () => {
    const guard = src.indexOf('effectivePayMethod !== "direct" && reviewStatusRef.current !== "hidden"');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(src.indexOf("await createOrder({", guard));
    expect(guard).toBeLessThan(src.indexOf("requestReturnToken(orderId)"));
    const direct = src.indexOf('if (effectivePayMethod === "direct") {', guard); expect(direct).toBeGreaterThan(guard);   // 직접결제 분기는 가드 뒤에서 그대로 유지
  });
});

describe("Lint 수정(렌더 중 ref 변경·effect 동기 setState 제거) 후에도 상태 전달이 유지된다", () => {
  it("부모가 콜백을 바꿔 다시 렌더하면 이후 상태 변화는 새 콜백으로만 전달된다(최신 콜백 보관)", async () => {
    const first: ReviewWindowStatus[] = [], second: ReviewWindowStatus[] = [];
    await render((s) => first.push(s)); expect(first.at(-1)).toBe("allowed");
    const n1 = first.length; await render((s) => second.push(s));   // 같은 컴포넌트에 새 콜백(재렌더)
    await act(async () => { h.callback!(); });                       // 로그인 변경 → resolving → 재확인 → allowed
    expect(first.length).toBe(n1); expect(second[0]).toBe("resolving"); expect(second.at(-1)).toBe("allowed");
  });
  it("로그인 변경 시 resolving 을 먼저 알리고(실제 결제 잠금 유지) 재확인 결과로 갱신한다", async () => {
    const seen: ReviewWindowStatus[] = []; await render((s) => seen.push(s)); seen.length = 0;
    h.token = "other"; await act(async () => { h.callback!(); });
    expect(seen[0]).toBe("resolving"); expect(seen.at(-1)).toBe("hidden"); expect(seen).not.toContain("allowed");
  });
  it("재확인 중 늦게 도착한 이전 확인 응답은 새 상태를 덮어쓰지 않는다(세대 검사)", async () => {
    let release!: (v: unknown) => void; let n = 0;
    h.fetch.mockImplementation(async (_u: string, init: RequestInit) => actionOf(init) === "check" ? (++n === 1 ? new Promise((r) => { release = r; }) : response({ allowed: false })) : response({ allowed: true, params: h.params }));
    const seen: ReviewWindowStatus[] = []; await render((s) => seen.push(s));   // 첫 check 가 대기 중
    await act(async () => { h.callback!(); });                                   // 로그인 변경 → 두 번째 check(거부)
    await act(async () => { release(response({ allowed: true })); });           // 첫 응답이 뒤늦게 도착
    expect(seen.at(-1)).toBe("denied"); expect(seen).not.toContain("allowed");
  });
  it("정적: 렌더 중 ref.current 대입과 effect 본문의 동기 setState 가 없다", () => {
    const src = readFileSync(join(__dirname, "../../app/components/NicepayReviewWindow.tsx"), "utf-8");
    expect(src).toMatch(/useEffect\(\(\) => \{ notify\.current = onStatusChange; \}\);/);
    expect(src.match(/notify\.current = onStatusChange/g)?.length).toBe(1);
    expect(src).not.toMatch(/const g = \+\+generation\.current, ctrl = new AbortController\(\);\s*setStatus\(/);
    expect(src).not.toMatch(/eslint-disable[^\n]*(refs|set-state-in-effect)/);
  });
});
