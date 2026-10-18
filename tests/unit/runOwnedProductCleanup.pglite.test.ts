// 격리 PostgreSQL(PGlite)에서 실제 FK로 검증한다. CI E2E 3/4 실패(reservations_membership_id_fkey)를 재현하고,
// 새 정리 로직이 (a) 이 실행의 데이터는 FK 순서대로 지우고 (b) 소유를 증명 못 하면 아무 것도 지우지 않음을 확인한다.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { prepareRunOwnedCleanup, executeRunOwnedCleanup, type CleanupStore, type RunContext } from "../e2e/fixtures/runOwnedProductCleanup";

const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CENTER = U(1), USER_A = U(2), OTHER = U(3), PROD = U(4), OLD_PROD = U(5);
const K_OWN = U(10), K_STALE = U(11), M1 = U(20), M_OLD = U(21);

async function world() {
  const db = new PGlite();
  await db.exec(`
    create table products(id uuid primary key, center_id uuid, name text, is_on_sale boolean default true, is_active boolean default true);
    create table classes(id uuid primary key, center_id uuid, title text);
    create table memberships(id uuid primary key, profile_id uuid not null, product_id uuid references products(id), created_at timestamptz default now());
    create table reservations(id uuid primary key default gen_random_uuid(), class_id uuid references classes(id) on delete cascade, profile_id uuid, membership_id uuid references memberships(id));
    create table payments(id uuid primary key default gen_random_uuid(), membership_id uuid references memberships(id), profile_id uuid, created_at timestamptz default now());
    create table membership_transfers(id uuid primary key default gen_random_uuid(), membership_id uuid not null references memberships(id));
    create table product_passes(id uuid primary key default gen_random_uuid(), linked_membership_id uuid references memberships(id));
    create table contracts(id uuid primary key default gen_random_uuid(), membership_id uuid references memberships(id));
    create table admin_action_logs(id uuid primary key default gen_random_uuid(), membership_id uuid references memberships(id), source_unassigned_id uuid references memberships(id));
    create table class_allowed_products(class_id uuid references classes(id) on delete cascade, product_id uuid references products(id));
    insert into products(id, center_id, name) values ('${PROD}','${CENTER}','TEST4 신규구매전용패스 ab12cd34'), ('${OLD_PROD}','${CENTER}','TEST4 신규구매전용패스');
    insert into classes values ('${K_OWN}','${CENTER}','NEWCLASS-BUY-1'), ('${K_STALE}','${CENTER}','과거 실행 수업');
  `);
  return db;
}

function sqlStore(db: PGlite): CleanupStore {
  const list = (ids: string[]) => `(${ids.map((i) => `'${i}'`).join(",")})`;
  return {
    getProduct: async (id) => (await db.query<{ id: string; name: string; center_id: string }>(`select id, name, center_id from products where id='${id}'`)).rows[0] ?? null,
    membershipsOfProduct: async (id) => (await db.query<{ id: string; profile_id: string; product_id: string; created_at: string }>(`select id, profile_id, product_id, created_at::text as created_at from memberships where product_id='${id}'`)).rows,
    reservationsOf: async (ids) => (await db.query<{ id: string; class_id: string; membership_id: string; profile_id: string }>(`select id, class_id, membership_id, profile_id from reservations where membership_id in ${list(ids)}`)).rows,
    paymentsOf: async (ids) => (await db.query<{ id: string; membership_id: string; profile_id: string; created_at: string }>(`select id, membership_id, profile_id, created_at::text as created_at from payments where membership_id in ${list(ids)}`)).rows,
    otherReferences: async (id) => {
      const q = `select (select count(*) from membership_transfers where membership_id='${id}') + (select count(*) from product_passes where linked_membership_id='${id}') + (select count(*) from contracts where membership_id='${id}') + (select count(*) from admin_action_logs where membership_id='${id}' or source_unassigned_id='${id}') as n`;
      return { count: Number((await db.query<{ n: string }>(q)).rows[0].n), unverifiable: false };
    },
    deleteReservations: async (ids, classes, prof) => { await db.exec(`delete from reservations where id in ${list(ids)} and class_id in ${list(classes)} and profile_id='${prof}'`); },
    deletePayments: async (ids, prof) => { await db.exec(`delete from payments where id in ${list(ids)} and profile_id='${prof}'`); },
    deleteMemberships: async (ids, prof, prod) => { await db.exec(`delete from memberships where id in ${list(ids)} and profile_id='${prof}' and product_id='${prod}'`); },
    deleteProduct: async (id, name, center) => {
      try { await db.exec(`delete from products where id='${id}' and name='${name}' and center_id='${center}'`); return true; }
      catch { await db.exec(`update products set is_on_sale=false, is_active=false where id='${id}'`); return false; }
    },
  };
}
const count = async (db: PGlite, t: string) => Number((await db.query<{ n: string }>(`select count(*) as n from ${t}`)).rows[0].n);
const ctx = (): RunContext => ({ runShort: "ab12cd34", profileId: USER_A, centerId: CENTER, productId: PROD, ownedClassIds: new Set([K_OWN]), runStartedAtMs: Date.now() - 5_000 });

describe("격리 PostgreSQL — 실제 FK", () => {
  it("재현: 옛 방식(payments → memberships만 삭제)은 예약이 남아 있으면 reservations_membership_id_fkey로 실패한다", async () => {
    const db = await world();
    await db.exec(`insert into memberships(id, profile_id, product_id) values ('${M_OLD}','${USER_A}','${OLD_PROD}');
      insert into reservations(class_id, profile_id, membership_id) values ('${K_STALE}','${USER_A}','${M_OLD}');
      insert into payments(membership_id, profile_id) values ('${M_OLD}','${USER_A}')`);
    await db.exec(`delete from payments where membership_id='${M_OLD}'`);
    await expect(db.exec(`delete from memberships where id='${M_OLD}'`)).rejects.toThrow(/reservations_membership_id_fkey/);
  });

  it("수정: 이 실행이 만든 수강권·예약·결제·상품은 FK 순서대로 모두 정리된다", async () => {
    const db = await world();
    await db.exec(`insert into memberships(id, profile_id, product_id) values ('${M1}','${USER_A}','${PROD}');
      insert into reservations(class_id, profile_id, membership_id) values ('${K_OWN}','${USER_A}','${M1}');
      insert into payments(membership_id, profile_id) values ('${M1}','${USER_A}')`);
    const store = sqlStore(db);
    const plan = await prepareRunOwnedCleanup(store, ctx());
    expect(plan.refused).toEqual([]);
    expect((await executeRunOwnedCleanup(store, plan, ctx())).productDeleted).toBe(true);
    expect([await count(db, "reservations"), await count(db, "payments"), await count(db, "memberships")]).toEqual([0, 0, 0]);
    expect(await count(db, "products")).toBe(1); // 옛 고정 이름 상품은 그대로
  });

  it("수정: 이 실행이 만들지 않은 수업의 예약이 이 수강권을 참조하면 아무 것도 지우지 않고 거부한다", async () => {
    const db = await world();
    await db.exec(`insert into memberships(id, profile_id, product_id) values ('${M1}','${USER_A}','${PROD}');
      insert into reservations(class_id, profile_id, membership_id) values ('${K_OWN}','${USER_A}','${M1}'), ('${K_STALE}','${USER_A}','${M1}');
      insert into payments(membership_id, profile_id) values ('${M1}','${USER_A}')`);
    const store = sqlStore(db);
    const plan = await prepareRunOwnedCleanup(store, ctx());
    expect(plan.refused.length).toBe(1);
    await executeRunOwnedCleanup(store, plan, ctx());
    expect([await count(db, "reservations"), await count(db, "payments"), await count(db, "memberships"), await count(db, "products")]).toEqual([2, 1, 1, 2]);
  });

  it("수정: 과거 실행의 잔여물(고정 이름 상품의 수강권+예약)은 이 실행이 전혀 건드리지 않는다", async () => {
    const db = await world();
    await db.exec(`insert into memberships(id, profile_id, product_id, created_at) values ('${M_OLD}','${USER_A}','${OLD_PROD}', now() - interval '3 days');
      insert into reservations(class_id, profile_id, membership_id) values ('${K_STALE}','${USER_A}','${M_OLD}')`);
    const store = sqlStore(db);
    const plan = await prepareRunOwnedCleanup(store, ctx()); // 이 실행의 상품(PROD)에는 수강권이 없다
    expect(plan).toMatchObject({ refused: [], deleteMembershipIds: [], deleteProduct: true });
    await executeRunOwnedCleanup(store, plan, ctx());
    expect([await count(db, "memberships"), await count(db, "reservations")]).toEqual([1, 1]);
  });

  it("수정: 예약·결제 외 참조(양도 등)가 있으면 거부, 소유 조건이 다른 행은 id가 같아도 지워지지 않는다", async () => {
    const db = await world();
    await db.exec(`insert into memberships(id, profile_id, product_id) values ('${M1}','${USER_A}','${PROD}');
      insert into membership_transfers(membership_id) values ('${M1}')`);
    const store = sqlStore(db);
    expect((await prepareRunOwnedCleanup(store, ctx())).refused.length).toBe(1);
    // 다른 프로필로 소유 조건을 걸면 삭제되지 않는다
    await store.deleteMemberships([M1], OTHER, PROD);
    expect(await count(db, "memberships")).toBe(1);
  });

  it("동시 실행: 두 실행(A·B)이 각자 새 상품을 쓰므로 한쪽 정리가 다른 쪽 상품·수강권·예약을 건드리지 않는다", async () => {
    const db = await world();
    const PROD_B = U(40), M_B = U(41), K_B = U(12);
    await db.exec(`insert into products(id, center_id, name) values ('${PROD_B}','${CENTER}','TEST4 신규구매전용패스 ff99ee88');
      insert into classes values ('${K_B}','${CENTER}','NEWCLASS-BUY-ff99ee88-1');
      insert into memberships(id, profile_id, product_id) values ('${M1}','${USER_A}','${PROD}'), ('${M_B}','${USER_A}','${PROD_B}');
      insert into reservations(class_id, profile_id, membership_id) values ('${K_OWN}','${USER_A}','${M1}'), ('${K_B}','${USER_A}','${M_B}');
      insert into payments(membership_id, profile_id) values ('${M1}','${USER_A}'), ('${M_B}','${USER_A}')`);
    const store = sqlStore(db);
    const ctxA = ctx();
    const planA = await prepareRunOwnedCleanup(store, ctxA);   // 실행 A만 정리
    expect(planA.refused).toEqual([]);
    await executeRunOwnedCleanup(store, planA, ctxA);
    // B의 데이터는 그대로
    const left = await db.query<{ id: string }>(`select id from memberships`);
    expect(left.rows.map((r) => r.id)).toEqual([M_B]);
    expect([await count(db, "reservations"), await count(db, "payments")]).toEqual([1, 1]);
    // B도 자기 것만 정리된다
    const ctxB: RunContext = { runShort: "ff99ee88", profileId: USER_A, centerId: CENTER, productId: PROD_B, ownedClassIds: new Set([K_B]), runStartedAtMs: Date.now() - 5_000 };
    const planB = await prepareRunOwnedCleanup(store, ctxB);
    expect(planB.refused).toEqual([]);
    await executeRunOwnedCleanup(store, planB, ctxB);
    expect([await count(db, "memberships"), await count(db, "reservations"), await count(db, "payments")]).toEqual([0, 0, 0]);
  });

  it("재시도·반복 실행: 같은 정리를 다시 실행해도(이미 정리됨) 오류 없이 아무 것도 지우지 않고, 앞 실행 잔여물이 있어도 새 실행은 새 상품만 본다", async () => {
    const db = await world();
    await db.exec(`insert into memberships(id, profile_id, product_id, created_at) values ('${M_OLD}','${USER_A}','${OLD_PROD}', now() - interval '1 day');
      insert into reservations(class_id, profile_id, membership_id) values ('${K_STALE}','${USER_A}','${M_OLD}')`);   // 앞 실행(재시도 전)이 남긴 잔여물
    const store = sqlStore(db);
    for (let i = 0; i < 3; i++) {                                    // 새 상품에는 수강권이 없는 상태로 반복
      const plan = await prepareRunOwnedCleanup(store, ctx());
      expect(plan.refused).toEqual([]);
      await executeRunOwnedCleanup(store, plan, ctx());
    }
    expect([await count(db, "memberships"), await count(db, "reservations")]).toEqual([1, 1]);   // 잔여물 보존
    const again = await prepareRunOwnedCleanup(store, ctx());         // 상품이 이미 사라진 뒤
    expect(again).toMatchObject({ deleteProduct: false, refused: [] });
  });

  it("소유 위조: 이름에 RUN_SHORT가 있어도 다른 센터 상품이거나 다른 프로필·이전 시각 수강권이면 거부한다", async () => {
    const db = await world();
    const FOREIGN_CENTER = U(99);
    await db.exec(`update products set center_id='${FOREIGN_CENTER}' where id='${PROD}';
      insert into memberships(id, profile_id, product_id) values ('${M1}','${OTHER}','${PROD}')`);
    const store = sqlStore(db);
    const plan = await prepareRunOwnedCleanup(store, ctx());
    expect(plan.refused.length).toBeGreaterThanOrEqual(2);          // 센터 불일치 + 다른 프로필
    await executeRunOwnedCleanup(store, plan, ctx());
    expect([await count(db, "memberships"), await count(db, "products")]).toEqual([1, 2]);
  });
});
