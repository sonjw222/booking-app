// 격리 PostgreSQL(PGlite) — 회원 추가 "전체 번호 exact-search 시도" rate limit(외부 매칭 여부와 무관하게 전체 번호 시도 자체를 센다). 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/member-candidate-rate-limit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const base = read('add_member_candidate_search_20261003.sql');
const migration = read('fix_member_candidate_search_rate_limit_20261004.sql');
const rollback = read('rollback_fix_member_candidate_search_rate_limit_20261004.sql');
const verify = read('verify_member_candidate_search_rate_limit_20261004.sql');
const code = s => s.replace(/^\s*--.*$/gm, '');
const id = (k, n) => `${String(k).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C1 = id(1, 1), C2 = id(1, 2);
const MGR1 = id(2, 1), MGR2 = id(2, 2), NOPERM = id(2, 3), NOPHONE = id(2, 5), PLATFORM = id(2, 6);
const ACC_MEMBER = id(3, 1), ACC_OUT = id(3, 2), ACC_MERGED = id(3, 3), ACC_DEACT = id(3, 4), ACC_OTHERCENTER = id(3, 5);
const TOO_MANY = /검색 요청이 너무 많아요/;
async function world({ apply = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    grant usage on schema public to anon, authenticated;
    create function my_account_id() returns uuid language sql stable as $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;
    create table accounts(id uuid primary key, name text, phone text, merged_into uuid, deactivated_at timestamptz);
    create table profiles(id uuid primary key default gen_random_uuid(), account_id uuid, name text, is_primary boolean default true, deleted_at timestamptz);
    create table center_members(center_id uuid, profile_id uuid);
    create table perms(account_id uuid, center_id uuid, perm text);
    create function is_platform_admin() returns boolean language sql stable as $$ select my_account_id() = '${PLATFORM}'::uuid $$;
    create function has_permission(p_center_id uuid, p_permission text) returns boolean language sql stable as $$ select exists (select 1 from perms where account_id = my_account_id() and center_id = p_center_id and perm = p_permission) $$;
    -- Production에 이미 있는 전역 부분일치 RPC(회수 대상)
    create function search_accounts_for_member(p_keyword text) returns table(profile_id uuid, name text, phone text) language sql security definer set search_path = public as $$ select p.id, p.name, a.phone from profiles p join accounts a on a.id = p.account_id where p.name ilike '%' || p_keyword || '%' $$;
    revoke all on function search_accounts_for_member(text) from public, anon; grant execute on function search_accounts_for_member(text) to authenticated;
    insert into accounts values ('${ACC_MEMBER}','김센터회원','01011112222',null,null), ('${ACC_OUT}','홍길동','01012345678',null,null), ('${ACC_MERGED}','병합된계정','01099990001','${ACC_OUT}',null),
      ('${ACC_DEACT}','비활성계정','01099990002',null,now()), ('${ACC_OTHERCENTER}','다른센터회원','01055556666',null,null);
    insert into profiles(id, account_id, name) values ('${id(4, 1)}','${ACC_MEMBER}','김센터회원'), ('${id(4, 2)}','${ACC_OUT}','홍길동'), ('${id(4, 3)}','${ACC_MERGED}','병합된계정'),
      ('${id(4, 4)}','${ACC_DEACT}','비활성계정'), ('${id(4, 5)}','${ACC_OTHERCENTER}','다른센터회원');
    insert into accounts values ('${id(3, 11)}','저장형식A','010-3000-0001',null,null), ('${id(3, 12)}','저장형식B','+82 10-3000-0002',null,null), ('${id(3, 13)}','저장형식C','+82-010-3000-0003',null,null), ('${id(3, 14)}','저장형식D','821030000004',null,null), ('${id(3, 15)}','저장형식E',' 010 3000 0005 ',null,null);
    insert into profiles(id, account_id, name) values ('${id(4, 11)}','${id(3, 11)}','저장형식A'), ('${id(4, 12)}','${id(3, 12)}','저장형식B'), ('${id(4, 13)}','${id(3, 13)}','저장형식C'), ('${id(4, 14)}','${id(3, 14)}','저장형식D'), ('${id(4, 15)}','${id(3, 15)}','저장형식E');
    insert into profiles(id, account_id, name, deleted_at) values ('${id(4, 6)}','${ACC_OUT}','삭제된프로필', now());
    insert into center_members values ('${C1}','${id(4, 1)}'), ('${C2}','${id(4, 5)}');
    insert into perms values ('${MGR1}','${C1}','customer.member.create'), ('${MGR1}','${C1}','customer.member.phone'), ('${MGR2}','${C2}','customer.member.create'), ('${MGR2}','${C2}','customer.member.phone'), ('${NOPERM}','${C1}','customer.member.view'),
      ('${NOPHONE}','${C1}','customer.member.create'), ('${PLATFORM}','${C1}','customer.member.create');
  `);
  await db.exec(base);
  if (apply) await db.exec(migration);
  return db;
}
const as = async (db, role, acc, fn) => { await db.exec(`set role ${role}; select set_config('app.account_id','${acc ?? ''}', false);`); try { return await fn(); } finally { await db.exec(`reset role; select set_config('app.account_id','',false);`); } };
const search = (db, acc, center, kw) => as(db, 'authenticated', acc, async () => (await db.query(`select * from search_member_candidates(${center ? `'${center}'` : 'null'}, $q$${kw}$q$)`)).rows);
const EXACT = '010-1234-5678';
const attempts = async (db, where = 'true') => (await db.query(`select count(*)::int c from member_candidate_search_attempts where ${where}`)).rows[0].c;
const exhaust = async (db, n = 30) => { for (let i = 0; i < n; i++) await search(db, MGR1, C1, EXACT); };

test('한도 미만/경계: 30번째까지 성공(결과 정상), 31번째는 generic 오류, 거부된 호출은 기록되지 않는다', async () => {
  const db = await world();
  try {
    for (let i = 1; i <= 30; i++) {
      const r = await search(db, MGR1, C1, i % 2 ? EXACT : '01012345678');
      assert.deepEqual(r.map(x => [x.name, x.phone, x.already_member]), [['홍길동', '010-****-5678', false]], 'call ' + i);
    }
    assert.equal(await attempts(db), 30);
    await assert.rejects(search(db, MGR1, C1, EXACT), e => TOO_MANY.test(e.message) && !/01012345678|홍길동|1234/.test(e.message));
    assert.equal(await attempts(db), 30);
  } finally { await db.close(); }
});

test('시간 window(10분)가 지나면 다시 허용된다', async () => {
  const db = await world();
  try {
    await exhaust(db);
    await assert.rejects(search(db, MGR1, C1, EXACT), TOO_MANY);
    await db.exec(`update member_candidate_search_attempts set created_at = now() - interval '11 minutes'`);
    assert.equal((await search(db, MGR1, C1, EXACT)).length, 1);
  } finally { await db.close(); }
});

test('다른 호출 계정은 영향을 받지 않는다', async () => {
  const db = await world();
  try {
    await exhaust(db);
    await assert.rejects(search(db, MGR1, C1, EXACT), TOO_MANY);
    assert.equal((await search(db, NOPHONE, C1, EXACT)).length, 1);
    assert.equal((await search(db, PLATFORM, C1, EXACT)).length, 1);
  } finally { await db.close(); }
});

test('센터별 10분 버킷: 다른 센터에서의 시도는 이 센터 한도에 포함되지 않지만, 계정 24시간 200회 한도는 센터를 가로질러 적용된다', async () => {
  const db = await world();
  try {
    await db.exec(`insert into member_candidate_search_attempts(caller_account_id, center_id) select '${MGR1}', '${C2}' from generate_series(1, 30)`);
    assert.equal((await search(db, MGR1, C1, EXACT)).length, 1);                       // C2에서 30회 썼어도 C1은 허용
    await db.exec(`delete from member_candidate_search_attempts; insert into member_candidate_search_attempts(caller_account_id, center_id, created_at) select '${MGR1}', '${C2}', now() - interval '2 hours' from generate_series(1, 200)`);
    await assert.rejects(search(db, MGR1, C1, EXACT), TOO_MANY);                       // 계정 24시간 200회 초과
    await db.exec(`update member_candidate_search_attempts set created_at = now() - interval '25 hours'`);
    assert.equal((await search(db, MGR1, C1, EXACT)).length, 1);
  } finally { await db.close(); }
});

test('권한 없는 요청은 한도와 무관하게 권한 오류만 — 한도 오류/기록으로 존재 여부 oracle이 되지 않는다', async () => {
  const db = await world();
  try {
    await db.exec(`insert into member_candidate_search_attempts(caller_account_id, center_id) select '${NOPERM}', '${C1}' from generate_series(1, 300)`);
    const before = await attempts(db);
    for (const [acc, center] of [[NOPERM, C1], [MGR2, C1], [MGR1, C2], [MGR1, null]]) {
      await assert.rejects(search(db, acc, center, EXACT), e => /권한/.test(e.message) && !TOO_MANY.test(e.message), `${acc}/${center}`);
    }
    assert.equal(await attempts(db), before);
    await assert.rejects(as(db, 'authenticated', null, async () => db.query(`select * from search_member_candidates('${C1}', '${EXACT}')`)), /권한/);
  } finally { await db.close(); }
});

test('anon은 함수 실행 불가, authenticated도 시도 테이블을 직접 읽거나 쓸 수 없다', async () => {
  const db = await world();
  try {
    await assert.rejects(as(db, 'anon', null, async () => db.query(`select * from search_member_candidates('${C1}', '${EXACT}')`)), /permission denied/);
    await search(db, MGR1, C1, EXACT);
    await assert.rejects(as(db, 'authenticated', MGR1, async () => db.query('select * from member_candidate_search_attempts')), /permission denied/);
    await assert.rejects(as(db, 'authenticated', MGR1, async () => db.query(`delete from member_candidate_search_attempts`)), /permission denied/);
    await assert.rejects(as(db, 'authenticated', MGR1, async () => db.query(`insert into member_candidate_search_attempts(caller_account_id, center_id) values ('${MGR1}','${C1}')`)), /permission denied/);
    await assert.rejects(as(db, 'anon', null, async () => db.query('select * from member_candidate_search_attempts')), /permission denied/);
  } finally { await db.close(); }
});

test('센터 회원 이름/전화 일부 검색 등 정상 검색은 제한되지 않고 기록도 안 한다(정확 번호 한도가 소진돼도 동작)', async () => {
  const db = await world();
  try {
    await exhaust(db);
    await assert.rejects(search(db, MGR1, C1, EXACT), TOO_MANY);
    const n = await attempts(db);
    for (let i = 0; i < 60; i++) assert.equal((await search(db, MGR1, C1, '센터회')).length, 1);
    assert.equal((await search(db, MGR1, C1, '1111')).length, 1);                       // 전화 일부
    assert.equal((await search(db, MGR1, C1, '010-1111')).length, 1);
    assert.equal((await search(db, MGR1, C1, '010-123')).length, 0);                    // 부분 번호는 외부 가입자를 찾지 못하고 제한도 안 받음
    assert.equal(await attempts(db), n);
  } finally { await db.close(); }
});

test('완전한 번호가 아닌 입력/2글자 미만은 기록하지 않고, 전체 번호는 결과 유무·내부/외부와 무관하게 모두 센다(이미 센터 회원인 번호 포함). 기존 동작(마스킹·정규화·병합/비활성 제외)은 그대로', async () => {
  const db = await world();
  try {
    assert.equal((await search(db, MGR1, C1, '홍길동')).length, 0);
    assert.equal((await search(db, MGR1, C1, '1')).length, 0);
    assert.equal(await attempts(db), 0);
    for (const kw of ['+82 10-1234-5678', '821012345678', '010 1234 5678']) assert.deepEqual((await search(db, MGR1, C1, kw)).map(x => x.phone), ['010-****-5678'], kw);
    assert.equal((await search(db, MGR1, C1, '010-9999-0001')).length, 0);              // 병합
    assert.equal((await search(db, MGR1, C1, '010-9999-0002')).length, 0);              // 비활성
    assert.equal((await search(db, MGR1, C1, '010-1111-2222'))[0].already_member, true);  // 이미 센터 회원(번호 전체 검색도 정상 반환)
    assert.equal(await attempts(db), 6);
  } finally { await db.close(); }
});

test('동시 호출도 한도를 넘기지 못한다(advisory lock으로 직렬화) — 같은 계정 40건 병렬 → 정확히 30건 기록', async () => {
  const db = await world();
  try {
    await db.exec(`select set_config('app.account_id','${MGR1}', false)`);
    const res = await Promise.allSettled(Array.from({ length: 40 }, () => db.query(`select * from search_member_candidates('${C1}', '${EXACT}')`)));
    assert.equal(res.filter(r => r.status === 'fulfilled').length, 30);
    assert.equal(await attempts(db), 30);
  } finally { await db.close(); }
});

test('함수 보안 계약 유지: SECURITY DEFINER + search_path=public, 권한 검사 뒤 rate limit, VOLATILE, 본문에 ilike 없음', async () => {
  const db = await world();
  try {
    const r = (await db.query(`select prosecdef, provolatile, proconfig::text cfg, pg_get_functiondef(oid) def from pg_proc where proname='search_member_candidates'`)).rows[0];
    assert.equal(r.prosecdef, true); assert.equal(r.provolatile, 'v'); assert.match(r.cfg, /search_path=public/);
    assert.ok(r.def.indexOf("has_permission(p_center_id, 'customer.member.create')") < r.def.indexOf('member_candidate_search_attempts'));
    assert.doesNotMatch(r.def.toLowerCase(), /ilike/);
  } finally { await db.close(); }
});

test('verify: 적용 전 NOT_APPLIED → 적용 후 APPLIED → rollback 후 NOT_APPLIED(함수는 STABLE로 복원, 테이블 제거), 재적용 안전', async () => {
  const db = await world({ apply: false });
  try {
    const v = async () => (await db.query(code(verify))).rows[0];
    assert.equal((await v()).verdict, 'NOT_APPLIED');
    await db.exec(migration);
    const ok = await v();
    assert.equal(ok.verdict, 'APPLIED', JSON.stringify(ok));
    await db.exec(migration);                                                            // 재적용(멱등)
    assert.equal((await v()).verdict, 'APPLIED');
    await db.exec(rollback);
    assert.equal((await v()).verdict, 'NOT_APPLIED');
    assert.equal((await db.query(`select provolatile from pg_proc where proname='search_member_candidates'`)).rows[0].provolatile, 's');
    assert.equal((await db.query(`select count(*)::int c from pg_tables where tablename='member_candidate_search_attempts'`)).rows[0].c, 0);
    assert.equal((await search(db, MGR1, C1, EXACT)).length, 1);                         // 롤백 후 기존 기능 정상
    await db.exec(migration);
    assert.equal((await v()).verdict, 'APPLIED');
  } finally { await db.close(); }
});

test('정적: verify는 read-only, migration은 이 domain만(accounts/profiles 정책·데이터 변경 없음)', () => {
  assert.doesNotMatch(code(verify).toLowerCase(), /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|create\s|alter\s|drop\s|truncate\s|grant\s|revoke\s)/);
  assert.equal(code(verify).trim().split(';').filter(x => x.trim()).length, 1);
  const m = code(migration).toLowerCase();
  assert.doesNotMatch(m, /create policy|drop policy|alter table public\.(accounts|profiles)/);
  assert.match(m, /enable row level security/);
});
