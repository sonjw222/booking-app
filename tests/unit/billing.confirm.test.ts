// app/api/billing/confirm/route.ts — 2026-09-14 변경분만 검증한다(기존 authKey→
// billingKey 교환/최초결제 로직 자체는 2026-09-11 배치에서 이미 구현됨, 여기서는
// 그걸 다시 재구현하지 않는다):
//   1) payment_failed 상태도 재등록(claim) 대상에 포함되고, 성공 시 retry_count가
//      0으로 리셋된다 (add_center_subscription_billing_retry_policy.sql 정책)
//   2) 원자적 claim으로 이미 active/canceled인 구독, 또는 다른 요청이 방금 선점한
//      구독은 409로 막힌다
//   3) customerKey가 centerId와 짝이 안 맞으면 400 (기존 방어, 회귀 확인)
//
// 실제 카드 결제는 절대 실행하지 않는다 — 토스 fetch는 전부 스텁.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  center_id: string;
  status: string;
  retry_count: number;
  billing_locked_until: string | null;
  plan_id: string;
};

const PLAN = { id: "plan-1", name: "모하빗 센터 이용권", monthly_price: 39000 };
let subs: Row[] = [];
const charges: any[] = [];

function makeRow(overrides: Partial<Row>): Row {
  const defaults: Row = {
    id: "sub-1", center_id: "center-1", status: "pending_billing_setup",
    retry_count: 0, billing_locked_until: null, plan_id: PLAN.id,
  };
  return { ...defaults, ...overrides };
}

function fakeCenterSubscriptionsQuery() {
  let patch: Record<string, unknown> = {};
  const filters: Array<(r: Row) => boolean> = [];
  const builder: any = {
    update(p: Record<string, unknown>) { patch = p; return builder; },
    in(field: keyof Row, vals: unknown[]) { filters.push((r) => vals.includes(r[field] as any)); return builder; },
    eq(field: keyof Row, val: unknown) { filters.push((r) => r[field] === val); return builder; },
    or(_expr: string) {
      const now = new Date().toISOString();
      filters.push((r) => r.billing_locked_until === null || r.billing_locked_until < now);
      return builder;
    },
    select(_cols?: string) {
      const matches = subs.filter((r) => filters.every((f) => f(r)));
      matches.forEach((r) => Object.assign(r, patch));
      return {
        maybeSingle: () => Promise.resolve({
          data: matches[0] ? { ...matches[0], subscription_plans: { name: PLAN.name, monthly_price: PLAN.monthly_price } } : null,
          error: null,
        }),
      };
    },
    then(resolve: (v: any) => void) {
      const matches = subs.filter((r) => filters.every((f) => f(r)));
      matches.forEach((r) => Object.assign(r, patch));
      resolve({ data: null, error: null });
    },
  };
  return builder;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      if (table === "center_subscriptions") return fakeCenterSubscriptionsQuery();
      if (table === "center_subscription_charges") return { insert: (p: any) => { charges.push(p); return Promise.resolve({ data: null, error: null }); } };
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

function mockToss(issueOk: boolean, chargeOk: boolean) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
    if (url.includes("/authorizations/issue")) {
      return Promise.resolve({
        ok: issueOk, status: issueOk ? 200 : 400,
        json: () => Promise.resolve(issueOk
          ? { billingKey: "new-billing-key", card: { issuerCode: "51", number: "1234567890121234" } }
          : { message: "authKey 오류" }),
      });
    }
    return Promise.resolve({
      ok: chargeOk, status: chargeOk ? 200 : 402,
      json: () => Promise.resolve(chargeOk ? { paymentKey: "pay_1" } : { message: "첫 결제 실패" }),
    });
  }));
}

function confirmRequest(body: Record<string, unknown>) {
  return import("../../app/api/billing/confirm/route").then(({ POST }) =>
    POST(new Request("http://localhost/api/billing/confirm", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }))
  );
}

beforeEach(() => {
  subs = [];
  charges.length = 0;
  vi.unstubAllGlobals();
});

describe("POST /api/billing/confirm — payment_failed 재등록", () => {
  it("payment_failed 구독도 재등록 대상이고, 성공하면 active + retry_count 0으로 리셋된다", async () => {
    subs.push(makeRow({ status: "payment_failed", retry_count: 7 }));
    mockToss(true, true);

    const res = await confirmRequest({ authKey: "auth-1", customerKey: "center-center-1", centerId: "center-1" });
    expect(res.status).toBe(200);
    expect(subs[0].status).toBe("active");
    expect(subs[0].retry_count).toBe(0);
  });
});

describe("POST /api/billing/confirm — 대상 아님/경합", () => {
  it("이미 active인 구독은 409로 막힌다(중복 등록 방지)", async () => {
    subs.push(makeRow({ status: "active" }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await confirmRequest({ authKey: "auth-1", customerKey: "center-center-1", centerId: "center-1" });
    expect(res.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("canceled 구독은 재등록 대상이 아니다(오너가 재등록하려면 먼저 취소를 되돌려야 함)", async () => {
    subs.push(makeRow({ status: "canceled" }));
    const res = await confirmRequest({ authKey: "auth-1", customerKey: "center-center-1", centerId: "center-1" });
    expect(res.status).toBe(409);
  });

  it("customerKey가 centerId와 짝이 안 맞으면 400 (형식 위조 방지)", async () => {
    subs.push(makeRow({ status: "pending_billing_setup" }));
    const res = await confirmRequest({ authKey: "auth-1", customerKey: "center-다른센터", centerId: "center-1" });
    expect(res.status).toBe(400);
  });

  it("다른 요청이 방금 선점한(리스가 살아있는) 구독은 409로 막힌다(권한 없는/경합 요청 방어)", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    subs.push(makeRow({ status: "pending_billing_setup", billing_locked_until: future }));
    const res = await confirmRequest({ authKey: "auth-1", customerKey: "center-center-1", centerId: "center-1" });
    expect(res.status).toBe(409);
  });
});
