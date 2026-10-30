import { describe, it, expect } from "vitest";
// @ts-expect-error — 순수 .mjs 스크립트(타입 선언 없음)
import { runPreflight } from "../../scripts/qa/nicepayAuthOnlyPreflight.mjs";

const good = {
  NICEPAY_MID: "nicepay00m", NICEPAY_QA_AUTH_ONLY: "true", NICEPAY_CHECKOUT_ENABLED: "true", NICEPAY_API_FAMILY: "v3_mid", NICEPAY_ENV: "sandbox",
  NEXT_PUBLIC_PAYMENT_PROVIDER: "nicepay", NICEPAY_RETURN_BASE_URL: "http://localhost:3100", PAYMENT_RETURN_TOKEN_SECRET: "s", NICEPAY_MERCHANT_KEY: "k",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "r", NEXT_PUBLIC_SUPABASE_ANON_KEY: "a",
};
type Row = { name: string; status: string; note: string };
const fails = async (env: Record<string, string>) => (await runPreflight(env) as Row[]).filter((r) => r.status === "FAIL");

describe("NICEPAY auth-only 사전 점검 스크립트", () => {
  it("안전한 설정은 FAIL 0", async () => { expect(await fails(good)).toEqual([]); });
  it("운영 MID·운영 Supabase·일반회원 결제 ON·키 누락은 FAIL", async () => {
    expect((await fails({ ...good, NICEPAY_MID: "mwhabit01m" })).length).toBeGreaterThan(0);
    expect((await fails({ ...good, NEXT_PUBLIC_SUPABASE_URL: "https://bxntqggkfwnhcczsbqtj.supabase.co" })).length).toBeGreaterThan(0);
    expect((await fails({ ...good, NEXT_PUBLIC_PG_CHECKOUT_ENABLED: "true" })).length).toBeGreaterThan(0);
    const { NICEPAY_MERCHANT_KEY: _k, ...noKey } = good; void _k;
    expect((await fails(noKey)).length).toBeGreaterThan(0);
  });
  it("출력(행)에 MerchantKey·MID·URL 값이 들어가지 않는다", async () => {
    const out = JSON.stringify(await runPreflight({ ...good, NICEPAY_MERCHANT_KEY: "SECRET-KEY-VALUE-123" }));
    expect(out).not.toContain("SECRET-KEY-VALUE-123"); expect(out).not.toContain("127.0.0.1");
  });
});
