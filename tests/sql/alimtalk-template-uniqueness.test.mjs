// 격리 PostgreSQL(PGlite) — alimtalk_templates.aligo_template_code 중복 방지 index(fix_alimtalk_template_code_unique.sql) + verify + rollback.
// 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/alimtalk-template-uniqueness.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('fix_alimtalk_template_code_unique.sql');
const rollback = read('rollback_fix_alimtalk_template_code_unique.sql');
const verify = read('verify_alimtalk_template_uniqueness_20261004.sql').replace(/^\s*--.*$/gm, '');
const C1 = '00000000-0000-0000-0000-000000000001', C2 = '00000000-0000-0000-0000-000000000002';
// add_alimtalk_integration.sql + add_alimtalk_template_common.sql 이후 구조(center_id nullable)
const schema = `create table alimtalk_templates(id uuid primary key default gen_random_uuid(), center_id uuid, aligo_template_code text, title text not null default 't', content text not null default 'c');`;
const ins = (db, center, code) => db.exec(`insert into alimtalk_templates(center_id, aligo_template_code) values (${center ? `'${center}'` : 'null'}, ${code ? `'${code}'` : 'null'})`);
const uv = p => assert.rejects(p, e => e.code === '23505' || /unique|duplicate/i.test(e.message));
async function fixture() { const db = new PGlite(); await db.exec(schema); await db.exec(migration); return db; }
const verdict = async db => (await db.query(verify)).rows[0];

test('같은 센터에서 같은 코드 중복은 차단', async () => {
  const db = await fixture();
  try { await ins(db, C1, 'T1'); await uv(ins(db, C1, 'T1')); } finally { await db.close(); }
});
test('다른 센터가 같은 코드를 쓰는 것도 차단(플랫폼 단일 알리고 계정 — 코드는 전체에서 1행)', async () => {
  const db = await fixture();
  try { await ins(db, C1, 'T1'); await uv(ins(db, C2, 'T1')); await ins(db, C2, 'T2'); } finally { await db.close(); }
});
test('공통(center_id null) 중복 차단 + 센터/공통이 같은 코드를 나눠 갖는 것도 차단 — (center_id, code) 복합 unique였다면 못 막았을 케이스', async () => {
  const db = await fixture();
  try {
    await ins(db, null, 'COMMON1'); await uv(ins(db, null, 'COMMON1')); await uv(ins(db, C1, 'COMMON1'));
    await ins(db, null, 'COMMON2'); await ins(db, C1, 'T9');                         // 서로 다른 코드는 공존
  } finally { await db.close(); }
});
test('코드가 null인 초안/미승인 행은 여러 개 허용(센터/공통 모두), 코드 업데이트로 중복을 만들 수 없음', async () => {
  const db = await fixture();
  try {
    await ins(db, C1, null); await ins(db, C1, null); await ins(db, null, null); await ins(db, C2, null);
    await ins(db, C1, 'A'); await ins(db, C2, 'B');
    await uv(db.exec(`update alimtalk_templates set aligo_template_code = 'A' where aligo_template_code = 'B'`));
    assert.equal((await db.query(`select count(*)::int c from alimtalk_templates`)).rows[0].c, 6);
  } finally { await db.close(); }
});
test('동일 코드 동시 insert(두 탭 경합)에서도 정확히 1행만 남는다', async () => {
  const db = await fixture();
  try {
    const res = await Promise.allSettled([ins(db, C1, 'RACE'), ins(db, C1, 'RACE'), ins(db, C2, 'RACE')]);
    assert.equal(res.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await db.query(`select count(*)::int c from alimtalk_templates where aligo_template_code='RACE'`)).rows[0].c, 1);
  } finally { await db.close(); }
});
test('기존 중복 데이터가 있으면 migration은 조용히 병합/삭제하지 않고 실패, verify는 중복 코드를 보여주며 NOT_APPLIED', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema); await ins(db, C1, 'DUP'); await ins(db, C2, 'DUP'); await ins(db, C1, 'OK');
    await assert.rejects(db.exec(migration));
    assert.equal((await db.query(`select count(*)::int c from alimtalk_templates`)).rows[0].c, 3);
    const r = await verdict(db);
    assert.equal(r.duplicate_code_groups, 1); assert.deepEqual(r.duplicate_codes, ['DUP']); assert.equal(r.verdict, 'NOT_APPLIED');
  } finally { await db.close(); }
});
test('verify: 적용 전 NOT_APPLIED → 적용 APPLIED(모든 항목 true) → 정의가 다르면 NOT_APPLIED → rollback NOT_APPLIED, 재적용 안전, 읽기 전용', async () => {
  assert.doesNotMatch(verify, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
  assert.equal(verify.trim().split(';').filter(x => x.trim()).length, 1);
  const db = new PGlite();
  try {
    await db.exec(schema);
    assert.equal((await verdict(db)).verdict, 'NOT_APPLIED');
    await db.exec(migration);
    const ok = await verdict(db); assert.equal(ok.verdict, 'APPLIED', JSON.stringify(ok));
    await db.exec(migration); assert.equal((await verdict(db)).verdict, 'APPLIED');
    const IDX = 'idx_alimtalk_templates_aligo_code_unique';
    await db.exec(`drop index ${IDX}; create unique index ${IDX} on alimtalk_templates(center_id, aligo_template_code) where aligo_template_code is not null;`);   // 복합 키는 다른 정의
    assert.equal((await verdict(db)).verdict, 'NOT_APPLIED');
    await db.exec(`drop index ${IDX}; create unique index ${IDX} on alimtalk_templates(aligo_template_code);`);                                                   // predicate 없음
    assert.equal((await verdict(db)).verdict, 'NOT_APPLIED');
    await db.exec(`drop index ${IDX}; create index ${IDX} on alimtalk_templates(aligo_template_code) where aligo_template_code is not null;`);                    // unique 아님
    assert.equal((await verdict(db)).verdict, 'NOT_APPLIED');
    await db.exec(`drop index ${IDX}`); await db.exec(migration);
    await db.exec(rollback); assert.equal((await verdict(db)).verdict, 'NOT_APPLIED');
    await ins(db, C1, 'X'); await ins(db, C2, 'X');                                                                                                                  // 롤백 후 중복 다시 가능(데이터는 그대로)
    await db.exec(rollback);
  } finally { await db.close(); }
});
test('정적: rollback은 해당 index만 drop', () => {
  assert.equal(rollback.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim().toLowerCase(), 'drop index if exists public.idx_alimtalk_templates_aligo_code_unique;');
});
