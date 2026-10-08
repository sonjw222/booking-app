// 격리 PostgreSQL(PGlite) — storage 버킷 MIME/크기 제한 migration. 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/storage-bucket-limits.test.mjs
// Production export(prod-storage-config.json) 기준 초기 상태(세 버킷 모두 file_size_limit/allowed_mime_types = null)를 재현한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const M = { fwd: read('fix_storage_bucket_mime_limits_20261008.sql'), rb: read('rollback_fix_storage_bucket_mime_limits_20261008.sql'), v: read('verify_fix_storage_bucket_mime_limits_20261008.sql') };
const S = { fwd: read('fix_storage_bucket_size_limits_20261008.sql'), rb: read('rollback_fix_storage_bucket_size_limits_20261008.sql'), v: read('verify_fix_storage_bucket_size_limits_20261008.sql') };
const code = s => s.replace(/^\s*--.*$/gm, '');

async function world() {
  const db = new PGlite();
  await db.exec(`
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
    insert into storage.buckets(id, name, public) values ('alimtalk-images','alimtalk-images',true), ('avatars','avatars',true), ('business-licenses','business-licenses',false), ('other','other',false);
    alter table storage.objects enable row level security;
    create policy "아바타 조회" on storage.objects for select using (bucket_id = 'avatars');
    create policy "사업자등록증 조회" on storage.objects for select using (bucket_id = 'business-licenses');
    insert into storage.objects(bucket_id, name, metadata) values ('avatars','a.jpg','{"size":2500000,"mimetype":"image/jpeg"}'), ('avatars','b.png','{"size":900000,"mimetype":"image/png"}'),
      ('business-licenses','l.pdf','{"size":4000000,"mimetype":"application/pdf"}');
  `);
  return db;
}
const buckets = async db => Object.fromEntries((await db.query(`select id, public, file_size_limit::int8 as sz, allowed_mime_types as mt from storage.buckets order by id`)).rows.map(r => [r.id, r]));

test('MIME migration: 세 버킷만 앱 형식대로 설정, 공개 여부/크기/다른 버킷/정책은 그대로', async () => {
  const db = await world(); await db.exec(M.fwd);
  const b = await buckets(db);
  assert.deepEqual(b['avatars'].mt, ['image/*']); assert.deepEqual(b['alimtalk-images'].mt, ['image/*']); assert.deepEqual(b['business-licenses'].mt, ['image/*', 'application/pdf']);
  assert.equal(b['other'].mt, null); assert.deepEqual([b['avatars'].public, b['alimtalk-images'].public, b['business-licenses'].public], [true, true, false]);
  assert.deepEqual([b['avatars'].sz, b['business-licenses'].sz], [null, null]);
  assert.equal((await db.query(`select count(*)::int c from pg_policies where schemaname='storage' and tablename='objects'`)).rows[0].c, 2);
});
test('크기 migration: 제안 한도만 설정(MIME/공개/정책 불변), 롤백은 null 복귀', async () => {
  const db = await world(); await db.exec(S.fwd);
  let b = await buckets(db);
  assert.deepEqual([b['avatars'].sz, b['alimtalk-images'].sz, b['business-licenses'].sz], [10485760, 10485760, 20971520]);
  assert.deepEqual([b['avatars'].mt, b['business-licenses'].mt], [null, null]); assert.equal(b['other'].sz, null);
  await db.exec(S.rb); b = await buckets(db); assert.deepEqual([b['avatars'].sz, b['alimtalk-images'].sz, b['business-licenses'].sz], [null, null, null]);
});
test('MIME 롤백 + 멱등', async () => {
  const db = await world(); await db.exec(M.fwd); await db.exec(M.fwd); await db.exec(M.rb);
  const b = await buckets(db); assert.deepEqual([b['avatars'].mt, b['alimtalk-images'].mt, b['business-licenses'].mt], [null, null, null]);
});
test('verify SQL: SELECT만이고 실제로 실행된다(크기 분포 질의 포함)', async () => {
  for (const f of [M.v, S.v]) assert.doesNotMatch(code(f), /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);
  const db = await world(); await db.exec(M.fwd); await db.exec(S.fwd);
  for (const stmt of code(M.v).split(';').map(s => s.trim()).filter(Boolean)) await db.query(stmt);
  const stmts = code(S.v).split(';').map(s => s.trim()).filter(Boolean);
  const dist = (await db.query(stmts[0])).rows; assert.ok(dist.find(r => r.bucket_id === 'avatars'));
  const after = (await db.query(stmts[1])).rows; assert.equal(after.length, 3);
});
test('정적: storage.objects 정책/버킷 공개 여부/객체는 건드리지 않는다', () => {
  for (const f of [M.fwd, S.fwd]) { const c = code(f); assert.doesNotMatch(c, /policy|storage\.objects|\bpublic\s*=|delete|insert|alter /i); assert.match(c, /update storage\.buckets set/i); }
});
