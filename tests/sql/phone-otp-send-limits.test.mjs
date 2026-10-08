// 격리 PostgreSQL(PGlite) — send-phone-otp IP/전역 한도(add_phone_otp_send_limits_20261008.sql). 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/phone-otp-send-limits.test.mjs
// 합성 스키마에서 RPC 의미만 검증한다(Production/DEV DB에 접속하지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('add_phone_otp_send_limits_20261008.sql');
const rollback = read('rollback_add_phone_otp_send_limits_20261008.sql');
const verify = read('verify_add_phone_otp_send_limits_20261008.sql');

async function world() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon, authenticated, service_role;`);
  // Production의 public 스키마 postgres 기본 ACL(새 테이블에 API 롤 권한 자동 부여)을 재현한다 — 마이그레이션이 이를 명시적으로 회수해야 한다.
  await db.exec(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
  await db.exec(migration);
  return db;
}
const consume = async (db, ip, ipCap, globalCap) => (await db.query(`select public.consume_phone_otp_send_attempt($1, $2, $3) as v`, [ip, ipCap, globalCap])).rows[0].v;

test('IP별 시간당 한도: 한도까지 ok, 이후 ip_limit(기록하지 않음), 다른 IP는 영향 없음', async () => {
  const db = await world();
  for (let i = 0; i < 3; i++) assert.equal(await consume(db, 'ipA', 3, 100), 'ok');
  assert.equal(await consume(db, 'ipA', 3, 100), 'ip_limit');
  assert.equal(await consume(db, 'ipB', 3, 100), 'ok');
  assert.equal((await db.query(`select count(*)::int c from phone_otp_send_attempts where ip_hash='ipA'`)).rows[0].c, 3);
});
test('전역 24시간 한도: 서로 다른 IP를 돌려도 전체 상한에서 global_limit', async () => {
  const db = await world();
  for (let i = 0; i < 5; i++) assert.equal(await consume(db, 'ip' + i, 10, 5), 'ok');
  assert.equal(await consume(db, 'ipNew', 10, 5), 'global_limit');
  assert.equal((await db.query(`select count(*)::int c from phone_otp_send_attempts`)).rows[0].c, 5);
});
test('윈도우: 1시간 지난 기록은 IP 한도에서, 24시간 지난 기록은 전역 한도에서 빠진다', async () => {
  const db = await world();
  await db.exec(`insert into phone_otp_send_attempts(ip_hash, created_at) select 'ipOld', now() - interval '61 minutes' from generate_series(1,3)`);
  assert.equal(await consume(db, 'ipOld', 3, 100), 'ok');            // 1시간 밖이라 IP 한도 미소진
  await db.exec(`insert into phone_otp_send_attempts(ip_hash, created_at) select 'x'||g, now() - interval '25 hours' from generate_series(1,5) g`);
  // 24시간 윈도우 안의 기록은 ipOld 4건(61분 전 3 + 방금 1)뿐 — 25시간 전 5건이 포함됐다면 9건이라 한도 5를 넘었을 것
  assert.equal(await consume(db, 'ipNew2', 10, 5), 'ok');
  assert.equal(await consume(db, 'ipNew3', 10, 5), 'global_limit');   // 이제 5건이라 상한 도달
});
test('2일 지난 기록은 호출 때 정리된다', async () => {
  const db = await world();
  await db.exec(`insert into phone_otp_send_attempts(ip_hash, created_at) values ('stale', now() - interval '3 days'), ('recent', now() - interval '1 hour')`);
  await consume(db, 'ipZ', 10, 100);
  const left = (await db.query(`select ip_hash from phone_otp_send_attempts order by 1`)).rows.map(r => r.ip_hash);
  assert.deepEqual(left, ['ipZ', 'recent']);
});
test('빈 IP 해시는 거부, 한도 인자 0 이하여도 최소 1로 동작', async () => {
  const db = await world();
  await assert.rejects(db.query(`select consume_phone_otp_send_attempt('', 10, 100)`), /ip hash required/);
  assert.equal(await consume(db, 'ipC', 0, 100), 'ok'); assert.equal(await consume(db, 'ipC', 0, 100), 'ip_limit');
});
test('기본 인자(10/시간, 500/일)로 호출 가능', async () => {
  const db = await world();
  for (let i = 0; i < 10; i++) assert.equal((await db.query(`select consume_phone_otp_send_attempt('ipD') as v`)).rows[0].v, 'ok');
  assert.equal((await db.query(`select consume_phone_otp_send_attempt('ipD') as v`)).rows[0].v, 'ip_limit');
});
test('권한: 기본 ACL이 회수돼 anon/authenticated/service_role 모두 테이블 직접 접근 불가, RPC는 service_role만', async () => {
  const db = await world();
  const p = (await db.query(`select has_function_privilege('anon', p.oid,'execute') a, has_function_privilege('authenticated', p.oid,'execute') b, has_function_privilege('service_role', p.oid,'execute') c, p.prosecdef, p.proconfig from pg_proc p where p.proname='consume_phone_otp_send_attempt'`)).rows[0];
  assert.deepEqual([p.a, p.b, p.c, p.prosecdef], [false, false, true, true]); assert.deepEqual(p.proconfig, ['search_path=""']);
  assert.equal((await db.query(`select relrowsecurity from pg_class where relname='phone_otp_send_attempts'`)).rows[0].relrowsecurity, true);
  assert.equal((await db.query(`select count(*)::int c from pg_policies where tablename='phone_otp_send_attempts'`)).rows[0].c, 0);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const priv of ['select', 'insert', 'update', 'delete', 'truncate']) assert.equal((await db.query(`select has_table_privilege('${role}', 'public.phone_otp_send_attempts', '${priv}') ok`)).rows[0].ok, false, `${role} ${priv}`);
  }
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query(`select * from public.phone_otp_send_attempts`), /permission denied/);                              // 테이블 SELECT 불가
    await assert.rejects(db.query(`insert into public.phone_otp_send_attempts(ip_hash) values ('x')`), /permission denied/);       // 테이블 INSERT 불가
    await assert.rejects(db.query(`select public.consume_phone_otp_send_attempt('x')`), /permission denied/);                       // RPC 실행 불가
    await db.exec('reset role');
  }
});
test('service_role은 RPC만으로 동작한다(SECURITY DEFINER가 소유자 권한으로 select/insert/delete 수행) — 테이블 권한 없이 ok/ip_limit/global_limit', async () => {
  const db = await world();
  await db.exec(`insert into public.phone_otp_send_attempts(ip_hash, created_at) values ('stale', now() - interval '3 days')`);   // 소유자(SQL Editor 등) 경로
  await db.exec('set role service_role');
  try {
    assert.equal((await db.query(`select public.consume_phone_otp_send_attempt('svcIp', 2, 100) v`)).rows[0].v, 'ok');
    assert.equal((await db.query(`select public.consume_phone_otp_send_attempt('svcIp', 2, 100) v`)).rows[0].v, 'ok');
    assert.equal((await db.query(`select public.consume_phone_otp_send_attempt('svcIp', 2, 100) v`)).rows[0].v, 'ip_limit');
    assert.equal((await db.query(`select public.consume_phone_otp_send_attempt('otherIp', 100, 2) v`)).rows[0].v, 'global_limit');   // 전역 한도(이미 기록 2건)
  } finally { await db.exec('reset role'); }
  assert.equal((await db.query(`select count(*)::int c from public.phone_otp_send_attempts where ip_hash = 'stale'`)).rows[0].c, 0);   // cleanup DELETE 수행됨
});
test('동시 호출: 한도를 넘겨 기록되지 않는다(락)', async () => {
  const db = await world();
  const res = await Promise.all(Array.from({ length: 8 }, () => consume(db, 'ipRace', 3, 100)));
  assert.equal(res.filter(v => v === 'ok').length, 3);
});
test('마이그레이션 멱등 + 롤백은 함수/테이블만 제거, verify는 SELECT만', async () => {
  const db = await world(); await db.exec(migration);
  await db.exec(rollback);
  assert.equal((await db.query(`select count(*)::int c from pg_proc where proname='consume_phone_otp_send_attempt'`)).rows[0].c, 0);
  assert.equal((await db.query(`select count(*)::int c from pg_tables where tablename='phone_otp_send_attempts'`)).rows[0].c, 0);
  assert.doesNotMatch(verify.replace(/^\s*--.*$/gm, '').replace(/'[^']*'/g, "''"), /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);
});
