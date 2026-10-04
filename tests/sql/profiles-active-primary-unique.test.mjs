// 격리 PostgreSQL(PGlite) — 계정당 live primary 프로필 1개 unique index. 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/profiles-active-primary-unique.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('add_profiles_active_primary_unique_20261004.sql');
const rollback = read('rollback_add_profiles_active_primary_unique_20261004.sql');
const verify = read('verify_profiles_active_primary_unique_20261004.sql');
const code = s => s.replace(/--.*$/gm, '');
const IDX = 'profiles_one_active_primary_per_account';

// PGlite(단일 연결 WASM)는 CREATE/DROP INDEX CONCURRENTLY 를 지원하지 않거나 의미가 없다.
// 그래서 Production migration/rollback SQL 자체는 바꾸지 않고, 테스트 DB에는 CONCURRENTLY 만 제거한 동일 SQL을 적용한다
// (인덱스 정의는 동일; CONCURRENTLY 는 락 전략일 뿐 결과 인덱스에는 영향 없음).
const noConcurrently = s => code(s).replace(/\s+concurrently\b/i, '');
const schema = `
  create table accounts(id uuid primary key default gen_random_uuid());
  create table profiles(id uuid primary key default gen_random_uuid(), account_id uuid not null references accounts(id),
    name text not null default 'x', is_primary boolean not null default false, deleted_at timestamptz);
`;
const A1 = '00000000-0000-0000-0000-000000000001', A2 = '00000000-0000-0000-0000-000000000002';
async function fixture() {
  const db = new PGlite();
  await db.exec(schema + `insert into accounts(id) values ('${A1}'),('${A2}');`);
  await db.exec(noConcurrently(migration));
  return db;
}
const ins = (db, acc, primary, deleted = false) =>
  db.exec(`insert into profiles(account_id, is_primary, deleted_at) values ('${acc}', ${primary}, ${deleted ? "'2026-01-01'" : 'null'});`);
const uniqueViolation = p => assert.rejects(p, e => e.code === '23505' || /unique|duplicate/i.test(e.message));
const verdict = async db => (await db.query(code(verify))).rows[0];

test('정적: migration — exact name/UNIQUE/account_id/live primary 조건/CONCURRENTLY/트랜잭션 없음', () => {
  const m = code(migration).toLowerCase().replace(/\s+/g, ' ');
  assert.match(m, new RegExp(`create unique index concurrently if not exists ${IDX} on public\\.profiles \\(account_id\\) where is_primary = true and deleted_at is null;`));
  assert.doesNotMatch(m, /\b(begin|commit|start transaction)\b/);
  assert.doesNotMatch(m, /\b(update|delete|insert)\b/);
  assert.match(migration, /2026-10-04 Production에 이미 수동 적용/);
});
test('정적: rollback 은 해당 index 만 drop, 트랜잭션 없음', () => {
  const r = code(rollback).toLowerCase().replace(/\s+/g, ' ').trim();
  assert.equal(r, `drop index concurrently if exists public.${IDX};`);
});
test('정적: verify 는 read-only(DML/DDL 없음), pg_catalog 정의 검사, verdict 컬럼', () => {
  const v = code(verify).toLowerCase();
  assert.doesNotMatch(v, /\b(insert|update|delete|create|alter|drop|truncate|grant)\b/);
  for (const k of ['indisunique', 'indisvalid', 'indisready', 'indpred', 'indkey', 'APPLIED', 'NOT_APPLIED']) assert.ok(code(verify).includes(k), k);
});

test('live primary 1개 insert 성공, 같은 account 두 번째 live primary 는 unique violation', async () => {
  const db = await fixture();
  try {
    await ins(db, A1, true);
    await uniqueViolation(ins(db, A1, true));
  } finally { await db.close(); }
});
test('is_primary=false 프로필은 여러 개 허용(live primary 가 있어도)', async () => {
  const db = await fixture();
  try {
    await ins(db, A1, true); await ins(db, A1, false); await ins(db, A1, false); await ins(db, A1, false);
    assert.equal((await db.query('select count(*)::int c from profiles')).rows[0].c, 4);
  } finally { await db.close(); }
});
test('deleted primary 는 여러 개 허용, 그 뒤에도 새 live primary 1개 허용(두 번째 live 는 거부)', async () => {
  const db = await fixture();
  try {
    await ins(db, A1, true, true); await ins(db, A1, true, true);
    await ins(db, A1, true);
    await uniqueViolation(ins(db, A1, true));
    assert.equal((await db.query('select count(*)::int c from profiles where account_id=$1', [A1])).rows[0].c, 3);
  } finally { await db.close(); }
});
test('서로 다른 account 는 각각 live primary 1개 허용', async () => {
  const db = await fixture();
  try { await ins(db, A1, true); await ins(db, A2, true); } finally { await db.close(); }
});
test('계정 병합 순서(B primary 를 false 로 내린 뒤 A 로 이동)는 인덱스와 충돌하지 않는다', async () => {
  const db = await fixture();
  try {
    await ins(db, A1, true); await ins(db, A2, true);
    await db.exec(`update profiles set is_primary = false where account_id = '${A2}' and is_primary = true;
                   update profiles set account_id = '${A1}' where account_id = '${A2}';`);
    assert.equal((await db.query('select count(*)::int c from profiles where account_id=$1 and is_primary and deleted_at is null', [A1])).rows[0].c, 1);
  } finally { await db.close(); }
});
test('verify: 적용 상태에서 APPLIED(모든 항목 true, 중복 0)', async () => {
  const db = await fixture();
  try {
    await ins(db, A1, true);
    const r = await verdict(db);
    assert.deepEqual([r.duplicate_active_primary_accounts, r.index_exists, r.is_unique, r.is_valid, r.is_ready, r.key_is_account_id_only, r.predicate_is_live_primary, r.verdict],
      [0, true, true, true, true, true, true, 'APPLIED']);
  } finally { await db.close(); }
});
test('verify: 미적용/잘못된 정의면 NOT_APPLIED(index 없음, 비-unique, 다른 predicate, 중복 데이터)', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema + `insert into accounts(id) values ('${A1}');`);
    assert.equal((await verdict(db)).verdict, 'NOT_APPLIED');
    await db.exec(`create index ${IDX} on profiles(account_id) where is_primary = true and deleted_at is null;`);   // unique 아님
    assert.equal((await verdict(db)).verdict, 'NOT_APPLIED');
    await db.exec(`drop index ${IDX}; create unique index ${IDX} on profiles(account_id) where is_primary = true;`);   // deleted_at 조건 누락
    assert.equal((await verdict(db)).verdict, 'NOT_APPLIED');
    await db.exec(`drop index ${IDX}; insert into profiles(account_id,is_primary) values ('${A1}',true),('${A1}',true);
                   create unique index ${IDX} on profiles(account_id) where is_primary = true and deleted_at is null and false;`);
    const r = await verdict(db);
    assert.equal(r.duplicate_active_primary_accounts, 1); assert.equal(r.verdict, 'NOT_APPLIED');
  } finally { await db.close(); }
});
test('중복 live primary 가 이미 있으면 migration 은 조용히 고치지 않고 실패한다(데이터 불변)', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema + `insert into accounts(id) values ('${A1}'); insert into profiles(account_id,is_primary) values ('${A1}',true),('${A1}',true);`);
    await assert.rejects(db.exec(noConcurrently(migration)));
    assert.equal((await db.query('select count(*)::int c from profiles where is_primary')).rows[0].c, 2);
  } finally { await db.close(); }
});
test('rollback 후에는 index 가 없어지고(verdict NOT_APPLIED) 데이터는 그대로, 두 번째 live primary 가 다시 가능', async () => {
  const db = await fixture();
  try {
    await ins(db, A1, true);
    await db.exec(noConcurrently(rollback));
    assert.equal((await db.query(`select count(*)::int c from pg_indexes where indexname='${IDX}'`)).rows[0].c, 0);
    assert.equal((await verdict(db)).verdict, 'NOT_APPLIED');
    await ins(db, A1, true);
    assert.equal((await db.query('select count(*)::int c from profiles')).rows[0].c, 2);
  } finally { await db.close(); }
});
