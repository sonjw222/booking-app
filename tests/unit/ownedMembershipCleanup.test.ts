// E2E 수강권 정리의 소유권 규칙 오프라인 검증 — 메모리 가짜 저장소만 사용(DB 접속 없음).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runOwnedMembershipCleanup, planOwnedMembershipCleanup, ownsClass, type CleanupStore, type OwnershipContext } from "../e2e/fixtures/ownedMembershipCleanup";

const T0 = Date.parse("2026-10-16T00:00:00Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
type Db = {
  memberships: { id: string; profile_id: string; product_id: string; created_at: string }[];
  reservations: { id: string; class_id: string; membership_id: string }[];
  payments: { id: string; membership_id: string }[];
  other: Record<string, number>; unverifiable?: boolean;
};
function fake(db: Db) {
  const log: string[] = [];
  const store: CleanupStore = {
    async listMemberships(p, pr) { return db.memberships.filter(m => m.profile_id === p && m.product_id === pr); },
    async reservationsOf(ids) { return db.reservations.filter(r => ids.includes(r.membership_id)); },
    async paymentsOf(ids) { return db.payments.filter(r => ids.includes(r.membership_id)); },
    async otherReferences(id) { return { count: db.other[id] ?? 0, unverifiable: !!db.unverifiable }; },
    async deleteReservations(ids) { log.push(`reservations:${ids.join(",")}`); db.reservations = db.reservations.filter(r => !ids.includes(r.id)); },
    async deletePayments(ids) { log.push(`payments:${ids.join(",")}`); db.payments = db.payments.filter(r => !ids.includes(r.id)); },
    async deleteMemberships(ids) {
      // 실제 DB의 reservations_membership_id_fkey를 재현: 참조가 남아 있으면 삭제 실패.
      for (const id of ids) if (db.reservations.some(r => r.membership_id === id) || db.payments.some(p => p.membership_id === id)) throw new Error(`violates foreign key constraint "reservations_membership_id_fkey"`);
      log.push(`memberships:${ids.join(",")}`); db.memberships = db.memberships.filter(m => !ids.includes(m.id));
    },
  };
  return { store, log };
}
const ctx = (over: Partial<OwnershipContext> = {}): OwnershipContext => ({
  runId: "run-1", profileId: "userA", productId: "buy", preexistingMembershipIds: new Set(["old-1"]), ownedClassIds: new Set(["cls-mine"]), runStartedAtMs: T0, ...over,
});
const base = (): Db => ({
  memberships: [
    { id: "old-1", profile_id: "userA", product_id: "buy", created_at: iso(-86_400_000) },   // 실행 이전부터 있던 수강권
    { id: "new-1", profile_id: "userA", product_id: "buy", created_at: iso(5_000) },         // 이 실행의 구매로 생김
    { id: "other-user", profile_id: "userB", product_id: "buy", created_at: iso(5_000) },
    { id: "other-prod", profile_id: "userA", product_id: "xxx", created_at: iso(5_000) },
  ],
  reservations: [
    { id: "r-old", class_id: "cls-real", membership_id: "old-1" },
    { id: "r-new", class_id: "cls-mine", membership_id: "new-1" },
  ],
  payments: [{ id: "p-old", membership_id: "old-1" }, { id: "p-new", membership_id: "new-1" }],
  other: {},
});

describe("runOwnedMembershipCleanup", () => {
  it("이 실행의 구매로 생긴 수강권만, 이 실행 수업의 예약·결제와 함께 reservations → payments → memberships 순으로 지운다", async () => {
    const db = base(); const { store, log } = fake(db);
    const r = await runOwnedMembershipCleanup(store, ctx());
    expect(log).toEqual(["reservations:r-new", "payments:p-new", "memberships:new-1"]);
    expect(r.refused).toEqual([]);
    expect(db.memberships.map(m => m.id).sort()).toEqual(["old-1", "other-prod", "other-user"]);
  });
  it("기존 사용자의 수강권·결제·예약(스냅샷에 있던 것)은 하나도 삭제하지 않는다", async () => {
    const db = base(); const { store } = fake(db);
    const r = await runOwnedMembershipCleanup(store, ctx());
    expect(db.reservations.map(x => x.id)).toEqual(["r-old"]);
    expect(db.payments.map(x => x.id)).toEqual(["p-old"]);
    expect(r.untouchedPreexisting).toEqual(["old-1"]);
  });
  it("다른 사용자·다른 상품의 수강권은 대상이 아니다", async () => {
    const db = base(); const { store } = fake(db);
    await runOwnedMembershipCleanup(store, ctx());
    expect(db.memberships.some(m => m.id === "other-user")).toBe(true);
    expect(db.memberships.some(m => m.id === "other-prod")).toBe(true);
  });
  it("새 수강권이라도 이 실행이 만들지 않은 수업의 예약이 참조하면 거부하고 아무 것도 지우지 않는다(reservations_membership_id_fkey 방지)", async () => {
    const db = base(); db.reservations.push({ id: "r-foreign", class_id: "cls-someone-else", membership_id: "new-1" });
    const { store, log } = fake(db);
    const r = await runOwnedMembershipCleanup(store, ctx());
    expect(log).toEqual([]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0].reason).toContain("이 실행이 만들지 않은 수업의 예약 1건");
    expect(db.reservations.map(x => x.id)).toContain("r-foreign");
    expect(db.memberships.map(m => m.id)).toContain("new-1");
  });
  it("예약·결제 외 참조(양도·상품권·계약·관리 로그)가 있으면 거부한다", async () => {
    const db = base(); db.other = { "new-1": 2 };
    const { store, log } = fake(db);
    const r = await runOwnedMembershipCleanup(store, ctx());
    expect(log).toEqual([]);
    expect(r.refused[0].reason).toContain("예약·결제 외 참조 2건");
  });
  it("스냅샷에는 없지만 실행 시작보다 한참 전에 만들어진 수강권은 소유를 증명할 수 없어 거부한다", async () => {
    const db = base(); db.memberships.push({ id: "sneaky", profile_id: "userA", product_id: "buy", created_at: iso(-3_600_000) });
    const { store } = fake(db);
    const r = await runOwnedMembershipCleanup(store, ctx());
    expect(r.refused.map(x => x.membershipId)).toEqual(["sneaky"]);
    expect(db.memberships.map(m => m.id)).toContain("sneaky");
  });
  it("읽을 수 없는 참조 테이블이 있으면 unverifiable로 알리고, 남은 참조는 DB의 FK가 막는다", async () => {
    const db = base(); db.unverifiable = true;
    const { store } = fake(db);
    const r = await runOwnedMembershipCleanup(store, ctx());
    expect(r.unverifiableMembershipIds).toEqual(["new-1"]);
  });
  it("삭제할 것이 없으면(구매 실패 등) 아무 호출도 하지 않는다", async () => {
    const db = base(); db.memberships = db.memberships.filter(m => m.id !== "new-1");
    const { store, log } = fake(db);
    await runOwnedMembershipCleanup(store, ctx());
    expect(log).toEqual([]);
  });
  it("과거 방식(예약을 지우지 않고 payments → memberships만 삭제)이라면 FK 위반이 났을 상황을 재현한다", async () => {
    const db = base(); const { store } = fake(db);
    await store.deletePayments(["p-new"]);
    await expect(store.deleteMemberships(["new-1"])).rejects.toThrow("reservations_membership_id_fkey");
  });
});

describe("planOwnedMembershipCleanup / ownsClass", () => {
  it("수업 소유권은 제목의 실행 UUID 조각과 센터가 모두 맞아야 한다", () => {
    expect(ownsClass({ id: "1", title: "NEWCLASS-BUY-ab12cd34-1760", center_id: "c" }, { runShort: "ab12cd34", centerId: "c" })).toBe(true);
    expect(ownsClass({ id: "1", title: "NEWCLASS-BUY-ab12cd34-1760", center_id: "other" }, { runShort: "ab12cd34", centerId: "c" })).toBe(false);
    expect(ownsClass({ id: "1", title: "정규 수업", center_id: "c" }, { runShort: "ab12cd34", centerId: "c" })).toBe(false);
  });
  it("대상 조합이 아닌 행만 들어오면 계획은 비어 있다", () => {
    const p = planOwnedMembershipCleanup({ ctx: ctx(), memberships: [{ id: "x", profile_id: "zzz", product_id: "buy", created_at: iso(0) }], reservations: [], payments: [], others: {} });
    expect(p.deleteMembershipIds).toEqual([]);
  });
});

describe("new-class-creation.spec.ts 정적 안전 확인", () => {
  const spec = readFileSync("tests/e2e/admin/new-class-creation.spec.ts", "utf8");
  it("조건 없이 memberships/payments를 직접 지우는 코드가 없다(소유권 모듈만 사용)", () => {
    expect(spec).not.toMatch(/from\("(memberships|payments)"\)[\s\S]{0,80}\.delete\(/);
    expect(spec).not.toMatch(/cleanupBuyProductMemberships\(/);
    expect(spec).toContain("runOwnedMembershipCleanup");
  });
  it("beforeAll은 기존 수강권을 지우지 않고 스냅샷만 만든다", () => {
    expect(spec).toContain("preexistingBuyMembershipIds");
  });
  it("모든 신규 수업 제목에 실행별 UUID 조각이 들어간다", () => {
    for (const k of ["ALL", "SPECIFIC", "BUY", "GOODSCHK", "CONTROL"]) expect(spec).toContain(`NEWCLASS-${k}-\${RUN_SHORT}`);
  });
});
