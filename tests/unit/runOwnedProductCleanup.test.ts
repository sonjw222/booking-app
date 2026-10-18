import { describe, it, expect } from "vitest";
import {
  planRunOwnedCleanup, prepareRunOwnedCleanup, executeRunOwnedCleanup,
  type CleanupStore, type RunContext, type MembershipRow, type ReservationRef, type PaymentRef, type ProductRow,
} from "../e2e/fixtures/runOwnedProductCleanup";

const T0 = Date.parse("2026-10-18T09:00:00Z");
const ctx: RunContext = { runShort: "ab12cd34", profileId: "userA", centerId: "c1", productId: "p1", ownedClassIds: new Set(["k1", "k2"]), runStartedAtMs: T0 };
const product: ProductRow = { id: "p1", name: "TEST4 신규구매전용패스 ab12cd34", center_id: "c1" };
const mem = (o: Partial<MembershipRow> = {}): MembershipRow => ({ id: "m1", profile_id: "userA", product_id: "p1", created_at: "2026-10-18T09:00:10Z", ...o });
const res = (o: Partial<ReservationRef> = {}): ReservationRef => ({ id: "r1", class_id: "k1", membership_id: "m1", profile_id: "userA", ...o });
const pay = (o: Partial<PaymentRef> = {}): PaymentRef => ({ id: "y1", membership_id: "m1", profile_id: "userA", created_at: "2026-10-18T09:00:12Z", ...o });
const clean = { m1: { count: 0, unverifiable: false } };
const plan = (o: Partial<Parameters<typeof planRunOwnedCleanup>[0]> = {}) =>
  planRunOwnedCleanup({ ctx, product, memberships: [mem()], reservations: [res()], payments: [pay()], others: clean, ...o });

describe("planRunOwnedCleanup", () => {
  it("이 실행이 만든 상품·수강권·예약·결제는 소유가 증명되어 삭제 계획이 된다", () => {
    const p = plan();
    expect(p.refused).toEqual([]);
    expect(p).toMatchObject({ deleteReservationIds: ["r1"], deletePaymentIds: ["y1"], deleteMembershipIds: ["m1"], deleteProduct: true });
  });
  it("구매가 없었으면(수강권 0) 상품만 지운다", () => {
    expect(plan({ memberships: [], reservations: [], payments: [], others: {} })).toMatchObject({ deleteMembershipIds: [], deleteProduct: true, refused: [] });
  });
  it("상품이 이미 없으면 아무 것도 하지 않는다", () => {
    expect(plan({ product: null })).toMatchObject({ deleteProduct: false, refused: [] });
  });
  it("이름에 RUN_SHORT가 없는 상품(=고정 이름 옛 상품·실제 상품)은 거부", () => {
    expect(plan({ product: { ...product, name: "TEST4 신규구매전용패스" } }).refused.length).toBeGreaterThan(0);
  });
  it("다른 센터의 상품이면 거부", () => {
    expect(plan({ product: { ...product, center_id: "c2" } }).refused.length).toBeGreaterThan(0);
  });
  it("다른 프로필의 수강권이 있으면 전부 거부(프로필·상품 일치만으로 인정하지 않음)", () => {
    const p = plan({ memberships: [mem(), mem({ id: "m2", profile_id: "other" })], others: { ...clean, m2: clean.m1 } });
    expect(p.refused.length).toBeGreaterThan(0);
    expect(p.deleteMembershipIds).toEqual([]); // 부분 삭제 없음
  });
  it("실행 시작보다 오래된 수강권은 거부", () => {
    expect(plan({ memberships: [mem({ created_at: "2026-10-17T00:00:00Z" })] }).refused.length).toBe(1);
  });
  it("이 실행이 만들지 않은 수업의 예약이 이 수강권을 참조하면 거부 — 이번 CI 실패의 잔여 예약 사례", () => {
    const p = plan({ reservations: [res(), res({ id: "r9", class_id: "stale-class" })] });
    expect(p.refused.join()).toContain("r9");
    expect(p.deleteReservationIds).toEqual([]);
  });
  it("다른 프로필의 예약·결제, 실행 이전 결제는 거부", () => {
    expect(plan({ reservations: [res({ profile_id: "other" })] }).refused.length).toBe(1);
    expect(plan({ payments: [pay({ profile_id: "other" })] }).refused.length).toBe(1);
    expect(plan({ payments: [pay({ created_at: "2026-10-01T00:00:00Z" })] }).refused.length).toBe(1);
  });
  it("그 밖의 참조가 있거나 조회하지 못하면 거부(DB FK를 안전장치로 쓰지 않음)", () => {
    expect(plan({ others: { m1: { count: 2, unverifiable: false } } }).refused.length).toBe(1);
    expect(plan({ others: { m1: { count: 0, unverifiable: true } } }).refused.length).toBe(1);
    expect(plan({ others: {} }).refused.length).toBe(1);
  });
});

function memoryStore(init: { memberships: MembershipRow[]; reservations: ReservationRef[]; payments: PaymentRef[]; product?: ProductRow | null; productBlocked?: boolean }) {
  const db = { ...init, product: init.product === undefined ? product : init.product };
  const log: string[] = [];
  const store: CleanupStore = {
    getProduct: async () => db.product,
    membershipsOfProduct: async () => db.memberships,
    reservationsOf: async (ids) => db.reservations.filter((r) => ids.includes(r.membership_id)),
    paymentsOf: async (ids) => db.payments.filter((r) => ids.includes(r.membership_id)),
    otherReferences: async () => ({ count: 0, unverifiable: false }),
    deleteReservations: async (ids, classes, prof) => { log.push("reservations"); db.reservations = db.reservations.filter((r) => !(ids.includes(r.id) && classes.includes(r.class_id) && r.profile_id === prof)); },
    deletePayments: async (ids) => { log.push("payments"); db.payments = db.payments.filter((r) => !ids.includes(r.id)); },
    deleteMemberships: async (ids) => {
      log.push("memberships");
      if (db.reservations.some((r) => ids.includes(r.membership_id))) throw new Error("reservations_membership_id_fkey");
      db.memberships = db.memberships.filter((m) => !ids.includes(m.id));
    },
    deleteProduct: async () => { log.push("product"); if (init.productBlocked) return false; db.product = null; return true; },
  };
  return { db, log, store };
}

describe("prepare/execute", () => {
  it("reservations → payments → memberships → product 순서로 지운다", async () => {
    const m = memoryStore({ memberships: [mem()], reservations: [res()], payments: [pay()] });
    const p = await prepareRunOwnedCleanup(m.store, ctx);
    const out = await executeRunOwnedCleanup(m.store, p, ctx);
    expect(m.log).toEqual(["reservations", "payments", "memberships", "product"]);
    expect(out.productDeleted).toBe(true);
    expect(m.db.memberships).toEqual([]);
  });
  it("소유를 증명하지 못하면 아무 것도 삭제하지 않는다(잔여 예약이 그대로 남는다)", async () => {
    const stale = res({ id: "r9", class_id: "stale-class" });
    const m = memoryStore({ memberships: [mem()], reservations: [res(), stale], payments: [pay()] });
    const p = await prepareRunOwnedCleanup(m.store, ctx);
    const out = await executeRunOwnedCleanup(m.store, p, ctx);
    expect(p.refused.length).toBe(1);
    expect(out.productDeleted).toBe(false);
    expect(m.log).toEqual([]);
    expect(m.db.reservations).toHaveLength(2);
    expect(m.db.payments).toHaveLength(1);
    expect(m.db.memberships).toHaveLength(1);
  });
  it("상품 삭제가 막히면 예외 없이 false(호출부가 판매 중지로 대체)", async () => {
    const m = memoryStore({ memberships: [], reservations: [], payments: [], productBlocked: true });
    const p = await prepareRunOwnedCleanup(m.store, ctx);
    expect((await executeRunOwnedCleanup(m.store, p, ctx)).productDeleted).toBe(false);
  });
  it("중간 단계가 실패하면 어느 단계에서 실패했는지 알리고 이후 단계는 실행하지 않는다", async () => {
    const m = memoryStore({ memberships: [mem()], reservations: [res()], payments: [pay()] });
    m.store.deletePayments = async () => { throw new Error("boom"); };
    const p = await prepareRunOwnedCleanup(m.store, ctx);
    await expect(executeRunOwnedCleanup(m.store, p, ctx)).rejects.toThrow(/결제 삭제 실패/);
    expect(m.log).toEqual(["reservations"]);
  });
});
