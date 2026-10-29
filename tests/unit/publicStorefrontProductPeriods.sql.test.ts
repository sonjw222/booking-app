import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(__dirname, "../..");
const sql = readFileSync(path.join(root, "add_public_storefront_product_periods_20261027.sql"), "utf8");
const body = sql.replace(/^\s*--.*$/gm, "");

describe("add_public_storefront_product_periods_20261027.sql — 추가 전용·노출 조건 동일(검토용, 실행 안 함)", () => {
  it("정적 계약: 새 함수 하나만 추가, 기존 객체 변경/삭제 없음, 권한 회수 후 anon/authenticated 만 허용", () => {
    expect(body).toMatch(/create or replace function fetch_public_storefront_product_periods\(p_center_id uuid default null\)/);
    expect(body).not.toMatch(/\b(drop|truncate|alter\s+table|delete\s+from|update\s+\w+\s+set|insert\s+into)\b/i);
    expect(body).toContain("security definer"); expect(body).toContain("set search_path = public");
    expect(body).toContain("revoke all on function fetch_public_storefront_product_periods(uuid) from public;");
    expect(body).toContain("grant execute on function fetch_public_storefront_product_periods(uuid) to anon, authenticated;");
    // 반환 컬럼은 이용기간 원본뿐 — 가격·설명·수량 등을 추가로 공개하지 않는다
    expect(body).not.toMatch(/\bp\.(price|description|name|max_quantity)\b/);
  });
  it("노출 조건이 기존 공개 목록(fetch_public_storefront_products)과 같은 술어를 쓴다", () => {
    const existing = readFileSync(path.join(root, "add_internal_qa_center_flag.sql"), "utf8");
    for (const pred of ["c.status = 'approved'", "not c.is_internal", "p.is_active", "p.is_on_sale", "p.visibility_type = 'all'", "(p_center_id is null or p.center_id = p_center_id)"]) {
      expect(existing, `기존 함수: ${pred}`).toContain(pred); expect(body, `새 함수: ${pred}`).toContain(pred);
    }
  });
  it("PGlite 동작: 노출 대상만, 5개 컬럼만, 센터 필터, 권한", async () => {
    const db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated;
      create table centers (id uuid primary key, status text not null, is_internal boolean not null default false);
      create table products (id uuid primary key default gen_random_uuid(), center_id uuid not null, name text, price int default 0, is_active boolean not null default true, is_on_sale boolean not null default true,
        visibility_type text not null default 'all', purchase_count_selectable boolean default false, expiry_mode text not null default 'none', expiry_days int, expiry_date date,
        rolling_month_cutoff_day int, rolling_month_allow_early_use boolean not null default false);
      create table product_count_prices (product_id uuid, count int, price int);
      insert into centers values ('00000000-0000-0000-0000-00000000000a','approved',false), ('00000000-0000-0000-0000-00000000000b','approved',true), ('00000000-0000-0000-0000-00000000000c','pending',false);
    `);
    await db.exec(sql);
    const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b", C = "00000000-0000-0000-0000-00000000000c";
    const ins = async (c: string, name: string, extra = "") => (await db.query<{ id: string }>(`insert into products(center_id,name,${extra ? extra.split("=")[0] + "," : ""}expiry_mode) values ('${c}','${name}',${extra ? extra.split("=")[1] + "," : ""}'days') returning id`)).rows[0].id;
    const ok = await ins(A, "공개"), internal = await ins(B, "내부센터"), pending = await ins(C, "미승인센터");
    const off = await ins(A, "판매중지", "is_on_sale=false"), hidden = await ins(A, "지정회원", "visibility_type='selected_members'"), inactive = await ins(A, "비활성", "is_active=false");
    const selNoPrice = await ins(A, "횟수선택 가격표없음", "purchase_count_selectable=true");
    const selWithPrice = await ins(A, "횟수선택 가격표있음", "purchase_count_selectable=true"); await db.exec(`insert into product_count_prices values ('${selWithPrice}', 4, 40000)`);
    await db.exec(`update products set expiry_days = 90, expiry_date = null where id = '${ok}'`);
    const all = await db.query<Record<string, unknown>>(`select * from fetch_public_storefront_product_periods()`);
    const ids = all.rows.map((r) => r.product_id as string).sort();
    expect(ids).toEqual([ok, selWithPrice].sort());
    for (const excluded of [internal, pending, off, hidden, inactive, selNoPrice]) expect(ids).not.toContain(excluded);
    expect(Object.keys(all.rows[0]).sort()).toEqual(["expiry_date", "expiry_days", "expiry_mode", "product_id", "rolling_month_allow_early_use", "rolling_month_cutoff_day"]);
    expect(all.rows.find((r) => r.product_id === ok)).toMatchObject({ expiry_mode: "days", expiry_days: 90 });
    expect((await db.query(`select * from fetch_public_storefront_product_periods('${B}')`)).rows).toHaveLength(0);   // 내부 센터는 센터 지정으로도 안 나온다
    expect((await db.query<{ a: boolean; p: boolean; au: boolean }>(`select has_function_privilege('anon','fetch_public_storefront_product_periods(uuid)','execute') a, has_function_privilege('public','fetch_public_storefront_product_periods(uuid)','execute') p, has_function_privilege('authenticated','fetch_public_storefront_product_periods(uuid)','execute') au`)).rows[0]).toEqual({ a: true, p: false, au: true });
  });
});
