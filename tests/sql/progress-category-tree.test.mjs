// 격리 PostgreSQL(PGlite) — 진도 분류/기술 트리(category/skill). 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/progress-category-tree.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const migration = readFileSync(new URL('../../fix_progress_category_tree_20261003.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../../rollback_fix_progress_category_tree_20261003.sql', import.meta.url), 'utf8');
const verify = readFileSync(new URL('../../verify_progress_category_tree_20261003.sql', import.meta.url), 'utf8');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C1 = id(901), C2 = id(902), P1 = id(950);
// Production의 현재(마이그레이션 전) 구조: node_type 없음, parent FK, 기록 FK(on delete 없음)
const legacySchema = `
  create role anon; create role authenticated;
  create table progress_categories(id uuid primary key default gen_random_uuid(), center_id uuid not null, parent_id uuid references progress_categories(id), name text not null, sort_order int not null default 0, created_at timestamptz not null default now());
  create table progress_records(id uuid primary key default gen_random_uuid(), profile_id uuid not null, category_id uuid not null references progress_categories(id), lesson_date date not null default current_date, note text);
`;
async function legacyDb(extra = '') {
  const db = new PGlite();
  await db.exec(legacySchema + `
    insert into progress_categories(id, center_id, parent_id, name) values ('${id(1)}','${C1}',null,'점프'), ('${id(2)}','${C1}','${id(1)}','왈츠'), ('${id(3)}','${C2}',null,'다른센터');
  ` + extra);
  return db;
}
async function fixture() { const db = await legacyDb(); await db.exec(migration); return db; }
const cat = (db, n, parent, center = C1) => db.exec(`insert into progress_categories(id, center_id, parent_id, name, node_type) values ('${id(n)}','${center}',${parent ? `'${id(parent)}'` : 'null'},'n${n}','category');`);
const skill = (db, n, parent, center = C1) => db.exec(`insert into progress_categories(id, center_id, parent_id, name, node_type) values ('${id(n)}','${center}',${parent ? `'${id(parent)}'` : 'null'},'n${n}','skill');`);
const rec = (db, categoryId) => db.exec(`insert into progress_records(profile_id, category_id) values ('${P1}','${categoryId}');`);
const types = async db => Object.fromEntries((await db.query('select id, node_type from progress_categories')).rows.map(r => [r.id, r.node_type]));

test('legacy backfill: 기존 최상위 → category, 기존 하위 → skill, 기존 기록 보존', async () => {
  const db = await legacyDb(`insert into progress_records(profile_id, category_id) values ('${P1}','${id(2)}');`);
  try {
    await db.exec(migration);
    const t = await types(db);
    assert.deepEqual([t[id(1)], t[id(2)], t[id(3)]], ['category', 'skill', 'category']);
    assert.equal((await db.query('select count(*)::int c from progress_records')).rows[0].c, 1);
    assert.equal((await db.query(verify.replace(/--.*$/gm, ''))).rows[0].already_migrated, true);
  } finally { await db.close(); }
});

test('자동 backfill이 애매하면(3단계 이상 / 최상위에 기록 / 다른 센터 부모) 추측하지 않고 migration 전체를 중단한다', async () => {
  for (const extra of [
    `insert into progress_categories(id, center_id, parent_id, name) values ('${id(4)}','${C1}','${id(2)}','3단계');`,
    `insert into progress_records(profile_id, category_id) values ('${P1}','${id(1)}');`,
    `insert into progress_categories(id, center_id, parent_id, name) values ('${id(5)}','${C2}','${id(1)}','다른센터자식');`,
  ]) {
    const db = await legacyDb(extra);
    try {
      await assert.rejects(db.exec(migration), /자동으로 분류\/기술로 나눌 수 없어요/);
      await db.exec('rollback');   // 에러로 중단된 트랜잭션 정리(SQL Editor에서는 세션 종료 시 자동 rollback)
      const cols = (await db.query(`select count(*)::int c from information_schema.columns where table_name='progress_categories' and column_name='node_type'`)).rows[0].c;
      assert.equal(cols, 0);   // 롤백되어 컬럼도 안 생김
      assert.equal((await db.query(verify.replace(/--.*$/gm, ''))).rows[0].verdict, 'FIX_DATA_FIRST');
    } finally { await db.close(); }
  }
});

test('분류 1~7단계 허용 + 8번째 분류 거부, 7단계 분류 아래에도 기술 추가 허용(기술은 깊이에 포함하지 않는다)', async () => {
  const db = await fixture();
  try {
    for (let n = 10; n <= 15; n++) await cat(db, n, n === 10 ? 1 : n - 1);   // 점프(1단계) 아래 2..7단계 분류
    await assert.rejects(cat(db, 20, 15), /최대 7단계/);                        // 8번째 분류
    await skill(db, 21, 15);                                                    // 7단계 분류 아래 기술 OK
    await skill(db, 22, 1);                                                     // 1단계 분류 아래에도 기술 OK
    await cat(db, 23, 1);                                                       // 같은 분류 아래 하위 분류와 기술이 동시에 존재
    const kids = (await db.query(`select node_type from progress_categories where parent_id='${id(1)}' order by node_type`)).rows.map(r => r.node_type);
    assert.deepEqual(kids, ['category', 'category', 'skill', 'skill']);   // 기존 왈츠(skill) + 22(skill) + 10, 23(category)
  } finally { await db.close(); }
});

test('기술 규칙: top-level 기술 거부 / 기술 아래 자식(분류·기술) 거부 / 분류↔기술 전환 거부', async () => {
  const db = await fixture();
  try {
    await assert.rejects(skill(db, 30, null), /기술은 분류 아래에만|skill_has_parent/);
    await assert.rejects(skill(db, 31, 2), /기술 아래에는/);          // 왈츠(skill) 아래 기술
    await assert.rejects(cat(db, 32, 2), /기술 아래에는/);            // 왈츠(skill) 아래 분류
    await assert.rejects(db.exec(`update progress_categories set node_type='category' where id='${id(2)}'`), /서로 바꿀 수 없어요/);
    await assert.rejects(db.exec(`update progress_categories set node_type='skill' where id='${id(1)}'`), /서로 바꿀 수 없어요/);
    await assert.rejects(db.exec(`update progress_categories set node_type='x' where id='${id(1)}'`), /서로 바꿀 수 없어요|node_type_check/);
    await assert.rejects(db.exec(`update progress_categories set parent_id='${id(2)}' where id='${id(1)}'`), /기술 아래에는/);   // 분류를 기술 아래로 이동
    await assert.rejects(db.exec(`insert into progress_categories(center_id, parent_id, name, node_type) values ('${C1}','${id(1)}','bad','weird')`), /node_type_check|올바르지 않아요/);
  } finally { await db.close(); }
});

test('진도 기록은 skill에만: category 직접 INSERT/UPDATE 거부, skill은 허용, 기존 기록 보존', async () => {
  const db = await fixture();
  try {
    await rec(db, id(2));                                              // skill OK
    await assert.rejects(rec(db, id(1)), /분류에는 진도를 기록할 수 없어요/);
    await assert.rejects(db.exec(`update progress_records set category_id='${id(1)}'`), /분류에는 진도를 기록할 수 없어요/);
    await assert.rejects(rec(db, id(999)), /기술을 찾을 수 없어요|foreign key/);
    assert.equal((await db.query('select count(*)::int c from progress_records')).rows[0].c, 1);
    await db.exec(`update progress_records set note='메모'`);        // 다른 컬럼 UPDATE는 검사 대상이 아님
  } finally { await db.close(); }
});

test('삭제 의미: 기록 있는 skill 삭제 거부, 기록 있는 하위가 포함된 분류 삭제 거부, 기록 없으면 하위부터 삭제 가능', async () => {
  const db = await fixture();
  try {
    await rec(db, id(2));
    await assert.rejects(db.exec(`delete from progress_categories where id='${id(2)}'`), /foreign key|violates/);
    await assert.rejects(db.exec(`delete from progress_categories where id='${id(1)}'`), /foreign key|violates/);   // 하위 기술에 기록 + 하위 존재
    await cat(db, 40, 1); await skill(db, 41, 40);
    await db.exec(`delete from progress_categories where id='${id(41)}'`);   // 기록 없는 skill 삭제 OK
    await db.exec(`delete from progress_categories where id='${id(40)}'`);   // 기록 없는 분류 삭제 OK
    assert.equal((await db.query('select count(*)::int c from progress_categories')).rows[0].c, 3);
  } finally { await db.close(); }
});

test('자기 자신 / 순환 / 다른 센터 부모 / 없는 부모 거부, 센터 변경 금지', async () => {
  const db = await fixture();
  try {
    await assert.rejects(db.exec(`update progress_categories set parent_id='${id(1)}' where id='${id(1)}'`), /자기 자신/);
    await cat(db, 50, 1); await cat(db, 51, 50);
    await assert.rejects(db.exec(`update progress_categories set parent_id='${id(51)}' where id='${id(1)}'`), /순환/);
    await assert.rejects(cat(db, 52, 3, C1), /다른 센터/);
    await assert.rejects(cat(db, 53, 777), /상위 분류를 찾을 수|violates foreign key/);
    await assert.rejects(db.exec(`update progress_categories set center_id='${C2}' where id='${id(1)}'`), /센터는 바꿀 수 없어요/);
  } finally { await db.close(); }
});

test('하위 트리를 옮길 때 자신의 "분류" 높이만 포함(기술은 제외)해 7단계 초과 거부', async () => {
  const db = await fixture();
  try {
    // 분류 체인 A(1단계 새 top) 아래 4단계 분류 + 그 아래 기술들 / 대상 체인 5단계
    await cat(db, 60, null); await cat(db, 61, 60); await cat(db, 62, 61); await cat(db, 63, 62);          // 60~63 = 4단계 서브트리(루트 60)
    await skill(db, 64, 63);                                                                               // 기술은 높이에 포함되지 않는다
    await cat(db, 70, null); await cat(db, 71, 70); await cat(db, 72, 71); await cat(db, 73, 72);        // 70~73 = 4단계 체인
    await assert.rejects(db.exec(`update progress_categories set parent_id='${id(73)}' where id='${id(60)}'`), /최대 7단계/);   // 4+4=8
    await cat(db, 74, 72);                                                                                 // 72(3단계) 아래 4단계 → 서브트리 이동 시 3+4=7
    await db.exec(`update progress_categories set parent_id='${id(72)}' where id='${id(61)}'`);          // 61 서브트리 높이 3(61,62,63) → 3+3=6 OK
    await db.exec(`update progress_categories set name='x' where id='${id(1)}'`);                         // 다른 컬럼 UPDATE
  } finally { await db.close(); }
});

test('구버전 웹 호환: node_type 없이 INSERT해도 옛 의미(최상위=분류, 하위=기술)로 채워진다', async () => {
  const db = await fixture();
  try {
    await db.exec(`insert into progress_categories(id, center_id, parent_id, name) values ('${id(80)}','${C1}',null,'옛분류'), ('${id(81)}','${C1}','${id(80)}','옛기술');`);
    const t = await types(db);
    assert.deepEqual([t[id(80)], t[id(81)]], ['category', 'skill']);
    await assert.rejects(db.exec(`insert into progress_categories(id, center_id, parent_id, name) values ('${id(82)}','${C1}','${id(81)}','기술아래')`), /기술 아래에는/);
  } finally { await db.close(); }
});

test('migration 재실행 안전 + rollback은 trigger/function/제약/컬럼만 제거하고 데이터는 유지', async () => {
  const db = await fixture();
  try {
    await db.exec(migration);
    assert.equal((await db.query(`select count(*)::int c from pg_trigger where tgname in ('progress_categories_guard_tree','progress_records_guard_skill') and not tgisinternal`)).rows[0].c, 2);
    await assert.rejects(db.exec(`update progress_categories set parent_id='${id(2)}' where id='${id(1)}'`), /기술 아래에는|순환/);
    await db.exec(rollback);
    assert.equal((await db.query(`select count(*)::int c from pg_trigger where tgname in ('progress_categories_guard_tree','progress_records_guard_skill') and not tgisinternal`)).rows[0].c, 0);
    assert.equal((await db.query(`select count(*)::int c from information_schema.columns where table_name='progress_categories' and column_name='node_type'`)).rows[0].c, 0);
    assert.equal((await db.query('select count(*)::int c from progress_categories')).rows[0].c, 3);   // 데이터 유지
    await db.exec(`insert into progress_categories(center_id, parent_id, name) values ('${C1}','${id(1)}','롤백후')`);   // 옛 구조로 다시 사용 가능
    await db.exec(rollback);   // rollback도 재실행 안전
  } finally { await db.close(); }
});

test('동시성/보안 계약: 센터별 xact advisory lock이 검증 읽기보다 먼저, 보안 설정 유지, 진도 기록 가드 존재', () => {
  const body = migration.replace(/--.*$/gm, '');
  const lock = body.indexOf("pg_advisory_xact_lock(hashtextextended('progress_categories_tree:' || new.center_id::text, 0))");
  assert.ok(lock > 0);
  assert.ok(lock < body.indexOf('select center_id, node_type into v_parent_center'));
  assert.ok(lock < body.indexOf('with recursive up'));
  assert.doesNotMatch(body, /pg_advisory_lock\(|pg_advisory_lock_shared|for update/i);
  assert.equal((body.match(/security definer\s+set search_path = public/g) || []).length, 2);
  assert.match(body, /revoke all on function public\.progress_categories_guard_tree\(\) from public, anon, authenticated/);
  assert.match(body, /revoke all on function public\.progress_records_guard_skill\(\) from public, anon, authenticated/);
  assert.match(body, /before insert or update of parent_id, center_id, node_type on public\.progress_categories/);
  assert.match(body, /before insert or update of category_id on public\.progress_records/);
  assert.doesNotMatch(body, /\b(delete from|drop table|truncate)\b/i);
});

test('verify(read-only): 정상(기존 2단계) OK / 순환·3단계·최상위 기록·다른 센터는 FIX_DATA_FIRST, 데이터 불변, 순환에도 끝난다', async () => {
  const v = verify.replace(/--.*$/gm, '');
  assert.doesNotMatch(v, /\b(insert|update|delete|drop|alter|create|truncate)\b/i);
  const run = async (rows, recs = []) => {
    const db = new PGlite();
    await db.exec(`create table progress_categories(id uuid primary key, center_id uuid not null, parent_id uuid, name text not null default 'x'); create table progress_records(id uuid primary key default gen_random_uuid(), category_id uuid not null);`);
    for (const [n, p, c] of rows) await db.exec(`insert into progress_categories(id, center_id, parent_id) values ('${id(n)}','${c ?? C1}',${p ? `'${id(p)}'` : 'null'});`);
    for (const n of recs) await db.exec(`insert into progress_records(category_id) values ('${id(n)}');`);
    try { const before = (await db.query('select count(*)::int c from progress_categories')).rows[0].c; const r = (await db.query(v)).rows[0]; assert.equal((await db.query('select count(*)::int c from progress_categories')).rows[0].c, before); return r; } finally { await db.close(); }
  };
  let r = await run([[1, null], [2, 1], [3, null, C2]], [2]);
  assert.equal(r.verdict, 'OK'); assert.equal(Number(r.top_level_rows), 2); assert.equal(r.already_migrated, false);
  r = await run([[1, null], [2, 1], [3, 2]]);                 assert.equal(r.verdict, 'FIX_DATA_FIRST'); assert.equal(Number(r.legacy_depth_gt_2), 1);
  r = await run([[1, null], [2, 1]], [1]);                    assert.equal(r.verdict, 'FIX_DATA_FIRST'); assert.equal(Number(r.records_on_top_level), 1);
  r = await run([[1, 2], [2, 1]]);                            assert.equal(r.verdict, 'FIX_DATA_FIRST'); assert.equal(Number(r.cyclic_nodes), 2);
  r = await run([[1, null], [2, 1, C2]]);                     assert.equal(r.verdict, 'FIX_DATA_FIRST'); assert.equal(Number(r.cross_center_parents), 1);
  r = await run([[1, 1]]);                                    assert.equal(r.verdict, 'FIX_DATA_FIRST'); assert.equal(Number(r.self_parents), 1);
});
