// @vitest-environment jsdom
/* NICEPAY v3 결제창(브라우저) — goPay 호출·콜백(nicepaySubmit/nicepayClose)·form 구성. 가짜 goPay(실제 NICEPAY 스크립트·결제창 아님). 결제창 호출과 승인은 분리: 이 모듈은 승인 요청 코드를 갖지 않는다. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NICEPAY_V3_SDK_URL, nicepayV3FormFields, openNicepayV3Window, type NicepayV3Params } from "../../lib/payments/nicepayV3Window";

const params: NicepayV3Params = { MID: "testmid01m", Moid: "33333333-3333-4333-8333-333333333333", Amt: "4000", GoodsName: "수강권", EdiDate: "20261029120000", SignData: "a".repeat(64), ReturnURL: "https://app.example.test/api/payments/nicepay/return?rt=abc", PayMethod: "CARD", CharSet: "utf-8" };
afterEach(() => { document.body.innerHTML = ""; vi.useRealTimers(); });

describe("openNicepayV3Window", () => {
  it("form 은 허용 필드만, 결제창 호출(goPay)은 form 하나로, 승인 관련 필드·키는 없다", () => {
    const goPay = vi.fn(); const win = { goPay } as unknown as Window & { goPay: (f: HTMLFormElement) => void };
    openNicepayV3Window(params, { doc: document, win });
    expect(goPay).toHaveBeenCalledTimes(1);
    const form = goPay.mock.calls[0][0] as HTMLFormElement;
    expect(form.method).toBe("post"); expect(form.action).toBe(params.ReturnURL); expect(form.getAttribute("accept-charset")).toBe("euc-kr");
    expect(Object.fromEntries(new FormData(form) as unknown as Iterable<[string, string]>)).toEqual({ MID: params.MID, Moid: params.Moid, Amt: "4000", GoodsName: "수강권", EdiDate: params.EdiDate, SignData: params.SignData, ReturnURL: params.ReturnURL, PayMethod: "CARD", CharSet: "utf-8" });
    expect(nicepayV3FormFields({ ...params, MerchantKey: "x" } as unknown as NicepayV3Params).map(([k]) => k)).not.toContain("MerchantKey");
  });
  it("PC: 인증이 끝나 nicepaySubmit() 이 불리면 같은 form 을 서버 ReturnURL 로 제출한다(브라우저가 승인을 요청하지 않는다)", () => {
    const goPay = vi.fn(); const win = { goPay } as unknown as Window & { goPay: (f: HTMLFormElement) => void; nicepaySubmit?: () => void };
    openNicepayV3Window(params, { doc: document, win });
    const form = goPay.mock.calls[0][0] as HTMLFormElement; const submit = vi.spyOn(form, "submit").mockImplementation(() => {});
    win.nicepaySubmit!(); expect(submit).toHaveBeenCalledTimes(1);
  });
  it("결제창을 그냥 닫으면(제출 없음) 유예 후 한 번만 닫힘 콜백, 제출했으면 닫힘 이벤트가 와도 주문을 건드리지 않는다", () => {
    vi.useFakeTimers();
    const goPay = vi.fn(); const win = { goPay } as unknown as Window & { goPay: (f: HTMLFormElement) => void; nicepaySubmit?: () => void; nicepayClose?: () => void };
    const onClosed = vi.fn(); openNicepayV3Window(params, { doc: document, win, onClosedBeforeSubmit: onClosed, closeGraceMs: 100 });
    win.nicepayClose!(); vi.advanceTimersByTime(150); expect(onClosed).toHaveBeenCalledTimes(1);
    const goPay2 = vi.fn(); const win2 = { goPay: goPay2 } as unknown as Window & { goPay: (f: HTMLFormElement) => void; nicepaySubmit?: () => void; nicepayClose?: () => void };
    const onClosed2 = vi.fn(); openNicepayV3Window(params, { doc: document, win: win2, onClosedBeforeSubmit: onClosed2, closeGraceMs: 100 });
    vi.spyOn(goPay2.mock.calls[0][0] as HTMLFormElement, "submit").mockImplementation(() => {});
    win2.nicepaySubmit!(); win2.nicepayClose!(); vi.advanceTimersByTime(150); expect(onClosed2).not.toHaveBeenCalled();
  });
  it("SDK(goPay)가 없으면 throw — 결제창을 연 것처럼 처리하지 않는다", () => {
    expect(() => openNicepayV3Window(params, { doc: document, win: {} as unknown as Window })).toThrow();
  });
  it("모듈 안에 승인/키 코드가 없다(결제창 호출만)", () => {
    const src = readFileSync(path.resolve(__dirname, "../../lib/payments/nicepayV3Window.ts"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
    expect(src).not.toMatch(/NextAppURL|approve|process\.env|fetch\(/); expect(NICEPAY_V3_SDK_URL).toBe("https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js");
  });
});
