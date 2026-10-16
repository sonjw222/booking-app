// E2E 수강권 정리의 소유권 증명·격리 DB 가드 오프라인 검증 — 메모리 가짜 저장소만 사용(DB 접속 없음).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  executeOwnedMembershipCleanup, makeSupabaseStore, ownsClass, planOwnedMembershipCleanup, prepareOwnedMembershipCleanup,
  type CleanupStore, type OwnershipContext,
} from "../e2e/fixtures/ownedMembershipCleanup";
import { assertIsolatedTestDb, ISOLATED_DB_ACK_PHRASE, IsolatedTestDbGuardError } from "../e2e/fixtures/isolatedTestDbGuard";

const T0 = Date.parse("2026-10-16T00:00:00Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
type Db = {
  memberships: { id: string; profile_id: string; product_id: string; created_at: string }[];
  reservations: { id: string; class_id: string; membership_id: string; profile_id: string }[];
  payments: { id: string; membership_id: string; profile_id: string; created_at: string }[];
  other: Record<string, number>; unverifiable?: boolean; failMembershipDelete?: boolean;
};
function fake(db: Db) {
  const log: string[] = [];
  const store: CleanupStore = {
    async listMemberships(p, pr) { return db.memberships.filter(m => m.profile_id === p && m.product_id === pr); },
    async reservationsOf(ids) { return db.reservations.filter(r => ids.includes(r.membership_id)); },
    async paymentsOf(ids) { return db.payments.filter(r => ids.includes(r.membership_id)); },
    async otherReferences(id) { return { count: db.other[id] ?? 0, unverifiable: !!db.unverifiable }; },
    // 실제 어댑터처럼 id + 소유 조건을 함께 걸어 지운다 — 조건에 안 맞는 행은 id가 같아도 남는다.
    async deleteReservations(ids, classIds) { log.push(`reservations:${ids.join(",")}`); db.reservations = db.reservations.filter(r => !(ids.includes(r.id) && classIds.includes(r.class_id))); },
    async deletePayments(ids, profileId) { log.push(`payments:${ids.join(",")}`); db.payments = db.payments.filter(r => !(ids.includes(r.id) && r.profile_id === profileId)); },
    async deleteMemberships(ids, profileId, productId) {
      if (db.failMembershipDelete) throw new Error('violates foreign key constraint "reservations_membership_id_fkey"');
      log.push(`memberships:${ids.join(",")}`); db.memberships = db.memberships.filter(m => !(ids.includes(m.id) && m.profile_id === profileId && m.product_id === productId));
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
    { id: "r-old", class_id: "cls-real", membership_id: "old-1", profile_id: "userA" },
    { id: "r-new", class_id: "cls-mine", membership_id: "new-1", profile_id: "userA" },
  ],
  payments: [{ id: "p-old", membership_id: "old-1", profile_id: "userA", created_at: iso(-86_400_000) }, { id: "p-new", membership_id: "new-1", profile_id: "userA", created_at: iso(4_000) }],
  other: {},
});
const run = async (db: Db, c = ctx()) => { const { store, log } = fake(db); const plan = await prepareOwnedMembershipCleanup(store, c); await executeOwnedMembershipCleanup(store, plan, c); return { plan, log }; };

describe("소유 증명이 된 수강권만 reservations → payments → memberships 순으로 삭제", () => {
  it("이 실행의 수업 예약이 쓴 새 수강권 1개는 예약·결제와 함께 삭제된다", async () => {
    const db = base(); const { plan, log } = await run(db);
    expect(plan.refused).toEqual([]);
    expect(log).toEqual(["reservations:r-new", "payments:p-new", "memberships:new-1"]);
  });
  it("기존 사용자의 수강권·결제·예약(스냅샷에 있던 것)과 다른 사용자·다른 상품의 수강권은 하나도 삭제하지 않는다", async () => {
    const db = base(); const { plan } = await run(db);
    expect(db.memberships.map(m => m.id).sort()).toEqual(["old-1", "other-prod", "other-user"]);
    expect(db.reservations.map(x => x.id)).toEqual(["r-old"]);
    expect(db.payments.map(x => x.id)).toEqual(["p-old"]);
    expect(plan.untouchedPreexisting).toEqual(["old-1"]);
  });
  it("삭제할 것이 없으면(구매 안 함) 아무 호출도 하지 않는다", async () => {
    const db = base(); db.memberships = db.memberships.filter(m => m.id !== "new-1");
    const { log } = await run(db);
    expect(log).toEqual([]);
  });
});

describe("소유를 증명하지 못하면 아무 것도 삭제하지 않는다(부분 삭제 없음)", () => {
  it("'시작 시점에 없었다'만으로는 삭제하지 않는다 — 이 실행의 예약이 쓴 증거가 없으면 거부", async () => {
    const db = base(); db.reservations = db.reservations.filter(r => r.id !== "r-new"); // 구매는 됐지만 예약 전에 실패
    const { plan, log } = await run(db);
    expect(plan.refused[0].reason).toContain("증거가 없음");
    expect(log).toEqual([]);
    expect(db.memberships.map(m => m.id)).toContain("new-1");
    expect(db.payments.map(x => x.id)).toContain("p-new");
  });
  it("동시 실행/외부 구매로 새 수강권이 2개 생기면 어느 것이 내 것인지 구분할 수 없어 둘 다 거부", async () => {
    const db = base(); db.memberships.push({ id: "new-2", profile_id: "userA", product_id: "buy", created_at: iso(6_000) });
    const { plan, log } = await run(db);
    expect(plan.refused.map(r => r.membershipId).sort()).toEqual(["new-1", "new-2"]);
    expect(log).toEqual([]);
  });
  it("다른 실행이 만든 수강권만 새로 보이고 내 예약 증거가 없으면(내 구매 실패) 그 수강권을 지우지 않는다", async () => {
    const db = base();
    db.memberships = db.memberships.filter(m => m.id !== "new-1"); db.reservations = db.reservations.filter(r => r.id !== "r-new"); db.payments = db.payments.filter(p => p.id !== "p-new");
    db.memberships.push({ id: "theirs", profile_id: "userA", product_id: "buy", created_at: iso(7_000) });
    db.reservations.push({ id: "r-theirs", class_id: "cls-theirs", membership_id: "theirs", profile_id: "userA" });
    const { log } = await run(db);
    expect(log).toEqual([]);
    expect(db.memberships.map(m => m.id)).toContain("theirs");
  });
  it("이 실행이 만들지 않은 수업의 예약이 같은 수강권을 참조하면 거부(FK 위반 이전에 막는다)", async () => {
    const db = base(); db.reservations.push({ id: "r-foreign", class_id: "cls-else", membership_id: "new-1", profile_id: "userA" });
    const { plan, log } = await run(db);
    expect(plan.refused[0].reason).toContain("이 실행이 만들지 않은 수업의 예약 1건");
    expect(log).toEqual([]);
    expect(db.reservations.map(x => x.id)).toContain("r-new"); // 내 예약도 지우지 않음(부분 삭제 없음)
  });
  it("다른 프로필이거나 실행 이전의 결제가 그 수강권을 참조하면 거부", async () => {
    const a = base(); a.payments.push({ id: "p-x", membership_id: "new-1", profile_id: "userB", created_at: iso(4_500) });
    expect((await run(a)).plan.refused[0].reason).toContain("다른 프로필이거나 실행 이전의 결제 1건");
    const b = base(); b.payments.push({ id: "p-y", membership_id: "new-1", profile_id: "userA", created_at: iso(-3_600_000) });
    expect((await run(b)).log).toEqual([]);
  });
  it("예약·결제 외 참조가 있으면 거부", async () => {
    const db = base(); db.other = { "new-1": 2 };
    const { plan, log } = await run(db);
    expect(plan.refused[0].reason).toContain("예약·결제 외 참조 2건"); expect(log).toEqual([]);
  });
  it("참조 테이블 일부를 조회하지 못하면(unverifiable) 삭제하지 않는다 — DB FK에 의존하지 않는다", async () => {
    const db = base(); db.unverifiable = true;
    const { plan, log } = await run(db);
    expect(plan.refused[0].reason).toContain("조회하지 못함");
    expect(log).toEqual([]);
    expect(db.memberships.map(m => m.id)).toContain("new-1");
  });
  it("실행 시작보다 한참 전에 만들어진 새 수강권은 거부", async () => {
    const db = base(); db.memberships.find(m => m.id === "new-1")!.created_at = iso(-3_600_000);
    expect((await run(db)).log).toEqual([]);
  });
  it("계획에 소유 조건 밖의 id가 섞여 있어도 삭제 조건(수업/프로필/상품)이 다시 걸려 지워지지 않는다", async () => {
    const db = base(); const { store } = fake(db);
    await store.deleteReservations(["r-old"], ["cls-mine"]);      // 다른 수업의 예약
    await store.deletePayments(["p-old"], "userB");               // 다른 프로필
    await store.deleteMemberships(["other-prod", "other-user"], "userA", "buy"); // 다른 상품 / 다른 프로필
    expect(db.reservations.map(r => r.id)).toContain("r-old");
    expect(db.payments.map(p => p.id)).toContain("p-old");
    expect(db.memberships.map(m => m.id).sort()).toEqual(["new-1", "old-1", "other-prod", "other-user"]);
  });
  it("수업을 먼저 지워 증거(예약)가 사라진 뒤에 계획하면 거부된다 — 그래서 계획은 수업 삭제 전에 세운다", async () => {
    const db = base(); db.reservations = db.reservations.filter(r => r.class_id !== "cls-mine"); // cleanupTestClassAdmin이 한 일
    expect((await run(db)).log).toEqual([]);
  });
  it("수강권 삭제 단계가 FK로 실패하면 소유가 증명된 예약·결제만 지워진 상태임을 오류에 밝힌다(기존 데이터는 그대로)", async () => {
    const db = base(); db.failMembershipDelete = true;
    const { store } = fake(db); const plan = await prepareOwnedMembershipCleanup(store, ctx());
    await expect(executeOwnedMembershipCleanup(store, plan, ctx())).rejects.toThrow(/예약 1건·결제 1건\(소유 증명됨\)은 이미 삭제됨.*new-1/);
    expect(db.reservations.map(r => r.id)).toEqual(["r-old"]);
    expect(db.payments.map(p => p.id)).toEqual(["p-old"]);
  });
  it("거부된 계획은 실행해도 아무 호출도 하지 않는다", async () => {
    const db = base(); const { store, log } = fake(db);
    const plan = planOwnedMembershipCleanup({ ctx: ctx(), memberships: db.memberships, reservations: [], payments: [], others: { "new-1": { count: 0, unverifiable: false } } });
    expect(plan.refused).toHaveLength(1);
    await executeOwnedMembershipCleanup(store, plan, ctx());
    expect(log).toEqual([]);
  });
});

describe("ownsClass", () => {
  it("수업 소유권은 제목의 실행 UUID 조각과 센터가 모두 맞아야 한다", () => {
    expect(ownsClass({ id: "1", title: "NEWCLASS-BUY-ab12cd34-1760", center_id: "c" }, { runShort: "ab12cd34", centerId: "c" })).toBe(true);
    expect(ownsClass({ id: "1", title: "NEWCLASS-BUY-ab12cd34-1760", center_id: "other" }, { runShort: "ab12cd34", centerId: "c" })).toBe(false);
    expect(ownsClass({ id: "1", title: "정규 수업", center_id: "c" }, { runShort: "ab12cd34", centerId: "c" })).toBe(false);
  });
});

describe("격리 DB 가드(assertIsolatedTestDb) — 공유 DEV/Production에서 파괴적 E2E 차단", () => {
  const REF = "abcdefghij0123456789"; // 형식만 맞춘 가짜 ref
  const ok = (): Record<string, string> => ({ ISOLATED_TEST_DB_PROJECT_REF: REF, ISOLATED_TEST_DB_ACK: ISOLATED_DB_ACK_PHRASE, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` });
  const fails = (env: Record<string, string | undefined>, re?: RegExp) => { try { assertIsolatedTestDb(env); } catch (e) { expect(e).toBeInstanceOf(IsolatedTestDbGuardError); if (re) expect((e as Error).message).toMatch(re); return; } throw new Error("가드가 통과함"); };
  const jwt = (ref: string) => `h.${Buffer.from(JSON.stringify({ ref })).toString("base64url")}.s`;

  it("아무 선언이 없으면(공유 DEV 기본 상태) 차단", () => fails({ NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` }, /미선언/));
  it("ref만 선언하고 확인 문구가 없으면 차단", () => fails({ ...ok(), ISOLATED_TEST_DB_ACK: "1" }, /확인 문구/));
  it("정확히 선언·확인·URL 일치하면 통과", () => expect(() => assertIsolatedTestDb(ok())).not.toThrow());
  it("URL의 프로젝트가 선언과 다르면 차단(공유 DEV를 가리킨 채 다른 ref만 선언)", () => fails({ ...ok(), NEXT_PUBLIC_SUPABASE_URL: "https://zzzzzzzzzz0123456789.supabase.co" }, /일치하지 않음/));
  it("선언한 ref가 Production이면 차단", () => fails({ ...ok(), ISOLATED_TEST_DB_PROJECT_REF: "bxntqggkfwnhcczsbqtj", NEXT_PUBLIC_SUPABASE_URL: "https://bxntqggkfwnhcczsbqtj.supabase.co" }, /Production/));
  it("선언한 ref가 공유 DEV 목록에 있으면 차단", () => fails({ ...ok(), SHARED_DEV_PROJECT_REFS: `foo, ${REF}` }, /공유 DEV/));
  it("URL 우회(userinfo·경로·부분 일치·http 호스트 변형)는 모두 차단", () => {
    for (const u of [`https://${REF}.supabase.co.evil.example`, `https://x@${REF}.supabase.co`, `https://${REF}.supabase.co/rest/v1`, `https://evil.example/${REF}.supabase.co`, ""]) fails({ ...ok(), NEXT_PUBLIC_SUPABASE_URL: u });
  });
  it("service/anon 키의 project ref가 선언과 다르면 차단", () => {
    fails({ ...ok(), SUPABASE_SERVICE_ROLE_KEY: jwt("zzzzzzzzzz0123456789") }, /SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => assertIsolatedTestDb({ ...ok(), SUPABASE_SERVICE_ROLE_KEY: jwt(REF) })).not.toThrow();
  });
  it("오류 메시지에 URL/키 값을 넣지 않는다", () => {
    try { assertIsolatedTestDb({ NEXT_PUBLIC_SUPABASE_URL: "https://secretsecretsecret12.supabase.co", SUPABASE_SERVICE_ROLE_KEY: jwt("secretsecretsecret12") }); } catch (e) { expect((e as Error).message).not.toContain("secretsecretsecret12"); return; }
    throw new Error("통과하면 안 됨");
  });
  it("makeSupabaseStore는 가드를 통과하지 못하면 DB 클라이언트를 건드리기 전에 throw한다(삭제 함수가 만들어지지 않는다)", () => {
    const admin = { from: () => { throw new Error("DB에 접근하면 안 됨"); } };
    expect(() => makeSupabaseStore(admin, { NEXT_PUBLIC_SUPABASE_URL: "https://shareddevshareddev0000.supabase.co" })).toThrow(IsolatedTestDbGuardError);
    expect(() => makeSupabaseStore(admin, ok())).not.toThrow();
  });
});

describe("new-class-creation.spec.ts 정적 안전 확인", () => {
  const spec = readFileSync("tests/e2e/admin/new-class-creation.spec.ts", "utf8");
  it("조건 없이 memberships/payments를 직접 지우는 코드가 없다(소유권 모듈만 사용)", () => {
    expect(spec).not.toMatch(/from\("(memberships|payments|reservations)"\)[\s\S]{0,80}\.delete\(/);
    expect(spec).not.toMatch(/cleanupBuyProductMemberships\(/);
    expect(spec).toContain("executeOwnedMembershipCleanup");
  });
  it("beforeAll은 어떤 DB 접근보다 먼저 격리 DB 가드를 확인하고, 실패하면 BLOCKED로 건너뛴다", () => {
    const before = spec.slice(spec.indexOf("test.beforeAll"));
    expect(before.indexOf("assertIsolatedTestDb")).toBeGreaterThan(-1);
    expect(before.indexOf("assertIsolatedTestDb")).toBeLessThan(before.indexOf("loadTestAccountMeta"));
    expect(before).toMatch(/test\.skip\(true, `BLOCKED:/);
  });
  it("afterAll은 격리 확인 전에는 아무 것도 하지 않고, 소유 증명 계획 → 수업 삭제 → 수강권 삭제 순서를 지킨다", () => {
    const after = spec.slice(spec.indexOf("test.afterAll"), spec.indexOf("test.beforeAll"));
    expect(after.indexOf("if (!isolatedDbConfirmed) return;")).toBeGreaterThan(-1);
    const iPrep = after.indexOf("prepareOwnedMembershipCleanup(");
    const iClasses = after.indexOf("cleanupOwnedClasses()");
    const iExec = after.indexOf("executeOwnedMembershipCleanup(");
    expect(iPrep).toBeGreaterThan(-1); expect(iPrep).toBeLessThan(iClasses); expect(iClasses).toBeLessThan(iExec);
  });
  it("beforeAll은 기존 수강권을 지우지 않고 스냅샷만 만들며, 모든 신규 수업 제목에 실행별 UUID 조각이 들어간다", () => {
    expect(spec).toContain("preexistingBuyMembershipIds");
    for (const k of ["ALL", "SPECIFIC", "BUY", "GOODSCHK", "CONTROL"]) expect(spec).toContain(`NEWCLASS-${k}-\${RUN_SHORT}`);
  });
});
