// 격리 PostgreSQL(PGlite) — 스태프 초대 검색 개인정보 축소. 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/staff-account-search-privacy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('fix_staff_account_search_privacy_20261004.sql');
const rollback = read('rollback_fix_staff_account_search_privacy_20261004.sql');
const verify = read('verify_fix_staff_account_search_privacy_20261004.sql').replace(/^\s*--.*$/gm, '');
const memberSql = read('add_member_candidate_search_20261003.sql');
const krFn = memberSql.slice(memberSql.indexOf('create or replace function public.kr_phone_digits'), memberSql.indexOf('revoke all on function public.kr_phone_digits'));
const id = (k, n) => `${String(k).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C1 = id(1, 1), C2 = id(1, 2);
// 계정: 센터1 오너(O1: 권한 있음), 센터1 스태프(S1, 권한 없음), 센터1 회원(M1), 센터2 오너(O2), 센터 밖 가입자(X: 정확 번호로 찾는 대상), 병합/비활성/기존스태프(pending/suspended)
const A = { O1: id(2, 1), S1: id(2, 2), M1: id(2, 3), O2: id(2, 4), X: id(2, 5), MERGED: id(2, 6), DEACT: id(2, 7), PEND: id(2, 8), SUSP: id(2, 9), NOPERM_MGR: id(2, 10), LINKED: id(2, 11), STRANGER: id(2, 12) };
const AUTH = (n) => `auth-${n}`;

async function world({ apply = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema auth; create function auth.uid() returns text language sql stable as $$ select nullif(current_setting('app.auth_uid', true), '') $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    create table accounts(id uuid primary key, auth_id text unique, name text, phone text unique, merged_into uuid, deactivated_at timestamptz);
    create table account_auth_identities(account_id uuid, auth_id text);
    create table profiles(id uuid primary key default gen_random_uuid(), account_id uuid);
    create table center_members(center_id uuid, profile_id uuid);
    create table center_roles(id uuid primary key default gen_random_uuid(), center_id uuid, is_owner boolean default false);
    create table role_permissions(role_id uuid, permission_key text);
    create table manager_centers(id uuid primary key default gen_random_uuid(), account_id uuid not null, center_id uuid not null, role_id uuid, status text not null check (status in ('pending','active','suspended')), unique(account_id, center_id));
    grant select on accounts, account_auth_identities, profiles, center_members, center_roles, role_permissions, manager_centers to anon, authenticated;
    create function my_account_id() returns uuid language sql stable security definer set search_path = public as $$ select id from accounts where auth_id = auth.uid() $$;
    create function my_managed_center_ids() returns setof uuid language sql stable security definer set search_path = public as $$ select center_id from manager_centers where account_id = my_account_id() and status = 'active' $$;
    create function has_permission(p_center_id uuid, p_perm text) returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from manager_centers mc join center_roles r on r.id = mc.role_id where mc.account_id = my_account_id() and mc.center_id = p_center_id and mc.status = 'active'
                       and (r.is_owner or exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_key = p_perm))) $$;
    ${krFn}
    alter table accounts enable row level security;
    insert into accounts values
      ('${A.O1}','${AUTH('o1')}','센터1오너','01011110001',null,null), ('${A.S1}','${AUTH('s1')}','센터1스태프','01011110002',null,null), ('${A.M1}','${AUTH('m1')}','센터1회원','01011110003',null,null),
      ('${A.O2}','${AUTH('o2')}','센터2오너','01022220001',null,null), ('${A.X}','${AUTH('x')}','손지윤','01023265051',null,null),
      ('${A.MERGED}','${AUTH('merged')}','병합된계정','01033330001','${A.X}',null), ('${A.DEACT}','${AUTH('deact')}','탈퇴계정','01033330002',null,now()),
      ('${A.PEND}','${AUTH('pend')}','대기스태프','01044440001',null,null), ('${A.SUSP}','${AUTH('susp')}','정지스태프','01044440002',null,null),
      ('${A.NOPERM_MGR}','${AUTH('np')}','권한없는매니저','01055550001',null,null), ('${A.LINKED}','${AUTH('linked-orig')}','연동원계정','01066660001',null,null), ('${A.STRANGER}','${AUTH('stranger')}','무관한사람','01077770001',null,null);
    insert into account_auth_identities values ('${A.LINKED}','${AUTH('o1')}');   -- O1이 로그인한 auth가 연동 계정(LINKED)의 identity이기도 하다
    insert into profiles(id, account_id) values ('${id(3, 1)}','${A.M1}');
    insert into center_members values ('${C1}','${id(3, 1)}');
  `);
  const r1 = id(4, 1), r2 = id(4, 2), r3 = id(4, 3), r4 = id(4, 4);
  await db.exec(`
    insert into center_roles(id, center_id, is_owner) values ('${r1}','${C1}',true), ('${r2}','${C1}',false), ('${r3}','${C2}',true), ('${r4}','${C1}',false);
    insert into role_permissions values ('${r4}','facility.staff.create'), ('${r2}','customer.member.view');
    insert into manager_centers(account_id, center_id, role_id, status) values
      ('${A.O1}','${C1}','${r1}','active'), ('${A.S1}','${C1}','${r2}','active'), ('${A.NOPERM_MGR}','${C1}','${r2}','active'),
      ('${A.O2}','${C2}','${r3}','active'), ('${A.PEND}','${C1}','${r2}','pending'), ('${A.SUSP}','${C1}','${r2}','suspended');
  `);
  // 수정 전 상태 = rollback(직전 Production 정책 + RPC 없음). 그 위에 migration 적용.
  await db.exec(rollback);
  await db.exec(`grant select on accounts to anon, authenticated;`);
  if (apply) await db.exec(migration);
  return db;
}
const as = async (db, role, authUid, fn) => { await db.exec(`set role ${role}; select set_config('app.auth_uid','${authUid ?? ''}', false);`); try { return await fn(); } finally { await db.exec(`reset role; select set_config('app.auth_uid','',false);`); } };
const visible = async (db, who) => (await as(db, 'authenticated', AUTH(who), () => db.query('select id from accounts order by id'))).rows.map(r => r.id);
const search = (db, who, center, phone) => as(db, 'authenticated', who === null ? null : AUTH(who), async () => (await db.query(`select * from search_staff_candidates(${center ? `'${center}'` : 'null'}, ${phone === null ? 'null' : `$q$${phone}$q$`})`)).rows);

test('accounts RLS: 수정 전에는 owner/staff.create가 accounts 전체를 볼 수 있었고(문제), 수정 후에는 본인·연동·내 센터 스태프·내 센터 회원만', async () => {
  const before = await world({ apply: false });
  try {
    assert.equal((await visible(before, 'o1')).length, 12);                  // 오너라는 이유만으로 전체 12개
    assert.equal((await visible(before, 'o2')).length, 12);                  // 다른 센터 오너도 전체
    assert.ok((await visible(before, 'np')).length < 12);                    // staff.create 없는 매니저는 관계 기반(수정 전에도)
  } finally { await before.close(); }
  const after = await world();
  try {
    const o1 = await visible(after, 'o1');
    assert.deepEqual(o1.sort(), [A.O1, A.S1, A.M1, A.NOPERM_MGR, A.PEND, A.SUSP, A.LINKED].sort());   // 본인 + 연동 + 스태프(전 상태) + 회원
    assert.ok(!o1.includes(A.X) && !o1.includes(A.STRANGER) && !o1.includes(A.O2));                   // 센터와 무관한 계정은 안 보임
    assert.deepEqual((await visible(after, 'o2')).sort(), [A.O2].sort());                            // 다른 센터 오너는 자기 자신만
    const np = await visible(after, 'np'); assert.ok(np.includes(A.O1) && np.includes(A.M1) && !np.includes(A.X));   // 관계 기반은 그대로(권한 없는 매니저도 같은 센터 스태프/회원)
    assert.equal((await visible(after, 's1')).includes(A.X), false);
    assert.equal((await as(after, 'anon', null, () => after.query('select id from accounts'))).rows.length, 0);
  } finally { await after.close(); }
});

test('RPC: 해당 센터 staff.create 권한자가 정확한 전체 번호로 검색 — 형식 달라도 1명, 마스킹된 번호만, 이름/번호 일부/짧은 입력은 결과 없음', async () => {
  const db = await world();
  try {
    for (const q of ['01023265051', '010-2326-5051', ' 010 2326 5051 ', '+82 10-2326-5051', '+82-010-2326-5051', '821023265051']) {
      const r = await search(db, 'o1', C1, q);
      assert.equal(r.length, 1, q);
      assert.deepEqual([r[0].account_id, r[0].name, r[0].phone, r[0].already_staff, r[0].staff_status], [A.X, '손지윤', '010-****-5051', false, null], q);
      assert.ok(!JSON.stringify(r[0]).includes('23265051'));                // 전체 번호 미노출
      assert.deepEqual(Object.keys(r[0]).sort(), ['account_id', 'already_staff', 'name', 'phone', 'staff_status']);
    }
    for (const q of ['손지윤', '지윤', '5051', '2326', '010-2326', '010232650', '01023265', '010', 'someone@example.com', '%', '_', '', '   ']) assert.equal((await search(db, 'o1', C1, q)).length, 0, `부분/이름/짧은 입력: ${JSON.stringify(q)}`);
    assert.equal((await search(db, 'o1', C1, '01099999999')).length, 0);   // 없는 번호
    assert.equal((await search(db, 'o1', C1, null)).length, 0);
    // staff.create 권한이 role_permissions로 부여된 비-오너(r4)도 가능(권한 모델은 has_permission 그대로)
  } finally { await db.close(); }
});

test('RPC 권한: 이 센터 권한 없음/다른 센터 오너/권한 없는 매니저/로그인 없음/NULL 센터는 거부, anon은 실행 불가', async () => {
  const db = await world();
  try {
    await assert.rejects(search(db, 'o2', C1, '01023265051'), /스태프를 추가할 권한이 없어요/);        // 다른 센터의 오너(그 센터 권한 없음)
    await assert.rejects(search(db, 'np', C1, '01023265051'), /스태프를 추가할 권한이 없어요/);        // 같은 센터지만 staff.create 없는 매니저
    await assert.rejects(search(db, 's1', C1, '01023265051'), /스태프를 추가할 권한이 없어요/);
    await assert.rejects(search(db, 'stranger', C1, '01023265051'), /스태프를 추가할 권한이 없어요/);   // 센터와 무관한 사용자
    await assert.rejects(search(db, 'o1', C2, '01023265051'), /스태프를 추가할 권한이 없어요/);        // 오너여도 다른 센터 id로는 불가
    await assert.rejects(search(db, 'o1', null, '01023265051'), /스태프를 추가할 권한이 없어요/);
    await assert.rejects(search(db, null, C1, '01023265051'), /로그인이 필요해요/);
    await assert.rejects(as(db, 'anon', null, () => db.query(`select * from search_staff_candidates('${C1}','01023265051')`)), /permission denied/);
  } finally { await db.close(); }
});

test('already_staff: 이 센터의 active/pending/suspended 스태프는 구분되어 반환, 다른 센터 스태프는 아님, 병합/비활성 계정은 제외', async () => {
  const db = await world();
  try {
    for (const [phone, who, status] of [['01011110002', A.S1, 'active'], ['01044440001', A.PEND, 'pending'], ['01044440002', A.SUSP, 'suspended'], ['01011110001', A.O1, 'active']]) {
      const r = await search(db, 'o1', C1, phone);
      assert.deepEqual([r[0].account_id, r[0].already_staff, r[0].staff_status], [who, true, status], phone);
    }
    assert.deepEqual((await search(db, 'o1', C1, '01022220001')).map(r => [r.account_id, r.already_staff]), [[A.O2, false]]);   // 다른 센터의 스태프는 이 센터 기준으로는 신규 후보
    assert.equal((await search(db, 'o1', C1, '01033330001')).length, 0);   // 병합된 계정
    assert.equal((await search(db, 'o1', C1, '01033330002')).length, 0);   // 비활성/탈퇴 계정
  } finally { await db.close(); }
});

test('같은 번호로 정규화되는 계정이 여럿이면 임의로 고르지 않고 거부(데이터 이상 방어)', async () => {
  const db = await world();
  try {
    await db.exec(`insert into accounts(id, auth_id, name, phone) values ('${id(2, 99)}','dup','중복','010-2326-5051')`);   // 원본 phone unique 제약은 통과하지만 정규화하면 X와 같은 번호
    await assert.rejects(search(db, 'o1', C1, '01023265051'), /같은 번호로 가입한 계정이 여러 개예요/);
  } finally { await db.close(); }
});

test('함수/정책 보안 계약 + 재실행 안전 + rollback(광범위 정책 복구) + verify 왕복/포맷 변형/조건 제거 시 NOT_APPLIED', async () => {
  const body = migration.replace(/--.*$/gm, '');
  assert.match(body, /security definer\s+set search_path = public/);
  assert.match(body, /revoke all on function public\.search_staff_candidates\(uuid, text\) from public, anon;/);
  assert.match(body, /grant execute on function public\.search_staff_candidates\(uuid, text\) to authenticated;/);
  assert.doesNotMatch(body.slice(body.indexOf('create or replace function'), body.indexOf('revoke all on function')), /\bi?like\b/i);
  assert.ok(body.indexOf("has_permission(p_center_id, 'facility.staff.create')") < body.indexOf('return query'));
  assert.doesNotMatch(body.slice(body.indexOf('create policy')), /facility\.staff\.create|is_owner|role_permissions|center_roles/);
  assert.match(body, /begin;[\s\S]*commit;/);
  const db = await world();
  try {
    const v = async () => (await db.query(verify)).rows[0];
    let r = await v(); assert.equal(r.verdict, 'APPLIED');
    for (const k of Object.keys(r).filter(k => k.endsWith('_ok'))) assert.equal(r[k], true, k);
    await db.exec(migration);                                                    // idempotent
    assert.equal((await v()).verdict, 'APPLIED');
    await db.exec(`grant execute on function search_staff_candidates(uuid, text) to anon`); assert.equal((await v()).verdict, 'NOT_APPLIED');
    await db.exec(`revoke execute on function search_staff_candidates(uuid, text) from anon`); assert.equal((await v()).verdict, 'APPLIED');
    // 광범위 절을 되살리면 NOT_APPLIED
    await db.exec(`drop policy "계정 조회" on accounts; create policy "계정 조회" on accounts for select using (auth_id = auth.uid() or id in (select account_id from account_auth_identities where auth_id = auth.uid()) or id in (select mc.account_id from manager_centers mc where mc.center_id in (select my_managed_center_ids())) or id in (select p.account_id from profiles p join center_members cm on cm.profile_id = p.id where cm.center_id in (select my_managed_center_ids())) or exists (select 1 from manager_centers mc join center_roles r on r.id = mc.role_id where mc.account_id = my_account_id() and mc.status = 'active' and r.is_owner = true))`);
    r = await v(); assert.equal(r.verdict, 'NOT_APPLIED'); assert.equal(r.policy_global_staff_clause_removed_ok, false);
    // 관계 절을 지우면(회원 절 누락) NOT_APPLIED
    await db.exec(`drop policy "계정 조회" on accounts; create policy "계정 조회" on accounts for select using (auth_id = auth.uid())`);
    r = await v(); assert.equal(r.verdict, 'NOT_APPLIED'); assert.equal(r.relation_managed_staff_kept_ok, false);
    await db.exec(migration); assert.equal((await v()).verdict, 'APPLIED');
    // rollback: 직전(광범위) 상태 복원 — 오너가 다시 전체 accounts를 볼 수 있다, RPC 제거, verify NOT_APPLIED
    await db.exec(rollback);
    assert.equal((await v()).verdict, 'NOT_APPLIED');
    assert.equal((await visible(db, 'o1')).length, 12);
    assert.equal((await db.query(`select count(*)::int c from pg_proc where proname='search_staff_candidates'`)).rows[0].c, 0);
    await db.exec(rollback); await db.exec(migration); assert.equal((await v()).verdict, 'APPLIED');
    assert.doesNotMatch(verify, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
    assert.match(verify.trim(), /^with\b/i);
  } finally { await db.close(); }
  // formatting-safe: CRLF / 들여쓰기 / 주석 없음
  const crlf = s => s.replace(/\r?\n/g, '\r\n');
  const reindent = s => s.split('\n').map((l, i) => (i % 2 ? '\t  ' : '    ') + l.trim().replace(/[ \t]{2,}/g, ' ')).join('\n');
  const noComments = s => s.split('\n').map(l => l.replace(/\s*--.*$/, '')).join('\n');
  for (const tf of [crlf, reindent, noComments, s => noComments(crlf(reindent(s)))]) {
    const d = await world({ apply: false });
    try { await d.exec(tf(migration)); assert.equal((await d.query(verify)).rows[0].verdict, 'APPLIED'); } finally { await d.close(); }
  }
});

// ---- 번호 열거 rate limit(전체 번호 exact-search 시도 단위, 서버 강제) ----
const PH = '010-2326-5051';
const TOO_MANY = /검색 요청이 너무 많아요/;
const attempts = async (db, where = 'true') => (await db.query(`select count(*)::int c from staff_candidate_search_attempts where ${where}`)).rows[0].c;
const exhaust = async (db, who = 'o1', center = C1, n = 30) => { for (let i = 0; i < n; i++) await search(db, who, center, PH); };

test('rate limit 경계: 30번째까지 성공, 31번째는 generic 오류이며 기록되지 않는다(결과 유무와 무관하게 전체 번호 시도를 센다)', async () => {
  const db = await world();
  try {
    for (let i = 1; i <= 30; i++) assert.equal((await search(db, 'o1', C1, i % 2 ? PH : '01077779999')).length, i % 2 ? 1 : 0, 'call ' + i);   // 결과가 없는 번호도 센다
    assert.equal(await attempts(db), 30);
    await assert.rejects(search(db, 'o1', C1, PH), e => TOO_MANY.test(e.message) && !/손지윤|5051/.test(e.message));
    assert.equal(await attempts(db), 30);
  } finally { await db.close(); }
});

test('10분 window 이후 재허용, 24시간 200회 boundary(센터를 가로질러), 25시간 후 재허용', async () => {
  const db = await world();
  try {
    await exhaust(db);
    await assert.rejects(search(db, 'o1', C1, PH), TOO_MANY);
    await db.exec(`update staff_candidate_search_attempts set created_at = now() - interval '11 minutes'`);
    assert.equal((await search(db, 'o1', C1, PH)).length, 1);
    await db.exec(`delete from staff_candidate_search_attempts; insert into staff_candidate_search_attempts(caller_account_id, center_id, created_at) select '${A.O1}', '${C2}', now() - interval '2 hours' from generate_series(1, 199)`);
    assert.equal((await search(db, 'o1', C1, PH)).length, 1);                          // 199 + 1 = 200번째는 허용
    await assert.rejects(search(db, 'o1', C1, PH), TOO_MANY);                          // 201번째 거부
    await db.exec(`update staff_candidate_search_attempts set created_at = now() - interval '25 hours'`);
    assert.equal((await search(db, 'o1', C1, PH)).length, 1);
  } finally { await db.close(); }
});

test('다른 caller 격리 + 다른 센터의 시도는 이 센터 10분 한도에 포함되지 않음', async () => {
  const db = await world();
  try {
    await exhaust(db);
    await assert.rejects(search(db, 'o1', C1, PH), TOO_MANY);
    assert.equal((await search(db, 'o2', C2, PH)).length, 1);                          // 다른 계정/센터는 영향 없음
    await db.exec(`delete from staff_candidate_search_attempts; insert into staff_candidate_search_attempts(caller_account_id, center_id) select '${A.O1}', '${C2}' from generate_series(1, 30)`);
    assert.equal((await search(db, 'o1', C1, PH)).length, 1);                          // C2에서 30회 썼어도 C1은 허용
  } finally { await db.close(); }
});

test('권한 없는 요청/anon은 시도를 소모하지 않고 한도 오류 대신 권한 오류만 낸다', async () => {
  const db = await world();
  try {
    await db.exec(`insert into staff_candidate_search_attempts(caller_account_id, center_id) select '${A.NOPERM_MGR}', '${C1}' from generate_series(1, 300)`);
    const before = await attempts(db);
    for (const [who, center] of [['np', C1], ['o2', C1], ['o1', C2], ['stranger', C1], ['o1', null]]) await assert.rejects(search(db, who, center, PH), e => /권한/.test(e.message) && !TOO_MANY.test(e.message), `${who}/${center}`);
    await assert.rejects(as(db, 'anon', null, () => db.query(`select * from search_staff_candidates('${C1}','${PH}')`)), /permission denied/);
    assert.equal(await attempts(db), before);
    // 형식이 완전하지 않은 입력은 검색하지 않으므로 세지 않는다
    await search(db, 'o1', C1, '손지'); await search(db, 'o1', C1, '0102326'); assert.equal(await attempts(db, `caller_account_id='${A.O1}'`), 0);
  } finally { await db.close(); }
});

test('시도 기록에는 번호/검색어가 저장되지 않고(컬럼 3개), client는 테이블에 접근할 수 없다 + advisory lock 설계', async () => {
  const db = await world();
  try {
    await search(db, 'o1', C1, PH);
    const cols = (await db.query(`select column_name from information_schema.columns where table_name='staff_candidate_search_attempts' order by 1`)).rows.map(r => r.column_name);
    assert.deepEqual(cols, ['caller_account_id', 'center_id', 'created_at', 'id']);
    const dump = JSON.stringify((await db.query(`select * from staff_candidate_search_attempts`)).rows);
    assert.doesNotMatch(dump, /2326|5051|손지윤/);
    for (const role of ['anon', 'authenticated']) await assert.rejects(as(db, role, AUTH('o1'), () => db.query('select * from staff_candidate_search_attempts')), /permission denied/);
    await assert.rejects(as(db, 'authenticated', AUTH('o1'), () => db.query(`delete from staff_candidate_search_attempts`)), /permission denied/);
    const def = (await db.query(`select pg_get_functiondef(oid) d, provolatile v from pg_proc where proname='search_staff_candidates'`)).rows[0];
    assert.equal(def.v, 'v');
    assert.match(def.d, /pg_advisory_xact_lock/);
    assert.ok(def.d.indexOf("has_permission(p_center_id, 'facility.staff.create')") < def.d.indexOf('staff_candidate_search_attempts'));
  } finally { await db.close(); }
});

test('rollback은 시도 테이블도 제거하고 verify는 NOT_APPLIED, 재적용하면 APPLIED(테이블 없으면 NOT_APPLIED)', async () => {
  const db = await world();
  try {
    const v = async () => (await db.query(verify)).rows[0];
    assert.equal((await v()).verdict, 'APPLIED');
    await db.exec(`drop table staff_candidate_search_attempts`);
    assert.equal((await v()).verdict, 'NOT_APPLIED');
    await db.exec(migration); assert.equal((await v()).verdict, 'APPLIED');
    await db.exec(rollback);
    assert.equal((await db.query(`select count(*)::int c from pg_tables where tablename='staff_candidate_search_attempts'`)).rows[0].c, 0);
    assert.equal((await v()).verdict, 'NOT_APPLIED');
  } finally { await db.close(); }
});
