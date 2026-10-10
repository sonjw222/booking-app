// 격리 PostgreSQL(PGlite) — centers 민감 컬럼 SELECT 차단(add_admin_list_centers_rpc_20261009.sql + fix_centers_sensitive_column_privileges_20261009.sql).
// 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/centers-sensitive-column-privileges.test.mjs
// 합성 스키마에서 권한/RLS/함수 의미만 검증한다(Production/DEV DB에 접속하지 않는다). 라이브 grant 상태(Supabase 기본 ACL)는 fixture로 흉내 낸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const SQL1 = read('add_admin_list_centers_rpc_20261009.sql'), SQL1_RB = read('rollback_add_admin_list_centers_rpc_20261009.sql'), SQL1_VF = read('verify_add_admin_list_centers_rpc_20261009.sql');
const SQL2 = read('fix_centers_sensitive_column_privileges_20261009.sql'), SQL2_RB = read('rollback_fix_centers_sensitive_column_privileges_20261009.sql'), SQL2_VF = read('verify_fix_centers_sensitive_column_privileges_20261009.sql');
const MEMBER = '00000000-0000-0000-0000-0000000000a1', ADMIN = '00000000-0000-0000-0000-0000000000a2', MGR = '00000000-0000-0000-0000-0000000000a3', MGR2 = '00000000-0000-0000-0000-0000000000a4';
const C_OK = '10000000-0000-0000-0000-000000000001', C_INTERNAL = '10000000-0000-0000-0000-000000000002', C_PENDING = '10000000-0000-0000-0000-000000000003', C_OTHER = '10000000-0000-0000-0000-000000000004';
const SENS = ['business_number', 'business_license_url', 'reject_reason'];

async function world({ s1 = true, s2 = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema auth; grant usage on schema auth to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    create table accounts(id uuid primary key, auth_id uuid unique not null, name text not null, phone text, is_platform_admin boolean not null default false);
    create table centers(id uuid primary key default gen_random_uuid(), name text not null, categories text[] not null default '{}', address text, phone text,
      intro text, intro_blocks jsonb not null default '[]', pay_methods text[], photo_url text, sns text, latitude numeric(9,6), longitude numeric(9,6),
      business_number text, business_license_url text,
      status text not null default 'pending' check (status in ('pending','approved','rejected')), reject_reason text,
      payment_methods text[] not null default '{card}', created_at timestamptz not null default now(),
      instagram text, kakao text, review_point int, is_internal boolean not null default false);   -- instagram/kakao/review_point/is_internal: 라이브에만 있는 컬럼(repo CREATE TABLE에 없음)
    create table manager_centers(id uuid primary key default gen_random_uuid(), account_id uuid not null references accounts(id), center_id uuid not null references centers(id),
      status text not null default 'active', created_at timestamptz not null default now(), unique(account_id, center_id));
    create table center_members(center_id uuid, account_id uuid);
    create table classes(id uuid primary key default gen_random_uuid(), center_id uuid not null references centers(id), title text not null);
    create table reservations(id uuid primary key default gen_random_uuid(), class_id uuid not null references classes(id), account_id uuid not null);
    -- 라이브 함수 모양(개요): SECURITY DEFINER 헬퍼
    create function my_account_id() returns uuid language sql stable security definer as $$ select id from accounts where auth_id = auth.uid() $$;
    create function is_platform_admin() returns boolean language sql stable security definer as $$ select coalesce((select is_platform_admin from accounts where auth_id = auth.uid()), false) $$;
    create function my_managed_center_ids() returns setof uuid language sql stable security definer as $$ select center_id from manager_centers where account_id = my_account_id() and status = 'active' $$;
    create function my_member_center_ids() returns setof uuid language sql stable security definer as $$ select center_id from center_members where account_id = my_account_id() $$;
    alter table centers enable row level security;
    create policy "승인된 센터 조회" on centers for select using ((status = 'approved' and (not is_internal or id in (select my_member_center_ids()))) or id in (select my_managed_center_ids()) or is_platform_admin());
    create policy "매니저 센터 수정" on centers for update using (id in (select my_managed_center_ids()) or is_platform_admin());
    create policy "센터 생성" on centers for insert with check (auth.uid() is not null);
    create function guard_center_status_change() returns trigger language plpgsql security definer as $$
      begin if new.status is distinct from old.status and not is_platform_admin() then raise exception '센터 승인 상태는 플랫폼 운영자만 변경할 수 있어요'; end if; return new; end; $$;
    create trigger trg_guard_center_status before update on centers for each row execute function guard_center_status_change();
    -- 센터 등록 RPC(라이브 register_center_for_account_safe 모양: SECURITY DEFINER, 민감 컬럼 INSERT, authenticated만 실행)
    create function register_center_for_account_safe(p_name text, p_business_number text, p_business_license_url text) returns uuid
      language plpgsql security definer set search_path = public as $$
      declare v uuid; begin
        insert into centers(name, business_number, business_license_url) values (p_name, p_business_number, p_business_license_url) returning id into v;
        insert into manager_centers(account_id, center_id) values (my_account_id(), v); return v; end; $$;
    revoke all on function register_center_for_account_safe(text,text,text) from public; grant execute on function register_center_for_account_safe(text,text,text) to authenticated;
    -- 예약 함수(SECURITY DEFINER가 centers를 읽는 라이브 패턴)
    create function reserve_class(p_class uuid) returns text language plpgsql security definer set search_path = public as $$
      declare v text; begin select c.status into v from classes cl join centers c on c.id = cl.center_id where cl.id = p_class;
        if v is distinct from 'approved' then raise exception '승인된 센터가 아니에요'; end if;
        insert into reservations(class_id, account_id) values (p_class, my_account_id()); return 'confirmed'; end; $$;
    grant execute on function reserve_class(uuid) to authenticated;
    -- Supabase 기본 ACL 흉내: anon/authenticated는 테이블 전체 권한(적용 전 취약 상태), service_role도 전체
    grant all on all tables in schema public to anon, authenticated, service_role;
    insert into accounts values ('${MEMBER}','${MEMBER}','회원','010-1'), ('${ADMIN}','${ADMIN}','운영자','010-2'), ('${MGR}','${MGR}','오너A','010-3'), ('${MGR2}','${MGR2}','오너B','010-4');
    update accounts set is_platform_admin = true where id = '${ADMIN}';
    insert into centers(id,name,status,business_number,business_license_url,is_internal,instagram) values
      ('${C_OK}','공개센터','approved','111-11-11111','u/lic1.pdf',false,'@ok'),
      ('${C_INTERNAL}','내부QA센터','approved','000-00-00000','u/qa.pdf',true,null),
      ('${C_OTHER}','다른센터','approved','222-22-22222','u/lic2.pdf',false,null);
    insert into centers(id,name,status,business_number,business_license_url,reject_reason) values ('${C_PENDING}','대기센터','pending','333-33-33333','u/lic3.pdf','서류 미비');
    insert into manager_centers(account_id, center_id) values ('${MGR}','${C_OK}'), ('${MGR2}','${C_OTHER}'), ('${MGR}','${C_PENDING}');
    insert into classes(id, center_id, title) values ('20000000-0000-0000-0000-000000000001','${C_OK}','수업');
  `);
  if (s1) await db.exec(SQL1);
  if (s2) await db.exec(SQL2);
  return db;
}
async function as(db, role, uid, sql, preface) {
  await db.exec(`select set_config('app.uid', '${uid ?? ''}', false)`);
  await db.exec(`set role ${role}`);
  try { if (preface) await db.exec(preface); return await db.query(sql); } finally { await db.exec('reset search_path'); await db.exec('reset role'); await db.exec(`select set_config('app.uid', '', false)`); }
}
const denied = /permission denied/i;

test('1) 익명 사용자 공개 센터 조회: 안전한 컬럼 select/filter/embed 정상, 행 필터(RLS) 유지', async () => {
  const db = await world();
  const r = await as(db, 'anon', null, `select id, name, address, phone, intro, intro_blocks, photo_url, sns, categories, latitude, longitude, pay_methods, payment_methods, review_point, status, created_at, instagram, kakao from centers where status = 'approved' order by name`);
  assert.deepEqual(r.rows.map(x => x.name), ['공개센터', '다른센터']);
  const e = await as(db, 'anon', null, `select cl.title, c.name, c.status from classes cl join centers c on c.id = cl.center_id`);
  assert.equal(e.rows[0].name, '공개센터');
});
test('2) 익명 사용자 제한 컬럼 접근 거부(select/select */where/order by/returning 우회 포함)', async () => {
  const db = await world();
  for (const col of SENS) {
    await assert.rejects(as(db, 'anon', null, `select ${col} from centers`), denied);
    await assert.rejects(as(db, 'anon', null, `select id from centers where ${col} is not null`), denied);
    await assert.rejects(as(db, 'anon', null, `select id from centers order by ${col}`), denied);
  }
  await assert.rejects(as(db, 'anon', null, `select * from centers`), denied);
  await assert.rejects(as(db, 'anon', null, `select c.* from centers c`), denied);
  await assert.rejects(as(db, 'anon', null, `select to_jsonb(c) from centers c`), denied);   // 행 전체 직렬화로 우회 불가
});
test('3) 일반 회원 제한 컬럼 접근 거부, 안전 컬럼은 정상', async () => {
  const db = await world();
  for (const col of SENS) await assert.rejects(as(db, 'authenticated', MEMBER, `select ${col} from centers`), denied);
  await assert.rejects(as(db, 'authenticated', MEMBER, `select * from centers`), denied);
  const ok = await as(db, 'authenticated', MEMBER, `select name, status from centers where status='approved' order by name`);
  assert.equal(ok.rows.length, 2);
});
test('3-b) 센터 관리자도 테이블 직접 SELECT로는 자기 센터의 민감 컬럼을 못 읽는다(필요 시 별도 RPC) / 타 센터 접근도 마찬가지', async () => {
  const db = await world();
  await assert.rejects(as(db, 'authenticated', MGR, `select business_number from centers where id='${C_OK}'`), denied);
  await assert.rejects(as(db, 'authenticated', MGR, `select business_number from centers where id='${C_OTHER}'`), denied);
  await assert.rejects(as(db, 'authenticated', MGR, `select * from centers where id='${C_OK}'`), denied);
});
test('4) 센터 관리자 일반 업무 정상: 자기 센터 안전 컬럼 조회/수정, 타 센터 수정 불가(RLS), status 가드 유지', async () => {
  const db = await world();
  const mine = await as(db, 'authenticated', MGR, `select id, name, status from centers where id = '${C_PENDING}'`);   // 승인 전 센터도 매니저 본인은 조회(기존 정책)
  assert.equal(mine.rows[0].name, '대기센터');
  await as(db, 'authenticated', MGR, `update centers set intro='소개 수정', phone='02-1', pay_methods=array['card'], review_point=10, latitude=37.5, longitude=127.0 where id='${C_OK}'`);
  assert.equal((await db.query(`select intro from centers where id='${C_OK}'`)).rows[0].intro, '소개 수정');
  const other = await as(db, 'authenticated', MGR, `update centers set intro='침입' where id='${C_OTHER}' returning id`);
  assert.equal(other.rows.length, 0);
  await assert.rejects(as(db, 'authenticated', MGR, `update centers set status='approved' where id='${C_PENDING}'`), /플랫폼 운영자만/);
});
test('4-b) 센터 등록 RPC(SECURITY DEFINER)는 민감 컬럼을 INSERT하고 정상 동작', async () => {
  const db = await world();
  const r = await as(db, 'authenticated', MEMBER, `select register_center_for_account_safe('신규센터','444-44-44444','u/new.pdf') as id`);
  const row = await db.query(`select name, status, business_number, business_license_url from centers where id='${r.rows[0].id}'`);
  assert.deepEqual(row.rows[0], { name: '신규센터', status: 'pending', business_number: '444-44-44444', business_license_url: 'u/new.pdf' });
  await assert.rejects(as(db, 'anon', null, `select register_center_for_account_safe('x','y','z')`), denied);   // anon은 기존대로 실행 불가
});
test('5) 플랫폼 관리자 승인 화면: RPC가 민감 컬럼+오너를 돌려주고, 승인/반려 UPDATE가 정상', async () => {
  const db = await world();
  const list = await as(db, 'authenticated', ADMIN, `select * from admin_list_centers('pending')`);
  assert.equal(list.rows.length, 1);
  assert.deepEqual(
    { id: list.rows[0].id, business_number: list.rows[0].business_number, business_license_url: list.rows[0].business_license_url, reject_reason: list.rows[0].reject_reason, status: list.rows[0].status, owner_name: list.rows[0].owner_name, owner_phone: list.rows[0].owner_phone },
    { id: C_PENDING, business_number: '333-33-33333', business_license_url: 'u/lic3.pdf', reject_reason: '서류 미비', status: 'pending', owner_name: '오너A', owner_phone: '010-3' });
  assert.equal((await as(db, 'authenticated', ADMIN, `select * from admin_list_centers('approved')`)).rows.length, 3);   // 내부 QA 센터 포함(관리자 화면은 원래 전부 본다)
  await as(db, 'authenticated', ADMIN, `update centers set status='rejected', reject_reason='사유' where id='${C_PENDING}'`);
  assert.equal((await as(db, 'authenticated', ADMIN, `select * from admin_list_centers('rejected')`)).rows[0].reject_reason, '사유');
  await as(db, 'authenticated', ADMIN, `update centers set status='approved', reject_reason=null where id='${C_PENDING}'`);
  assert.equal((await db.query(`select status from centers where id='${C_PENDING}'`)).rows[0].status, 'approved');
});
test('6) 관리자 RPC 실행 거부: 일반 회원/센터 오너(forbidden 42501), 익명(execute 권한 없음), 비로그인 JWT 없음, 잘못된 status', async () => {
  const db = await world();
  await assert.rejects(as(db, 'authenticated', MEMBER, `select * from admin_list_centers('pending')`), /forbidden/);
  await assert.rejects(as(db, 'authenticated', MGR, `select * from admin_list_centers('pending')`), /forbidden/);
  await assert.rejects(as(db, 'authenticated', null, `select * from admin_list_centers('pending')`), /forbidden/);   // JWT 없는 authenticated 컨텍스트
  await assert.rejects(as(db, 'anon', null, `select * from admin_list_centers('pending')`), denied);
  await assert.rejects(as(db, 'authenticated', ADMIN, `select * from admin_list_centers('approved'' or ''1''=''1')`), /invalid status/);
  await assert.rejects(as(db, 'authenticated', ADMIN, `select * from admin_list_centers(null)`), /invalid status/);
});
test('6-b) 권한 상승 방지: SECURITY DEFINER + search_path 고정, 함수 소유자 외 변조 불가, 가짜 is_platform_admin 스키마 가로채기 무효', async () => {
  const db = await world();
  const p = (await db.query(`select p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') b,
      (select count(*) from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) pub from pg_proc p where p.proname = 'admin_list_centers'`)).rows[0];
  assert.equal(p.prosecdef, true); assert.deepEqual(p.proconfig, ['search_path=public, pg_temp']); assert.deepEqual([p.a, p.b, Number(p.pub)], [false, true, 0]);
  // 일반 사용자가 자기 스키마/임시 객체로 함수를 가로채려 해도(search_path 조작) 결과는 forbidden
  await db.exec(`create schema evil; create function evil.is_platform_admin() returns boolean language sql as $$ select true $$; grant usage on schema evil to authenticated;`);
  await assert.rejects(as(db, 'authenticated', MEMBER, `select * from admin_list_centers('pending')`, `set search_path = evil, public`), /forbidden/);
});
test('6-c) is_platform_admin()이 NULL을 반환해도 접근 거부(`not NULL` 통과 방지 — IS NOT TRUE 검사), 관리자 정상 흐름은 유지', async () => {
  const db = await world();
  // 계정이 없는 사용자(연결 계정 없음)는 라이브 정의에서도 coalesce 전 NULL이 될 수 있다 — 아래는 함수 자체가 NULL을 돌려주는 최악의 경우
  await db.exec(`create or replace function is_platform_admin() returns boolean language sql stable security definer as $$ select null::boolean $$`);
  assert.equal((await as(db, 'authenticated', ADMIN, `select is_platform_admin() as v`)).rows[0].v, null);
  await assert.rejects(as(db, 'authenticated', ADMIN, `select * from admin_list_centers('pending')`), /forbidden/);   // 평소 관리자여도 NULL이면 거부
  await assert.rejects(as(db, 'authenticated', MEMBER, `select * from admin_list_centers('approved')`), /forbidden/);
  await db.exec(`create or replace function is_platform_admin() returns boolean language sql stable security definer as $$ select coalesce((select is_platform_admin from accounts where auth_id = auth.uid()), false) $$`);
  assert.equal((await as(db, 'authenticated', ADMIN, `select * from admin_list_centers('pending')`)).rows.length, 1);   // 복구하면 다시 정상
});
test('6-d) RPC 본문은 `is_platform_admin() is not true`로 검사한다(정적)', () => {
  const code = SQL1.replace(/^\s*--.*$/gm, '');
  assert.match(code, /if public\.is_platform_admin\(\) is not true then/i);
  assert.doesNotMatch(code, /if not public\.is_platform_admin\(\)/i);
});
test('12-c) 예상 밖 컬럼이 하나라도 있으면 SQL 2 중단 — 권한은 한 글자도 바뀌지 않고 새 컬럼은 공개되지 않는다', async () => {
  const db = await world({ s1: false, s2: false });
  await db.exec(`alter table centers add column internal_note text`);
  await assert.rejects(db.exec(SQL2), /예상과 다릅니다.*unexpected.*internal_note/s);
  await db.exec('rollback');
  assert.equal((await db.query(`select has_table_privilege('anon','public.centers','select') v`)).rows[0].v, true);   // 적용 전 상태 그대로(전체 권한)
  assert.equal((await db.query(`select has_table_privilege('authenticated','public.centers','select') v`)).rows[0].v, true);
});
test('12-d) 예상 컬럼이 빠져 있어도 SQL 2 중단(스키마 변경 감지) + 메시지에 missing 표시', async () => {
  const db = await world({ s1: false, s2: false });
  await db.exec(`alter table centers drop column kakao`);
  await assert.rejects(db.exec(SQL2), /예상과 다릅니다.*missing.*kakao/s);
  await db.exec('rollback');
  assert.equal((await db.query(`select has_table_privilege('anon','public.centers','select') v`)).rows[0].v, true);
});
test('12-e) 허용 목록이 정확히 19개이고 민감 3개와 겹치지 않으며, 적용 후 anon이 읽을 수 있는 컬럼 집합과 일치한다', async () => {
  const code = SQL2.replace(/^\s*--.*$/gm, '');
  const pub = [...code.match(/v_public\s+text\[\] := array\[([\s\S]*?)\];/)[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert.equal(pub.length, 19); assert.equal(new Set(pub).size, 19);
  for (const c of SENS) assert.ok(!pub.includes(c), c);
  const db = await world();
  const readable = (await db.query(`select a.attname from pg_attribute a where a.attrelid='public.centers'::regclass and a.attnum>0 and not a.attisdropped and has_column_privilege('anon','public.centers',a.attname,'select') order by 1`)).rows.map(r => r.attname);
  assert.deepEqual(readable, [...pub].sort());
  // 적용 후에 추가된 컬럼은 자동 공개되지 않는다(개별 grant 필요)
  await db.exec(`alter table centers add column later_col text`);
  assert.equal((await db.query(`select has_column_privilege('anon','public.centers','later_col','select') v`)).rows[0].v, false);
});
test('7) 예약/결제 경로 회귀 없음: SECURITY DEFINER 예약 함수와 anon 공개 조회가 컬럼 권한 적용 후에도 동작', async () => {
  const db = await world();
  const r = await as(db, 'authenticated', MEMBER, `select reserve_class('20000000-0000-0000-0000-000000000001') as s`);
  assert.equal(r.rows[0].s, 'confirmed');
  assert.equal((await as(db, 'service_role', null, `select count(*)::int n from centers`)).rows[0].n, 4);   // service_role(Edge Function/서버)은 전체 컬럼 그대로
  assert.equal((await as(db, 'service_role', null, `select business_number from centers where id='${C_OK}'`)).rows[0].business_number, '111-11-11111');
});
test('8) 내부 QA 센터 비노출 유지(행 단위 정책은 그대로)', async () => {
  const db = await world();
  const anon = await as(db, 'anon', null, `select id from centers where id = '${C_INTERNAL}'`);
  assert.equal(anon.rows.length, 0);
  const member = await as(db, 'authenticated', MEMBER, `select id from centers where id = '${C_INTERNAL}'`);
  assert.equal(member.rows.length, 0);
  const pend = await as(db, 'anon', null, `select id from centers where id = '${C_PENDING}'`);
  assert.equal(pend.rows.length, 0);   // 승인 전 센터도 익명 비노출
});
test('9) 권한 구조: 테이블 SELECT 회수 + 컬럼 단위 grant(민감 3개 제외), INSERT/UPDATE 권한 유지', async () => {
  const db = await world();
  const q = async (role, col) => (await db.query(`select has_column_privilege('${role}','public.centers','${col}','select') v`)).rows[0].v;
  for (const role of ['anon', 'authenticated']) {
    for (const c of SENS) assert.equal(await q(role, c), false, `${role}.${c}`);
    for (const c of ['id', 'name', 'status', 'is_internal', 'instagram', 'review_point', 'latitude']) assert.equal(await q(role, c), true, `${role}.${c}`);
    assert.equal((await db.query(`select has_table_privilege('${role}','public.centers','select') v`)).rows[0].v, false);
  }
  assert.equal((await db.query(`select has_table_privilege('authenticated','public.centers','insert') i, has_table_privilege('authenticated','public.centers','update') u`)).rows[0].i, true);
  assert.equal((await db.query(`select has_table_privilege('service_role','public.centers','select') v`)).rows[0].v, true);
});
test('10) 적용 전(취약 상태) 재현: SQL 2 적용 전에는 anon이 민감 컬럼을 읽는다 — 테스트가 실제로 효과를 검증함', async () => {
  const db = await world({ s2: false });
  const r = await as(db, 'anon', null, `select business_number from centers where id = '${C_OK}'`);
  assert.equal(r.rows[0].business_number, '111-11-11111');
});
test('11) 재실행 안전(SQL 1, SQL 2 각각 두 번)', async () => {
  const db = await world();
  await db.exec(SQL1); await db.exec(SQL2);
  await assert.rejects(as(db, 'anon', null, `select business_number from centers`), denied);
  assert.equal((await as(db, 'authenticated', ADMIN, `select * from admin_list_centers('pending')`)).rows.length, 1);
});
test('12) 원자성: 예상 밖 스키마(필수 공개 컬럼 없음)면 SQL 2가 예외로 전체 롤백 — 권한이 중간 상태로 남지 않는다', async () => {
  const db = await world({ s1: false, s2: false });
  await db.exec(`alter table centers rename column status to state`);
  await assert.rejects(db.exec(SQL2), /예상과 다릅니다/);
  await db.exec('rollback');
  assert.equal((await db.query(`select has_table_privilege('anon','public.centers','select') v`)).rows[0].v, true);   // 적용 전 상태 그대로
});
test('12-b) 원자성: PUBLIC 등 다른 경로로 민감 컬럼이 열려 있으면 자체 검사로 전체 롤백', async () => {
  const db = await world({ s1: false, s2: false });
  await db.exec(`grant select on centers to public`);
  await assert.rejects(db.exec(SQL2), /여전히 열려 있습니다/);
  await db.exec('rollback');
  assert.equal((await db.query(`select has_table_privilege('anon','public.centers','select') v`)).rows[0].v, true);
});
test('13) 롤백: SQL 2 롤백은 즉시 원복, SQL 1 롤백은 함수만 제거(권한 SQL 먼저 롤백해야 함)', async () => {
  const db = await world();
  await db.exec(SQL2_RB);
  assert.equal((await as(db, 'anon', null, `select business_number from centers where id='${C_OK}'`)).rows[0].business_number, '111-11-11111');
  await db.exec(SQL1_RB);
  assert.equal((await db.query(`select count(*)::int n from pg_proc where proname='admin_list_centers'`)).rows[0].n, 0);
  await db.exec(SQL1_RB);   // 멱등
});
test('14) verify SQL은 SELECT만 포함하고 적용 후 실제로 기대값을 돌려준다', async () => {
  for (const v of [SQL1_VF, SQL2_VF]) assert.doesNotMatch(v.replace(/^\s*--.*$/gm, '').replace(/'[^']*'/g, "''"), /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);
  const db = await world();
  const stmts = SQL2_VF.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
  const first = await db.query(stmts[0]);
  assert.ok(first.rows.every(r => r.can_select === false));
  const second = await db.query(stmts[1]);
  assert.ok(second.rows.length > 0 && second.rows.every(r => r.can_select === true));
  const third = (await db.query(stmts[2])).rows[0];
  assert.deepEqual([third.anon_table_select, third.authenticated_table_select, third.service_role_table_select], [false, false, true]);
  const extra = await db.query(stmts[4]); assert.equal(extra.rows.length, 0);   // 허용 목록 밖에 열린 컬럼 없음
  const v1 = SQL1_VF.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
  const f = (await db.query(v1[0])).rows[0]; assert.equal(f.security_definer, true);
  const g = (await db.query(v1[2])).rows[0]; assert.deepEqual([g.anon_exec, g.authenticated_exec, Number(g.public_grants)], [false, true, 0]);
});
