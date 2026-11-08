import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

/* 실제 센터 허용 목록 SQL — 적용 / 롤백 / 재적용 / 실패 시 원자적 취소를 PGlite(실제 PostgreSQL 엔진, Docker·포트 사용 없음)로 검증한다.
   함수 정의는 P2 파일에서 그대로 만들고, pg_get_functiondef MD5 가 운영 기준값(적용 전)과 같음을 먼저 확인한다 — 그래서 preflight·롤백의 해시 검사를 운영과 같은 조건으로 시험한다. */
const read = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const P2 = read('add_nicepay_review_center_isolation_20261028.sql'), APPLY = read('add_nicepay_review_real_center_grants_20261103.sql'), ROLLBACK = read('rollback_add_nicepay_review_real_center_grants_20261103.sql');
const PRE = { allowed: '636cb33ff0feaf95244ef0c41c3eb923', member: 'a3a299f743087d104ebf41948e464d94', guard: '0e8dc90f9da6cb921225657ba6ae4fb4' };
const SIG = { allowed: 'public.nicepay_review_center_allowed(uuid)', member: 'public.nicepay_review_center_member_allowed(uuid)', guard: 'public.nicepay_review_guard_center()' };
const fn = (n) => (new RegExp(`create or replace function ${n}\\(.*?(?:\\n\\$\\$;|\\nend \\$\\$;)\\n`, 's').exec(P2) ?? [''])[0];
const ACC = '00000000-0000-0000-0000-0000000000a1', CEN = '00000000-0000-0000-0000-00000000c001';

async function world() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table accounts(id uuid primary key, auth_id uuid, nicepay_review_access boolean default false, deactivated_at timestamptz);
    create table centers(id uuid primary key, name text, status text, is_internal boolean default false, is_nicepay_review boolean default false);
    create table classes(id uuid primary key, center_id uuid); create table memberships(id uuid primary key, center_id uuid); create table products(id uuid primary key, center_id uuid);
    create function my_account_id() returns uuid language sql stable as $$ select null::uuid $$;
    create function my_managed_center_ids() returns setof uuid language sql stable as $$ select null::uuid where false $$;
    create function is_platform_admin() returns boolean language sql stable as $$ select false $$;
    create function nicepay_is_reviewer() returns boolean language sql stable as $$ select false $$;
    create function nicepay_is_client_request() returns boolean language sql stable as $$ select false $$;`);
  for (const n of ['nicepay_review_center_allowed', 'nicepay_review_center_member_allowed', 'nicepay_review_guard_center']) await db.exec(fn(n));
  return db;
}
const hashes = async (db) => Object.fromEntries(await Promise.all(Object.entries(SIG).map(async ([k, s]) => [k, (await db.query(`select md5(pg_get_functiondef('${s}'::regprocedure)) m`)).rows[0].m])));
const run = async (db, sql) => { try { await db.exec(sql); return { ok: true, err: '' }; } catch (e) { try { await db.exec('rollback'); } catch { /* 이미 종료 */ } return { ok: false, err: String(e.message) }; } };
const exists = async (db) => (await db.query(`select to_regclass('public.nicepay_review_center_grants') is not null t, to_regprocedure('nicepay_review_center_granted(uuid)') is not null f`)).rows[0];
const seedRow = (db) => db.exec(`insert into accounts values ('${ACC}', null, true, null); insert into centers values ('${CEN}', 'c', 'approved', false, false); insert into nicepay_review_center_grants(account_id, center_id) values ('${ACC}', '${CEN}');`);

test('PGlite 의 P2 함수 정의 MD5 가 운영 기준값(적용 전)과 같다 — 해시 검사를 운영과 같은 조건으로 시험할 수 있다', async () => {
  assert.deepEqual(await hashes(await world()), PRE);
});

test('적용 → 적용본 해시 → 재적용(멱등) → 롤백 → 원본 해시 복원 → 롤백 재실행 → 재적용', async () => {
  const db = await world();
  assert.ok((await run(db, APPLY)).ok, '적용'); assert.deepEqual(await exists(db), { t: true, f: true });
  const applied = await hashes(db); assert.notDeepEqual(applied, PRE);
  assert.ok((await run(db, APPLY)).ok, '재적용(멱등)'); assert.deepEqual(await hashes(db), applied);
  const rb = await run(db, ROLLBACK); assert.ok(rb.ok, rb.err); assert.deepEqual(await hashes(db), PRE); assert.deepEqual(await exists(db), { t: false, f: false });
  assert.ok((await run(db, ROLLBACK)).ok, '이미 복원된 상태에서 롤백 재실행'); assert.deepEqual(await hashes(db), PRE);
  assert.ok((await run(db, APPLY)).ok, '롤백 후 재적용'); assert.deepEqual(await hashes(db), applied);
});

test('허용 행이 있으면 롤백은 변경 없이 중단하고 계정·센터 목록을 보여 준다 — 전체 삭제를 권하지 않는다', async () => {
  const db = await world(); await run(db, APPLY); await seedRow(db); const before = await hashes(db);
  const rb = await run(db, ROLLBACK); assert.equal(rb.ok, false); assert.match(rb.err, /롤백 중단: 허용 목록에 행이 있어요/); assert.ok(rb.err.includes(ACC) && rb.err.includes(CEN), '계정·센터가 메시지에 보임');
  assert.deepEqual(await hashes(db), before); assert.equal((await exists(db)).t, true);
  assert.equal((await db.query('select count(*)::int n from nicepay_review_center_grants')).rows[0].n, 1);
  await db.exec(`delete from nicepay_review_center_grants where account_id = '${ACC}' and center_id = '${CEN}'`);   // 계정·센터를 지정한 개별 해제
  assert.ok((await run(db, ROLLBACK)).ok); assert.deepEqual(await hashes(db), PRE);
});

test('현재 정의가 (적용본|원본)이 아니면 롤백은 아무것도 바꾸지 않고 중단한다', async () => {
  const db = await world(); await run(db, APPLY); const applied = await hashes(db);
  await db.exec(`create or replace function public.nicepay_review_center_allowed(p_center_id uuid) returns boolean language sql stable security definer set search_path=public as $$ select true $$`);
  const tampered = await hashes(db);
  const rb = await run(db, ROLLBACK); assert.equal(rb.ok, false); assert.match(rb.err, /롤백 중단: .* 현재 정의가 예상/);
  assert.deepEqual(await hashes(db), tampered, '변조된 정의 그대로'); assert.equal((await hashes(db)).member, applied.member, '다른 함수도 복원되지 않음'); assert.deepEqual(await exists(db), { t: true, f: true }, '새 객체도 삭제되지 않음');
});

test('복원 후 MD5 가 원본과 다르면 EXCEPTION 으로 트랜잭션 전체가 취소된다(복원·삭제 모두 되돌아감)', async () => {
  const db = await world(); await run(db, APPLY); const applied = await hashes(db);
  const bad = ROLLBACK.replace('else not nicepay_is_reviewer()\n    end;', 'else true\n    end;');   // 복원될 allowed 정의를 일부러 틀리게 만든다
  assert.notEqual(bad, ROLLBACK, '시험용 변조 적용됨');
  const rb = await run(db, bad); assert.equal(rb.ok, false); assert.match(rb.err, /롤백 취소: 복원한 .* 정의가 적용 전 운영 값과 달라요/);
  assert.deepEqual(await hashes(db), applied, '함수 정의는 롤백 이전(적용본) 그대로');
  assert.deepEqual(await exists(db), { t: true, f: true }, '삭제된 줄 알았던 테이블·함수가 그대로 남아 있음(원자적 취소)');
  assert.equal((await db.query(`select count(*)::int n from pg_trigger where tgname = 'trg_nicepay_review_center_grant_valid'`)).rows[0].n, 1, '트리거도 그대로');
  assert.ok((await run(db, ROLLBACK)).ok, '정상 롤백은 이후에도 성공'); assert.deepEqual(await hashes(db), PRE);
});

test('정적: 롤백은 WARNING 을 쓰지 않고, 전체 삭제(delete from … ;)를 안내하지 않으며 개별 해제 절차를 담는다', async () => {
  const code = ROLLBACK.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(ROLLBACK, /raise warning/i); assert.doesNotMatch(ROLLBACK, /delete\s+from\s+nicepay_review_center_grants\s*;/i);
  assert.match(ROLLBACK, /where account_id = '<심사관 account id>' and center_id = '<센터 UUID>'/); assert.match(code, /raise exception '롤백 취소/);
  assert.equal(createHash('md5').update('x').digest('hex').length, 32);
});
