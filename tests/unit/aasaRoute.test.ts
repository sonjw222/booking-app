import { describe, expect, it } from "vitest";
import { AASA, AASA_BUNDLE_ID, AASA_TEAM_ID, GET } from "../../app/.well-known/apple-app-site-association/route";
import { resolvePaymentCallbackTarget } from "../../lib/paymentUniversalLink";

describe("AASA 라우트 회귀 방지(Universal Link는 결제 복귀 두 경로만)", () => {
  it("200 + application/json + appID/components가 entitlement·앱 라우팅 허용 경로와 일치", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual(AASA);
    expect(body.applinks.details[0].appIDs).toEqual([`${AASA_TEAM_ID}.${AASA_BUNDLE_ID}`]);
    const paths = body.applinks.details[0].components.map((c: { "/": string }) => c["/"]);
    expect(paths).toEqual(["/checkout/success", "/checkout/fail"]);
    // AASA가 약속한 경로는 앱 라우팅 helper가 받아주는 경로와 정확히 같다
    for (const p of paths) expect(resolvePaymentCallbackTarget(`https://mwhabit.com${p}?x=1`)).toBe(`${p}?x=1`);
    expect(resolvePaymentCallbackTarget("https://mwhabit.com/login")).toBeNull();
  });
});
