// 격리 PostgreSQL(PGlite) — 비로그인 공개 상품 예약조건 RPC 경계. 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/public-product-schedule-rules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const rpcSql = read('add_public_product_schedule_rules_20261003.sql');
const rollbackSql = read('rollback_add_public_product_schedule_rules_20261003.sql');
// 공개 storefront 함수는 Production과 같은 정의 파일(add_internal_qa_center_flag.sql)에서 그대로 꺼내 쓴다 — 새 RPC가 이 경계를 재사용하는지 확인하려는 것
const qa = read('add_internal_qa_center_flag.sql');
const storefront = qa.slice(qa.indexOf('create or replace function fetch_public_storefront_products'), qa.indexOf('grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;') + 'grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;'.length);
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const CA = id(1), CB = id(2), CINT = id(3), CPEND = id(4);

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    create table centers(id uuid primary key, name text, status text, is_internal boolean default false);
    create table products(id uuid primary key, center_id uuid, name text, price int default 1000, product_kind text default 'pass', description text, total_count int, unlimited boolean default false, unlimited_pass boolean default false,
      group_label text, max_quantity int, is_active boolean default true, is_on_sale boolean default true, visibility_type text default 'all', purchase_count_selectable boolean default false);
    create table memberships(id uuid primary key default gen_random_uuid(), product_id uuid, status text);
    create table product_count_prices(id uuid primary key default gen_random_uuid(), product_id uuid, count int, price int);
    create table membership_schedule_rules(id uuid primary key default gen_random_uuid(), product_id uuid not null, day_of_week int, start_time time, class_title text, created_at timestamptz default now());
    alter table membership_schedule_rules enable row level security;
    create policy "예약조건 조회" on membership_schedule_rules for select using (auth.uid() is not null);
    grant select on membership_schedule_rules to anon, authenticated;   -- Production과 동일: 테이블 권한은 있지만 RLS가 anon을 막는다
    insert into centers values ('${CA}','A센터','approved',false), ('${CB}','B센터','approved',false), ('${CINT}','QA센터','approved',true), ('${CPEND}','대기센터','pending',false);
  `);
  await db.exec(storefront);
  return db;
}
const prod = (n, center, extra = '') => `insert into products(id, center_id, name${extra ? ', ' + extra.split('|')[0] : ''}) values ('${id(n)}','${center}','p${n}'${extra ? ', ' + extra.split('|')[1] : ''});`;
const rule = (n, day, time, title = null) => `insert into membership_schedule_rules(product_id, day_of_week, start_time, class_title) values ('${id(n)}', ${day}, ${time ? `'${time}'` : 'null'}, ${title ? `'${title}'` : 'null'});`;
const asAnon = async (db, sql) => { await db.exec('set role anon'); try { return (await db.query(sql)).rows; } finally { await db.exec('reset role'); } };
const call = (db, center) => asAnon(db, `select product_id, day_of_week, to_char(start_time,'HH24:MI') t, class_title from fetch_public_product_schedule_rules(${center ? `'${center}'` : 'null'})`);

async function world() {
  const db = await fixture();
  await db.exec([
    prod(10, CA), rule(10, 1, '19:00', '정규반'), rule(10, 3, '20:30', '정규반'), rule(10, null, null, null),    // 공개 pass
    prod(11, CINT), rule(11, 1, '19:00'),                                                                   // 내부 QA 센터
    prod(12, CPEND), rule(12, 1, '19:00'),                                                                  // 미승인 센터
    prod(13, CA, 'is_active|false'), rule(13, 1, '19:00'),                                                  // 비활성
    prod(14, CA, 'is_on_sale|false'), rule(14, 1, '19:00'),                                                 // 판매중지
    prod(15, CA, `visibility_type|'grades'`), rule(15, 1, '19:00'),                                         // 등급 전용
    prod(16, CA, `visibility_type|'selected_members'`), rule(16, 1, '19:00'),                               // 지정회원 전용
    prod(17, CA, `product_kind|'goods'`), rule(17, 1, '19:00'),                                             // 상품(대여권 등)
    prod(18, CA, 'purchase_count_selectable|true'), rule(18, 2, '10:00'),                                   // 횟수 선택형인데 가격표 없음 → 비공개
    prod(19, CA, 'purchase_count_selectable|true'), rule(19, 2, '11:00'), `insert into product_count_prices(product_id,count,price) values ('${id(19)}',4,40000);`,
    prod(20, CB), rule(20, 5, '09:00'),                                                                     // 다른 센터 공개 pass
    prod(21, CA),                                                                                            // 예약조건 없는 자유이용
  ].join('\n'));
  return db;
}

test('anon: 승인 센터 + 전체공개 + 판매중 + active pass의 규칙만 조회된다(다른 모든 경계는 0행)', async () => {
  const db = await world();
  try {
    await db.exec(rpcSql);
    const rows = await call(db, CA);
    assert.deepEqual([...new Set(rows.map(r => r.product_id))].sort(), [id(10), id(19)]);   // 10(공개 pass), 19(가격표 있는 횟수 선택형)
    assert.equal(rows.filter(r => r.product_id === id(10)).length, 3);
    assert.deepEqual(rows.filter(r => r.product_id === id(10)).map(r => [r.day_of_week, r.t, r.class_title]).sort(), [[1, '19:00', '정규반'], [3, '20:30', '정규반'], [null, null, null]].sort());
    for (const hidden of [11, 12, 13, 14, 15, 16, 17, 18, 20, 21]) assert.ok(!rows.some(r => r.product_id === id(hidden)), `상품 ${hidden}은 노출되면 안 된다`);
  } finally { await db.close(); }
});

test('internal QA 센터 / 미승인 센터를 직접 지정해도 0행, 다른 센터 id를 넣어도 그 센터의 공개 상품 것만, NULL center는 0행', async () => {
  const db = await world();
  try {
    await db.exec(rpcSql);
    assert.equal((await call(db, CINT)).length, 0);
    assert.equal((await call(db, CPEND)).length, 0);
    assert.deepEqual((await call(db, CB)).map(r => r.product_id), [id(20)]);
    assert.equal((await call(db, null)).length, 0);
    assert.equal((await call(db, id(999))).length, 0);
  } finally { await db.close(); }
});

test('원본 membership_schedule_rules는 anon에게 여전히 열리지 않는다(RLS) — migration이 정책/권한을 늘리지 않는다', async () => {
  const db = await world();
  try {
    assert.equal((await asAnon(db, 'select * from membership_schedule_rules')).length, 0);   // 이미 RLS로 0행
    const before = (await db.query(`select has_table_privilege('anon','membership_schedule_rules','select') p, (select count(*)::int from pg_policy where polrelid='membership_schedule_rules'::regclass) n`)).rows[0];
    await db.exec(rpcSql);
    const after = (await db.query(`select has_table_privilege('anon','membership_schedule_rules','select') p, (select count(*)::int from pg_policy where polrelid='membership_schedule_rules'::regclass) n`)).rows[0];
    assert.deepEqual(after, before);
    assert.equal((await asAnon(db, 'select * from membership_schedule_rules')).length, 0);
    const body = rpcSql.replace(/--.*$/gm, '');
    assert.doesNotMatch(body, /create policy|alter table|grant select|using\s*\(\s*true/i);
  } finally { await db.close(); }
});

test('함수 권한/보안: SECURITY DEFINER + search_path 고정, PUBLIC revoke 후 anon/authenticated만 실행, storefront 함수를 그대로 재사용', async () => {
  const db = await world();
  try {
    await db.exec(rpcSql);
    const p = (await db.query(`select p.prosecdef, p.proconfig::text cfg, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') b, has_function_privilege('public', p.oid, 'execute') c from pg_proc p where proname='fetch_public_product_schedule_rules'`)).rows[0];
    assert.equal(p.prosecdef, true); assert.match(p.cfg, /search_path=public/); assert.equal(p.a, true); assert.equal(p.b, true); assert.equal(p.c, false);
    const body = rpcSql.replace(/--.*$/gm, '');
    assert.match(body, /join public\.fetch_public_storefront_products\(p_center_id\) s on s\.id = r\.product_id/);   // 독자적인 공개 판단을 만들지 않는다
    assert.match(body, /s\.product_kind = 'pass'/);
    assert.match(body, /begin;[\s\S]*commit;/);
    assert.doesNotMatch(body, /\b(delete|update|insert|truncate|drop table)\b/i);   // read-only
  } finally { await db.close(); }
});

test('authenticated(로그인) 호출도 같은 공개 경계, rollback은 RPC만 제거하고 재실행 안전', async () => {
  const db = await world();
  try {
    await db.exec(rpcSql);
    await db.exec(rpcSql);   // idempotent
    await db.exec('set role authenticated');
    const r = (await db.query(`select count(*)::int c from fetch_public_product_schedule_rules('${CA}')`)).rows[0].c;
    await db.exec('reset role');
    assert.equal(r, 4);   // 10번 3개 + 19번 1개
    await db.exec(rollbackSql);
    assert.equal((await db.query(`select count(*)::int c from pg_proc where proname='fetch_public_product_schedule_rules'`)).rows[0].c, 0);
    assert.equal((await db.query(`select count(*)::int c from membership_schedule_rules`)).rows[0].c, 13);   // 데이터 불변(세팅한 규칙 13개)
    await db.exec(rollbackSql);
  } finally { await db.close(); }
});
