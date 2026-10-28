import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNicepayRefund } from "../../lib/payments/server/nicepay/runtime";
import type { SupabaseClient } from "@supabase/supabase-js";

/* 코드 상수 NICEPAY_CHECKOUT_ACTIVATED=false 인 동안 NICEPAY 서버 경로(prepare / 인증 복귀 / 상태 / 취소(abandon) / 웹훅 / 환불·취소 핸들러)는
   NICEPAY 설정·키가 환경에 모두 있어도 어떤 외부 호출(fetch)도, DB 클라이언트 생성도 하지 않고 503/undefined 로 거부한다. fetch 를 전부 가로채 호출 0건을 단언한다. */
const ENV = { NICEPAY_CHECKOUT_ENABLED: "true", NICEPAY_API_FAMILY: "v3_mid", NICEPAY_ENV: "production", NICEPAY_MID: "unit-mid", NICEPAY_MERCHANT_KEY: "unit-key", NICEPAY_RETURN_BASE_URL: "https://app.example.test", PAYMENT_RETURN_TOKEN_SECRET: "unit-secret", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54421", SUPABASE_SERVICE_ROLE_KEY: "unit-service", NEXT_PUBLIC_PAYMENT_PROVIDER: "nicepay" };
const saved: Record<string, string | undefined> = {}; let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } fetchSpy = vi.fn(async () => { throw new Error("외부 호출 금지"); }); vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } vi.unstubAllGlobals(); });

const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("http://localhost/x", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
describe("NICEPAY 서버 경로 — 코드 비활성 동안 외부 호출 0건", () => {
  for (const name of ["prepare", "return", "status", "abandon", "webhook"] as const) {
    it(`/api/payments/nicepay/${name}: 설정이 완전해도 503, fetch 호출 0건`, async () => {
      const { POST } = await import(`../../app/api/payments/nicepay/${name}/route`);
      const form = name === "return" ? new URLSearchParams({ Moid: "00000000-0000-4000-8000-000000000000", AuthResultCode: "0000", AuthToken: "t", Amt: "1000", MID: "unit-mid", Signature: "0".repeat(64), NextAppURL: "https://webapi.nicepay.co.kr/webapi/pay_process.jsp" }).toString() : null;
      const res = await POST(name === "return" ? post(form, { "content-type": "application/x-www-form-urlencoded" }) : post(JSON.stringify({ orderId: "00000000-0000-4000-8000-000000000000" }), { authorization: "Bearer unit" }));
      expect(res.status).toBe(503); expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
  it("환불·취소 핸들러(buildNicepayRefund)는 비활성이면 undefined — NICEPAY 환불은 501 fail-closed(핸들러 없음), 외부 호출 0건", () => {
    expect(buildNicepayRefund({} as SupabaseClient, {} as never)).toBeUndefined(); expect(fetchSpy).not.toHaveBeenCalled();
  });
});
