// 격리 PostgreSQL(PGlite) — QA/내부 센터 비가시화(add_internal_qa_center_flag.sql) readiness. 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/internal-qa-center-flag.test.mjs
// 이 파일은 Production QA runner(qa:production:*)를 실행하지 않는다 — 합성 스키마에서 정책/RPC 의미만 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('add_internal_qa_center_flag.sql');
const rollback = read('rollback_add_internal_qa_center_flag.sql');
const verify = read('verify_add_internal_qa_center_flag_20261004.sql').replace(/^\s*--.*$/gm, '');
// 마이그레이션 말미의 "확인" SELECT들은 테스트에서는 불필요(결과 무시) — 그대로 실행해도 무해하므로 수정하지 않는다.
const id = (k, n) => `${String(k).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const QA = id(1, 1), NORMAL = id(1, 2), PENDING = id(1, 3);
const ACC_STRANGER = id(2, 1), ACC_QAMEMBER = id(2, 2), ACC_QAMGR = id(2, 3), ACC_PLATFORM = id(2, 4), ACC_NORMGR = id(2, 5), ACC_PENDINGMGR = id(2, 6);
const P_STRANGER = id(3, 1), P_QAMEMBER = id(3, 2);

// 적용 직전 라이브 구조: reservation_functions.sql 의 정책 + fix_manager_centers_rls_recursion_final 의 my_center_ids_any_status
async function world({ apply = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create function my_account_id() returns uuid language sql stable as $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;
    create table profiles(id uuid primary key, account_id uuid);
    create table centers(id uuid primary key, name text, status text not null default 'pending');
    create table manager_centers(account_id uuid, center_id uuid, status text default 'active');
    create table center_members(id uuid primary key default gen_random_uuid(), center_id uuid, profile_id uuid, grade_id uuid);
    create table classes(id uuid primary key default gen_random_uuid(), center_id uuid, title text);
    create table products(id uuid primary key default gen_random_uuid(), center_id uuid, name text, price int default 1000, product_kind text default 'pass', description text,
      total_count int, unlimited boolean default false, unlimited_pass boolean default false, group_label text, max_quantity int, purchase_count_selectable boolean default false,
      min_purchase_count int, max_purchase_count int, is_active boolean default true, is_on_sale boolean default true, visibility_type text default 'all');
    create table memberships(product_id uuid, status text);
    create table product_count_prices(product_id uuid, count int, price int);
    create table membership_product_grades(product_id uuid, grade_id uuid);
    create table membership_product_members(product_id uuid, center_member_id uuid);
    create function is_platform_admin() returns boolean language sql stable security definer as $$ select my_account_id() = '${ACC_PLATFORM}'::uuid $$;
    create function my_profile_ids() returns setof uuid language sql stable security definer set search_path = public as $$ select id from profiles where account_id = my_account_id() $$;
    create function my_managed_center_ids() returns setof uuid language sql stable security definer set search_path = public as $$ select center_id from manager_centers where account_id = my_account_id() and status = 'active' $$;
    create function my_center_ids_any_status() returns setof uuid language sql stable security definer set search_path = public as $$ select center_id from manager_centers where account_id = my_account_id() $$;
    alter table centers enable row level security; alter table classes enable row level security; alter table products enable row level security;
    create policy "승인된 센터 조회" on centers for select using (status = 'approved' or id in (select my_managed_center_ids()) or id in (select my_center_ids_any_status()) or is_platform_admin());
    create policy "승인된 센터 수업 조회" on classes for select using (center_id in (select centers.id from centers where centers.status = 'approved') or center_id in (select my_managed_center_ids()));
    create policy "상품 조회" on products for select using (center_id in (select centers.id from centers where centers.status = 'approved') or center_id in (select my_managed_center_ids()));
    grant select on centers, classes, products, memberships, product_count_prices, membership_product_grades, membership_product_members, center_members, profiles, manager_centers to anon, authenticated;
    -- 라이브의 fetch_public_storefront_products / fetch_purchasable_products(내부 센터 제외 없는 이전 정의): 적용 전 상태를 재현하기 위해 마이그레이션이 덮어쓰기 전 stub
    create function fetch_public_storefront_products(p_center_id uuid default null) returns table (id uuid, center_id uuid, center_name text, name text, price integer, product_kind text, description text, total_count integer, unlimited boolean, unlimited_pass boolean, group_label text, remaining integer, purchase_count_selectable boolean, min_purchase_count integer, max_purchase_count integer, min_tier_price integer, max_tier_price integer)
      language sql stable security definer set search_path = public as $$ select null::uuid, null::uuid, null::text, null::text, null::int, null::text, null::text, null::int, null::boolean, null::boolean, null::text, null::int, null::boolean, null::int, null::int, null::int, null::int where false $$;
    create function fetch_purchasable_products(p_center_id uuid) returns setof products language sql stable security definer set search_path = public as $$ select p.* from products p where p.center_id = p_center_id and p.is_active and p.is_on_sale $$;
    revoke all on function fetch_public_storefront_products(uuid) from public; grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;
    revoke all on function fetch_purchasable_products(uuid) from public, anon; grant execute on function fetch_purchasable_products(uuid) to authenticated, service_role;
    insert into centers values ('${QA}','[QA] 센터','approved'), ('${NORMAL}','일반 센터','approved'), ('${PENDING}','승인대기 센터','pending');
    insert into profiles values ('${P_STRANGER}','${ACC_STRANGER}'), ('${P_QAMEMBER}','${ACC_QAMEMBER}');
    insert into manager_centers values ('${ACC_QAMGR}','${QA}','active'), ('${ACC_NORMGR}','${NORMAL}','active'), ('${ACC_PENDINGMGR}','${PENDING}','active');
    insert into center_members(center_id, profile_id) values ('${QA}','${P_QAMEMBER}');
    insert into classes(center_id, title) values ('${QA}','QA수업'), ('${NORMAL}','일반수업'), ('${PENDING}','대기수업');
    insert into products(center_id, name) values ('${QA}','QA상품'), ('${NORMAL}','일반상품'), ('${PENDING}','대기상품');
  `);
  if (apply) { await db.exec(migration); await db.exec(`update centers set is_internal = true where id = '${QA}'`); }
  return db;
}
const as = async (db, role, acc, fn) => { await db.exec(`set role ${role}; select set_config('app.account_id','${acc ?? ''}', false);`); try { return await fn(); } finally { await db.exec(`reset role; select set_config('app.account_id','',false);`); } };
const names = async (db, role, acc, table, col = 'name') => (await as(db, role, acc, () => db.query(`select ${col} n from ${table} order by 1`))).rows.map(r => r.n);

test('anon/무관한 로그인 계정: QA(내부) 센터·수업·상품이 직접 조회에서 보이지 않고 일반 센터는 그대로 보인다', async () => {
  const db = await world();
  try {
    for (const [role, acc] of [['anon', null], ['authenticated', ACC_STRANGER], ['authenticated', ACC_NORMGR]]) {
      const centers = await names(db, role, acc, 'centers');
      assert.ok(centers.includes('일반 센터'), `${role}/${acc}: ${centers}`);
      assert.ok(!centers.includes('[QA] 센터'), `${role}/${acc} centers`);
      assert.ok(!(await names(db, role, acc, 'classes', 'title')).includes('QA수업'), `${role}/${acc} classes`);
      assert.ok(!(await names(db, role, acc, 'products')).includes('QA상품'), `${role}/${acc} products`);
      assert.ok((await names(db, role, acc, 'products')).includes('일반상품'));
    }
  } finally { await db.close(); }
});

test('QA 회원/QA 매니저/플랫폼 관리자는 QA 센터에 정상 접근, 승인대기 센터는 그 매니저에게만(기존 동작 유지)', async () => {
  const db = await world();
  try {
    for (const acc of [ACC_QAMEMBER, ACC_QAMGR]) {
      assert.ok((await names(db, 'authenticated', acc, 'centers')).includes('[QA] 센터'), `centers ${acc}`);
      assert.ok((await names(db, 'authenticated', acc, 'classes', 'title')).includes('QA수업'), `classes ${acc}`);
      assert.ok((await names(db, 'authenticated', acc, 'products')).includes('QA상품'), `products ${acc}`);
    }
    assert.deepEqual(await names(db, 'authenticated', ACC_PLATFORM, 'centers'), ['[QA] 센터', '승인대기 센터', '일반 센터']);
    assert.ok((await names(db, 'authenticated', ACC_PENDINGMGR, 'centers')).includes('승인대기 센터'));
    assert.ok(!(await names(db, 'authenticated', ACC_STRANGER, 'centers')).includes('승인대기 센터'));
    assert.ok(!(await names(db, 'anon', null, 'centers')).includes('승인대기 센터'));
  } finally { await db.close(); }
});

test('기존 센터는 default false라 적용 후에도 동작 불변(일반 센터를 anon이 계속 조회)', async () => {
  const db = await world({ apply: false });
  try {
    await db.exec(migration);
    assert.equal((await db.query(`select is_internal from centers where id='${NORMAL}'`)).rows[0].is_internal, false);
    assert.deepEqual(await names(db, 'anon', null, 'centers'), ['[QA] 센터', '일반 센터']);          // flag를 켜기 전에는 QA 센터도 일반 approved와 동일(마이그레이션이 자동으로 센터를 internal로 바꾸지 않음)
  } finally { await db.close(); }
});

test('fetch_public_storefront_products(anon): 내부 센터 상품 제외, p_center_id로 UUID를 지정해도 0행', async () => {
  const db = await world();
  try {
    // 마이그레이션이 만든 실제 RPC가 쓰는 조건을 충족하는 공개 상품(승인 센터/활성/판매중/visibility all)
    const all = await as(db, 'anon', null, () => db.query(`select center_name, name from fetch_public_storefront_products(null)`));
    assert.deepEqual(all.rows.map(r => r.name), ['일반상품']);
    assert.equal((await as(db, 'anon', null, () => db.query(`select * from fetch_public_storefront_products('${QA}')`))).rows.length, 0);
    assert.equal((await as(db, 'authenticated', ACC_STRANGER, () => db.query(`select * from fetch_public_storefront_products('${QA}')`))).rows.length, 0);
    // QA 매니저/회원이라도 "공개" 목록에는 나오지 않는다(공개 경계 불변)
    assert.equal((await as(db, 'authenticated', ACC_QAMGR, () => db.query(`select * from fetch_public_storefront_products('${QA}')`))).rows.length, 0);
  } finally { await db.close(); }
});

test('fetch_purchasable_products: anon 실행 불가, 무관한 계정은 내부 센터 상품이 빈 목록, QA 회원/매니저는 조회, 일반 센터는 누구나', async () => {
  const db = await world();
  try {
    await assert.rejects(as(db, 'anon', null, () => db.query(`select * from fetch_purchasable_products('${NORMAL}')`)), /permission denied/);
    assert.equal((await as(db, 'authenticated', ACC_STRANGER, () => db.query(`select * from fetch_purchasable_products('${QA}')`))).rows.length, 0);
    assert.equal((await as(db, 'authenticated', ACC_QAMEMBER, () => db.query(`select * from fetch_purchasable_products('${QA}')`))).rows.length, 1);
    assert.equal((await as(db, 'authenticated', ACC_QAMGR, () => db.query(`select * from fetch_purchasable_products('${QA}')`))).rows.length, 1);
    assert.equal((await as(db, 'authenticated', ACC_STRANGER, () => db.query(`select * from fetch_purchasable_products('${NORMAL}')`))).rows.length, 1);
  } finally { await db.close(); }
});

test('helper my_member_center_ids: anon 실행 가능(정책 평가용)하지만 anon에게는 항상 빈 결과, PUBLIC 직접 권한 없음, RLS 재귀 없음', async () => {
  const db = await world();
  try {
    assert.equal((await as(db, 'anon', null, () => db.query(`select * from my_member_center_ids()`))).rows.length, 0);
    assert.deepEqual((await as(db, 'authenticated', ACC_QAMEMBER, () => db.query(`select my_member_center_ids() c`))).rows.map(r => r.c), [QA]);
    assert.equal((await db.query(`select has_function_privilege('public', 'my_member_center_ids()', 'execute') p`)).rows[0].p, false);
    assert.equal((await db.query(`select prosecdef, proconfig::text cfg from pg_proc where proname='my_member_center_ids'`)).rows[0].prosecdef, true);
  } finally { await db.close(); }
});

test('verify: 컬럼 없는 환경에서도 오류 없이 NOT_APPLIED → 적용 후 APPLIED → negative-control → rollback 후 NOT_APPLIED(QA 센터가 다시 일반 노출) → 재적용', async () => {
  assert.doesNotMatch(verify, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
  assert.equal(verify.trim().split(';').filter(x => x.trim()).length, 1);
  const db = await world({ apply: false });
  try {
    const v = async () => (await db.query(verify)).rows[0];
    let r = await v(); assert.equal(r.verdict, 'NOT_APPLIED'); assert.equal(r.internal_centers_now, null);
    await db.exec(migration); await db.exec(`update centers set is_internal = true where id = '${QA}'`);
    r = await v(); assert.equal(r.verdict, 'APPLIED', JSON.stringify(r)); assert.equal(r.internal_centers_now, 1);
    await db.exec(migration); assert.equal((await v()).verdict, 'APPLIED');                              // 재실행 안전
    for (const [brk, fix] of [
      [`drop policy "승인된 센터 조회" on centers; create policy "승인된 센터 조회" on centers for select using (status = 'approved' or is_platform_admin())`, null],
    ]) { await db.exec(brk); assert.equal((await v()).verdict, 'NOT_APPLIED'); await db.exec(migration); assert.equal((await v()).verdict, 'APPLIED'); }
    await db.exec(`grant execute on function fetch_purchasable_products(uuid) to anon`); assert.equal((await v()).verdict, 'NOT_APPLIED');
    await db.exec(`revoke execute on function fetch_purchasable_products(uuid) from anon`); assert.equal((await v()).verdict, 'APPLIED');
    await db.exec(rollback);
    assert.equal((await v()).verdict, 'NOT_APPLIED');
    assert.ok((await names(db, 'anon', null, 'centers')).includes('[QA] 센터'));                          // 롤백하면 approved QA 센터가 다시 일반 노출(롤백 파일 경고와 일치)
    assert.equal((await db.query(`select count(*)::int c from pg_proc where proname='my_member_center_ids'`)).rows[0].c, 0);
    await db.exec(migration); assert.equal((await v()).verdict, 'APPLIED');
  } finally { await db.close(); }
});
