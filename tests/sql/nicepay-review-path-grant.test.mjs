import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

/* 실제 센터 허용 행 추가/롤백 SQL(2026-11-06) — 운영 baseline 스키마 + P2 + 허용 목록 SQL 위에서 PGlite(Docker·포트 없음)로 검증한다. 운영 DB 는 건드리지 않는다. */
const read = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const BASELINE = read('isolated-supabase/supabase/migrations/20261027000000_baseline_public_schema.sql').replace(/^\s*(CREATE EXTENSION|COMMENT ON EXTENSION)[^;]*;/gim, '').replace(/ALTER (TABLE|FUNCTION|SEQUENCE|VIEW|SCHEMA)[^;]*OWNER TO[^;]*;/gi, '');
const P2 = read('add_nicepay_review_center_isolation_20261028.sql'), GRANTS = read('add_nicepay_review_real_center_grants_20261103.sql');
const GRANT = read('grant_nicepay_review_real_center_20261106_proposed.sql'), ROLLBACK = read('rollback_grant_nicepay_review_real_center_20261106.sql'), AUDIT = read('audit_nicepay_review_path_readonly_20261106.sql');
const AUTH = '7ffcf57d-b6d1-4562-a260-33be15f66ee5', CENTER = '8965e09c-0d2b-44c6-ab26-40a85507f8b5', ACC = '00000000-0000-4000-8000-0000000000a1', PROD = '00000000-0000-4000-8000-0000000000b1';

async function world() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_admin;
    create schema auth; create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz); create table auth.identities(id uuid, user_id uuid, provider text);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$; create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$; create function auth.role() returns text language sql as $$ select 'postgres'::text $$;
    create schema extensions; create schema storage; create schema realtime; create schema vault; create schema cron; create schema net;`);
  await db.exec(BASELINE); await db.exec('set search_path = public, auth');
  await db.exec(P2); await db.exec(GRANTS);
  await db.exec(`insert into auth.users values ('${AUTH}', 'niceqa@mwhabit.com', now());
    insert into accounts(id, auth_id, name, nicepay_review_access) values ('${ACC}', '${AUTH}', 'niceqa', true);
    insert into centers(id, name, status) values ('${CENTER}', 'A10TION 피겨팀', 'approved');
    insert into products(id, center_id, name, price, is_active, is_on_sale, product_kind, pass_type, total_count, expiry_mode, expiry_date) values ('${PROD}', '${CENTER}', '11월 수강권', 80000, true, true, 'pass', 'count', 8, 'date', '2099-11-28');`);
  return db;
}
const run = async (db, sql) => { try { await db.exec(sql); return ''; } catch (e) { try { await db.exec('rollback'); } catch { /* 종료됨 */ } return String(e.message); } };
const q = async (db, sql) => (await db.query(sql)).rows;
const grants = async (db) => (await q(db, `select account_id::text a, center_id::text c, can_purchase p from nicepay_review_center_grants`));

test('baseline+P2+허용 SQL 위에서 감사(읽기 전용) SQL 이 오류 없이 실행되고 데이터를 바꾸지 않는다', async () => {
  const db = await world(); const before = JSON.stringify(await grants(db));
  const stmts = AUDIT.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !s.split('\n').every((l) => l.startsWith('--')));
  for (const st of stmts) await db.query(st);
  assert.equal(JSON.stringify(await grants(db)), before);
  const prod = (await q(db, stmts.find((s) => /from products p where p.center_id/.test(s))))[0]; assert.equal(prod.is_sellable_now, true);
});

test('허용 SQL: 조회 전용 1행만 추가, 중복 실행 중단, 롤백은 그 1행만 삭제, 롤백 재실행 무변경, 다시 적용 가능', async () => {
  const db = await world();
  assert.equal(await run(db, GRANT), ''); assert.deepEqual(await grants(db), [{ a: ACC, c: CENTER, p: false }]);
  assert.match(await run(db, GRANT), /이미 허용되어 있어요/); assert.equal((await grants(db)).length, 1);
  assert.equal(await run(db, ROLLBACK), ''); assert.deepEqual(await grants(db), []);
  assert.equal(await run(db, ROLLBACK), ''); assert.deepEqual(await grants(db), []);
  assert.equal(await run(db, GRANT), ''); assert.equal((await grants(db)).length, 1);
});

test('다른 허용 행·다른 계정/센터는 롤백이 건드리지 않는다, 구매 허용으로 바뀐 행은 롤백이 중단한다', async () => {
  const db = await world(); const ACC2 = '00000000-0000-4000-8000-0000000000a2', C2 = '00000000-0000-4000-8000-0000000000c2', AUTH2 = '00000000-0000-4000-8000-0000000000d2';
  await db.exec(`insert into auth.users values ('${AUTH2}', 'other@test.invalid', now()); insert into accounts(id, auth_id, name, nicepay_review_access) values ('${ACC2}', '${AUTH2}', 'other', true); insert into centers(id, name, status) values ('${C2}', '다른 센터', 'approved');
    insert into nicepay_review_center_grants(account_id, center_id) values ('${ACC2}', '${C2}');`);
  assert.equal(await run(db, GRANT), ''); assert.equal(await run(db, ROLLBACK), '');
  assert.deepEqual(await grants(db), [{ a: ACC2, c: C2, p: false }], '다른 행은 그대로');
  assert.equal(await run(db, GRANT), ''); await db.exec(`update nicepay_review_center_grants set can_purchase = true where account_id='${ACC}' and center_id='${CENTER}'`);
  assert.match(await run(db, ROLLBACK), /구매 허용\(can_purchase=true\)/); assert.equal((await grants(db)).length, 2, '중단 시 삭제 없음');
});

const guards = [
  ['허용 목록 테이블 없음', async (db) => { await db.exec('drop table nicepay_review_center_grants cascade'); }, /허용 목록 테이블이 없어요/],
  ['이메일이 niceqa 가 아님', (db) => db.exec(`update auth.users set email='x@test.invalid' where id='${AUTH}'`), /예상 조건/],
  ['이메일 미인증', (db) => db.exec(`update auth.users set email_confirmed_at=null where id='${AUTH}'`), /예상 조건/],
  ['심사 권한 없음', (db) => db.exec(`update accounts set nicepay_review_access=false where id='${ACC}'`), /예상 조건/],
  ['탈퇴 계정', (db) => db.exec(`update accounts set deactivated_at=now() where id='${ACC}'`), /예상 조건/],
  ['센터 이름이 다름', (db) => db.exec(`update centers set name='다른 이름' where id='${CENTER}'`), /A10TION 센터가 예상 값/],
  ['센터가 승인 상태가 아님', (db) => db.exec(`set session_replication_role = replica; update centers set status='pending' where id='${CENTER}'; set session_replication_role = origin;`), /A10TION 센터가 예상 값/],
  ['센터가 내부 센터', (db) => db.exec(`update centers set is_internal=true where id='${CENTER}'`), /A10TION 센터가 예상 값/],
  ['판매 중 상품 없음', (db) => db.exec(`update products set is_on_sale=false where id='${PROD}'`), /판매 중인\(미만료\) 상품이 없어요/],
  ['상품이 모두 만료', (db) => db.exec(`update products set expiry_date='2020-01-01' where id='${PROD}'`), /판매 중인\(미만료\) 상품이 없어요/],
];
for (const [name, mutate, re] of guards) {
  test(`가드: ${name} → 아무것도 바꾸지 않고 중단`, async () => {
    const db = await world(); await mutate(db);
    const e = await run(db, GRANT); assert.match(e, re, e);
    const has = (await q(db, `select to_regclass('public.nicepay_review_center_grants') t`))[0].t; if (has) assert.deepEqual(await grants(db), []);
  });
}
test('가드: 심사 계정이 센터 매니저로도 등록되어 있으면(권한 과다) 중단', async () => {
  const db = await world(); const C2 = '00000000-0000-4000-8000-0000000000c2';
  await db.exec(`set session_replication_role = replica; insert into centers(id, name, status) values ('${C2}', '매니저 센터', 'approved'); insert into manager_centers(account_id, center_id, status) values ('${ACC}', '${C2}', 'active'); set session_replication_role = origin;`);
  assert.match(await run(db, GRANT), /센터 매니저로도 등록/); assert.deepEqual(await grants(db), []);
});
