// 격리 PostgreSQL(PGlite) — 관리자 회원 추가 검색 RPC. 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/member-candidate-search.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('add_member_candidate_search_20261003.sql');
const rollback = read('rollback_add_member_candidate_search_20261003.sql');
const verify = read('verify_member_candidate_search_20261003.sql');
const id = (k, n) => `${String(k).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C1 = id(1, 1), C2 = id(1, 2);
const MGR1 = id(2, 1), MGR2 = id(2, 2), NOPERM = id(2, 3), STRANGER = id(2, 99);
const ACC_MEMBER = id(3, 1), ACC_OUT = id(3, 2), ACC_MERGED = id(3, 3), ACC_DEACT = id(3, 4), ACC_OTHERCENTER = id(3, 5);

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
    create function has_permission(p_center_id uuid, p_permission text) returns boolean language sql stable as $$ select exists (select 1 from perms where account_id = my_account_id() and center_id = p_center_id and perm = p_permission) $$;
    -- Production에 이미 있는 전역 부분일치 RPC(회수 대상)
    create function search_accounts_for_member(p_keyword text) returns table(profile_id uuid, name text, phone text) language sql security definer set search_path = public as $$ select p.id, p.name, a.phone from profiles p join accounts a on a.id = p.account_id where p.name ilike '%' || p_keyword || '%' $$;
    revoke all on function search_accounts_for_member(text) from public, anon; grant execute on function search_accounts_for_member(text) to authenticated;
    insert into accounts values ('${ACC_MEMBER}','김센터회원','01011112222',null,null), ('${ACC_OUT}','홍길동','01012345678',null,null), ('${ACC_MERGED}','병합된계정','01099990001','${ACC_OUT}',null),
      ('${ACC_DEACT}','비활성계정','01099990002',null,now()), ('${ACC_OTHERCENTER}','다른센터회원','01055556666',null,null);
    insert into profiles(id, account_id, name) values ('${id(4, 1)}','${ACC_MEMBER}','김센터회원'), ('${id(4, 2)}','${ACC_OUT}','홍길동'), ('${id(4, 3)}','${ACC_MERGED}','병합된계정'),
      ('${id(4, 4)}','${ACC_DEACT}','비활성계정'), ('${id(4, 5)}','${ACC_OTHERCENTER}','다른센터회원');
    insert into profiles(id, account_id, name, deleted_at) values ('${id(4, 6)}','${ACC_OUT}','삭제된프로필', now());
    insert into center_members values ('${C1}','${id(4, 1)}'), ('${C2}','${id(4, 5)}');
    insert into perms values ('${MGR1}','${C1}','customer.member.create'), ('${MGR2}','${C2}','customer.member.create'), ('${NOPERM}','${C1}','customer.member.view');
  `);
  if (apply) await db.exec(migration);
  return db;
}
const as = async (db, role, acc, fn) => { await db.exec(`set role ${role}; select set_config('app.account_id','${acc ?? ''}', false);`); try { return await fn(); } finally { await db.exec(`reset role; select set_config('app.account_id','',false);`); } };
const search = (db, acc, center, kw) => as(db, 'authenticated', acc, async () => (await db.query(`select * from search_member_candidates(${center ? `'${center}'` : 'null'}, $q$${kw}$q$)`)).rows);

test('이 센터 회원: 이름/전화 일부 검색 가능(already_member=true, 전체 번호), wildcard 무력, 2글자 미만 없음', async () => {
  const db = await world();
  try {
    let r = await search(db, MGR1, C1, '센터회');
    assert.deepEqual(r.map(x => [x.name, x.phone, x.already_member]), [['김센터회원', '01011112222', true]]);
    r = await search(db, MGR1, C1, '1111');                           // 전화 일부
    assert.equal(r.length, 1);
    r = await search(db, MGR1, C1, '010-1111');                       // 하이픈이 섞인 일부
    assert.equal(r.length, 1);
    for (const kw of ['%', '__', '%%', '김%원', '_센터']) assert.equal((await search(db, MGR1, C1, kw)).length, 0, kw);
    assert.equal((await search(db, MGR1, C1, '김')).length, 0);       // 1글자
    assert.equal((await search(db, MGR1, C1, '  ')).length, 0);
  } finally { await db.close(); }
});

test('센터에 없는 사람: 이름/전화 일부/이메일 조각으로는 전혀 안 나온다(전역 부분 검색 금지)', async () => {
  const db = await world();
  try {
    for (const kw of ['홍길동', '홍길', '길동', '1234', '5678', '01012', '010-1234', '010123456', '0101234567', 'gmail', 'naver.com', '병합', '비활성']) {
      assert.equal((await search(db, MGR1, C1, kw)).length, 0, `${kw}`);
    }
  } finally { await db.close(); }
});

test('정확한 전체 휴대폰 번호는 형식이 달라도 같은 계정으로 정규화 — 최소 정보(이름 + 마스킹 번호)만, 전체 번호 미노출', async () => {
  const db = await world();
  try {
    for (const kw of ['01012345678', '010-1234-5678', ' 010 1234 5678 ', '+82 10-1234-5678', '821012345678', '+82-010-1234-5678']) {
      const r = await search(db, MGR1, C1, kw);
      if (kw === '+82-010-1234-5678') { assert.equal(r.length, 0, '잘못된 국제 형식은 추측하지 않는다'); continue; }
      assert.equal(r.length, 1, kw);
      assert.deepEqual([r[0].name, r[0].phone, r[0].already_member], ['홍길동', '010-****-5678', false]);
      assert.deepEqual(Object.keys(r[0]).sort(), ['already_member', 'name', 'phone', 'profile_id']);   // 이메일/주소/계정 id 등 다른 필드 없음
      assert.ok(!JSON.stringify(r[0]).includes('01012345678'));
    }
    for (const kw of ['01099999999', '010-0000-0000', '0212345678', '1012345678']) assert.equal((await search(db, MGR1, C1, kw)).length, 0, kw);   // 존재하지 않는 번호/휴대폰 형식 아님
    // 병합/비활성 계정, 삭제된 프로필은 정확한 번호여도 제외
    assert.equal((await search(db, MGR1, C1, '01099990001')).length, 0);
    assert.equal((await search(db, MGR1, C1, '01099990002')).length, 0);
    assert.equal((await search(db, MGR1, C1, '삭제된프로필')).length, 0);
  } finally { await db.close(); }
});

test('이미 이 센터 회원인 번호는 중복 없이 1건(already_member=true, 전체 번호), 다른 센터 회원은 정확한 번호로만 마스킹되어 조회', async () => {
  const db = await world();
  try {
    let r = await search(db, MGR1, C1, '010-1111-2222');
    assert.deepEqual(r.map(x => [x.already_member, x.phone]), [[true, '01011112222']]);
    r = await search(db, MGR1, C1, '010-5555-6666');                    // 다른 센터 회원: C1 입장에선 "센터에 없는 사람"
    assert.deepEqual(r.map(x => [x.name, x.phone, x.already_member]), [['다른센터회원', '010-****-6666', false]]);
    assert.equal((await search(db, MGR1, C1, '다른센터')).length, 0);   // 이름으로는 다른 센터 회원을 찾을 수 없다
  } finally { await db.close(); }
});

test('권한: 권한 없는 사용자/다른 센터 관리자/로그인 안 한 사용자/NULL 센터는 거부, anon은 실행 권한 없음', async () => {
  const db = await world();
  try {
    await assert.rejects(search(db, NOPERM, C1, '01012345678'), /회원 등록 권한이 없어요/);
    await assert.rejects(search(db, MGR2, C1, '01012345678'), /회원 등록 권한이 없어요/);     // 다른 센터 관리자가 이 센터 id로 호출
    await assert.rejects(search(db, MGR1, C2, '01012345678'), /회원 등록 권한이 없어요/);     // 반대로
    await assert.rejects(search(db, STRANGER, C1, '01012345678'), /회원 등록 권한이 없어요/);
    await assert.rejects(search(db, null, C1, '01012345678'), /회원 등록 권한이 없어요/);
    await assert.rejects(search(db, MGR1, null, '01012345678'), /회원 등록 권한이 없어요/);
    await assert.rejects(as(db, 'anon', null, () => db.query(`select * from search_member_candidates('${C1}','01012345678')`)), /permission denied/);
  } finally { await db.close(); }
});

test('전역 부분일치 RPC(search_accounts_for_member)는 적용 후 authenticated도 실행 불가, rollback으로 복원 가능, 재적용 안전, verify 왕복', async () => {
  const pre = await world({ apply: false });
  try {
    assert.equal((await as(pre, 'authenticated', MGR1, () => pre.query(`select * from search_accounts_for_member('홍길')`))).rows.length, 1);   // 적용 전: 전역 부분일치가 가능(문제 상태)
  } finally { await pre.close(); }
  const db = await world();
  try {
    await assert.rejects(as(db, 'authenticated', MGR1, () => db.query(`select * from search_accounts_for_member('홍길')`)), /permission denied/);
    const v = verify.replace(/--.*$/gm, '');
    assert.doesNotMatch(v, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
    assert.match(v.trim(), /^with\b/i);
    const row = async () => (await db.query(v)).rows[0];
    let r = await row(); assert.equal(r.verdict, 'APPLIED');
    for (const k of Object.keys(r).filter(k => k.endsWith('_ok'))) assert.equal(r[k], true, k);
    await db.exec(migration);                                                        // idempotent
    assert.equal((await row()).verdict, 'APPLIED');
    // verify negative controls
    await db.exec(`grant execute on function search_member_candidates(uuid, text) to anon`); assert.equal((await row()).verdict, 'NOT_APPLIED');
    await db.exec(`revoke execute on function search_member_candidates(uuid, text) from anon`); assert.equal((await row()).verdict, 'APPLIED');
    await db.exec(`grant execute on function search_accounts_for_member(text) to authenticated`); assert.equal((await row()).verdict, 'NOT_APPLIED');
    await db.exec(`revoke execute on function search_accounts_for_member(text) from authenticated`); assert.equal((await row()).verdict, 'APPLIED');
    await db.exec(`revoke execute on function search_member_candidates(uuid, text) from authenticated`); assert.equal((await row()).verdict, 'NOT_APPLIED');
    await db.exec(`grant execute on function search_member_candidates(uuid, text) to authenticated`);
    await db.exec(rollback);
    assert.equal((await row()).verdict, 'NOT_APPLIED');
    assert.equal((await as(db, 'authenticated', MGR1, () => db.query(`select * from search_accounts_for_member('홍길')`))).rows.length, 1);   // 직전 상태 복원
    await db.exec(rollback);                                                         // rollback 재실행 안전
    await db.exec(migration); assert.equal((await row()).verdict, 'APPLIED');
  } finally { await db.close(); }
});

test('함수 보안 계약: SECURITY DEFINER + search_path 고정, 본문에 ilike/LIKE 부분일치 없음, 권한 검사가 데이터 조회보다 먼저', async () => {
  const body = migration.replace(/--.*$/gm, '');
  assert.match(body, /security definer\s+set search_path = public/);
  assert.match(body, /revoke all on function public\.search_member_candidates\(uuid, text\) from public, anon;/);
  assert.doesNotMatch(body.slice(body.indexOf('create or replace function'), body.indexOf('revoke all on function public.search_member_candidates')), /\bi?like\b/i);
  assert.ok(body.indexOf("has_permission(p_center_id, 'customer.member.create')") < body.indexOf('return query'));
});
