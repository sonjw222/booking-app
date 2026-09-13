// app/api/billing/charge-due/route.ts(정기 청구 + 2026-09-14 확정 연체 정책: 하루 1회
// 재시도, 최대 7회/7일, 소진 시 payment_failed로 자동중지, 카드 만료/분실 등 재시도
// 무의미한 오류는 즉시 payment_failed)를 실제 Supabase/토스 없이 검증한다.
//
// createClient()가 반환하는 admin 클라이언트를 완전히 가짜(in-memory)로 대체하고,
// 토스 API 호출(global.fetch)도 시나리오별로 원하는 응답을 주도록 스텁한다 — 실제
// 카드 결제는 절대 실행되지 않는다.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  center_id: string;
  status: string;
  billing_key: string | null;
  billing_customer_key: string | null;
  next_billing_date: string | null;
  retry_count: number;
  billing_locked_until: string | null;
  plan_id: string;
};

const PLAN = { id: "plan-1", name: "모하빗 센터 이용권", monthly_price: 39000 };

let subs: Row[] = [];
const charges: any[] = [];

function makeRow(overrides: Partial<Row>): Row {
  // 주의: ??로 필드별 기본값을 주면 overrides에 명시적으로 null을 넘긴 케이스(예:
  // billing_key: null)가 기본값으로 되돌아가버린다(null ?? 기본값 === 기본값) —
  // 반드시 스프레드로 overrides가 defaults를 덮어쓰게 한다.
  const defaults: Row = {
    id: "sub-1", center_id: "center-1", status: "active",
    billing_key: "billing-key-1", billing_customer_key: "center-center-1",
    next_billing_date: "2026-09-10", retry_count: 0, billing_locked_until: null,
    plan_id: PLAN.id,
  };
  return { ...defaults, ...overrides };
}

// center_subscriptions 전용 가짜 쿼리 빌더 — claim(.select() 있음)과 단순 업데이트
// (.select() 없이 await, .eq()만) 두 형태를 실제 라우트가 쓰는 그대로 지원한다.
function fakeCenterSubscriptionsQuery() {
  let patch: Record<string, unknown> = {};
  const filters: Array<(r: Row) => boolean> = [];
  const builder: any = {
    update(p: Record<string, unknown>) { patch = p; return builder; },
    in(field: keyof Row, vals: unknown[]) {
      filters.push((r) => vals.includes(r[field] as any));
      return builder;
    },
    lte(field: keyof Row, val: string) {
      filters.push((r) => (r[field] as any) !== null && (r[field] as any) <= val);
      return builder;
    },
    eq(field: keyof Row, val: unknown) {
      filters.push((r) => r[field] === val);
      return builder;
    },
    or(_expr: string) {
      // 이 라우트가 쓰는 유일한 or() 패턴: 리스가 비었거나 만료됐을 것.
      const now = new Date().toISOString();
      filters.push((r) => r.billing_locked_until === null || r.billing_locked_until < now);
      return builder;
    },
    select(_cols?: string) {
      const matches = subs.filter((r) => filters.every((f) => f(r)));
      matches.forEach((r) => Object.assign(r, patch));
      return Promise.resolve({
        data: matches.map((r) => ({ ...r, subscription_plans: r.plan_id === PLAN.id ? { name: PLAN.name, monthly_price: PLAN.monthly_price } : null })),
        error: null,
      });
    },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      try {
        const matches = subs.filter((r) => filters.every((f) => f(r)));
        matches.forEach((r) => Object.assign(r, patch));
        resolve({ data: matches, error: null });
      } catch (e) { reject?.(e); }
    },
  };
  return builder;
}

function fakeChargesQuery() {
  return {
    insert(payload: any) { charges.push(payload); return Promise.resolve({ data: null, error: null }); },
  };
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      if (table === "center_subscriptions") return fakeCenterSubscriptionsQuery();
      if (table === "center_subscription_charges") return fakeChargesQuery();
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

const CRON_SECRET = "unit-test-placeholder-cron-secret"; // vitest.config.ts와 동일

function post(headers: Record<string, string> = { "x-cron-secret": CRON_SECRET }) {
  return import("../../app/api/billing/charge-due/route").then(({ POST }) =>
    POST(new Request("http://localhost/api/billing/charge-due", { method: "POST", headers }))
  );
}

function mockToss(response: { ok: boolean; body: any }) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.ok ? 200 : 400,
    json: () => Promise.resolve(response.body),
  }));
}

beforeEach(() => {
  subs = [];
  charges.length = 0;
  vi.unstubAllGlobals();
});

describe("POST /api/billing/charge-due — 인증", () => {
  it("x-cron-secret이 없거나 틀리면 401을 반환하고 DB/토스에 전혀 접근하지 않는다", async () => {
    subs.push(makeRow({ next_billing_date: "2026-09-01" }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post({ "x-cron-secret": "wrong" });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(subs[0].status).toBe("active"); // 손대지 않음
  });
});

describe("POST /api/billing/charge-due — 정상 결제", () => {
  it("성공하면 active 유지 + next_billing_date 1개월 뒤로 + retry_count 0", async () => {
    subs.push(makeRow({ id: "sub-1", next_billing_date: "2026-09-10", retry_count: 3 }));
    mockToss({ ok: true, body: { paymentKey: "pay_1" } });

    const res = await post();
    const body = await res.json();

    expect(body.succeeded).toBe(1);
    expect(subs[0].status).toBe("active");
    expect(subs[0].next_billing_date).toBe("2026-10-10");
    expect(subs[0].retry_count).toBe(0);
    expect(subs[0].billing_locked_until).toBeNull();
    expect(charges[0]).toMatchObject({ status: "succeeded", amount: PLAN.monthly_price });
    expect(charges[0].order_id).toBe("sub-recur-center-1-2026-09-10");
  });

  it("결정적 orderId를 써서 같은 회차 재시도가 토스 쪽에서도 같은 주문번호로 식별되게 한다", async () => {
    subs.push(makeRow({ center_id: "center-9", next_billing_date: "2026-09-05" }));
    mockToss({ ok: true, body: { paymentKey: "pay_x" } });
    await post();
    expect(charges[0].order_id).toBe("sub-recur-center-9-2026-09-05");
  });
});

describe("POST /api/billing/charge-due — 재시도 정책(7회/7일)", () => {
  it("1회 실패하면 past_due + retry_count 1, next_billing_date는 그대로", async () => {
    subs.push(makeRow({ next_billing_date: "2026-09-10", retry_count: 0 }));
    mockToss({ ok: false, body: { code: "REJECT_CARD_COMPANY", message: "잔액 부족" } });

    const res = await post();
    const body = await res.json();

    expect(body.failed).toBe(1);
    expect(body.suspended).toBe(0);
    expect(subs[0].status).toBe("past_due");
    expect(subs[0].retry_count).toBe(1);
    expect(subs[0].next_billing_date).toBe("2026-09-10"); // 안 바뀜 — 다음날 같은 회차 재시도
  });

  it("재시도가 성공하면 active로 복귀하고 retry_count가 0으로 리셋된다", async () => {
    subs.push(makeRow({ next_billing_date: "2026-09-10", retry_count: 4, status: "past_due" }));
    mockToss({ ok: true, body: { paymentKey: "pay_2" } });

    await post();

    expect(subs[0].status).toBe("active");
    expect(subs[0].retry_count).toBe(0);
    expect(subs[0].next_billing_date).toBe("2026-10-10");
  });

  it("6번째 실패까지는 past_due를 유지한다", async () => {
    subs.push(makeRow({ next_billing_date: "2026-09-10", retry_count: 5, status: "past_due" }));
    mockToss({ ok: false, body: { code: "REJECT_CARD_COMPANY", message: "잔액 부족" } });

    await post();

    expect(subs[0].status).toBe("past_due");
    expect(subs[0].retry_count).toBe(6);
  });

  it("7번째 실패(retry_count가 7에 도달)하면 payment_failed로 자동중지된다", async () => {
    subs.push(makeRow({ next_billing_date: "2026-09-10", retry_count: 6, status: "past_due" }));
    mockToss({ ok: false, body: { code: "REJECT_CARD_COMPANY", message: "잔액 부족" } });

    const res = await post();
    const body = await res.json();

    expect(body.suspended).toBe(1);
    expect(body.failed).toBe(0);
    expect(subs[0].status).toBe("payment_failed");
    expect(subs[0].retry_count).toBe(7);
  });

  it("payment_failed로 자동중지된 구독은 다음 실행에서 다시 청구 대상으로 잡히지 않는다(7회 초과 재시도 금지)", async () => {
    subs.push(makeRow({ next_billing_date: "2026-09-01", retry_count: 7, status: "payment_failed" }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await post();
    const body = await res.json();

    expect(body.claimed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(subs[0].retry_count).toBe(7); // 손대지 않음
  });

  it("카드 만료처럼 재시도 무의미한 오류는 retry_count와 무관하게 즉시 payment_failed로 전환된다", async () => {
    subs.push(makeRow({ next_billing_date: "2026-09-10", retry_count: 1 }));
    mockToss({ ok: false, body: { code: "INVALID_CARD_EXPIRATION", message: "카드 유효기간 오류" } });

    const res = await post();
    const body = await res.json();

    expect(body.suspended).toBe(1);
    expect(subs[0].status).toBe("payment_failed");
    expect(subs[0].retry_count).toBe(1); // 그대로 — 재시도 횟수를 채운 게 아니라 즉시중지
  });

  it("확인되지 않은(목록에 없는) 토스 오류코드는 추측 분류하지 않고 기본 7회 재시도 정책을 그대로 따른다", async () => {
    subs.push(makeRow({ next_billing_date: "2026-09-10", retry_count: 6 }));
    mockToss({ ok: false, body: { code: "SOME_UNDOCUMENTED_CODE", message: "정체불명" } });

    const res = await post();

    // 목록에 없어도 안전한 쪽(기본 정책)으로만 처리 — retry_count 7 도달이라 여기선 terminal.
    expect(subs[0].status).toBe("payment_failed");
    expect(subs[0].retry_count).toBe(7);
  });
});

describe("POST /api/billing/charge-due — 대상 제외/중복 방지", () => {
  it("canceled 구독은 청구 대상 쿼리에 아예 잡히지 않는다", async () => {
    subs.push(makeRow({ status: "canceled", next_billing_date: "2026-09-01" }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await post();
    const body = await res.json();

    expect(body.claimed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pending_billing_setup(카드 미등록) 구독도 청구 대상이 아니다", async () => {
    subs.push(makeRow({ status: "pending_billing_setup", billing_key: null, next_billing_date: "2026-09-01" }));
    const res = await post();
    const body = await res.json();
    expect(body.claimed).toBe(0);
  });

  it("아직 next_billing_date가 도래하지 않은 구독은 청구하지 않는다", async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    subs.push(makeRow({ next_billing_date: future }));
    const res = await post();
    const body = await res.json();
    expect(body.claimed).toBe(0);
  });

  it("리스가 걸려 있는(다른 실행이 처리 중인) 구독은 동시에 두 번 잡히지 않는다(lock 경쟁)", async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString(); // 아직 안 풀림
    subs.push(makeRow({ next_billing_date: "2026-09-01", billing_locked_until: future }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await post();
    const body = await res.json();

    expect(body.claimed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("리스가 만료된 구독은 다시 청구 대상이 된다", async () => {
    const past = new Date(Date.now() - 60_000).toISOString(); // 이미 만료
    subs.push(makeRow({ next_billing_date: "2026-09-01", billing_locked_until: past }));
    mockToss({ ok: true, body: { paymentKey: "pay_3" } });

    const res = await post();
    const body = await res.json();

    expect(body.succeeded).toBe(1);
  });

  it("billing_key가 없는 이상 상태(정상적으로는 발생하지 않아야 함)는 재시도 없이 즉시 terminal 처리된다", async () => {
    subs.push(makeRow({ billing_key: null, billing_customer_key: null, next_billing_date: "2026-09-01" }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await post();
    const body = await res.json();

    expect(fetchSpy).not.toHaveBeenCalled(); // 카드 정보가 없으니 토스 호출 자체를 안 함
    expect(body.suspended).toBe(1);
    expect(subs[0].status).toBe("payment_failed");
  });
});
