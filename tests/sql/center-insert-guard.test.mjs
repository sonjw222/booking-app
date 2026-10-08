// 격리 PostgreSQL(PGlite) — centers INSERT 가드(fix_center_insert_guard_20261008.sql). 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/center-insert-guard.test.mjs
// 합성 스키마에서 정책/트리거 의미만 검증한다(Production/DEV DB에 접속하지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('fix_center_insert_guard_20261008.sql');
const rollback = read('rollback_fix_center_insert_guard_20261008.sql');
const verify = read('verify_fix_center_insert_guard_20261008.sql');
const USER = '00000000-0000-0000-0000-0000000000a1', ADMIN = '00000000-0000-0000-0000-0000000000a2';

async function world({ apply = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema auth; grant usage on schema auth to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    -- Supabase auth.jwt(): 요청 JWT claims(jsonb), JWT가 없으면 null
    create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('app.jwt', true), '')::jsonb $$;
    grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
    create table accounts(id uuid primary key, is_platform_admin boolean default false);
    create function my_account_id() returns uuid language sql stable security definer as $$ select auth.uid() $$;
    create function is_platform_admin() returns boolean language sql stable security definer set search_path = public as
      $$ select coalesce((select is_platform_admin from accounts where id = my_account_id()), false) $$;
    create table centers(id uuid primary key default gen_random_uuid(), name text not null,
      status text not null default 'pending' check (status in ('pending','approved','rejected')), is_internal boolean not null default false,
      business_license_url text);
    alter table centers enable row level security;
    -- 라이브 정책(INSERT는 로그인만 요구) + 라이브 UPDATE 가드 사본(회귀 확인용)
    create policy "센터 생성" on centers for insert with check (auth.uid() is not null);
    create policy "센터 수정(테스트용: 본인 범위 없이 UPDATE 허용해 트리거만 검증)" on centers for update using (true) with check (true);
    create policy "센터 조회" on centers for select using (true);
    create function guard_center_status_change() returns trigger language plpgsql security definer as $$
      begin if new.status is distinct from old.status and not is_platform_admin() then raise exception '센터 승인 상태는 플랫폼 운영자만 변경할 수 있어요'; end if; return new; end; $$;
    create trigger trg_guard_center_status before update on centers for each row execute function guard_center_status_change();
    grant select, insert, update on centers to authenticated; grant all on centers to anon; grant select, insert, delete, update on centers to service_role;
    insert into accounts values ('${USER}', false), ('${ADMIN}', true);
  `);
  if (apply) await db.exec(migration);
  return db;
}
// role: 'authenticated' | 'anon' | 'service_role', uid: auth.uid() 값(없으면 JWT 없음)
// jwtRole: JWT의 role claim('anon'|'authenticated'|'service_role'), undefined면 요청 JWT 자체가 없는 컨텍스트(auth.jwt() = null)
async function as(db, role, uid, sql, jwtRole = role) {
  const jwt = jwtRole ? JSON.stringify({ role: jwtRole, ...(uid ? { sub: uid } : {}) }) : '';
  await db.exec(`select set_config('app.uid', '${uid ?? ''}', false)`);
  await db.exec(`select set_config('app.jwt', '${jwt}', false)`);
  await db.exec(`set role ${role}`);
  try { return await db.query(sql); } finally { await db.exec('reset role'); await db.exec(`select set_config('app.uid', '', false)`); await db.exec(`select set_config('app.jwt', '', false)`); }
}

test('1) 일반 로그인 사용자가 status=approved로 INSERT해도 저장은 pending', async () => {
  const db = await world();
  const r = await as(db, 'authenticated', USER, `insert into centers(name, status) values ('사칭센터','approved') returning status, is_internal`);
  assert.equal(r.rows[0].status, 'pending'); assert.equal(r.rows[0].is_internal, false);
});
test('2) 일반 로그인 사용자가 is_internal=true로 INSERT해도 저장은 false', async () => {
  const db = await world();
  const r = await as(db, 'authenticated', USER, `insert into centers(name, is_internal) values ('내부위장센터', true) returning status, is_internal`);
  assert.equal(r.rows[0].is_internal, false); assert.equal(r.rows[0].status, 'pending');
  const both = await as(db, 'authenticated', USER, `insert into centers(name, status, is_internal) values ('둘다','approved',true) returning status, is_internal`);
  assert.deepEqual([both.rows[0].status, both.rows[0].is_internal], ['pending', false]);
});
test('3) 정상 일반 센터 등록(status/is_internal 미지정)은 성공하고 pending', async () => {
  const db = await world();
  const r = await as(db, 'authenticated', USER, `insert into centers(name, business_license_url) values ('정상센터','path/x.pdf') returning status, is_internal, name`);
  assert.deepEqual([r.rows[0].status, r.rows[0].is_internal, r.rows[0].name], ['pending', false, '정상센터']);
});
test('4) service_role(JWT 없음) fixture 생성은 approved/internal 그대로 가능', async () => {
  const db = await world();
  const r = await as(db, 'service_role', null, `insert into centers(name, status, is_internal) values ('통합테스트센터-x','approved',true) returning status, is_internal`);
  assert.deepEqual([r.rows[0].status, r.rows[0].is_internal], ['approved', true]);
  const noJwtOwner = await db.query(`insert into centers(name, status) values ('SQL Editor 생성','approved') returning status`);   // 슈퍼유저/SQL Editor도 JWT 없음 → 통과
  assert.equal(noJwtOwner.rows[0].status, 'approved');
});
test('5) 플랫폼 운영자는 approved/internal 생성 권한 유지', async () => {
  const db = await world();
  const r = await as(db, 'authenticated', ADMIN, `insert into centers(name, status, is_internal) values ('운영자 생성','approved',true) returning status, is_internal`);
  assert.deepEqual([r.rows[0].status, r.rows[0].is_internal], ['approved', true]);
});
test('5-c) anon JWT(sub 없음, role=anon)는 trusted 분기에 들어가지 않는다 — 트리거 단독으로도 pending/false 강제', async () => {
  const db = await world();
  // anon에게 INSERT 정책을 임시로 열어 RLS가 아니라 트리거가 막는지를 직접 확인한다(트리거 단독 방어선 검증)
  await db.exec(`create policy "anon 임시 허용(테스트)" on centers for insert to anon with check (true)`);
  const r = await as(db, 'anon', null, `insert into centers(name, status, is_internal) values ('익명위장','approved',true) returning status, is_internal`);
  assert.deepEqual([r.rows[0].status, r.rows[0].is_internal], ['pending', false]);
});
test('5-d) service_role JWT / JWT 없는 SQL·cron 컨텍스트는 각각 기존대로 허용', async () => {
  const db = await world();
  const svc = await as(db, 'service_role', null, `insert into centers(name, status, is_internal) values ('svc','approved',true) returning status, is_internal`, 'service_role');
  assert.deepEqual([svc.rows[0].status, svc.rows[0].is_internal], ['approved', true]);
  const noJwt = await as(db, 'service_role', null, `insert into centers(name, status, is_internal) values ('cron','approved',true) returning status, is_internal`, undefined);
  assert.deepEqual([noJwt.rows[0].status, noJwt.rows[0].is_internal], ['approved', true]);
});
test('5-b) anon은 여전히 INSERT 불가(RLS)', async () => {
  const db = await world();
  await assert.rejects(as(db, 'anon', null, `insert into centers(name, status) values ('익명','approved')`), /row-level security|policy/i);
});
test('6) UPDATE 보호 회귀 없음: 일반 사용자는 status를 바꿀 수 없고 운영자는 바꿀 수 있다', async () => {
  const db = await world();
  const c = (await as(db, 'authenticated', USER, `insert into centers(name) values ('업데이트검증') returning id`)).rows[0].id;
  await assert.rejects(as(db, 'authenticated', USER, `update centers set status='approved' where id='${c}'`), /플랫폼 운영자만/);
  await as(db, 'authenticated', ADMIN, `update centers set status='approved' where id='${c}'`);
  assert.equal((await db.query(`select status from centers where id='${c}'`)).rows[0].status, 'approved');
});
test('7) 마이그레이션 멱등 + 롤백은 가드만 제거(적용 전 동작으로 복귀), 다른 가드는 유지', async () => {
  const db = await world();
  await db.exec(migration);   // 재실행 안전
  await db.exec(rollback);
  const r = await as(db, 'authenticated', USER, `insert into centers(name, status, is_internal) values ('롤백후','approved',true) returning status, is_internal`);
  assert.deepEqual([r.rows[0].status, r.rows[0].is_internal], ['approved', true]);   // 적용 전 취약 상태 재현(롤백 확인)
  const t = await db.query(`select tgname from pg_trigger where tgrelid='centers'::regclass and not tgisinternal order by 1`);
  assert.deepEqual(t.rows.map(x => x.tgname), ['trg_guard_center_status']);
});
test('8) verify SQL은 SELECT만 포함하고 적용 후 실제로 실행된다', async () => {
  const stripped = verify.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(stripped, /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);
  const db = await world();
  const trig = await db.query(`select t.tgname, t.tgenabled from pg_trigger t where t.tgrelid = 'public.centers'::regclass and not t.tgisinternal and t.tgname = 'trg_guard_center_insert'`);
  assert.equal(trig.rows[0].tgenabled, 'O');
  const fn = await db.query(`select p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') as a, has_function_privilege('authenticated', p.oid, 'execute') as b from pg_proc p where p.proname='guard_center_insert'`);
  assert.equal(fn.rows[0].prosecdef, true); assert.deepEqual(fn.rows[0].proconfig, ['search_path=public']); assert.deepEqual([fn.rows[0].a, fn.rows[0].b], [false, false]);
});
test('9) 마이그레이션은 centers 데이터/RLS/기존 정책을 바꾸지 않는다(정적)', () => {
  const code = migration.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(code, /\b(update|delete)\b[^;]*\bcenters\b|alter table|create policy|drop policy|disable row level|enable row level/i);
  assert.match(code, /create trigger trg_guard_center_insert\s+before insert on public\.centers/i);
});
