// 격리 PostgreSQL(PGlite) — 알림톡 큐 선점 마이그레이션(fix_alimtalk_dispatch_claim_20261008.sql). 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/alimtalk-dispatch-claim.test.mjs
// 합성 스키마에서 선점 UPDATE 의미/유일 인덱스/권한만 검증한다(Production/DEV DB에 접속하지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('fix_alimtalk_dispatch_claim_20261008.sql');
const rollback = read('rollback_fix_alimtalk_dispatch_claim_20261008.sql');
const verify = read('verify_fix_alimtalk_dispatch_claim_20261008.sql');
const M1 = '00000000-0000-0000-0000-000000000001', C1 = '00000000-0000-0000-0000-0000000000c1', P1 = '00000000-0000-0000-0000-0000000000a1', P2 = '00000000-0000-0000-0000-0000000000a2';

async function world({ apply = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public to anon, authenticated, service_role;
    create table messages(id uuid primary key default gen_random_uuid(), center_id uuid not null, channel text not null, content text not null,
      target_profile_ids uuid[] not null default '{}', status text not null default 'draft'
      check (status in ('draft','scheduled','sent','cancelled','failed')), scheduled_at timestamptz, sent_at timestamptz, created_at timestamptz not null default now());
    create table notification_logs(id uuid primary key default gen_random_uuid(), center_id uuid not null, profile_id uuid, rule_id uuid,
      channel text not null, cost int not null default 0, status text not null default 'sent' check (status in ('sent','failed')), sent_at timestamptz not null default now());
    -- 적용 전 라이브 권한: service_role은 messages에 DELETE만(fix_service_role_grants_full_audit.sql), notification_logs에는 전부
    grant delete on messages to service_role; grant select, insert, delete, update on notification_logs to service_role;
    insert into messages(id, center_id, channel, content, target_profile_ids, status, scheduled_at) values ('${M1}', '${C1}', 'alimtalk', '안내', array['${P1}','${P2}']::uuid[], 'scheduled', now());
  `);
  if (apply) await db.exec(migration);
  return db;
}
const claim = (db, id, leaseSeconds = 600) => db.query(`update messages set claimed_at = now() where id = '${id}' and status = 'scheduled' and (claimed_at is null or claimed_at < now() - interval '${leaseSeconds} seconds') returning id`);

test('1) 선점 UPDATE: 첫 실행만 행을 돌려받고, 겹치는 두 번째 실행은 0행', async () => {
  const db = await world();
  assert.equal((await claim(db, M1)).rows.length, 1);
  assert.equal((await claim(db, M1)).rows.length, 0);
});
test('2) 임대(10분) 만료 후에는 다시 선점 가능(죽은 실행 복구), 처리 완료(sent) 행은 불가', async () => {
  const db = await world();
  await claim(db, M1);
  await db.exec(`update messages set claimed_at = now() - interval '11 minutes' where id = '${M1}'`);
  assert.equal((await claim(db, M1)).rows.length, 1);
  await db.exec(`update messages set status = 'sent', sent_at = now() where id = '${M1}'`);
  await db.exec(`update messages set claimed_at = null where id = '${M1}'`);
  assert.equal((await claim(db, M1)).rows.length, 0);
});
test('3) (message, profile) sent 로그는 한 번만, failed 로그는 여러 번 허용', async () => {
  const db = await world();
  const ins = st => db.exec(`insert into notification_logs(center_id, profile_id, channel, status, message_id) values ('${C1}','${P1}','alimtalk','${st}','${M1}')`);
  await ins('sent');
  await assert.rejects(ins('sent'), /unique|duplicate/i);
  await ins('failed'); await ins('failed');
  // 다른 수신자의 sent는 가능, message_id가 null인 기존/즉시발송 로그는 영향 없음
  await db.exec(`insert into notification_logs(center_id, profile_id, channel, status, message_id) values ('${C1}','${P2}','alimtalk','sent','${M1}')`);
  await db.exec(`insert into notification_logs(center_id, profile_id, channel, status) values ('${C1}','${P1}','alimtalk','sent'), ('${C1}','${P1}','alimtalk','sent')`);
});
test('4) service_role 권한: 적용 전에는 messages SELECT/UPDATE 불가(디스패치가 막힌 상태), 적용 후에는 필요한 만큼만 가능', async () => {
  const before = await world({ apply: false });
  await before.exec('set role service_role');
  await assert.rejects(before.query('select 1 from messages'), /permission denied/i);
  await before.exec('reset role');
  const db = await world();
  await db.exec('set role service_role');
  assert.equal((await db.query('select id from messages')).rows.length, 1);
  await db.exec(`update messages set claimed_at = now() where id = '${M1}'`);
  await db.exec(`update messages set status = 'sent', sent_at = now() where id = '${M1}'`);
  await assert.rejects(db.exec(`update messages set content = '변조' where id = '${M1}'`), /permission denied/i);   // 컬럼 단위 최소 권한
  await assert.rejects(db.exec(`insert into messages(center_id, channel, content) values ('${C1}','alimtalk','x')`), /permission denied/i);
  await db.exec('reset role');
});
test('5) anon/authenticated 권한은 이 마이그레이션이 바꾸지 않는다(GRANT 대상은 service_role뿐)', () => {
  const code = migration.replace(/^\s*--.*$/gm, '');
  const grants = [...code.matchAll(/grant[^;]*;/gi)].map(m => m[0]);
  assert.ok(grants.length >= 2); for (const g of grants) assert.match(g, /to service_role;?$/i);
  assert.doesNotMatch(code, /create policy|drop policy|alter table[^;]*(enable|disable) row level/i);
});
test('6) 마이그레이션 멱등 + 롤백은 추가분만 제거', async () => {
  const db = await world();
  await db.exec(migration);   // 재실행 안전
  await db.exec(rollback);
  const cols = await db.query(`select column_name from information_schema.columns where table_name in ('messages','notification_logs') and column_name in ('claimed_at','message_id','error')`);
  assert.equal(cols.rows.length, 0);
  assert.equal((await db.query(`select 1 from pg_indexes where indexname like '%notification_logs_message%'`)).rows.length, 0);
  await db.exec('set role service_role'); await assert.rejects(db.query('select 1 from messages'), /permission denied/i); await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int as n from messages')).rows[0].n, 1);   // 데이터는 그대로
});
test('7) verify SQL은 SELECT만 포함하고 적용 후 실행 가능', async () => {
  const code = verify.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(code.replace(/'[^']*'/g, "''"), /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);   // 문자열 리터럴('update' 등)은 제외
  const db = await world();
  for (const stmt of code.split(';').map(s => s.trim()).filter(Boolean)) await db.query(stmt);
  const priv = await db.query(`select has_table_privilege('service_role','public.messages','select') as s, has_column_privilege('service_role','public.messages','claimed_at','update') as c`);
  assert.deepEqual([priv.rows[0].s, priv.rows[0].c], [true, true]);
});
