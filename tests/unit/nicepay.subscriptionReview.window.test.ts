// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openRegistrationWindow, type RegistrationWindow } from "../../lib/payments/nicepaySubscriptionReviewWindow";
import { prepareRegistration } from "../../lib/payments/server/nicepay/subscriptionReview";
import type { RegistrationParams } from "../../lib/payments/nicepaySubscriptionReviewProtocol";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });
const params = () => prepareRegistration({ origin: window.location.origin, hostedEnabled: true }, { kind: "nicepay-subscription-registration", mid: "fixtur00m1", merchantKey: "A".repeat(86) + "==", stateSecret: "offline-only-".repeat(4) }) as RegistrationParams;
describe("offline NICEPAY SDK form boundary", () => {
  it("passes BillAuthYN=Y and strips all card/personal fields from desktop callback forwarding", () => {
    const win = window as RegistrationWindow;
    let sent: FormData | undefined;
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) { sent = new FormData(this); });
    win.goPay = form => {
      expect(new FormData(form).get("BillAuthYN")).toBe("Y"); expect(new FormData(form).get("Amt")).toBe("1000"); expect(form.acceptCharset).toBe("euc-kr");
      for (const [name, value] of Object.entries({ AuthResultCode: "0000", AuthToken: "T".repeat(40), TxTid: "fixtur00m103012611091500000001", Signature: "f".repeat(64), CardNo: "never-forward-card-fixture", BuyerName: "never-forward-person", EncData: "never-forward-encrypted" })) {
        const input = document.createElement("input"); input.name = name; input.value = value; form.appendChild(input);
      }
      win.nicepaySubmit!(); win.nicepaySubmit?.();
    };
    const closed = vi.fn(), dispose = openRegistrationWindow(params(), document, win, closed);
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1);
    expect(sent!.get("AuthToken")).toBe("T".repeat(40)); expect(sent!.get("BillAuthYN")).toBe("Y");
    for (const key of ["CardNo", "BuyerName", "EncData", "SignData", "GoodsName"]) expect(sent!.has(key)).toBe(false);
    expect(document.querySelector("form")).toBeNull(); expect(closed).not.toHaveBeenCalled(); dispose(); delete win.goPay;
  });
  it("closes without submission and invalidates late callbacks after disposal", () => {
    vi.useFakeTimers(); const win = window as RegistrationWindow;
    win.goPay = vi.fn(); const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {}), closed = vi.fn();
    const dispose = openRegistrationWindow(params(), document, win, closed), staleSubmit = win.nicepaySubmit!, staleClose = win.nicepayClose!;
    staleClose(); vi.advanceTimersByTime(1500); expect(closed).toHaveBeenCalledTimes(1);
    staleSubmit(); staleClose(); dispose(); vi.runAllTimers(); expect(submit).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledTimes(1); delete win.goPay;
  });
});
