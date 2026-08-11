/*
  P4: manager_dashboard_summary() RPC(매출/통계 대시보드) 정확성 통합 테스트.

  getOrCreateOwnedTestCenter()로 얻는 센터는 이 계정으로 실행된 과거 테스트들의 결제가
  이미 쌓여 있을 수 있어(get-or-create, 삭제 안 됨) 절대값을 그대로 assert할 수 없다.
  그래서 모든 테스트는 payment-lifecycle.test.ts의 beforeCount/afterCount 패턴과 동일하게
  "삽입 전 스냅샷 → fixture 삽입 → 삽입 후 스냅샷 → 차이(delta)만 검증"한다 — 몇 번을
  반복 실행해도, 다른 통합테스트가 같은 센터에 데이터를 더 쌓아놔도 항상 성립한다.

  add_manager_dashboard_summary_draft_proposed.sql / fix_payments_payment_provider_draft_proposed.sql
  이 아직 Supabase에 적용되지 않았다면 이 파일의 테스트는 전부 실패한다(예상된 실패 —
  RPC 자체가 없거나 payment_provider 컬럼이 없음. 최종 보고서 "SQL 필요 여부"에 기록).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchDashboardSummary, type DashboardSummary } from "../../lib/sales";
import {
  switchToTestUser,
  signOutTestSession,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  type TestUser,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MEMBER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };

let managerA: TestUser;
let centerAId: string;
let passProductId: string;
let goodsProductId: string;
let passMembershipId: string;
let goodsMembershipId: string;

const insertedPaymentIds: string[] = [];

async function asManagerA() { managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password); }

function kstDateStr(daysAgo: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(Date.now() - daysAgo * 86400000));
}
function kstTimestampIso(dateStr: string, hh: string, mm: string): string {
  return new Date(`${dateStr}T${hh}:${mm}:00+09:00`).toISOString();
}

const WIDE_FROM = kstDateStr(60);
const WIDE_TO = kstDateStr(0);

async function getWideSummary(): Promise<DashboardSummary> {
  await asManagerA();
  return fetchDashboardSummary(centerAId, WIDE_FROM, WIDE_TO);
}

type PaymentOverrides = {
  totalAmount: number;
  cardAmount?: number;
  cashAmount?: number;
  transferAmount?: number;
  pointAmount?: number;
  unpaidAmount?: number;
  membershipId?: string;
  paidAt?: string;
  paymentProvider?: string | null;
  saleType?: string;
};

async function insertPayment(o: PaymentOverrides): Promise<string> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin
    .from("payments")
    .insert({
      profile_id: managerA.profileId,
      center_id: centerAId,
      membership_id: o.membershipId ?? null,
      sale_type: o.saleType ?? "new",
      card_amount: o.cardAmount ?? 0,
      cash_amount: o.cashAmount ?? 0,
      transfer_amount: o.transferAmount ?? 0,
      point_amount: o.pointAmount ?? 0,
      total_amount: o.totalAmount,
      unpaid_amount: o.unpaidAmount ?? 0,
      status: "paid",
      paid_at: o.paidAt ?? new Date().toISOString(),
      payment_provider: o.paymentProvider ?? null,
      memo: "P4 통합테스트",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`테스트 결제 생성 실패: ${error?.message ?? "no data"}`);
  insertedPaymentIds.push(data.id);
  return data.id;
}

async function getOrCreateProduct(name: string, kind: "pass" | "goods"): Promise<string> {
  const admin = getFixtureAdminClient();
  const { data: existing } = await admin
    .from("products").select("id")
    .eq("center_id", centerAId).eq("name", name).eq("product_kind", kind).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await admin
    .from("products")
    .insert({ center_id: centerAId, name, product_kind: kind, pass_type: "count", total_count: 999, is_on_sale: true, is_active: true })
    .select("id").single();
  if (error || !data) throw new Error(`상품(${name}) 생성 실패: ${error?.message ?? "no data"}`);
  return data.id;
}

async function getOrCreateMembership(productId: string): Promise<string> {
  const admin = getFixtureAdminClient();
  const { data: existing } = await admin
    .from("memberships").select("id")
    .eq("center_id", centerAId).eq("profile_id", managerA.profileId).eq("product_id", productId).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await admin
    .from("memberships")
    .insert({
      profile_id: managerA.profileId, center_id: centerAId, product_id: productId,
      product_name: "P4 통합테스트 수강권", pass_type: "count", total_count: 999, remaining_count: 999,
      expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      status: "active",
    })
    .select("id").single();
  if (error || !data) throw new Error(`수강권 생성 실패: ${error?.message ?? "no data"}`);
  return data.id;
}

function dailyMap(d: DashboardSummary["daily"]): Map<string, number> {
  return new Map(d.map((row) => [row.date, row.revenue]));
}

beforeAll(async () => {
  await asManagerA();
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  passProductId = await getOrCreateProduct("P4 통합-패스", "pass");
  goodsProductId = await getOrCreateProduct("P4 통합-굿즈", "goods");
  passMembershipId = await getOrCreateMembership(passProductId);
  goodsMembershipId = await getOrCreateMembership(goodsProductId);
}, 30000);

afterAll(async () => {
  await signOutTestSession();
}, 30000);

describe("권한", () => {
  it("이 센터를 관리하지 않는 계정은 대시보드 요약을 조회할 수 없다", async () => {
    await switchToTestUser(MEMBER_A.email, MEMBER_A.password);
    await expect(fetchDashboardSummary(centerAId, WIDE_FROM, WIDE_TO)).rejects.toThrow();
  });
});

describe("매출 합계", () => {
  it("결제수단별 분할결제가 기간 매출/결제수단별 통계에 정확히 더해진다", async () => {
    const before = await getWideSummary();
    await insertPayment({ totalAmount: 20000, cardAmount: 12000, cashAmount: 8000 });
    const after = await getWideSummary();

    expect(after.periodRevenue - before.periodRevenue).toBe(20000);
    expect(after.periodPaymentCount - before.periodPaymentCount).toBe(1);
    expect(after.byMethod.card - before.byMethod.card).toBe(12000);
    expect(after.byMethod.cash - before.byMethod.cash).toBe(8000);
  });
});

describe("환불/취소 반영", () => {
  it("환불(음수 total_amount)이 매출 합계에서 정확히 차감된다", async () => {
    const before = await getWideSummary();
    await insertPayment({ totalAmount: 15000, cardAmount: 15000 });
    await insertPayment({ totalAmount: -6000, cardAmount: -6000, saleType: "refund" });
    const after = await getWideSummary();

    expect(after.periodRevenue - before.periodRevenue).toBe(9000);
    expect(after.byMethod.card - before.byMethod.card).toBe(9000);
  });
});

describe("미수금", () => {
  it("미수금이 있는 결제의 unpaid_amount가 미수금 합계에 정확히 반영된다", async () => {
    const before = await getWideSummary();
    await insertPayment({ totalAmount: 5000, cardAmount: 5000, unpaidAmount: 4000 });
    const after = await getWideSummary();

    expect(after.unpaidTotal - before.unpaidTotal).toBe(4000);
  });
});

describe("날짜/KST 경계", () => {
  it("오늘 00:05(KST) 결제는 오늘 매출에 잡히고, 어제 23:55(KST) 결제는 잡히지 않는다", async () => {
    const todayDate = kstDateStr(0);
    const yesterdayDate = kstDateStr(1);

    const beforeToday = (await getWideSummary()).todayRevenue;
    const beforeDaily = dailyMap((await getWideSummary()).daily);

    await insertPayment({ totalAmount: 3000, cardAmount: 3000, paidAt: kstTimestampIso(todayDate, "00", "05") });
    await insertPayment({ totalAmount: 5000, cardAmount: 5000, paidAt: kstTimestampIso(yesterdayDate, "23", "55") });

    const afterSummary = await getWideSummary();
    const afterToday = afterSummary.todayRevenue;
    const afterDaily = dailyMap(afterSummary.daily);

    // 오늘 00:05 결제만 todayRevenue에 반영 — 어제 23:55 결제는 반영되지 않는다.
    expect(afterToday - beforeToday).toBe(3000);

    const todayDelta = (afterDaily.get(todayDate) ?? 0) - (beforeDaily.get(todayDate) ?? 0);
    const yesterdayDelta = (afterDaily.get(yesterdayDate) ?? 0) - (beforeDaily.get(yesterdayDate) ?? 0);
    expect(todayDelta).toBe(3000);
    expect(yesterdayDelta).toBe(5000);
  });
});

describe("Mock 결제 제외", () => {
  it("payment_provider='mock' 결제는 실제로 저장되지만 통계에서는 완전히 제외된다", async () => {
    const before = await getWideSummary();
    const beforeTodayRevenue = before.todayRevenue;

    const mockId = await insertPayment({ totalAmount: 99000, cardAmount: 99000, paymentProvider: "mock" });

    const after = await getWideSummary();
    expect(after.periodRevenue - before.periodRevenue).toBe(0);
    expect(after.periodPaymentCount - before.periodPaymentCount).toBe(0);
    expect(after.todayRevenue - beforeTodayRevenue).toBe(0);

    // Mock 결제 행 자체는 실제로 존재해야 한다(제외가 "삽입 실패"가 아니라 "RPC가 의도적으로 뺀 것"임을 증명).
    const admin = getFixtureAdminClient();
    const { data: row, error } = await admin.from("payments").select("payment_provider, total_amount").eq("id", mockId).single();
    if (error || !row) throw new Error(`mock 결제 행 조회 실패: ${error?.message ?? "no data"}`);
    expect(row.payment_provider).toBe("mock");
    expect(row.total_amount).toBe(99000);
  });
});

describe("수강권/상품 매출 구분", () => {
  it("membership_id가 가리키는 상품의 product_kind에 따라 수강권/상품 매출로 정확히 나뉜다", async () => {
    const before = await getWideSummary();
    await insertPayment({ totalAmount: 10000, cardAmount: 10000, membershipId: passMembershipId });
    await insertPayment({ totalAmount: 7000, cardAmount: 7000, membershipId: goodsMembershipId });
    const after = await getWideSummary();

    expect(after.periodMembershipRevenue - before.periodMembershipRevenue).toBe(10000);
    expect(after.periodGoodsRevenue - before.periodGoodsRevenue).toBe(7000);
    expect(after.periodRevenue - before.periodRevenue).toBe(17000);
  });
});
