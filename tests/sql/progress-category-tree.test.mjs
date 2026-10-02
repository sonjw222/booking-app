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
