import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ admin: vi.fn(() => ({})), auth: vi.fn(), eligible: vi.fn() }));
vi.mock("../../lib/payments/server/nicepay/subscriptionReviewRuntime", () => ({
  subscriptionReviewAdmin: fake.admin,
  subscriptionReviewBearer: (r: Request) => r.headers.get("authorization") === "Bearer fixture-jwt" ? "fixture-jwt" : null,
  subscriptionReviewReadPort: () => ({ authenticatedUid: fake.auth, eligibleOwner: fake.eligible }),
}));
import { POST } from "../../app/api/billing/nicepay/registration-review/route";
import { POST as RETURN } from "../../app/api/billing/nicepay/registration-review/return/route";
import { GET as RESULT } from "../../app/api/billing/nicepay/registration-review/result/route";
import { SUBSCRIPTION_REVIEW_CENTER } from "../../lib/payments/nicepaySubscriptionReviewProtocol";
import { SUBSCRIPTION_REVIEW_UID } from "../../lib/payments/server/nicepay/subscriptionReview";

const origin = "http://localhost:3409", route = origin + "/api/billing/nicepay/registration-review";
const key = "A".repeat(86) + "==", mid = "fixtur00m1";
const req = (body: unknown, headers: Record<string, string> = {}) => new Request(route, { method: "POST", headers: { origin, authorization: "Bearer fixture-jwt", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function prepared() {
  const response = await POST(req({ action: "open", centerId: SUBSCRIPTION_REVIEW_CENTER }));
  const { params } = await response.json(); expect(response.status).toBe(200);
  return params as Record<string, string>;
}
function authForm(p: Record<string, string>) {
  return new URLSearchParams({ ...p, AuthResultCode: "0000", AuthToken: "T".repeat(40), TxTid: mid + "03012611091500000001", Signature: hash("T".repeat(40) + mid + "1000" + key) });
}
const callback = (p: Record<string, string>, body = authForm(p).toString(), type = "application/x-www-form-urlencoded") => RETURN(new Request(p.ReturnURL, { method: "POST", headers: { "content-type": type }, body }));
beforeEach(() => {
  vi.clearAllMocks(); fake.auth.mockResolvedValue(SUBSCRIPTION_REVIEW_UID); fake.eligible.mockResolvedValue(true); fake.admin.mockReturnValue({});
  for (const [name, value] of Object.entries({ NICEPAY_SUBSCRIPTION_REVIEW_ENABLED: "true", NICEPAY_SUBSCRIPTION_REVIEW_ORIGIN: origin,
    NICEPAY_SUBSCRIPTION_HOSTED_REVIEW_ENABLED: "true", NICEPAY_CHECKOUT_ENABLED: "false", NEXT_PUBLIC_PG_CHECKOUT_ENABLED: "false", NEXT_PUBLIC_BILLING_ENABLED: "false",
    NICEPAY_SUBSCRIPTION_MID: mid, NICEPAY_SUBSCRIPTION_MERCHANT_KEY: key, NICEPAY_SUBSCRIPTION_REVIEW_STATE_SECRET: "offline-review-fixture-".repeat(3),
  })) vi.stubEnv(name, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external calls forbidden"); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("offline HTTP integration: registration-only review", () => {
  it("defaults to OFF before any Auth/DB or PG dependency", async () => {
    vi.stubEnv("NICEPAY_SUBSCRIPTION_REVIEW_ENABLED", "false");
    expect((await POST(req({ action: "open", centerId: SUBSCRIPTION_REVIEW_CENTER }))).status).toBe(404);
    expect(fake.admin).not.toHaveBeenCalled();
    expect(await (await RETURN(new Request(route + "/return", { method: "POST", body: "" }))).text()).toContain("준비 중");
  });
  it("separates read-only capability from credential/network permission", async () => {
    vi.stubEnv("NICEPAY_SUBSCRIPTION_HOSTED_REVIEW_ENABLED", "false"); vi.stubEnv("NICEPAY_SUBSCRIPTION_MERCHANT_KEY", "");
    const check = await POST(req({ action: "check", centerId: SUBSCRIPTION_REVIEW_CENTER }));
    expect(await check.json()).toMatchObject({ allowed: true, provider: "nicepay", hostedAvailable: false, bidIssuanceEnabled: false, chargingEnabled: false, monthlyPrice: 39000 });
    const open = await POST(req({ action: "open", centerId: SUBSCRIPTION_REVIEW_CENTER })); expect(open.status).toBe(423); expect(await open.text()).not.toContain("params");
  });
  it.each([
    [{ origin: "https://evil.test" }, 403], [{ authorization: "" }, 401], [{ "content-type": "text/plain" }, 415], [{ "content-length": "99999" }, 413],
  ] as const)("rejects invalid headers %j", async (headers, status) => { expect((await POST(req({ action: "open", centerId: SUBSCRIPTION_REVIEW_CENTER }, headers))).status).toBe(status); expect(fake.admin).not.toHaveBeenCalled(); });
  it.each([{ action: "approve", centerId: SUBSCRIPTION_REVIEW_CENTER }, { action: "open", centerId: SUBSCRIPTION_REVIEW_CENTER, amount: 39000 }, { authKey: "toss", customerKey: "legacy" }, []])("rejects foreign/extra request fields", async body => { expect((await POST(req(body))).status).toBe(400); });
  it("rejects non-reviewer/non-owner/foreign center and missing server dependencies", async () => {
    expect((await POST(req({ action: "check", centerId: "other" }))).status).toBe(403);
    fake.auth.mockResolvedValueOnce("other"); expect((await POST(req({ action: "check", centerId: SUBSCRIPTION_REVIEW_CENTER }))).status).toBe(403);
    fake.eligible.mockResolvedValueOnce(false); expect((await POST(req({ action: "check", centerId: SUBSCRIPTION_REVIEW_CENTER }))).status).toBe(403);
    fake.admin.mockReturnValueOnce(null as unknown as object); expect((await POST(req({ action: "check", centerId: SUBSCRIPTION_REVIEW_CENTER }))).status).toBe(503);
  });
  it("finishes valid authentication with NO BID/charge/DB writes and never reflects raw data", async () => {
    const p = await prepared(), form = authForm(p);
    form.set("CardNo", "sensitive-card-fixture"); form.set("AuthResultMsg", "<script>hostile-message</script>"); form.set("NextAppURL", "https://evil.test");
    const response = await callback(p, form.toString()), html = await response.text();
    expect(html).toContain("인증 결과 확인 · 카드 미등록"); expect(html).toContain("빌링키(BID)를 발급하거나 저장하지 않았습니다");
    for (const value of ["sensitive-card-fixture", "hostile-message", "evil.test", p.MID, p.Moid, p.ReqReserved, "T".repeat(40)]) expect(html).not.toContain(value);
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'"); expect(html).not.toContain("<script");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self' https://pg-web.nicepay.co.kr https://dc1-web.nicepay.co.kr");
    expect(html).toContain('target="_top"');
    expect(response.headers.get("location")).toBeNull(); // no query tokens and no legacy Toss callback
  });
  it("rejects duplicate protocol keys, oversized body, unsupported encoding and altered state", async () => {
    const p = await prepared();
    for (const response of [await callback(p, authForm(p) + "&MID=duplicate"), await callback(p, "x=" + "x".repeat(8200)), await callback(p, "{}", "application/json"), await RETURN(new Request(p.ReturnURL + "&rt=duplicate", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: authForm(p) }))]) expect(await response.text()).toContain("인증 결과를 확인할 수 없어요");
  });
  it("rechecks owner eligibility on return and keeps forged GET results informational", async () => {
    const p = await prepared(); fake.eligible.mockResolvedValueOnce(false);
    expect(await (await callback(p)).text()).toContain("인증 결과를 확인할 수 없어요");
    expect(await (await RESULT()).text()).toContain("심사용 확인 종료");
  });
});
