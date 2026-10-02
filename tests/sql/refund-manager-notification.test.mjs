// 격리된 PostgreSQL(PGlite) 테스트 — 네트워크/Supabase 자격 증명/Production SQL 없음.
// 실행: PGLITE_MODULE=/private/tmp/refund-sql-test/node_modules/@electric-sql/pglite node --test tests/sql/refund-manager-notification.test.mjs
// 한계: PGlite는 단일 연결이라 "서로 다른 세션의 진짜 동시성"은 재현하지 못한다. 중복 방지는 PK(마커)/행 잠금 + 반복·상태 왕복 시나리오로 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const migration = readFileSync(new URL('../../fix_refund_manager_notification_20261002.sql', import.meta.url), 'utf8');
const rollbackSql = readFileSync(new URL('../../rollback_fix_refund_manager_notification_20261002.sql', import.meta.url), 'utf8');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const M = id(1), CENTER = id(2), A1 = id(3), A2 = id(4), INACTIVE = id(5), OTHER = id(6), OTHER_CENTER = id(7), O1 = id(8), O_DONE = id(9), O_OTHER = id(10), ME = id(11);

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table memberships(id uuid primary key, center_id uuid, status text, product_name text);
    create table orders(id uuid primary key, center_id uuid, profile_id uuid, status text, product_name text);
    create table payments(membership_id uuid, sale_type text, total_amount int);
    create table manager_centers(account_id uuid, center_id uuid, status text);
    create table notifications(recipient_account_id uuid, kind text, title text, body text, center_id uuid, link text, data jsonb);
    create table my_profiles(id uuid);
    create function my_profile_ids() returns setof uuid language sql as $$ select id from my_profiles $$;
    create function push_notification(uuid,text,text,text,uuid,text,jsonb) returns void language sql as $$
      insert into notifications values ($1,$2,$3,$4,$5,$6,$7);
    $$;
    insert into my_profiles values ('${ME}');
    insert into memberships values ('${M}','${CENTER}','active','요가 10회');
    insert into manager_centers values
      ('${A1}','${CENTER}','active'), ('${A2}','${CENTER}','active'), ('${A1}','${CENTER}','active'),
      ('${INACTIVE}','${CENTER}','inactive'), ('${OTHER}','${OTHER_CENTER}','active');
    insert into orders values ('${O1}','${CENTER}','${ME}','pending','요가 10회'),
      ('${O_DONE}','${CENTER}','${ME}','done','완료상품'), ('${O_OTHER}','${CENTER}','${id(99)}','pending','남의주문');
  `);
  await db.exec(migration);
  return db;
}
const rows = async (db, kind) => (await db.query('select * from notifications' + (kind ? ` where kind='${kind}'` : '') + ' order by recipient_account_id')).rows;
const refund = `update memberships set status='refunded' where id='${M}';`;

test('환불: 최종 금액 확정 뒤(커밋 시점) active 관리자별 1건, inactive/다른 센터 제외, 센터 링크', async () => {
  const db = await fixture();
  try {
    await db.exec('begin;' + refund);
    assert.equal((await rows(db)).length, 0);   // 커밋 전에는 없음(deferred)
    await db.exec(`insert into payments values ('${M}','refund',-35000); commit;`);
    const r = await rows(db);
    assert.deepEqual(r.map(x => x.recipient_account_id), [A1, A2]);
    assert.ok(r.every(x => x.kind === 'refund_completed' && x.data.refund_amount === 35000 && x.link === `/manager/sales?center=${CENTER}` && x.body.includes('35,000원 환불 완료')));
    assert.ok(!r.some(x => x.title.includes('주문 취소')));
  } finally { await db.close(); }
});
test('환불: 마이그레이션 재실행·재호출·상태 왕복·알림 삭제 후에도 중복 생성 없음', async () => {
  const db = await fixture();
  try {
    await db.exec(migration);
    await db.exec('begin;' + refund + `insert into payments values ('${M}','refund',-1000); commit;`);
    await db.exec(refund);
    assert.equal((await rows(db)).length, 2);
    await db.exec(`delete from notifications; update memberships set status='active';` + refund);
    assert.equal((await rows(db)).length, 0);
  } finally { await db.close(); }
});
test('환불: 환불 처리 뒤 후속 오류로 롤백되면 알림·마커도 롤백, 재시도 시 정상 1회', async () => {
  const db = await fixture();
  try {
    await assert.rejects(db.exec('begin;' + refund + 'select 1/0;'));
    await db.exec('rollback;');
    assert.equal((await rows(db)).length, 0);
    assert.equal((await db.query('select * from refund_notification_events')).rows.length, 0);
    await db.exec(refund);
    assert.equal((await rows(db)).length, 2);
  } finally { await db.close(); }
});
test('환불: 환불 불가/PG 실패(상태가 refunded로 바뀌지 않음)에는 알림 없음, 다른 컬럼 변경도 무시', async () => {
  const db = await fixture();
  try {
    await db.exec(`update memberships set product_name='변경', status='active';`);
    assert.equal((await rows(db)).length, 0);
  } finally { await db.close(); }
});
test('환불: 알림 helper가 실패해도 환불(상태 변경)은 성공하고 마커는 남지 않아 이후 재시도 가능', async () => {
  const db = await fixture();
  try {
    await db.exec(`create or replace function push_notification(uuid,text,text,text,uuid,text,jsonb) returns void language plpgsql as $$ begin raise exception 'helper failed'; end $$;`);
    await db.exec(refund);
    assert.equal((await db.query('select status from memberships')).rows[0].status, 'refunded');
    assert.equal((await rows(db)).length, 0);
    assert.equal((await db.query('select * from refund_notification_events')).rows.length, 0);
  } finally { await db.close(); }
});
test('환불: 0원(direct/mock 포함) 환불도 같은 처리, 금액 대신 "환불 금액 없음" 문구', async () => {
  const db = await fixture();
  try {
    await db.exec(refund);
    const r = await rows(db);
    assert.equal(r.length, 2);
    assert.ok(r.every(x => x.data.refund_amount === 0 && x.body.includes('환불 금액 없음')));
  } finally { await db.close(); }
});
test('환불: 관리자 중복 행(같은 계정 2행)도 계정당 1건', async () => {
  const db = await fixture();
  try { await db.exec(refund); assert.equal((await rows(db)).filter(x => x.recipient_account_id === A1).length, 1); } finally { await db.close(); }
});

test('주문 취소 RPC: 성공 시 active 관리자별 1건(환불 아님 문구), 중복 호출은 알림 없음', async () => {
  const db = await fixture();
  try {
    const r1 = await db.query(`select member_cancel_pending_order('${O1}') as r`);
    assert.equal(r1.rows[0].r.cancelled, true);
    const r = await rows(db, 'order_cancelled');
    assert.deepEqual(r.map(x => x.recipient_account_id), [A1, A2]);
    assert.ok(r.every(x => x.link === `/manager/orders?center=${CENTER}` && x.body.includes('환불 아님') && x.title.includes('결제 전')));
    const r2 = await db.query(`select member_cancel_pending_order('${O1}') as r`);
    assert.equal(r2.rows[0].r.already, true);
    assert.equal((await rows(db, 'order_cancelled')).length, 2);
    assert.equal((await rows(db, 'refund_completed')).length, 0);   // 환불 알림과 이중 처리 없음
  } finally { await db.close(); }
});
test('주문 취소 RPC: done 주문/남의 주문/없는 주문은 실패하고 알림 없음, 롤백 시 취소도 알림도 없음', async () => {
  const db = await fixture();
  try {
    for (const oid of [O_DONE, O_OTHER, id(77)]) await assert.rejects(db.query(`select member_cancel_pending_order('${oid}')`));
    assert.equal((await rows(db)).length, 0);
    assert.equal((await db.query(`select status from orders where id='${O_DONE}'`)).rows[0].status, 'done');
    await db.exec(`begin; select member_cancel_pending_order('${O1}'); rollback;`);
    assert.equal((await rows(db)).length, 0);
    assert.equal((await db.query(`select status from orders where id='${O1}'`)).rows[0].status, 'pending');
  } finally { await db.close(); }
});
test('주문 취소 RPC: 직접 UPDATE(checkout 자동 정리/결제창 닫힘/보상 취소/관리자 취소)는 알림을 만들지 않는다', async () => {
  const db = await fixture();
  try {
    await db.exec(`update orders set status='cancelled' where id='${O1}';`);
    assert.equal((await rows(db)).length, 0);
  } finally { await db.close(); }
});
test('주문 취소 RPC: 알림 helper 실패해도 주문 취소는 성공', async () => {
  const db = await fixture();
  try {
    await db.exec(`create or replace function push_notification(uuid,text,text,text,uuid,text,jsonb) returns void language plpgsql as $$ begin raise exception 'helper failed'; end $$;`);
    await db.query(`select member_cancel_pending_order('${O1}')`);
    assert.equal((await db.query(`select status from orders where id='${O1}'`)).rows[0].status, 'cancelled');
    assert.equal((await rows(db)).length, 0);
  } finally { await db.close(); }
});
test('롤백 SQL: 트리거/함수/마커 테이블 제거, 이미 만든 알림은 유지', async () => {
  const db = await fixture();
  try {
    await db.exec(refund);
    await db.exec(rollbackSql);
    assert.equal((await rows(db)).length, 2);
    assert.equal((await db.query(`select count(*)::int c from pg_trigger where tgname='trg_refund_completed_managers'`)).rows[0].c, 0);
    await assert.rejects(db.query(`select member_cancel_pending_order('${O1}')`));
  } finally { await db.close(); }
});
