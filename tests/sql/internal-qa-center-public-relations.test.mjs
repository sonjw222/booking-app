// 격리 PostgreSQL(PGlite) — 내부 QA 센터 공개/로그인 SELECT 경로(rooms, reviews, 설정 등 12개 테이블) 비가시화.
// 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/internal-qa-center-public-relations.test.mjs
// 선행 migration(add_internal_qa_center_flag.sql)의 결과(centers.is_internal, my_member_center_ids/my_managed_center_ids/is_platform_admin)를 합성 스키마로 재현한 뒤 이 후속 migration을 적용한다.
// 적용 순서: 1) add_internal_qa_center_flag.sql → 2) fix_internal_qa_center_public_relations_20261004.sql.  qa:production:* 은 실행하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('fix_internal_qa_center_public_relations_20261004.sql');
const rollback = read('rollback_fix_internal_qa_center_public_relations_20261004.sql');
const verify = read('verify_internal_qa_center_public_relations_20261004.sql').replace(/^\s*--.*$/gm, '');
const id = (k, n) => `${String(k).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const QA = id(1, 1), NORMAL = id(1, 2);
const STRANGER = id(2, 1), QAMEMBER = id(2, 2), QAMGR = id(2, 3), PLATFORM = id(2, 4), NORMGR = id(2, 5);
const QA_CLASS = id(5, 1), NORMAL_CLASS = id(5, 2), QA_PRODUCT = id(6, 1), NORMAL_PRODUCT = id(6, 2);
// [테이블, 공개 허용 role들(원래 trivial 조건), 센터 연결 컬럼]
const TABLES = [
  ['rooms', 'true', 'center_id'], ['center_reviews', 'true', 'center_id'], ['reviews', 'auth', 'target_center_id'], ['center_contacts', 'auth', 'center_id'],
  ['center_holidays', 'auth', 'center_id'], ['center_member_fields', 'auth', 'center_id'], ['center_settings', 'auth', 'center_id'], ['progress_categories', 'auth', 'center_id'],
  ['community_posts', 'auth', 'center_id'], ['class_trainers', 'auth', 'class_id'], ['class_allowed_products', 'auth', 'class_id'], ['membership_schedule_rules', 'auth', 'product_id'],
];
const POLICY = { rooms: ['룸 공개 조회', 'true'], center_reviews: ['센터후기 공개 조회', 'true'], reviews: ['로그인 사용자는 리뷰 조회 가능', "auth.role() = 'authenticated'"], center_contacts: ['상담채널 조회', "auth.role() = 'authenticated'"],
  center_holidays: ['로그인 사용자 휴무일 조회', "auth.role() = 'authenticated'"], center_member_fields: ['센터 항목 조회', "auth.role() = 'authenticated'"], center_settings: ['설정 조회', 'auth.uid() is not null'],
  progress_categories: ['진도 카테고리 조회', 'auth.uid() is not null'], community_posts: ['로그인 사용자는 커뮤니티 게시글 조회 가능', "auth.role() = 'authenticated'"], class_trainers: ['수업 강사 조회', "auth.role() = 'authenticated'"],
  class_allowed_products: ['수업수강권 조회', 'auth.uid() is not null'], membership_schedule_rules: ['예약조건 조회', 'auth.uid() is not null'] };

async function world({ apply = true } = {}) {
  const db = new PGlite();
  let sql = `
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema auth;
    create function auth.uid() returns text language sql stable as $$ select nullif(current_setting('app.uid', true), '') $$;
    create function auth.role() returns text language sql stable as $$ select case when nullif(current_setting('app.uid', true), '') is null then 'anon' else 'authenticated' end $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid(), auth.role() to anon, authenticated;
    create function my_account_id() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    create table centers(id uuid primary key, name text, is_internal boolean not null default false);
    create table manager_centers(account_id uuid, center_id uuid);
    create table center_members(center_id uuid, account_id uuid);
    create table classes(id uuid primary key, center_id uuid); create table products(id uuid primary key, center_id uuid);
    create function is_platform_admin() returns boolean language sql stable security definer as $$ select my_account_id() = '${PLATFORM}'::uuid $$;
    create function my_managed_center_ids() returns setof uuid language sql stable security definer set search_path = public as $$ select center_id from manager_centers where account_id = my_account_id() $$;
    create function my_member_center_ids() returns setof uuid language sql stable security definer set search_path = public as $$ select center_id from center_members where account_id = my_account_id() $$;
    grant execute on function my_managed_center_ids(), my_member_center_ids(), is_platform_admin(), my_account_id() to anon, authenticated;
    insert into centers values ('${QA}','[QA]',true), ('${NORMAL}','일반',false);
    insert into manager_centers values ('${QAMGR}','${QA}'), ('${NORMGR}','${NORMAL}');
    insert into center_members values ('${QA}','${QAMEMBER}');
    insert into classes values ('${QA_CLASS}','${QA}'), ('${NORMAL_CLASS}','${NORMAL}');
    insert into products values ('${QA_PRODUCT}','${QA}'), ('${NORMAL_PRODUCT}','${NORMAL}');
  `;
  for (const [t, , col] of TABLES) {
    const extra = t === 'reviews' ? ', target_account_id uuid' : '';
    sql += `create table ${t}(id serial primary key, ${col} uuid, label text${extra}); alter table ${t} enable row level security; grant select on ${t} to anon, authenticated;
            create policy "${POLICY[t][0]}" on ${t} for select using (${POLICY[t][1]});`;
    const [qa, normal] = col === 'class_id' ? [QA_CLASS, NORMAL_CLASS] : col === 'product_id' ? [QA_PRODUCT, NORMAL_PRODUCT] : [QA, NORMAL];
    sql += `insert into ${t}(${col}, label) values ('${qa}','QA'), ('${normal}','NORMAL');`;
  }
  sql += `insert into reviews(target_center_id, target_account_id, label) values (null, '${STRANGER}', 'PERSON');   -- 사람 대상 리뷰(센터 연결 없음)
          insert into community_posts(center_id, label) values (null, 'GLOBAL');   -- 전체 공개 게시글(센터 없음)`;
  await db.exec(sql);
  if (apply) await db.exec(migration);
  return db;
}
const as = async (db, role, uid, fn) => { await db.exec(`set role ${role}; select set_config('app.uid','${uid ?? ''}', false);`); try { return await fn(); } finally { await db.exec(`reset role; select set_config('app.uid','',false);`); } };
const labels = async (db, role, uid, t) => (await as(db, role, uid, () => db.query(`select label from ${t} order by id`))).rows.map(r => r.label);

test('anon: rooms/center_reviews(공개 using true)에서 QA 센터 행 차단, 일반 센터 행 유지 / 로그인 전용 테이블은 anon에게 원래 0행', async () => {
  const db = await world();
  try {
    for (const t of ['rooms', 'center_reviews']) assert.deepEqual(await labels(db, 'anon', null, t), ['NORMAL'], t);
    for (const [t, kind] of TABLES) if (kind === 'auth') assert.deepEqual(await labels(db, 'anon', null, t), [], t);
  } finally { await db.close(); }
});

test('무관한 로그인 사용자/다른 일반 센터 관리자: 12개 테이블 모두 QA 행 차단, 일반 센터 행/전역 행 유지, reviews 사람 대상 행 유지', async () => {
  const db = await world();
  try {
    for (const uid of [STRANGER, NORMGR]) for (const [t] of TABLES) {
      const got = await labels(db, 'authenticated', uid, t);
      assert.ok(!got.includes('QA'), `${uid}/${t}: ${got}`);
      assert.ok(got.includes('NORMAL'), `${uid}/${t}: ${got}`);
    }
    assert.deepEqual(await labels(db, 'authenticated', STRANGER, 'reviews'), ['NORMAL', 'PERSON']);                 // 사람 대상 리뷰(target_center_id null) 유지, 내부 센터 대상만 차단
    assert.deepEqual(await labels(db, 'authenticated', STRANGER, 'community_posts'), ['NORMAL', 'GLOBAL']);          // 센터 없는 게시글 유지
  } finally { await db.close(); }
});

test('QA 센터 회원/관리자/플랫폼 관리자는 QA 행에 계속 접근', async () => {
  const db = await world();
  try {
    for (const uid of [QAMEMBER, QAMGR, PLATFORM]) for (const [t] of TABLES) assert.ok((await labels(db, 'authenticated', uid, t)).includes('QA'), `${uid}/${t}`);
  } finally { await db.close(); }
});

test('적용 전(현재 라이브 lineage)에는 무관한 사용자도 QA 행이 보였다(문제 재현) + rollback 복원 + 재적용 idempotent', async () => {
  const db = await world({ apply: false });
  try {
    for (const [t] of TABLES) assert.ok((await labels(db, 'authenticated', STRANGER, t)).includes('QA'), `before ${t}`);
    assert.ok((await labels(db, 'anon', null, 'rooms')).includes('QA'));
    await db.exec(migration); await db.exec(migration);
    for (const [t] of TABLES) assert.ok(!(await labels(db, 'authenticated', STRANGER, t)).includes('QA'), `after ${t}`);
    await db.exec(rollback);
    for (const [t] of TABLES) assert.ok((await labels(db, 'authenticated', STRANGER, t)).includes('QA'), `rolled back ${t}`);
    assert.ok((await labels(db, 'anon', null, 'center_reviews')).includes('QA'));
    assert.equal((await db.query(`select count(*)::int c from pg_proc where proname in ('center_rows_visible','class_rows_visible','product_rows_visible')`)).rows[0].c, 0);
    for (const [t] of TABLES) assert.equal((await db.query(`select count(*)::int c from pg_policies where tablename='${t}' and cmd='SELECT'`)).rows[0].c, 1, t);   // 정책 개수 원복
    await db.exec(migration);
  } finally { await db.close(); }
});

test('helper 계약: SECURITY DEFINER + search_path 고정, anon/authenticated 실행 가능, PUBLIC 직접 권한 없음, NULL 센터는 true, RLS 재귀 없음', async () => {
  const db = await world();
  try {
    const rows = (await db.query(`select proname, prosecdef, proconfig::text cfg, has_function_privilege('public', oid, 'execute') pub from pg_proc where proname in ('center_rows_visible','class_rows_visible','product_rows_visible') order by 1`)).rows;
    assert.equal(rows.length, 3);
    for (const r of rows) { assert.equal(r.prosecdef, true); assert.match(r.cfg, /search_path=public/); assert.equal(r.pub, false); }
    assert.equal((await as(db, 'anon', null, () => db.query(`select center_rows_visible(null) v, center_rows_visible('${QA}') q, center_rows_visible('${NORMAL}') n`))).rows[0].q, false);
    assert.equal((await as(db, 'anon', null, () => db.query(`select center_rows_visible(null) v`))).rows[0].v, true);
    assert.equal((await as(db, 'authenticated', QAMGR, () => db.query(`select class_rows_visible('${QA_CLASS}') c, product_rows_visible('${QA_PRODUCT}') p`))).rows[0].c, true);
    assert.equal((await as(db, 'authenticated', STRANGER, () => db.query(`select class_rows_visible('${QA_CLASS}') c, product_rows_visible('${QA_PRODUCT}') p`))).rows[0].p, false);
  } finally { await db.close(); }
});

test('verify: 적용 전 NOT_APPLIED(tables_needing_attention 12개) → 적용 APPLIED → trivial 정책이 남으면 NOT_APPLIED → rollback NOT_APPLIED, 읽기 전용 단일 SELECT', async () => {
  assert.doesNotMatch(verify, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
  assert.equal(verify.trim().split(';').filter(x => x.trim()).length, 1);
  const db = await world({ apply: false });
  try {
    const v = async () => (await db.query(verify)).rows[0];
    let r = await v(); assert.equal(r.verdict, 'NOT_APPLIED'); assert.equal(r.tables_needing_attention.length, 12);
    await db.exec(migration);
    r = await v(); assert.equal(r.verdict, 'APPLIED', JSON.stringify(r)); assert.deepEqual(r.tables_needing_attention, []);
    await db.exec(`create policy "옛 정책 잔존" on rooms for select using (true)`);                  // 라이브 정책 이름이 달라 옛 정책이 남은 상황
    r = await v(); assert.equal(r.verdict, 'NOT_APPLIED'); assert.deepEqual(r.tables_needing_attention, ['rooms']);
    assert.ok((await labels(db, 'anon', null, 'rooms')).includes('QA'));                              // 실제로도 새는 상태 — verify가 이를 잡아낸다
    await db.exec(`drop policy "옛 정책 잔존" on rooms`); assert.equal((await v()).verdict, 'APPLIED');
    await db.exec(`drop policy "예약조건 조회" on membership_schedule_rules`); assert.equal((await v()).verdict, 'NOT_APPLIED');
    await db.exec(migration); await db.exec(rollback); assert.equal((await v()).verdict, 'NOT_APPLIED');
  } finally { await db.close(); }
});

test('정적: migration은 SELECT 정책 12개 + helper 3개만(쓰기 정책/데이터 변경 없음), rollback은 같은 12개를 원래 조건으로 복원', () => {
  const strip = s => s.replace(/--[^\n]*/g, '');
  const m = strip(migration);
  assert.equal([...m.matchAll(/create policy "([^"]+)" on public\.(\w+) for select/g)].length, 12);
  assert.equal([...m.matchAll(/create or replace function public\.(\w+)/g)].length, 3);
  assert.doesNotMatch(m, /\b(insert into|update public|delete from|alter table|for (insert|update|delete|all))\b/i);
  const r = strip(rollback);
  for (const [t, [name, orig]] of Object.entries(POLICY)) assert.ok(r.includes(`create policy "${name}" on public.${t} for select using (${orig});`), t);
});

// ---- verify 강화(정규화 일치 / permissive만 / helper 본문 의미) ----
const FN = (name, arg, body) => `create or replace function public.${name}(${arg}) returns boolean language sql stable security definer set search_path = public as $$ ${body} $$;`;
const applied = async () => { const db = await world(); return db; };

test('verify: 다른 이름으로 남은 옛 trivial SELECT 정책을 포맷(공백/괄호/대소문자/::text)과 무관하게 감지 → NOT_APPLIED', async () => {
  const db = await world();
  try {
    const v = async () => (await db.query(verify)).rows[0];
    assert.equal((await v()).verdict, 'APPLIED');
    const variants = [
      ["auth.role() = 'authenticated'", 'reviews'], ["(auth.role()='authenticated')", 'center_settings'], ["( ( auth.role( ) = 'authenticated' ) )", 'center_contacts'],
      ["AUTH.ROLE() = 'authenticated'::text", 'center_holidays'], ["auth.uid() IS NOT NULL", 'progress_categories'], ["((auth.uid()) is not null)", 'center_member_fields'],
      ["true", 'rooms'], ["(true)", 'center_reviews'], ["auth.role()::text = 'authenticated'::text", 'community_posts'],
    ];
    for (const [qual, t] of variants) {
      await db.exec(`create policy "옛 정책 잔존" on ${t} for select using (${qual})`);
      const r = await v();
      assert.equal(r.verdict, 'NOT_APPLIED', `${t}: ${qual}`);
      assert.ok(r.tables_needing_attention.includes(t), `${t}: ${qual} → ${r.tables_needing_attention}`);
      assert.equal(r.no_trivial_select_policy_left_ok, false, qual);
      await db.exec(`drop policy "옛 정책 잔존" on ${t}`);
      assert.equal((await v()).verdict, 'APPLIED', `원복 ${t}`);
    }
    // permissive FOR ALL도 SELECT를 허용하므로 감지
    await db.exec(`create policy "옛 ALL" on rooms for all using (true)`); assert.equal((await v()).verdict, 'NOT_APPLIED'); await db.exec(`drop policy "옛 ALL" on rooms`);
    // 실제로도 OR로 새는 상태임을 확인(이 verify가 막으려는 상황)
    await db.exec(`create policy "옛 정책 잔존" on class_trainers for select using (auth.role() = 'authenticated')`);
    assert.ok((await labels(db, 'authenticated', STRANGER, 'class_trainers')).includes('QA'));
    assert.equal((await v()).verdict, 'NOT_APPLIED');
  } finally { await db.close(); }
});

test('verify: restrictive SELECT 정책과 쓰기 정책, 센터 조건이 있는 정책은 오탐하지 않는다', async () => {
  const db = await world();
  try {
    const v = async () => (await db.query(verify)).rows[0];
    await db.exec(`create policy "제한" on rooms as restrictive for select using (auth.role() = 'authenticated')`);       // restrictive는 노출을 넓히지 않음
    await db.exec(`create policy "쓰기" on rooms for update using (true)`);
    await db.exec(`create policy "관리자" on center_settings for select using (center_id in (select my_managed_center_ids()))`);
    await db.exec(`create policy "로그인+센터" on reviews for select using (auth.role() = 'authenticated' and target_center_id is null)`);   // 단독 trivial이 아님
    const r = await v(); assert.equal(r.verdict, 'APPLIED', JSON.stringify(r)); assert.deepEqual(r.tables_needing_attention, []);
  } finally { await db.close(); }
});

test('verify: helper 본문 계약이 깨지면 NOT_APPLIED — 항상 true / is_internal·platform admin 검사 제거 / class·product 연결 제거, 재적용하면 APPLIED', async () => {
  const db = await world();
  try {
    const v = async () => (await db.query(verify)).rows[0];
    const r0 = await v(); assert.equal(r0.verdict, 'APPLIED'); assert.deepEqual([r0.center_helper_body_ok, r0.class_helper_body_ok, r0.product_helper_body_ok], [true, true, true]);
    const tampers = [
      ['center 항상 true', FN('center_rows_visible', 'p_center_id uuid', 'select true;'), 'center_helper_body_ok'],
      ['center is_internal 검사 제거', FN('center_rows_visible', 'p_center_id uuid', 'select coalesce(p_center_id is null or p_center_id in (select public.my_member_center_ids()) or p_center_id in (select public.my_managed_center_ids()) or public.is_platform_admin(), false);'), 'center_helper_body_ok'],
      ['center platform admin 제거', FN('center_rows_visible', 'p_center_id uuid', 'select coalesce(p_center_id is null or not exists (select 1 from public.centers c where c.id = p_center_id and c.is_internal) or p_center_id in (select public.my_member_center_ids()) or p_center_id in (select public.my_managed_center_ids()), false);'), 'center_helper_body_ok'],
      ['center 회원 검사 제거', FN('center_rows_visible', 'p_center_id uuid', 'select coalesce(p_center_id is null or not exists (select 1 from public.centers c where c.id = p_center_id and c.is_internal) or p_center_id in (select public.my_managed_center_ids()) or public.is_platform_admin(), false);'), 'center_helper_body_ok'],
      ['class 연결 제거(항상 true)', FN('class_rows_visible', 'p_class_id uuid', 'select true;'), 'class_helper_body_ok'],
      ['class가 center helper 미호출', FN('class_rows_visible', 'p_class_id uuid', 'select exists (select 1 from public.classes c where c.id = p_class_id);'), 'class_helper_body_ok'],
      ['product 연결 제거(항상 true)', FN('product_rows_visible', 'p_product_id uuid', 'select true;'), 'product_helper_body_ok'],
      ['product가 products를 조회하지 않음', FN('product_rows_visible', 'p_product_id uuid', 'select public.center_rows_visible(null);'), 'product_helper_body_ok'],
    ];
    for (const [name, sql, flag] of tampers) {
      await db.exec(sql);
      const r = await v();
      assert.equal(r[flag], false, `${name}: ${flag}`);
      assert.equal(r.verdict, 'NOT_APPLIED', name);
      await db.exec(migration);                                                      // 재적용(멱등)으로 복구
      assert.equal((await v()).verdict, 'APPLIED', `복구 ${name}`);
    }
  } finally { await db.close(); }
});

test('verify: 단일 읽기 전용 SELECT 유지(DDL/DML/GRANT 없음)', () => {
  const code = verify.replace(/'[^']*'/g, "''");   // 문자열 리터럴 제거 후 키워드 검사
  assert.doesNotMatch(code, /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
  assert.equal(verify.trim().split(';').filter(x => x.trim()).length, 1);
});
