// @vitest-environment node
/* NICEPAY v3(MID) 결제창 준비(서버) — 공식 문서 공식 SignData = sha256(EdiDate + MID + Amt + MerchantKey), 키는 응답에 없다, 금액은 DB 주문 금액. 가짜 DB 만 쓴다(실제 NICEPAY 호출 없음). */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handlePrepare, type FlowDeps } from "../../lib/payments/server/nicepay/flow";
import { validateNicepayV3Params } from "../../lib/payments/nicepayV3Window";

const ORDER = "22222222-2222-4222-8222-222222222222", MID = "testmid01m", KEY = "TEST_MERCHANT_KEY_NOT_REAL_0123456789", RET = "https://app.example.test";
const flow = (over: Partial<{ amount: number; provider: string; status: string; gate: boolean }> = {}): FlowDeps => ({
  config: { family: "v3_mid", mid: MID, merchantKey: KEY, env: "sandbox", returnBaseUrl: RET }, returnTokenSecret: "rt_secret_for_tests",
  getAuthUid: async (t: string) => (t === "tok" ? "u1" : null),
  ownedOrder: async (id: string, uid: string) => (id === ORDER && uid === "u1" ? { orderId: ORDER, status: over.status ?? "pending", amount: over.amount ?? 12000, provider: over.provider ?? "nicepay" } : null),
  gateAllows: async () => over.gate ?? true,
} as unknown as FlowDeps);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("v3 결제창 준비(prepare)", () => {
  it("SignData 는 공식 공식과 같고, MerchantKey 는 응답 어디에도 없다", async () => {
    const r = await handlePrepare({ token: "tok", orderId: ORDER, orderName: "[심사용] 4주 수업 이용권" }, flow(), new Date("2026-10-29T03:04:05Z"));
    expect(r.status).toBe(200);
    const p = r.body.params as Record<string, string>;
    expect(r.body.family).toBe("v3_mid");
    expect(p.SignData).toBe(sha(p.EdiDate + p.MID + p.Amt + KEY));
    expect(p.EdiDate).toMatch(/^\d{14}$/); expect(p.MID).toBe(MID); expect(p.Moid).toBe(ORDER); expect(p.PayMethod).toBe("CARD");
    expect(JSON.stringify(r.body)).not.toContain(KEY); expect(Object.keys(p).join()).not.toMatch(/key/i);
  });
  it("금액은 DB 주문 금액(요청이 보낸 금액은 받지 않는다) · ReturnURL 은 서버 복귀 경로 + 주문 전용 토큰", async () => {
    const r = await handlePrepare({ token: "tok", orderId: ORDER }, flow({ amount: 4000 }));
    const p = r.body.params as Record<string, string>;
    expect(p.Amt).toBe("4000"); expect(p.ReturnURL).toMatch(/^https:\/\/app\.example\.test\/api\/payments\/nicepay\/return\?rt=/);
    expect(p.ReturnURL).not.toContain(KEY);
  });
  it("로그인·본인 주문·pending·NICEPAY 주문·게이트 중 하나라도 아니면 결제창 파라미터를 주지 않는다", async () => {
    expect((await handlePrepare({ token: null, orderId: ORDER }, flow())).status).toBe(401);
    expect((await handlePrepare({ token: "other", orderId: ORDER }, flow())).status).toBe(401);
    expect((await handlePrepare({ token: "tok", orderId: ORDER }, flow({ provider: "toss" }))).status).toBe(400);
    expect((await handlePrepare({ token: "tok", orderId: ORDER }, flow({ status: "approving" }))).status).toBe(409);
    expect((await handlePrepare({ token: "tok", orderId: ORDER }, flow({ gate: false }))).status).toBe(403);
  });
  it("서버 응답을 브라우저 검증기가 통과시키고, 주문번호·금액이 다르면 거부한다(화면 금액과 실제 청구액 불일치 방지)", async () => {
    const r = await handlePrepare({ token: "tok", orderId: ORDER }, flow({ amount: 4000 }));
    const params = r.body.params;
    expect(validateNicepayV3Params(params, { orderId: ORDER, amount: 4000 }, RET).ok).toBe(true);
    expect(validateNicepayV3Params(params, { orderId: ORDER, amount: 4001 }, RET)).toMatchObject({ ok: false });
    expect(validateNicepayV3Params(params, { orderId: "other", amount: 4000 }, RET)).toMatchObject({ ok: false });
    expect(validateNicepayV3Params(params, { orderId: ORDER, amount: 4000 }, "https://evil.example.test")).toMatchObject({ ok: false });   // 복귀 주소는 같은 출처만
    expect(validateNicepayV3Params({ ...(params as object), MerchantKey: KEY }, { orderId: ORDER, amount: 4000 }, RET)).toMatchObject({ ok: false });   // 비밀 필드 거부
  });
});
