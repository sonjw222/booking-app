// 격리 PostgreSQL(PGlite) — 진도 분류 7단계 트리거. 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/progress-category-tree.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const migration = readFileSync(new URL('../../fix_progress_category_tree_20261003.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../../rollback_fix_progress_category_tree_20261003.sql', import.meta.url), 'utf8');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C1 = id(901), C2 = id(902);
async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create table progress_categories(id uuid primary key default gen_random_uuid(), center_id uuid not null, parent_id uuid references progress_categories(id), name text not null, sort_order int not null default 0);
    insert into progress_categories(id, center_id, parent_id, name) values ('${id(1)}','${C1}',null,'점프'), ('${id(2)}','${C1}','${id(1)}','왈츠'), ('${id(3)}','${C2}',null,'다른센터');
  `);
  await db.exec(migration);
  return db;
}
const ins = (db, n, parent, center = C1) => db.exec(`insert into progress_categories(id, center_id, parent_id, name) values ('${id(n)}','${center}',${parent ? `'${id(parent)}'` : 'null'},'n${n}');`);

test('기존 1~2단계 데이터는 그대로, 새 분류는 7단계까지 허용되고 8단계는 거부', async () => {
  const db = await fixture();
  try {
    // 기존: 점프(1) > 왈츠(2). 3~7단계 추가
    for (let n = 10; n <= 14; n++) await ins(db, n, n === 10 ? 2 : n - 1);   // 깊이 3..7
    assert.equal((await db.query('select count(*)::int c from progress_categories')).rows[0].c, 8);
    await assert.rejects(ins(db, 20, 14), /최대 7단계/);   // 깊이 8
    // 형제/다른 가지는 정상
    await ins(db, 21, 1);
  } finally { await db.close(); }
});
test('자기 자신 / 순환 / 다른 센터 부모 / 없는 부모 거부, 센터 변경 금지', async () => {
  const db = await fixture();
  try {
    await assert.rejects(db.exec(`update progress_categories set parent_id='${id(1)}' where id='${id(1)}'`), /자기 자신/);
    await assert.rejects(db.exec(`update progress_categories set parent_id='${id(2)}' where id='${id(1)}'`), /순환/);   // 점프를 왈츠 아래로
    await assert.rejects(ins(db, 30, 3, C1), /다른 센터/);
    await assert.rejects(ins(db, 31, 777), /상위 분류를 찾을 수|violates foreign key/);
    await assert.rejects(db.exec(`update progress_categories set center_id='${C2}' where id='${id(2)}'`), /센터는 바꿀 수 없어요/);
  } finally { await db.close(); }
});
test('하위 트리를 옮길 때 자신의 높이까지 포함해 7단계 초과 거부, 범위 안이면 허용', async () => {
  const db = await fixture();
  try {
    for (let n = 10; n <= 14; n++) await ins(db, n, n === 10 ? 2 : n - 1);   // 점프>왈츠>10..14 (깊이 7, 왈츠 가지의 하위 높이 5)
    await ins(db, 40, null);   // 최상위 하나
    await ins(db, 41, 40);     // 깊이 2
    await assert.rejects(db.exec(`update progress_categories set parent_id='${id(41)}' where id='${id(2)}'`), /최대 7단계/);   // 깊이2 부모 + 1 + 하위 높이 5 = 8 → 초과
    await db.exec(`update progress_categories set parent_id='${id(40)}' where id='${id(2)}'`);   // 깊이1 부모 + 1 + 5 = 7 → 허용
  } finally { await db.close(); }
});
test('다른 컬럼 UPDATE는 검사하지 않고(이름/정렬), rollback SQL은 트리거를 제거', async () => {
  const db = await fixture();
  try {
    await db.exec(`update progress_categories set name='변경', sort_order=3 where id='${id(2)}'`);
    await db.exec(rollback);
    await db.exec(`update progress_categories set parent_id='${id(2)}' where id='${id(1)}'`);   // 가드 제거 후엔 순환도 통과(롤백 확인)
  } finally { await db.close(); }
});

test('동시성: 센터별 transaction-scoped advisory lock이 검증 쿼리보다 먼저 잡힌다(전역 lock 아님, 보안 설정 유지)', async () => {
  const body = migration.replace(/--.*$/gm, '');
  const lock = body.indexOf("pg_advisory_xact_lock(hashtextextended('progress_categories_tree:' || new.center_id::text, 0))");
  assert.ok(lock > 0, 'xact advisory lock(center_id 기반) 필요');
  assert.ok(lock < body.indexOf('select center_id into v_parent_center'), 'lock은 부모/조상 읽기 전에');
  assert.ok(lock < body.indexOf('with recursive up'), 'lock은 순환/깊이 검사 전에');
  assert.doesNotMatch(body, /pg_advisory_lock\(|pg_advisory_lock_shared|for update/i);   // session-level lock 금지
  assert.match(body, /security definer\s+set search_path = public/);
  assert.match(body, /revoke all on function public\.progress_categories_guard_tree\(\) from public, anon, authenticated/);
  assert.match(body, /before insert or update of parent_id, center_id/);
});

test('migration 재실행 안전(idempotent) — 두 번 실행해도 오류 없고 트리거는 1개, 검증은 계속 동작', async () => {
  const db = await fixture();
  try {
    await db.exec(migration);
    assert.equal((await db.query(`select count(*)::int c from pg_trigger where tgname='progress_categories_guard_tree' and not tgisinternal`)).rows[0].c, 1);
    await assert.rejects(db.exec(`update progress_categories set parent_id='${id(2)}' where id='${id(1)}'`), /순환/);
  } finally { await db.close(); }
});

test('verify_progress_category_tree(read-only preflight): 정상 데이터는 OK, 순환/다른 센터/자기 부모/8단계는 FIX_DATA_FIRST, 데이터는 수정하지 않는다, 순환이 있어도 끝난다', async () => {
  const verify = readFileSync(new URL('../../verify_progress_category_tree_20261003.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(verify.replace(/--.*$/gm, ''), /\b(insert|update|delete|drop|alter|create|truncate)\b/i);
  const mk = async (rows) => {
    const db = new PGlite();
    await db.exec(`create table progress_categories(id uuid primary key, center_id uuid not null, parent_id uuid, name text not null default 'x');`);   // FK 없음 = 이미 깨진 데이터를 만들 수 있다
    for (const [n, p, c] of rows) await db.exec(`insert into progress_categories(id, center_id, parent_id) values ('${id(n)}','${c ?? C1}',${p ? `'${id(p)}'` : 'null'});`);
    return db;
  };
  const run = async (rows) => { const db = await mk(rows); try { const before = (await db.query('select count(*)::int c from progress_categories')).rows[0].c; const r = (await db.query(verify)).rows[0]; assert.equal((await db.query('select count(*)::int c from progress_categories')).rows[0].c, before); return r; } finally { await db.close(); } };
  let r = await run([[1, null], [2, 1], [3, 2], [4, null, C2]]);
  assert.deepEqual([r.verdict, r.cyclic_nodes, r.max_depth, r.cross_center_parents, r.self_parents, r.over_depth_7_nodes], ['OK', '0', 3, '0', '0', '0'].map((v, i) => (i === 0 || i === 2 ? v : Number(v))));
  r = await run([[1, 2], [2, 1]]);                       assert.equal(r.verdict, 'FIX_DATA_FIRST'); assert.equal(Number(r.cyclic_nodes), 2);
  r = await run([[1, 1]]);                                assert.equal(r.verdict, 'FIX_DATA_FIRST'); assert.equal(Number(r.self_parents), 1);
  r = await run([[1, null], [2, 1, C2]]);                 assert.equal(r.verdict, 'FIX_DATA_FIRST'); assert.equal(Number(r.cross_center_parents), 1);
  r = await run([[1, null], ...[2, 3, 4, 5, 6, 7, 8].map((n) => [n, n - 1])]);   // 8단계
  assert.equal(r.verdict, 'FIX_DATA_FIRST'); assert.equal(Number(r.over_depth_7_nodes), 1); assert.equal(r.max_depth, 8);
  r = await run([[1, null], [2, 1], [3, 4], [4, 3], [5, 3]]);   // 순환에 매달린 가지도 순환으로 센다
  assert.equal(Number(r.cyclic_nodes), 3);
});
