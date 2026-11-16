import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHENTICATION_AMOUNT, SUBSCRIPTION_REVIEW_CENTER, validateRegistrationParams } from "../../lib/payments/nicepaySubscriptionReviewProtocol";
import { assertBidIssuanceAllowed, authorizeSubscriptionReview, NICEPAY_BID_ISSUANCE_ENABLED, prepareRegistration, registrationCredentials, registrationIssueSignData, SUBSCRIPTION_REVIEW_UID, subscriptionReviewSettings, verifyRegistrationAttempt, verifyRegistrationReturn } from "../../lib/payments/server/nicepay/subscriptionReview";
import { NICEPAY_BILLING_ACTIVATED } from "../../lib/payments/server/nicepay/billing";

// Invented fixtures only. No contract key, production env file or external transport.
const REVIEW_ENV = {
  NICEPAY_SUBSCRIPTION_REVIEW_ENABLED: "true", NICEPAY_SUBSCRIPTION_REVIEW_ORIGIN: "http://localhost:3409",
  NICEPAY_CHECKOUT_ENABLED: "false", NEXT_PUBLIC_PG_CHECKOUT_ENABLED: "false", NEXT_PUBLIC_BILLING_ENABLED: "false",
  NICEPAY_SUBSCRIPTION_HOSTED_REVIEW_ENABLED: "true", NICEPAY_SUBSCRIPTION_MID: "fixtur00m1",
  NICEPAY_SUBSCRIPTION_MERCHANT_KEY: "A".repeat(86) + "==", NICEPAY_SUBSCRIPTION_REVIEW_STATE_SECRET: "offline-review-fixture-".repeat(3),
};
const c = registrationCredentials(REVIEW_ENV)!, settings = subscriptionReviewSettings(REVIEW_ENV)!;
const date = new Date("2026-11-09T06:00:00Z"), now = date.getTime() / 1000;
const port = { authenticatedUid: vi.fn(), eligibleOwner: vi.fn() };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const p = prepareRegistration(settings, c, date)!;
  const form = { MID: c.mid, Moid: p.Moid, Amt: "1000", PayMethod: "CARD", BillAuthYN: "Y", AuthResultCode: "0000", AuthToken: "T".repeat(40), TxTid: c.mid + "03012611091500000001", Signature: hash("T".repeat(40) + c.mid + "1000" + c.merchantKey), ReqReserved: p.ReqReserved };
  return { p, form };
}
beforeEach(() => { vi.clearAllMocks(); port.authenticatedUid.mockResolvedValue(SUBSCRIPTION_REVIEW_UID); port.eligibleOwner.mockResolvedValue(true); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("subscription registration review protocol and hard boundaries", () => {
  it.each(["NICEPAY_SUBSCRIPTION_REVIEW_ENABLED", "NICEPAY_CHECKOUT_ENABLED", "NEXT_PUBLIC_PG_CHECKOUT_ENABLED", "NEXT_PUBLIC_BILLING_ENABLED"])("fails closed for missing %s", key => { expect(subscriptionReviewSettings({ ...REVIEW_ENV, [key]: undefined })).toBeNull(); });
  it.each(["NICEPAY_BID_ISSUANCE_ENABLED", "NICEPAY_BILLING_ENABLED", "NEXT_PUBLIC_BILLING_ENABLED"])("rejects accidentally enabled %s", key => { expect(subscriptionReviewSettings({ ...REVIEW_ENV, [key]: "true" })).toBeNull(); });
  it.each(["https://evil.test/path", "https://user:pass@example.test", "javascript:alert(1)", "http://example.test", "https://example.test/?x=1"])("rejects invalid configured origin %s", origin => { expect(subscriptionReviewSettings({ ...REVIEW_ENV, NICEPAY_SUBSCRIPTION_REVIEW_ORIGIN: origin })).toBeNull(); });
  it("allows capability checks without credentials or hosted gate", () => {
    expect(subscriptionReviewSettings({ ...REVIEW_ENV, NICEPAY_SUBSCRIPTION_HOSTED_REVIEW_ENABLED: "false" })?.hostedEnabled).toBe(false);
    expect(registrationCredentials({})).toBeNull();
    expect(prepareRegistration({ ...settings, hostedEnabled: false }, c)).toBeNull();
    expect(registrationCredentials({ ...REVIEW_ENV, NICEPAY_MID: c.mid })).toBeNull();
    expect(registrationCredentials({ ...REVIEW_ENV, NICEPAY_MERCHANT_KEY: c.merchantKey })).toBeNull();
  });
  it("requires both pinned reviewer and server-confirmed ownership", async () => {
    expect(await authorizeSubscriptionReview(null, SUBSCRIPTION_REVIEW_CENTER, port)).toBe(false);
    expect(await authorizeSubscriptionReview("jwt", "other", port)).toBe(false);
    expect(port.authenticatedUid).not.toHaveBeenCalled();
    port.authenticatedUid.mockResolvedValueOnce("other"); expect(await authorizeSubscriptionReview("jwt", SUBSCRIPTION_REVIEW_CENTER, port)).toBe(false);
    port.eligibleOwner.mockResolvedValueOnce(false); expect(await authorizeSubscriptionReview("jwt", SUBSCRIPTION_REVIEW_CENTER, port)).toBe(false);
    port.eligibleOwner.mockRejectedValueOnce(new Error("offline")); expect(await authorizeSubscriptionReview("jwt", SUBSCRIPTION_REVIEW_CENTER, port)).toBe(false);
    expect(await authorizeSubscriptionReview("jwt", SUBSCRIPTION_REVIEW_CENTER, port)).toBe(true);
  });
  it("builds the documented non-charge amount, KST signature and subscription-only ReturnURL", () => {
    const { p } = fixture();
    expect(p).toMatchObject({ Amt: AUTHENTICATION_AMOUNT, PayMethod: "CARD", BillAuthYN: "Y", EdiDate: "20261109150000", CharSet: "utf-8" });
    expect(p.SignData).toBe(hash("20261109150000" + c.mid + "1000" + c.merchantKey));
    expect(p.Moid).toMatch(/^sub-reg-/); expect(p.ReturnURL).toContain("/api/billing/nicepay/registration-review/return?rt=");
    expect(JSON.stringify(p)).not.toContain(c.merchantKey); expect(JSON.stringify(p)).not.toContain(c.stateSecret);
    expect(validateRegistrationParams(p, settings.origin)).toEqual(p);
    expect(p.ReqReserved.length).toBeLessThanOrEqual(500);
    expect(p.ReturnURL.length).toBeLessThanOrEqual(500);
    expect(prepareRegistration({ ...settings, origin: "https://" + "x".repeat(240) + ".test" }, c, date)).toBeNull();
  });
  it.each(["MID", "Moid", "Amt", "PayMethod", "BillAuthYN", "AuthResultCode", "AuthToken", "TxTid", "Signature", "ReqReserved"])("rejects missing response %s", async key => {
    const { p, form } = fixture(); const bad = { ...form } as Record<string, string>; delete bad[key];
    expect(await verifyRegistrationReturn(bad, p.ReqReserved, c, port, now)).toBe("invalid");
  });
  it.each([
    ["MID", "different1"], ["Moid", "sub-first-forged"], ["Amt", "39000"], ["Amt", "01000"], ["PayMethod", "BANK"], ["BillAuthYN", "N"],
    ["AuthResultCode", "success"], ["AuthToken", "x"], ["AuthToken", "한".repeat(40)], ["TxTid", "x".repeat(30)], ["Signature", "０".repeat(64)], ["Signature", "0".repeat(64)], ["ReqReserved", "tampered"],
  ])("rejects altered response %s", async (key, value) => { const { p, form } = fixture(); expect(await verifyRegistrationReturn({ ...form, [key]: value }, p.ReqReserved, c, port, now)).toBe("invalid"); });
  it("valid authentication stops before BID and charging; repeated returns have no side effects", async () => {
    const { p, form } = fixture();
    expect(await verifyRegistrationReturn(form, p.ReqReserved, c, port, now)).toBe("auth-verified-no-bid");
    expect(await verifyRegistrationReturn(form, p.ReqReserved, c, port, now)).toBe("auth-verified-no-bid");
    expect(port.eligibleOwner).toHaveBeenCalledTimes(2);
    expect(NICEPAY_BID_ISSUANCE_ENABLED).toBe(false); expect(NICEPAY_BILLING_ACTIVATED).toBe(false);
    expect(assertBidIssuanceAllowed).toThrow("nicepay_bid_issuance_disabled");
  });
  it("rejects expired/future/tampered attempts and callbacks from a different attempt", async () => {
    const { p, form } = fixture();
    expect(verifyRegistrationAttempt(p.ReqReserved, c, now - 1)).toBeNull();
    expect(verifyRegistrationAttempt(p.ReqReserved, c, now + 600)).toBeNull();
    expect(verifyRegistrationAttempt(p.ReqReserved + "x", c, now)).toBeNull();
    expect(await verifyRegistrationReturn(form, fixture().p.ReqReserved, c, port, now)).toBe("invalid");
  });
  it("rechecks eligibility after auth, including revocation or DB failure", async () => {
    const { p, form } = fixture(); port.eligibleOwner.mockResolvedValueOnce(false);
    expect(await verifyRegistrationReturn(form, p.ReqReserved, c, port, now)).toBe("invalid");
    port.eligibleOwner.mockRejectedValueOnce(new Error("denied")); expect(await verifyRegistrationReturn(form, p.ReqReserved, c, port, now)).toBe("invalid");
  });
  it("never describes a failed auth as registered; failure without a verified envelope is invalid", async () => {
    const { p, form } = fixture(); expect(await verifyRegistrationReturn({ ...form, AuthResultCode: "9999", TxTid: "" }, p.ReqReserved, c, port, now)).toBe("authentication-failed");
    expect(await verifyRegistrationReturn({ Moid: p.Moid, AuthResultCode: "9999" }, p.ReqReserved, c, port, now)).toBe("invalid");
  });
  it("rejects extra browser fields and cross-domain/legacy ReturnURLs", () => {
    const { p } = fixture();
    for (const bad of [{ ...p, MerchantKey: "never" }, { ...p, CardNo: "never" }, { ...p, Amt: "39000" }, { ...p, ReturnURL: "https://evil.test" }, { ...p, ReturnURL: settings.origin + "/api/billing/confirm" }, { ...p, ReturnURL: p.ReturnURL + "&rt=duplicate" }]) expect(validateRegistrationParams(bad, settings.origin)).toBeNull();
  });
  it("calculates the issuer specification offline without providing an issuance transport", () => {
    const tid = c.mid + "03012611091500000001";
    expect(registrationIssueSignData(tid, "20261109150000", c)).toBe(hash(tid + c.mid + "20261109150000" + c.merchantKey));
    expect(() => registrationIssueSignData("forged", "20261109150000", c)).toThrow();
  });
});
