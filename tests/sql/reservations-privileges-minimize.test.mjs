// 격리 PostgreSQL(PGlite) — reservations 권한 최소화(Batch D). 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/reservations-privileges-minimize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('fix_reservations_privileges_minimize_20261003.sql');
const rollback = read('rollback_fix_reservations_privileges_minimize_20261003.sql');
const verify = read('verify_reservations_privileges_minimize_20261003.sql').replace(/--.*$/gm, '');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ACC1 = id(11), ACC2 = id(12), MGR = id(13), P1 = id(21), P2 = id(22), CLS = id(31), CENTER = id(41);

// "예약 무결성 SQL 적용 후" Production 상태를 그대로 만든다(authenticated: select/insert/delete/references/trigger + member_memo update, anon: select/references/trigger, service_role: select/insert/update/delete)
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
  if (apply) await db.exec(migration);
  return db;
}
const as = async (db, role, acc, fn) => { await db.exec(`set role ${role}; select set_config('app.account_id','${acc ?? ''}', false);`); try { return await fn(); } finally { await db.exec(`reset role; select set_config('app.account_id','',false);`); } };

test('positive: 회수 후에도 정상 경로 유지 — 예약/취소 RPC(SECURITY DEFINER), 본인 조회, member_memo UPDATE, 매니저 취소예약 정리(DELETE), 공개 인원수 view, service_role 전체', async () => {
  const db = await world();
  try {
    const rid = (await as(db, 'authenticated', ACC1, () => db.query(`select rpc_reserve('${CLS}','${P1}') id`))).rows[0].id;      // 호출자에게 INSERT 권한이 없어도 RPC로 예약 생성
    assert.equal((await as(db, 'authenticated', ACC1, () => db.query(`select id from reservations`))).rows.length, 1);              // 본인 예약 조회(RLS)
    assert.equal((await as(db, 'authenticated', ACC2, () => db.query(`select id from reservations`))).rows.length, 0);              // 남의 예약은 안 보임
    assert.equal((await as(db, 'authenticated', ACC1, () => db.query(`update reservations set member_memo='내 메모' where id='${rid}' returning id`))).rows.length, 1);
    assert.equal((await as(db, 'anon', null, () => db.query(`select * from class_reservation_counts`))).rows[0].confirmed_count, 1);   // anon 공개 인원수(view, owner 권한)
    assert.equal((await as(db, 'anon', null, () => db.query(`select id from reservations`))).rows.length, 0);                        // anon SELECT는 유지되지만 RLS가 0행
    await as(db, 'authenticated', ACC1, () => db.query(`select rpc_cancel('${rid}')`));                                              // 취소 RPC
    assert.equal((await as(db, 'authenticated', MGR, () => db.query(`delete from reservations where id='${rid}' returning id`))).rows.length, 1);   // 매니저의 취소예약 정리(RLS 정책 + DELETE 권한 유지)
    await as(db, 'service_role', null, async () => {
      await db.exec(`insert into reservations(id, class_id, profile_id, status) values ('${id(51)}','${CLS}','${P1}','confirmed')`);
      await db.exec(`update reservations set status='attended' where id='${id(51)}'`);
      assert.equal((await db.query(`select status from reservations where id='${id(51)}'`)).rows[0].status, 'attended');
      await db.exec(`delete from reservations where id='${id(51)}'`);
    });
    // FK 검증은 owner 권한 — 호출자에게 REFERENCES 없이도 참조 테이블 INSERT 가능(참조 테이블 쪽 권한만 필요)
    await db.exec(`insert into reservations(id, class_id, profile_id, status) values ('${id(52)}','${CLS}','${P1}','confirmed')`);
    await db.exec(`insert into reservation_goods_usages(reservation_id) values ('${id(52)}')`);
  } finally { await db.close(); }
});

test('negative: 회수한 권한은 실제로 거부 — authenticated INSERT, anon/authenticated 직접 UPDATE/DELETE/TRUNCATE, 다른 컬럼 UPDATE, 남의 행 DELETE, 정책이 실수로 추가돼도 INSERT 불가', async () => {
  const db = await world();
  try {
    const rid = (await as(db, 'authenticated', ACC1, () => db.query(`select rpc_reserve('${CLS}','${P1}') id`))).rows[0].id;
    await assert.rejects(as(db, 'authenticated', ACC1, () => db.exec(`insert into reservations(class_id, profile_id, status) values ('${CLS}','${P1}','confirmed')`)), /permission denied/);
    // INSERT RLS 정책이 (실수로) 생겨도 권한이 없어 여전히 거부
    await db.exec(`create policy "실수로 만든 INSERT" on reservations for insert with check (true)`);
    await assert.rejects(as(db, 'authenticated', ACC1, () => db.exec(`insert into reservations(class_id, profile_id, status) values ('${CLS}','${P1}','confirmed')`)), /permission denied/);
    await db.exec(`drop policy "실수로 만든 INSERT" on reservations`);
    for (const sql of [`update reservations set status='confirmed'`, `update reservations set class_id='${CLS}'`, `delete from reservations`, `truncate reservations`]) {
      await assert.rejects(as(db, 'anon', null, () => db.exec(sql)), /permission denied/, `anon ${sql}`);
    }
    for (const sql of [`update reservations set status='cancelled'`, `update reservations set membership_id=null`, `truncate reservations`]) {
      await assert.rejects(as(db, 'authenticated', ACC1, () => db.exec(sql)), /permission denied/, `auth ${sql}`);
    }
    // 매니저가 아닌 회원은 정책상 DELETE 0행(상태가 cancelled여도 남의 센터)
    await as(db, 'authenticated', ACC1, () => db.query(`select rpc_cancel('${rid}')`));
    assert.equal((await as(db, 'authenticated', ACC2, () => db.query(`delete from reservations where id='${rid}' returning id`))).rows.length, 0);
    assert.equal((await db.query(`select count(*)::int c from reservations`)).rows[0].c, 1);
    // 이 migration은 RLS 정책을 건드리지 않는다
    assert.equal((await db.query(`select count(*)::int c from pg_policy where polrelid='reservations'::regclass`)).rows[0].c, 4);
  } finally { await db.close(); }
});

test('권한 diff: 회수 대상은 정확히 authenticated INSERT + anon/authenticated REFERENCES·TRIGGER, 나머지(SELECT/DELETE/member_memo/service_role)는 불변', async () => {
  const before = await world({ apply: false });
  const after = await world();
  try {
    const snap = async db => (await db.query(`select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='reservations' and grantee in ('anon','authenticated','service_role') order by 1,2`)).rows.map(r => `${r.grantee}:${r.privilege_type}`);
    const b = await snap(before), a = await snap(after);
    assert.deepEqual(b.filter(x => !a.includes(x)).sort(), ['anon:REFERENCES', 'anon:TRIGGER', 'authenticated:INSERT', 'authenticated:REFERENCES', 'authenticated:TRIGGER']);
    assert.deepEqual(a.filter(x => !b.includes(x)), []);
    for (const db of [before, after]) assert.equal((await db.query(`select count(*)::int c from information_schema.column_privileges where table_name='reservations' and grantee='authenticated' and privilege_type='UPDATE' and column_name='member_memo'`)).rows[0].c, 1);
  } finally { await before.close(); await after.close(); }
});

test('verify 왕복 + 단일 읽기 전용 SELECT, negative-control(권한을 다시 열면 NOT_APPLIED, 유지 권한을 지우면 NOT_APPLIED), rollback/재적용 idempotent', async () => {
  assert.doesNotMatch(verify, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
  assert.match(verify.trim(), /^with\b/i);
  const db = await world();
  try {
    const v = async () => (await db.query(verify)).rows[0];
    let r = await v(); assert.equal(r.verdict, 'APPLIED');
    for (const k of Object.keys(r).filter(k => k.endsWith('_ok'))) assert.equal(r[k], true, k);
    await db.exec(migration); assert.equal((await v()).verdict, 'APPLIED');
    for (const [brk, fix] of [
      [`grant insert on reservations to authenticated`, `revoke insert on reservations from authenticated`],
      [`grant references on reservations to authenticated`, `revoke references on reservations from authenticated`],
      [`grant trigger on reservations to anon`, `revoke trigger on reservations from anon`],
      [`grant update on reservations to authenticated`, `revoke update on reservations from authenticated; grant update (member_memo) on reservations to authenticated`],
      [`revoke delete on reservations from authenticated`, `grant delete on reservations to authenticated`],
      [`revoke select on reservations from authenticated`, `grant select on reservations to authenticated`],
      [`revoke insert on reservations from service_role`, `grant insert on reservations to service_role`],
      [`revoke update on reservations from service_role`, `grant update on reservations to service_role`],
      [`drop policy "내 프로필 예약 조회" on reservations`, `create policy "내 프로필 예약 조회" on reservations for select using (profile_id in (select my_profile_ids()))`],
      [`alter table reservations disable row level security`, `alter table reservations enable row level security`],
    ]) { await db.exec(brk); assert.equal((await v()).verdict, 'NOT_APPLIED', brk); await db.exec(fix); assert.equal((await v()).verdict, 'APPLIED', `원복 ${brk}`); }
    await db.exec(rollback); assert.equal((await v()).verdict, 'NOT_APPLIED');
    await db.exec(rollback);
    await db.exec(migration); assert.equal((await v()).verdict, 'APPLIED');
  } finally { await db.close(); }
});

test('정적 계약: 이 migration은 REVOKE만(GRANT/정책/함수 변경 없음), service_role/owner/DELETE/SELECT는 건드리지 않음', () => {
  const sql = migration.replace(/--.*$/gm, '');
  assert.match(sql, /begin;[\s\S]*commit;/);
  assert.doesNotMatch(sql, /\bgrant\b|create policy|drop policy|alter policy|create (or replace )?function|alter table/i);
  assert.ok(!/service_role|postgres/.test(sql));
  assert.doesNotMatch(sql, /revoke[^;]*\b(select|delete|update|truncate)\b/i);
});
