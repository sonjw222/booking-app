// 제안 SQL(add_orders_selected_size_validation_20261109_proposed.sql)을 PGlite(실제 Postgres)에서 실행해 동작을 확인한다.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
const read = (f: string) => readFileSync(path.resolve(__dirname, "../..", f), "utf8");
const apply = read("add_orders_selected_size_validation_20261109_proposed.sql"), rollback = read("rollback_add_orders_selected_size_validation_20261109_proposed.sql");
const P_SIZED = "00000000-0000-0000-0000-0000000000a1", P_PLAIN = "00000000-0000-0000-0000-0000000000a2", UID = "00000000-0000-0000-0000-0000000000b1";

async function world() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create table products(id uuid primary key, price int, sizes text[]);
    create table orders(id uuid primary key default gen_random_uuid(), product_id uuid references products(id), selected_size text, created_at timestamptz default now());
    create function orders_snapshot_product_amount() returns trigger language plpgsql as $$ begin return new; end $$;
    insert into products values ('${P_SIZED}', 10000, array['S','M','L']), ('${P_PLAIN}', 5000, null);
  `);
  await db.exec(apply);
  return db;
}
const asUser = (db: PGlite, on: boolean) => db.exec(`select set_config('test.uid', '${on ? UID : ""}', false)`);
const insert = (db: PGlite, product: string, size: string | null) => db.query(`insert into orders(product_id, selected_size) values ('${product}', ${size === null ? "null" : `'${size}'`})`);

describe("주문 selected_size 서버 검증(제안 SQL, PGlite)", () => {
  it("클라이언트 세션: 사이즈 필수 상품 — 목록 안의 사이즈만 통과", async () => {
    const db = await world(); await asUser(db, true);
    await expect(insert(db, P_SIZED, "M")).resolves.toBeTruthy();
    await expect(insert(db, P_SIZED, null)).rejects.toThrow(/사이즈를 선택해주세요/);
    await expect(insert(db, P_SIZED, "")).rejects.toThrow(/사이즈를 선택해주세요/);
    await expect(insert(db, P_SIZED, "XXL")).rejects.toThrow(/선택할 수 없는 사이즈/);
  });
  it("클라이언트 세션: 사이즈 없는 상품에는 사이즈를 실을 수 없다", async () => {
    const db = await world(); await asUser(db, true);
    await expect(insert(db, P_PLAIN, null)).resolves.toBeTruthy();
    await expect(insert(db, P_PLAIN, "M")).rejects.toThrow(/사이즈를 선택할 수 없어요/);
  });
  it("서버 경로(auth.uid 없음)는 영향 없음, 기존 행은 건드리지 않는다", async () => {
    const db = await world(); await asUser(db, false);
    await expect(insert(db, P_SIZED, null)).resolves.toBeTruthy();
    await expect(insert(db, P_SIZED, "XXL")).resolves.toBeTruthy();
    expect(Number((await db.query<{ n: string }>("select count(*) n from orders")).rows[0].n)).toBe(2);
  });
  it("멱등(두 번 적용 가능)·롤백 후에는 검증이 사라진다", async () => {
    const db = await world(); await db.exec(apply); await asUser(db, true);
    await expect(insert(db, P_SIZED, "XXL")).rejects.toThrow();
    await db.exec(rollback);
    await expect(insert(db, P_SIZED, "XXL")).resolves.toBeTruthy();
    expect((await db.query("select 1 from pg_trigger where tgname='orders_validate_selected_size'")).rows).toHaveLength(0);
    await db.exec(rollback);   // 롤백도 멱등
  });
  it("데이터 변경 문장이 없다(새 함수·트리거만)", () => {
    const sql = apply.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/\b(delete\s+from|truncate|drop\s+table|insert\s+into|update\s+\w+\s+set)\b/i);
  });
});
