// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// 실제 helper(openNicepayV3Window) 를 mock 없이 사용한다 — SDK 의 goPay 만 가짜(창을 실제로 열지 않음).
import { openNicepayV3Window, type NicepayV3Params } from "../../lib/payments/nicepayV3Window";

const params: NicepayV3Params = { MID: "nicepay00m", Moid: "33333333-3333-4333-8333-333333333333", Amt: "15000", GoodsName: "상품", EdiDate: "20261105140000", SignData: "a".repeat(64), ReturnURL: "https://mwhabit.com/api/payments/nicepay/review-window/return?rt=x", PayMethod: "CARD", CharSet: "utf-8" };
type W = Window & { goPay?: (f: HTMLFormElement) => void; nicepaySubmit?: () => void; nicepayClose?: () => void };
const win = window as unknown as W;
const forms = () => document.querySelectorAll("form[name=nicepayV3Form]");
let goPay: ReturnType<typeof vi.fn>;
beforeEach(() => { vi.useFakeTimers(); goPay = vi.fn(); win.goPay = goPay as unknown as W["goPay"]; delete win.nicepaySubmit; delete win.nicepayClose; document.body.innerHTML = ""; });
afterEach(() => { vi.useRealTimers(); delete win.goPay; delete win.nicepaySubmit; delete win.nicepayClose; });
const open = (onClosed: () => void, closeGraceMs = 1500) => openNicepayV3Window(params, { doc: document, win, onClosedBeforeSubmit: onClosed, closeGraceMs });

describe("openNicepayV3Window — 시도별 식별자·늦은 콜백 무효화(실제 helper)", () => {
  it("첫 창 닫기 → 초기화(cleanup) → 새 창 열기 → 이전 콜백 실행 순서에서도 새 창이 유지된다", () => {
    const closedA = vi.fn(), closedB = vi.fn();
    const cleanupA = open(closedA);
    win.nicepayClose!();                                   // 1) 첫 창 닫힘 — 유예 타이머 시작
    cleanupA();                                            // 2) 초기화(정리)
    expect(win.nicepayClose).toBeUndefined();
    const cleanupB = open(closedB);                        // 3) 새 창 열기
    const handlerB = win.nicepayClose, submitB = win.nicepaySubmit;
    expect(forms()).toHaveLength(1); expect(goPay).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);                          // 4) 이전 시도의 타이머 시점이 지나도
    expect(closedA).not.toHaveBeenCalled();                //    이전 콜백은 실행되지 않고
    expect(closedB).not.toHaveBeenCalled();
    expect(forms()).toHaveLength(1);                       //    새 창(form)은 그대로
    expect(win.nicepayClose).toBe(handlerB); expect(win.nicepaySubmit).toBe(submitB);   //    전역 핸들러도 새 시도 것
    win.nicepayClose!(); vi.advanceTimersByTime(1500);     // 새 창은 정상적으로 닫힘 처리된다
    expect(closedB).toHaveBeenCalledTimes(1); expect(forms()).toHaveLength(0);
    cleanupB();
  });
  it("이전 시도의 cleanup 이 새 시도의 전역 핸들러·form 을 지우지 않는다(소유권 확인)", () => {
    const cleanupA = open(vi.fn()); const cleanupB = open(vi.fn());   // B 가 A 를 폐기하고 핸들러를 덮어쓴다
    const hB = { close: win.nicepayClose, submit: win.nicepaySubmit };
    cleanupA();                                            // 늦게 도착한 A 의 정리
    expect(win.nicepayClose).toBe(hB.close); expect(win.nicepaySubmit).toBe(hB.submit); expect(forms()).toHaveLength(1);
    cleanupB(); expect(win.nicepayClose).toBeUndefined(); expect(forms()).toHaveLength(0);
  });
  it("열려 있는 상태에서 새로 열면 이전 시도는 폐기되고 그 타이머 콜백은 실행되지 않는다", () => {
    const closedA = vi.fn(); open(closedA); win.nicepayClose!();   // A: 닫기 유예 중
    const closedB = vi.fn(); open(closedB);                         // cleanup 없이 바로 B
    vi.advanceTimersByTime(5000); expect(closedA).not.toHaveBeenCalled(); expect(forms()).toHaveLength(1);
  });
  it("정리된 시도의 nicepaySubmit 은 form 을 제출하지 않는다", () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    const cleanup = open(vi.fn()); const staleSubmit = win.nicepaySubmit!; cleanup(); staleSubmit();
    expect(submit).not.toHaveBeenCalled(); submit.mockRestore();
  });
  it("정상 경로: 닫기 후 유예 안에 제출되면(인증 완료) 닫음 콜백이 실행되지 않는다", () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    const closed = vi.fn(); open(closed); win.nicepayClose!(); win.nicepaySubmit!(); vi.advanceTimersByTime(5000);
    expect(submit).toHaveBeenCalledTimes(1); expect(closed).not.toHaveBeenCalled(); submit.mockRestore();
  });
  it("닫기 콜백은 유예 후 한 번만 실행되고 정리는 여러 번 불러도 안전하다", () => {
    const closed = vi.fn(); const cleanup = open(closed); win.nicepayClose!(); win.nicepayClose!(); vi.advanceTimersByTime(1500);
    expect(closed).toHaveBeenCalledTimes(1); cleanup(); cleanup(); expect(forms()).toHaveLength(0);
  });
  it("goPay 가 예외를 던지면 form·핸들러를 정리하고 예외를 그대로 전달한다", () => {
    goPay.mockImplementationOnce(() => { throw new Error("boom"); });
    expect(() => open(vi.fn())).toThrow("boom"); expect(forms()).toHaveLength(0); expect(win.nicepayClose).toBeUndefined();
  });
});
