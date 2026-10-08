// 격리 PostgreSQL(PGlite) — ensure_center_member / 알림 배치 함수 EXECUTE 축소 migration. 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/db-boundaries-privileges.test.mjs
// 합성 스키마에서 권한 의미만 검증한다(Production/DEV DB에 접속하지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const B = { fwd: read('fix_ensure_center_member_privileges_20261008.sql'), rb: read('rollback_fix_ensure_center_member_privileges_20261008.sql'), v: read('verify_fix_ensure_center_member_privileges_20261008.sql') };
const C = { fwd: read('fix_notification_batch_function_privileges_20261008.sql'), rb: read('rollback_fix_notification_batch_function_privileges_20261008.sql'), v: read('verify_fix_notification_batch_function_privileges_20261008.sql') };
const CEN = '00000000-0000-0000-0000-0000000000c1', PRO = '00000000-0000-0000-0000-0000000000d1';

// 적용 전 라이브 상태 재현: 함수는 기본 ACL(PUBLIC EXECUTE). 호출자는 SECURITY DEFINER 래퍼(confirm_test_payment/fulfill_order 역할) 하나로 흉내.
async function world() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create table center_members(center_id uuid, profile_id uuid, status text default 'active', unique(center_id, profile_id));
    create table queued(n int); grant select on queued to anon, authenticated, service_role;
    create function ensure_center_member(p_center_id uuid, p_profile_id uuid) returns void language plpgsql security definer as
      $$ begin insert into center_members(center_id, profile_id) values (p_center_id, p_profile_id) on conflict do nothing; end $$;
    create function evaluate_notification_rules() returns integer language plpgsql security definer set search_path = public as $$ begin insert into queued values (1); return 1; end $$;
    create function notify_expiring_passes() returns integer language plpgsql security definer set search_path = public as $$ begin insert into queued values (2); return 1; end $$;
    create function notify_upcoming_reservations() returns integer language plpgsql security definer set search_path = public as $$ begin insert into queued values (3); return 1; end $$;
    create function wrapper_like_confirm_test_payment(p_c uuid, p_p uuid) returns void language plpgsql security definer set search_path = public as $$ begin perform ensure_center_member(p_c, p_p); end $$;
    revoke all on function wrapper_like_confirm_test_payment(uuid, uuid) from public; grant execute on function wrapper_like_confirm_test_payment(uuid, uuid) to authenticated, service_role;
  `);
  return db;
}
async function as(db, role, sql) { await db.exec(`set role ${role}`); try { return await db.query(sql); } finally { await db.exec('reset role'); } }
const PERM = /permission denied for function/i;

test('적용 전 재현: anon/authenticated가 ensure_center_member / 배치 함수를 직접 호출할 수 있다(취약 상태)', async () => {
  const db = await world();
  await as(db, 'anon', `select ensure_center_member('${CEN}','${PRO}')`);
  await as(db, 'authenticated', `select evaluate_notification_rules(), notify_expiring_passes(), notify_upcoming_reservations()`);
});
test('B) ensure_center_member: anon/authenticated 차단, service_role 허용, SECURITY DEFINER 호출자는 계속 동작', async () => {
  const db = await world(); await db.exec(B.fwd);
  await assert.rejects(as(db, 'anon', `select ensure_center_member('${CEN}','${PRO}')`), PERM);
  await assert.rejects(as(db, 'authenticated', `select ensure_center_member('${CEN}','${PRO}')`), PERM);
  await as(db, 'service_role', `select ensure_center_member('${CEN}','${PRO}')`);
  await as(db, 'authenticated', `select wrapper_like_confirm_test_payment('${CEN}','${PRO}')`);   // 소유자 권한으로 실행 — 영향 없음
  assert.equal((await db.query(`select count(*)::int c from center_members`)).rows[0].c, 1);
});
test('C) 알림 배치 함수 3개: anon/authenticated 차단, service_role(및 소유자=cron) 허용', async () => {
  const db = await world(); await db.exec(C.fwd);
  for (const fn of ['evaluate_notification_rules', 'notify_expiring_passes', 'notify_upcoming_reservations']) {
    await assert.rejects(as(db, 'anon', `select ${fn}()`), PERM, fn);
    await assert.rejects(as(db, 'authenticated', `select ${fn}()`), PERM, fn);
    const r = await as(db, 'service_role', `select ${fn}() as v`); assert.equal(r.rows[0].v, 1, fn);
  }
  await db.query(`select evaluate_notification_rules(), notify_expiring_passes(), notify_upcoming_reservations()`);   // 소유자(postgres, pg_cron job 소유자와 동일 역할) 호출은 통과
  assert.equal((await db.query(`select count(*)::int c from queued`)).rows[0].c, 6);
});
test('멱등 + 롤백은 적용 전 상태로 복귀(PUBLIC 실행 가능)', async () => {
  const db = await world(); await db.exec(B.fwd); await db.exec(B.fwd); await db.exec(C.fwd); await db.exec(C.fwd);
  await db.exec(B.rb); await db.exec(C.rb);
  await as(db, 'anon', `select ensure_center_member('${CEN}','${PRO}')`);
  await as(db, 'authenticated', `select evaluate_notification_rules()`);
});
test('verify SQL은 SELECT만이며 적용 후 기대값을 돌려준다(함수 속성만; cron 조회 문은 pg_cron이 있는 프로젝트용)', async () => {
  for (const f of [B.v, C.v]) assert.doesNotMatch(f.replace(/^\s*--.*$/gm, ''), /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);
  const db = await world(); await db.exec(B.fwd); await db.exec(C.fwd);
  const rows = (await db.query(B.v.replace(/^\s*--.*$/gm, ''))).rows;
  assert.deepEqual([rows[0].anon_exec, rows[0].authenticated_exec, rows[0].service_role_exec], [false, false, true]);
  const first = C.v.replace(/^\s*--.*$/gm, '').split(';')[0];
  const crows = (await db.query(first)).rows;
  assert.equal(crows.length, 3); for (const r of crows) assert.deepEqual([r.anon_exec, r.authenticated_exec, r.service_role_exec], [false, false, true]);
});
test('migration은 함수 본문/정책/데이터를 건드리지 않는다(정적)', () => {
  for (const f of [B.fwd, C.fwd]) { const code = f.replace(/^\s*--.*$/gm, ''); assert.doesNotMatch(code, /create (or replace )?function|alter function|create policy|\b(insert|update|delete)\b/i); }
});
