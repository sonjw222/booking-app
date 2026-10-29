import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

/* 만료 상품 자동 노출 종료(fix_expired_fixed_date_products_20261031.sql) — PGlite(실제 PostgreSQL 엔진)로 규칙·경계·주문 차단을 검증한다.
   해시 가드(운영 정의 해시)는 PGlite 에 운영 함수가 없어 시험하지 않고, 가드를 뺀 "본문"(헬퍼+함수 4+정책)만 적용한다. 가드는 격리 Supabase 스택에서 따로 확인했다. */
const SQL = readFileSync(new URL('../../fix_expired_fixed_date_products_20261031.sql', import.meta.url), 'utf8');
const body = SQL.slice(SQL.indexOf('create or replace function public.fixed_expiry_passed'), SQL.indexOf("do $$\ndeclare r record; v_pol text;\nbegin\n    for r in select * from (values", SQL.indexOf('alter policy')));

const schema = `
create role anon; create role authenticated; create role service_role;
grant usage on schema public to anon, authenticated;
create table centers(id uuid primary key, name text, status text, is_internal boolean default false);
create table products(id uuid primary key, center_id uuid, name text, price int, product_kind text default 'pass', description text, total_count int, unlimited boolean default false, unlimited_pass boolean default false,
  group_label text, max_quantity int, purchase_count_selectable boolean default false, is_active boolean default true, is_on_sale boolean default true, visibility_type text default 'all',
  expiry_mode text, expiry_days int, expiry_date date, rolling_month_cutoff_day int, rolling_month_allow_early_use boolean);
create table product_count_prices(product_id uuid, count int, price int);
create table memberships(id uuid primary key default gen_random_uuid(), product_id uuid, status text default 'active', profile_id uuid, center_id uuid, created_at timestamptz default now());
create table membership_product_grades(product_id uuid, grade_id uuid); create table membership_product_members(product_id uuid, center_member_id uuid);
create table center_members(id uuid primary key default gen_random_uuid(), center_id uuid, profile_id uuid, grade_id uuid);
create table profiles(id uuid primary key, account_id uuid, is_primary boolean default true, created_at timestamptz default now());
create table orders(id uuid primary key default gen_random_uuid(), center_id uuid not null, profile_id uuid not null, product_id uuid, product_name text, amount int, pay_method text, selected_size text, auto_book boolean, payment_provider text, status text default 'pending', verified boolean default false);
create function nicepay_review_center_member_allowed(uuid) returns boolean language sql stable as $$ select true $$;
create function my_member_center_ids() returns setof uuid language sql stable as $$ select null::uuid where false $$;
create function my_managed_center_ids() returns setof uuid language sql stable as $$ select null::uuid where false $$;
create function my_profile_ids() returns setof uuid language sql stable security definer as $$ select id from profiles $$;
create function my_account_id() returns uuid language sql stable security definer as $$ select account_id from profiles limit 1 $$;
create function use_points(uuid, uuid, int) returns void language sql as $$ select 1 $$;
create function member_can_purchase_product(p_product_id uuid, p_profile_id uuid) returns boolean language sql stable security definer as $$
  select coalesce((select p.is_active and p.is_on_sale and p.visibility_type = 'all' from products p where p.id = p_product_id), false) $$;
-- 적용 전(운영) 함수 껍데기: CREATE OR REPLACE 가 같은 반환형으로 교체하도록 같은 시그니처만 먼저 만든다(실제 정의는 본문이 덮어쓴다)
create function fetch_public_storefront_products(p_center_id uuid default null) returns table(id uuid, center_id uuid, center_name text, name text, price integer, product_kind text, description text, total_count integer, unlimited boolean, unlimited_pass boolean, group_label text, remaining integer, purchase_count_selectable boolean, min_purchase_count integer, max_purchase_count integer, min_tier_price integer, max_tier_price integer) language sql as $$ select null::uuid,null::uuid,null::text,null::text,null::int,null::text,null::text,null::int,null::bool,null::bool,null::text,null::int,null::bool,null::int,null::int,null::int,null::int where false $$;
create function fetch_public_storefront_product_periods(p_center_id uuid default null) returns table(product_id uuid, expiry_mode text, expiry_days integer, expiry_date date, rolling_month_cutoff_day integer, rolling_month_allow_early_use boolean) language sql as $$ select null::uuid,null::text,null::int,null::date,null::int,null::bool where false $$;
create function fetch_purchasable_products(p_center_id uuid) returns setof products language sql as $$ select * from products where false $$;
create function create_order_secure(p_product_id uuid, p_pay_method text default null, p_selected_size text default null, p_point_used integer default 0, p_auto_book boolean default false, p_provider text default null) returns uuid language sql as $$ select null::uuid $$;
alter table orders enable row level security;
create policy "주문 본인 생성" on orders for insert to authenticated with check ((profile_id in (select my_profile_ids())) and ((product_id is null) or member_can_purchase_product(product_id, profile_id)));
grant select, insert on orders to authenticated; grant select on products, centers to anon, authenticated;
`;
const KST = "(now() at time zone 'Asia/Seoul')::date";
const C = '00000000-0000-0000-0000-00000000c001', P = '00000000-0000-0000-0000-0000000000a1', ACC = '00000000-0000-0000-0000-0000000000b1';
const pid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

async function seed(db) {
  await db.exec(`insert into centers values ('${C}', '센터A', 'approved', false); insert into profiles(id, account_id) values ('${P}', '${ACC}');`);
  const rows = [
    [1, '어제 만료', "'date'", `${KST} - 1`], [2, '오늘 만료', "'date'", `${KST}`], [3, '내일 만료', "'date'", `${KST} + 1`],
    [4, '30일권', "'days'", 'null'], [5, '60일권', "'days'", 'null'], [6, '90일권', "'days'", 'null'], [7, '만료일 없음', "'none'", 'null'], [8, '월 갱신', "'rolling_month'", 'null'],
    [9, '매우 오래전 만료', "'date'", `${KST} - 400`],
  ];
  for (const [n, name, mode, d] of rows) await db.exec(`insert into products(id, center_id, name, price, total_count, expiry_mode, expiry_days, expiry_date, rolling_month_cutoff_day) values ('${pid(n)}', '${C}', '${name}', 10000, 5, ${mode}, ${mode === "'days'" ? (n === 4 ? 30 : n === 5 ? 60 : 90) : 'null'}, ${d}, ${mode === "'rolling_month'" ? 20 : 'null'});`);
}
const names = (rows) => rows.map((r) => r.name).sort();

test('만료 상품 자동 노출 종료: 목록·기간 RPC·구매 목록·신규 주문(정책/함수) 차단, 오늘·미래·다른 만료 방식 유지, 기존 데이터 불변, 날짜가 지나면 자동 숨김', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema); await seed(db);
    await db.exec(`insert into memberships(product_id, profile_id, center_id) values ('${pid(1)}', '${P}', '${C}'); insert into orders(center_id, profile_id, product_id, product_name, amount, status) values ('${C}', '${P}', '${pid(1)}', '어제 만료', 10000, 'pending');`);   // 기존 구매내역·pending 주문
    const snapshot = async () => JSON.stringify((await db.query('select id, is_active, is_on_sale, expiry_mode, expiry_date from products order by id')).rows);
    const before = await snapshot();
    await db.exec(body); await db.exec(body);   // 적용 + 재적용(멱등)
    assert.equal(await snapshot(), before, '상품 데이터는 하나도 바뀌지 않는다(is_on_sale·is_active·expiry_date 불변)');

    // 순수 규칙: KST 날짜 경계
    const f = async (mode, offset) => (await db.query(`select fixed_expiry_passed($1, ${KST} + ($2)::int) v`, [mode, offset])).rows[0].v;
    assert.equal(await f('date', -1), true); assert.equal(await f('date', 0), false); assert.equal(await f('date', 1), false);
    assert.equal(await f('days', -100), false); assert.equal(await f('rolling_month', -100), false); assert.equal(await f('none', -100), false);
    assert.equal((await db.query("select fixed_expiry_passed('date', null) v")).rows[0].v, false);
    // 같은 UTC 시각이라도 KST 날짜로 비교(UTC 15:00 이후는 KST 다음 날)
    assert.equal((await db.query("select ((timestamptz '2026-10-30 14:59:59+00') at time zone 'Asia/Seoul')::date = date '2026-10-30' a, ((timestamptz '2026-10-30 15:00:00+00') at time zone 'Asia/Seoul')::date = date '2026-10-31' b")).rows[0].a, true);

    // 공개(비로그인) 목록 — 어제·오래전 만료만 빠진다
    const pub = (await db.query('select name from fetch_public_storefront_products(null)')).rows;
    assert.deepEqual(names(pub), ['30일권', '60일권', '90일권', '내일 만료', '만료일 없음', '오늘 만료', '월 갱신']);
    const per = (await db.query('select product_id from fetch_public_storefront_product_periods(null)')).rows.map((r) => r.product_id);
    assert.ok(!per.includes(pid(1)) && !per.includes(pid(9)) && per.includes(pid(2)) && per.includes(pid(3)));
    // 센터별 목록(p_center_id)도 동일
    assert.equal((await db.query('select count(*)::int n from fetch_public_storefront_products($1)', [C])).rows[0].n, 7);
    // 로그인 회원 구매 가능 목록
    await db.exec('set role authenticated');
    const mem = (await db.query('select name from fetch_purchasable_products($1)', [C])).rows;
    assert.deepEqual(names(mem), names(pub.map((r) => ({ name: r.name }))));
    await db.exec('reset role');

    // 신규 주문: 함수 경로(create_order_secure) 와 직접 INSERT(RLS 정책) 모두 만료 상품은 거부, 오늘·미래·days 는 허용
    const co = (id) => db.query('select create_order_secure($1::uuid, $2::text, null, 0, false, $3::text) as id', [id, 'direct', 'mock']);
    await db.exec('set role authenticated');
    await assert.rejects(co(pid(1)), /판매 기간이 지난 상품/);
    await assert.rejects(co(pid(9)), /판매 기간이 지난 상품/);
    await db.exec('reset role');
    const ins = async (n) => { await db.exec('set role authenticated'); try { await db.query("insert into orders(center_id, profile_id, product_id, product_name, amount) values ($1,$2,$3,'x',1)", [C, P, pid(n)]); return 'ok'; } catch (e) { return e.code; } finally { await db.exec('reset role'); } };
    assert.equal(await ins(1), '42501'); assert.equal(await ins(9), '42501');
    for (const n of [2, 3, 4, 5, 6, 7, 8]) assert.equal(await ins(n), 'ok', `상품 ${n} 직접 주문은 허용`);
    assert.equal((await db.query("select create_order_secure($1::uuid,'direct',null,0,false,'mock') is not null ok", [pid(3)])).rows[0].ok, true);   // 함수 경로 내일 만료 허용(SQL 함수 아닌 plpgsql 본문)

    // 기존 구매내역·pending 주문·수강권 유지 + 기존 pending 주문의 확정·발급이 의존하는 member_can_purchase_product 는 만료와 무관하게 true(발급 사고 방지)
    assert.equal((await db.query("select count(*)::int n from memberships where product_id = $1", [pid(1)])).rows[0].n, 1);
    assert.equal((await db.query("select count(*)::int n from orders where product_id = $1 and status = 'pending'", [pid(1)])).rows[0].n, 1);
    assert.equal((await db.query('select member_can_purchase_product($1, $2) v', [pid(1), P])).rows[0].v, true);
    // 관리자(테이블 직접 조회)는 만료 상품을 그대로 본다
    assert.equal((await db.query("select count(*)::int n from products where expiry_mode = 'date' and expiry_date < " + KST)).rows[0].n, 2);

    // 날짜가 지나면 자동 숨김: 하루가 흐른 효과를 만료일을 하루 앞당겨 재현(cron·UPDATE 로 판매 상태를 바꾸지 않는다)
    await db.exec("update products set expiry_date = expiry_date - 1 where expiry_mode = 'date'");
    const next = (await db.query('select name from fetch_public_storefront_products(null)')).rows;
    assert.ok(!names(next).includes('오늘 만료') && names(next).includes('내일 만료'), '다음 날: 오늘 만료 상품이 사라지고 내일 만료 상품은 남는다');
    assert.equal((await db.query("select is_on_sale from products where id = $1", [pid(2)])).rows[0].is_on_sale, true, '판매 상태 자체는 그대로');
  } finally { await db.close(); }
});

test('목록 함수는 기존 조건(승인 센터·내부 센터 제외·판매 중·공개 범위·횟수 선택 가격표)을 그대로 유지한다', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema); await seed(db); await db.exec(body);
    await db.exec(`insert into centers values ('00000000-0000-0000-0000-00000000c002', '내부', 'approved', true), ('00000000-0000-0000-0000-00000000c003', '대기', 'pending', false);
      insert into products(id, center_id, name, price, expiry_mode) values ('${pid(20)}', '00000000-0000-0000-0000-00000000c002', '내부센터상품', 1, 'none'), ('${pid(21)}', '00000000-0000-0000-0000-00000000c003', '미승인센터상품', 1, 'none');
      insert into products(id, center_id, name, price, expiry_mode, is_on_sale) values ('${pid(22)}', '${C}', '판매중지', 1, 'none', false);
      insert into products(id, center_id, name, price, expiry_mode, visibility_type) values ('${pid(23)}', '${C}', '등급전용', 1, 'none', 'grades');
      insert into products(id, center_id, name, price, expiry_mode, purchase_count_selectable) values ('${pid(24)}', '${C}', '가격표없는선택형', 1, 'none', true);`);
    const pub = names((await db.query('select name from fetch_public_storefront_products(null)')).rows);
    for (const hidden of ['내부센터상품', '미승인센터상품', '판매중지', '등급전용', '가격표없는선택형', '어제 만료']) assert.ok(!pub.includes(hidden), `${hidden} 은 계속 숨김`);
    assert.ok(pub.includes('내일 만료'));
  } finally { await db.close(); }
});

test('변경 SQL 구조: 한 트랜잭션, 해시 가드·적용 후 검증, 적용 전 정의/정책 보존, member_can_purchase_product 는 바꾸지 않는다, 롤백은 적용 전 해시로 복원', () => {
  assert.match(SQL, /^begin;/m); assert.match(SQL, /^commit;/m);
  assert.match(SQL, /덮어쓰지 않고 중단합니다/); assert.match(SQL, /nicepay_review_center_member_allowed/);
  assert.doesNotMatch(SQL, /create or replace function public\.member_can_purchase_product/i);
  assert.doesNotMatch(SQL.replace(/--.*$/gm, ''), /\b(update|delete|truncate)\b\s+(public\.)?(products|orders|memberships|payments)|drop table/i);
  const rb = readFileSync(new URL('../../rollback_fix_expired_fixed_date_products_20261031.sql', import.meta.url), 'utf8');
  assert.match(rb, /drop function if exists public\.fixed_expiry_passed/); assert.match(rb, /b40c8da87ee36e7cfd6d3e2cb1880d4c/); assert.doesNotMatch(rb, /%%/);
});
