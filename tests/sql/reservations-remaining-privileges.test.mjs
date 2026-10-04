// 격리 PostgreSQL(PGlite) — reservations 남은 권한(authenticated DELETE, anon SELECT) 회수. 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/reservations-remaining-privileges.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const prior = read('fix_reservations_privileges_minimize_20261003.sql');
const migration = read('fix_reservations_remaining_privileges_20261004.sql');
const rollback = read('rollback_fix_reservations_remaining_privileges_20261004.sql');
const verify = read('verify_reservations_remaining_privileges_20261004.sql').replace(/^\s*--.*$/gm, '');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ACC1 = id(11), ACC2 = id(12), MGR = id(13), P1 = id(21), P2 = id(22), CLS = id(31), CENTER = id(41);

// "예약 무결성 SQL 적용 후" Production 상태(authenticated: select/insert/delete/references/trigger + member_memo update, anon: select/references/trigger, service_role 전체)에서 시작해 직전 migration을 적용한 뒤 이번 migration을 적용한다.
async function world({ apply = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create function my_account_id() returns uuid language sql stable as $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;
    create table profiles(id uuid primary key, account_id uuid);
    create function my_profile_ids() returns setof uuid language sql stable security definer as $$ select id from profiles where account_id = my_account_id() $$;
    create function is_my_center(c uuid) returns boolean language sql stable as $$ select my_account_id() = '${MGR}'::uuid and c = '${CENTER}'::uuid $$;
    create table classes(id uuid primary key, center_id uuid);
    create table reservations(id uuid primary key default gen_random_uuid(), class_id uuid, profile_id uuid, membership_id uuid, status text, member_memo text, waitlist_order int);
    create table reservation_goods_usages(id uuid primary key default gen_random_uuid(), reservation_id uuid references reservations(id));   -- 다른 테이블의 FK는 owner 권한으로 검증된다
    create view class_reservation_counts as select class_id, count(*)::int as confirmed_count from reservations where status = 'confirmed' group by class_id;
    grant select on class_reservation_counts to anon, authenticated;
    grant select on classes to anon, authenticated;
    alter table reservations enable row level security;
    create policy "내 프로필 예약 조회" on reservations for select using (profile_id in (select my_profile_ids()));
    create policy "매니저 센터 예약 조회" on reservations for select using (exists (select 1 from classes c where c.id = reservations.class_id and is_my_center(c.center_id)));
    create policy "매니저 취소예약 정리" on reservations for delete using (status in ('cancelled','no_show') and class_id in (select id from classes where is_my_center(center_id)));
    create policy "본인 예약 메모 수정" on reservations for update using (profile_id in (select my_profile_ids())) with check (profile_id in (select my_profile_ids()));
    revoke all on reservations from anon, authenticated, service_role;
    grant select, references, trigger on reservations to anon;
    grant select, insert, delete, references, trigger on reservations to authenticated;
    grant update (member_memo) on reservations to authenticated;
    grant select, insert, update, delete on reservations to service_role;
    -- SECURITY DEFINER RPC(예약/취소) — owner 권한으로 동작
    create function rpc_reserve(p_class uuid, p_profile uuid) returns uuid language sql security definer set search_path = public as $$ insert into reservations(class_id, profile_id, status) values (p_class, p_profile, 'confirmed') returning id $$;
    create function rpc_cancel(p_id uuid) returns void language sql security definer set search_path = public as $$ update reservations set status = 'cancelled' where id = p_id $$;
    grant execute on function rpc_reserve(uuid, uuid), rpc_cancel(uuid) to authenticated;
    insert into profiles values ('${P1}','${ACC1}'), ('${P2}','${ACC2}');
    insert into classes values ('${CLS}','${CENTER}');
  `);
  await db.exec(prior);                      // 직전 migration(권한 최소화 20261003)은 적용된 상태에서 시작
  if (apply) await db.exec(migration);
  return db;
}
const as = async (db, role, acc, fn) => { await db.exec(`set role ${role}; select set_config('app.account_id','${acc ?? ''}', false);`); try { return await fn(); } finally { await db.exec(`reset role; select set_config('app.account_id','',false);`); } };

test('positive: 회수 후에도 정상 경로 유지 — 예약/취소 RPC(SECURITY DEFINER), 본인/매니저 조회, member_memo UPDATE, 공개 인원수 view(anon), service_role 전체', async () => {
  const db = await world();
  try {
    const rid = (await as(db, 'authenticated', ACC1, () => db.query(`select rpc_reserve('${CLS}','${P1}') id`))).rows[0].id;
    assert.equal((await as(db, 'authenticated', ACC1, () => db.query(`select id from reservations`))).rows.length, 1);
    assert.equal((await as(db, 'authenticated', ACC2, () => db.query(`select id from reservations`))).rows.length, 0);
    assert.equal((await as(db, 'authenticated', MGR, () => db.query(`select id from reservations`))).rows.length, 1);               // 매니저 센터 예약 조회
    assert.equal((await as(db, 'authenticated', ACC1, () => db.query(`update reservations set member_memo='내 메모' where id='${rid}' returning id`))).rows.length, 1);
    assert.equal((await as(db, 'anon', null, () => db.query(`select * from class_reservation_counts`))).rows[0].confirmed_count, 1);   // anon 공개 인원수(view는 owner 권한이라 anon에게 테이블 SELECT가 없어도 동작)
    await as(db, 'authenticated', ACC1, () => db.query(`select rpc_cancel('${rid}')`));
    await as(db, 'service_role', null, async () => {
      await db.exec(`insert into reservations(id, class_id, profile_id, status) values ('${id(51)}','${CLS}','${P1}','confirmed')`);
      await db.exec(`update reservations set status='attended' where id='${id(51)}'`);
      await db.exec(`delete from reservations where id='${id(51)}'`);
      assert.equal((await db.query(`select count(*)::int c from reservations where id='${id(51)}'`)).rows[0].c, 0);
    });
  } finally { await db.close(); }
});

test('negative: authenticated DELETE(매니저 취소예약 정리 정책이 있어도)와 anon SELECT는 거부', async () => {
  const db = await world();
  try {
    const rid = (await as(db, 'authenticated', ACC1, () => db.query(`select rpc_reserve('${CLS}','${P1}') id`))).rows[0].id;
    await as(db, 'authenticated', ACC1, () => db.query(`select rpc_cancel('${rid}')`));      // cancelled → 예전에는 매니저가 DELETE 가능했던 상태
    await assert.rejects(as(db, 'authenticated', MGR, () => db.exec(`delete from reservations where id='${rid}'`)), /permission denied/);
    await assert.rejects(as(db, 'authenticated', ACC1, () => db.exec(`delete from reservations`)), /permission denied/);
    await assert.rejects(as(db, 'anon', null, () => db.query(`select id from reservations`)), /permission denied/);
    assert.equal((await db.query(`select count(*)::int c from reservations`)).rows[0].c, 1);   // 데이터 불변
    // 선행 migration이 회수한 권한도 계속 거부
    await assert.rejects(as(db, 'authenticated', ACC1, () => db.exec(`insert into reservations(class_id, profile_id, status) values ('${CLS}','${P1}','confirmed')`)), /permission denied/);
    await assert.rejects(as(db, 'authenticated', ACC1, () => db.exec(`update reservations set status='confirmed'`)), /permission denied/);
  } finally { await db.close(); }
});

test('권한 diff: 이번 migration의 회수 대상은 정확히 authenticated DELETE + anon SELECT, 나머지 불변, RLS 정책 4개 그대로', async () => {
  const before = await world({ apply: false });
  const after = await world();
  try {
    const snap = async db => (await db.query(`select grantee || ':' || privilege_type k from information_schema.role_table_grants where table_schema='public' and table_name='reservations' and grantee in ('anon','authenticated','service_role')`)).rows.map(r => r.k);
    const b = await snap(before), a = await snap(after);
    assert.deepEqual(b.filter(x => !a.includes(x)).sort(), ['anon:SELECT', 'authenticated:DELETE']);
    assert.deepEqual(a.filter(x => !b.includes(x)), []);
    for (const db of [before, after]) {
      assert.equal((await db.query(`select count(*)::int c from information_schema.column_privileges where table_name='reservations' and grantee='authenticated' and privilege_type='UPDATE' and column_name='member_memo'`)).rows[0].c, 1);
      assert.equal((await db.query(`select count(*)::int c from pg_policy where polrelid='reservations'::regclass`)).rows[0].c, 4);
    }
  } finally { await before.close(); await after.close(); }
});

test('verify: 적용 전 NOT_APPLIED → 적용 후 APPLIED, 단일 읽기 전용 SELECT, negative-control, rollback/재적용', async () => {
  assert.doesNotMatch(verify, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
  assert.match(verify.trim(), /^with\b/i);
  const pre = await world({ apply: false });
  try { assert.equal((await pre.query(verify)).rows[0].verdict, 'NOT_APPLIED'); } finally { await pre.close(); }
  const db = await world();
  try {
    const v = async () => (await db.query(verify)).rows[0];
    const r = await v(); assert.equal(r.verdict, 'APPLIED', JSON.stringify(r));
    for (const k of Object.keys(r).filter(k => k.endsWith('_ok'))) assert.equal(r[k], true, k);
    await db.exec(migration); assert.equal((await v()).verdict, 'APPLIED');
    for (const [brk, fix] of [
      [`grant delete on reservations to authenticated`, `revoke delete on reservations from authenticated`],
      [`grant select on reservations to anon`, `revoke select on reservations from anon`],
      [`grant insert on reservations to authenticated`, `revoke insert on reservations from authenticated`],
      [`grant update on reservations to authenticated`, `revoke update on reservations from authenticated; grant update (member_memo) on reservations to authenticated`],
      [`revoke select on reservations from authenticated`, `grant select on reservations to authenticated`],
      [`revoke delete on reservations from service_role`, `grant delete on reservations to service_role`],
      [`revoke update (member_memo) on reservations from authenticated`, `grant update (member_memo) on reservations to authenticated`],
      [`drop policy "본인 예약 메모 수정" on reservations`, `create policy "본인 예약 메모 수정" on reservations for update using (profile_id in (select my_profile_ids()))`],
      [`alter table reservations disable row level security`, `alter table reservations enable row level security`],
    ]) { await db.exec(brk); assert.equal((await v()).verdict, 'NOT_APPLIED', brk); await db.exec(fix); assert.equal((await v()).verdict, 'APPLIED', `원복 ${brk}`); }
    await db.exec(rollback); assert.equal((await v()).verdict, 'NOT_APPLIED');
    // rollback 후에도 행 접근은 RLS 범위(매니저 취소예약 정리 정책)로만 열린다
    const rid = (await as(db, 'authenticated', ACC1, () => db.query(`select rpc_reserve('${CLS}','${P1}') id`))).rows[0].id;
    await as(db, 'authenticated', ACC1, () => db.query(`select rpc_cancel('${rid}')`));
    assert.equal((await as(db, 'authenticated', ACC2, () => db.query(`delete from reservations where id='${rid}' returning id`))).rows.length, 0);
    assert.equal((await as(db, 'authenticated', MGR, () => db.query(`delete from reservations where id='${rid}' returning id`))).rows.length, 1);
    await db.exec(rollback);
    await db.exec(migration); assert.equal((await v()).verdict, 'APPLIED');
  } finally { await db.close(); }
});

test('정적 계약: 이 migration/rollback은 정확히 DELETE/anon SELECT만 다룬다(정책·함수·service_role 불변)', () => {
  const strip = s => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();
  const m = strip(migration), r = strip(rollback);
  assert.match(m, /^ ?begin; revoke delete on table public\.reservations from authenticated; revoke select on table public\.reservations from anon; commit; ?$/);
  assert.match(r, /^ ?begin; grant delete on table public\.reservations to authenticated; grant select on table public\.reservations to anon; commit; ?$/);
  assert.doesNotMatch(m, /service_role|policy|function|trigger|references/);
});
