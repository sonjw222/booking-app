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
const MGR1 = id(2, 1), MGR2 = id(2, 2), NOPERM = id(2, 3), STRANGER = id(2, 99), NOPHONE = id(2, 5), PLATFORM = id(2, 6);
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
    for (const kw of ['01012345678', '010-1234-5678', ' 010 1234 5678 ', '+82 10-1234-5678', '821012345678', '+82-010-1234-5678', '+82 010 1234 5678']) {
      const r = await search(db, MGR1, C1, kw);
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

// ---- 전화번호 권한 분리 / 저장 형식 정규화 ----
test('A: create + phone 권한 — 기존 회원 이름/전화 부분 검색, 전체 전화번호 반환(fetch_member_phones_safe와 같은 기준)', async () => {
  const db = await world();
  try {
    assert.deepEqual((await search(db, MGR1, C1, '센터회')).map(x => [x.name, x.phone, x.already_member]), [['김센터회원', '01011112222', true]]);
    assert.equal((await search(db, MGR1, C1, '1111')).length, 1);
    assert.equal((await search(db, MGR1, C1, '010-1111-2222'))[0].phone, '01011112222');
    // platform admin도 phone 기준 통과(create 권한은 별도)
    assert.deepEqual((await search(db, PLATFORM, C1, '1111')).map(x => x.phone), ['01011112222']);
  } finally { await db.close(); }
});

test('B: create 권한만 있고 phone 권한 없음 — 이름 검색은 되지만 전화 부분검색 불가, 결과 phone은 NULL(전체 번호/부분 번호 노출 없음)', async () => {
  const db = await world();
  try {
    const byName = await search(db, NOPHONE, C1, '센터회');
    assert.deepEqual(byName.map(x => [x.name, x.phone, x.already_member]), [['김센터회원', null, true]]);
    for (const kw of ['1111', '2222', '010-1111', '01011112222', '010-1111-2222', '+82 10-1111-2222']) assert.equal((await search(db, NOPHONE, C1, kw)).length, 0, `phone 권한 없이 번호로 기존 회원이 검색되면 안 된다: ${kw}`);
    assert.ok(!JSON.stringify(byName).includes('1111'));
    // 센터 밖 신규 가입자의 정확한 전체 번호 검색은 create 권한만으로 가능 + 마스킹(전화 권한 없어도)
    const outside = await search(db, NOPHONE, C1, '010-1234-5678');
    assert.deepEqual(outside.map(x => [x.name, x.phone, x.already_member]), [['홍길동', '010-****-5678', false]]);
  } finally { await db.close(); }
});

test('C/D: 센터 밖·다른 센터 회원은 phone 권한과 무관하게 정확한 전체 번호로만 + 항상 마스킹, 이름/부분번호/email fragment는 불가', async () => {
  const db = await world();
  try {
    for (const actor of [MGR1, NOPHONE]) {
      assert.deepEqual((await search(db, actor, C1, '01055556666')).map(x => [x.name, x.phone, x.already_member]), [['다른센터회원', '010-****-6666', false]]);
      for (const kw of ['다른센터', '5555', '6666', '010-5555', 'example.com', '홍길', '1234']) assert.equal((await search(db, actor, C1, kw)).length, 0, `${kw}`);
    }
    for (const r of [...await search(db, MGR1, C1, '01012345678'), ...await search(db, NOPHONE, C1, '01012345678')]) assert.ok(/^010-\*{4}-\d{4}$/.test(r.phone));   // 전체 번호 절대 미반환
  } finally { await db.close(); }
});

test('G: 저장 형식별 정규화 — DB에 01012345678 / 010-… / +82 10-… / +82-010-… / 82… / 공백 형식이 저장돼 있어도 입력 형식과 무관하게 같은 번호로 비교', async () => {
  const db = await world();
  try {
    const stored = [['저장형식A', '3000-0001'], ['저장형식B', '3000-0002'], ['저장형식C', '3000-0003'], ['저장형식D', '3000-0004'], ['저장형식E', '3000-0005']];
    for (const [name, tail] of stored) {
      for (const input of [`010${tail.replace('-', '')}`, `010-${tail}`, `+82 10-${tail}`, `+82-010-${tail}`, `82 10 ${tail.replace('-', ' ')}`]) {
        const r = await search(db, MGR1, C1, input);
        assert.deepEqual(r.map(x => [x.name, x.already_member]), [[name, false]], `${name} ← ${input}`);
        assert.equal(r[0].phone, `010-****-${tail.slice(-4)}`);
      }
    }
    // 이 센터 회원으로 등록된 뒤에는 저장 형식이 달라도 부분 검색(phone 권한 있음)으로 찾아지고, 권한 없으면 안 찾아진다
    await db.exec(`insert into center_members values ('${C1}','${id(4, 12)}')`);
    assert.deepEqual((await search(db, MGR1, C1, '3000-0002')).map(x => [x.name, x.phone, x.already_member]), [['저장형식B', '+82 10-3000-0002', true]]);
    assert.equal((await search(db, NOPHONE, C1, '3000-0002')).length, 0);
    // 휴대폰 형식이 아닌 입력/잘린 입력은 정확 검색 후보가 아니다(센터 회원의 부분 일치는 phone 권한자에게만 허용되는 별개 동작)
    for (const bad of ['0101234567', '+82 10-3000', '8210300000', '0109999999']) assert.equal((await search(db, MGR1, C1, bad)).length, 0, bad);
  } finally { await db.close(); }
});

test('negative control: 수정 전(이전 버전, create 권한만 확인)에서는 phone 권한 없는 스태프에게 전체 번호가 노출됐다 — 위 B 테스트가 실제로 이 우회를 잡는다', async () => {
  const db = await world({ apply: false });
  try {
    // 수정 전 정의: customer.member.create만 확인하고 전체 번호 반환
    await db.exec(`create or replace function search_member_candidates(p_center_id uuid, p_keyword text) returns table (profile_id uuid, name text, phone text, already_member boolean) language plpgsql stable security definer set search_path = public as $$
      begin
        if p_center_id is null or not has_permission(p_center_id, 'customer.member.create') then raise exception '회원 등록 권한이 없어요'; end if;
        return query select p.id, p.name, a.phone, true from center_members cm join profiles p on p.id = cm.profile_id join accounts a on a.id = p.account_id where cm.center_id = p_center_id and p.is_primary and (p.name ilike '%' || p_keyword || '%' or a.phone like '%' || p_keyword || '%');
      end; $$;
      grant execute on function search_member_candidates(uuid, text) to authenticated;`);
    const leaked = await search(db, NOPHONE, C1, '1111');
    assert.equal(leaked.length, 1);
    assert.equal(leaked[0].phone, '01011112222');   // 전화번호 권한 우회(수정 전)
    await db.exec(migration);
    assert.equal((await search(db, NOPHONE, C1, '1111')).length, 0);   // 수정 후 차단
  } finally { await db.close(); }
});

test('권한 검사는 데이터 조회보다 먼저, 전화 권한 기준은 fetch_member_phones_safe와 동일, 정규화 helper는 내부 전용', async () => {
  const body = migration.replace(/--.*$/gm, '');
  const fn = body.slice(body.indexOf('create or replace function public.search_member_candidates'));
  assert.ok(fn.indexOf("has_permission(p_center_id, 'customer.member.create')") < fn.indexOf('return query'));
  assert.ok(fn.indexOf("has_permission(p_center_id, 'customer.member.phone') or public.is_platform_admin()") < fn.indexOf('return query'));
  assert.match(fn, /case when v_can_phone then a\.phone else null end/);
  assert.match(fn, /v_can_phone and length\(v_digits\) >= 2/);
  const db = await world();
  try {
    const r = (await db.query(`select has_function_privilege('anon', p.oid,'execute') a, has_function_privilege('authenticated', p.oid,'execute') u, has_function_privilege('public', p.oid,'execute') pub from pg_proc p where proname='kr_phone_digits'`)).rows[0];
    assert.deepEqual([r.a, r.u, r.pub], [false, false, false]);
    for (const [input, out] of [['010-1234-5678', '01012345678'], ['+82 10-1234-5678', '01012345678'], ['+82-010-1234-5678', '01012345678'], ['821012345678', '01012345678'], ['abc', ''], [null, '']]) {
      assert.equal((await db.query(`select public.kr_phone_digits(${input === null ? 'null' : `'${input}'`}) v`)).rows[0].v, out, String(input));
    }
  } finally { await db.close(); }
});
