// 격리 PostgreSQL(PGlite) — NICEPAY provider DB 기반 + 일반 환불 PG 우회 차단.
// 저장소의 라이브 정의를 그대로 설치한다(스텁 아님): orders_guard_status_transition / orders_restore_points_on_cancel / orders_force_server_fields_on_insert 트리거,
//   _issue_membership_and_record_payment / fulfill_order / _refund_membership_core(KST판) / confirm_real_payment / cancel_real_payment / confirm_test_payment / refund_membership(_server) / admin_center_settlement_summary.
// 스텁인 것: 날짜·쿠폰·자동예약과 무관한 보조 함수(member_can_purchase_product, _order_expected_amount, _order_auto_book, _refund_block_reason, ensure_center_member)와 포인트 복원 기록 함수.
// DEV/Production 접속 없음. 실행: node --test tests/sql/nicepay-provider-support.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const slice = (src, start, endMarker) => { const a = src.search(start); assert.ok(a >= 0, `start not found: ${start}`); const b = src.indexOf(endMarker, a); assert.ok(b > a, `end not found: ${endMarker}`); return src.slice(a, b + endMarker.length); };
const lifecycle = read('fix_pg_payment_lifecycle.sql');
const kst = read('fix_pg_order_refund_kst_dates_20261004.sql');
const issuance = read('fix_order_issuance_and_auto_booking.sql');
const confirmReal = read('add_confirm_real_payment.sql');
const pointLife = read('fix_order_point_lifecycle.sql');
const settlementSrc = read('fix_admin_settlement_summary_use_payment_provider.sql');
const refundFix = read('fix_refund_block_all_pg_providers_20261016.sql');
const refundRollback = read('rollback_fix_refund_block_all_pg_providers_20261016.sql');
const cosFix = read('fix_create_order_secure_allow_nicepay_20261016.sql');
const cosRollback = read('rollback_fix_create_order_secure_allow_nicepay_20261016.sql');
const preflight = stripCommentsEarly(read('preflight_nicepay_patch_targets_20261016.sql'));
function stripCommentsEarly(x) { return x.replace(/^\s*--.*$/gm, ''); }
const support = read('add_nicepay_provider_support_20261016.sql');
const supportRollback = read('rollback_add_nicepay_provider_support_20261016.sql');
const stripComments = s => s.replace(/^\s*--.*$/gm, '');

const id = (k, n) => `${String(k).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C1 = id(1, 1), CI = id(1, 2), P1 = id(2, 1), ACC = id(3, 1), AUTH = id(3, 9), MGR = id(3, 2), PROD = id(4, 1);

const liveHelper = slice(kst, /CREATE OR REPLACE FUNCTION public\._issue_membership_and_record_payment/, '$function$;');
const liveFulfill = slice(kst, /CREATE OR REPLACE FUNCTION public\.fulfill_order/, '$function$;');
const liveCore = slice(kst, /CREATE OR REPLACE FUNCTION public\._refund_membership_core/, '$function$;');
const liveForceInsert = slice(lifecycle, /create or replace function orders_force_server_fields_on_insert\(\)/, 'execute function orders_force_server_fields_on_insert();');
const liveStatusGuard = slice(pointLife, /create or replace function orders_guard_status_transition\(\)/, 'execute function orders_guard_status_transition();');
const liveRestoreTrigger = slice(pointLife, /create or replace function orders_restore_points_on_cancel\(\)/, 'execute function orders_restore_points_on_cancel();');
const liveRefundWrappers = slice(lifecycle, /create or replace function refund_membership\(p_membership_id uuid\)/, 'grant execute on function refund_membership_server(uuid, uuid, boolean, boolean) to service_role;');
const liveAccountFor = slice(lifecycle, /create or replace function _account_id_for_auth/, 'revoke all on function _account_id_for_auth(uuid) from public, anon, authenticated;');
const liveConfirmReal = slice(issuance, /create or replace function public\.confirm_real_payment/, '$function$;');
const liveCancelReal = slice(confirmReal, /create or replace function cancel_real_payment/, '$$;');
const liveConfirmTest = slice(lifecycle, /CREATE OR REPLACE FUNCTION public\.confirm_test_payment/, '$function$;');
const liveSettlement = slice(settlementSrc, /create or replace function admin_center_settlement_summary/, '\n$$;');

// 운영 정의 형태 재현: CRLF 줄바꿈, '[NEW 2026-10-02]' 주석 없음(운영 fulfill_order). 저장소 정의를 변환해 설치한다.
const toCrlf = t => t.replace(/\r?\n/g, '\r\n');
const dropNewComment = t => t.replace(/^[ \t]*-- \[NEW 2026-10-02\][^\n]*\n/m, '');
async function world({ refundFixApplied = true, supportApplied = true, crlf = false, noComment = false } = {}) {
  const shape = t => { let x = t; if (noComment) x = dropNewComment(x); if (crlf) x = toCrlf(x); return x; };
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    create function my_account_id() returns uuid language sql stable as $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;
    create table perms(account_id uuid, center_id uuid, perm text);
    create function has_permission(c uuid, p text) returns boolean language sql stable as $$ select exists (select 1 from perms where account_id = my_account_id() and center_id = c and perm = p) $$;
    create function is_platform_admin() returns boolean language sql stable as $$ select coalesce(current_setting('app.platform_admin', true), '') = 'on' $$;
    create table accounts(id uuid primary key, auth_id uuid, merged_into uuid);
    create table account_auth_identities(account_id uuid, auth_id uuid);
    create table profiles(id uuid primary key, account_id uuid);
    create function my_profile_ids() returns setof uuid language sql stable as $$ select id from profiles where account_id = my_account_id() $$;
    create table centers(id uuid primary key, name text default 'c', is_internal boolean not null default false);
    create table center_settlement_accounts(center_id uuid, bank_name text, account_number text, account_holder_name text);
    create table products(id uuid primary key, center_id uuid, name text, purchase_count_selectable boolean default false, unlimited_pass boolean default false, total_count int default 10,
      expiry_mode text default 'none', expiry_date date, expiry_days int, rolling_month_cutoff_day int default 15, rolling_month_allow_early_use boolean default false);
    create table orders(id uuid primary key default gen_random_uuid(), profile_id uuid, center_id uuid, product_id uuid, product_name text, amount int default 10000, selected_count int,
      selected_day_of_week int, selected_start_time time, selected_size text, auto_book boolean, member_coupon_id uuid,
      status text default 'pending' constraint orders_status_check check (status in ('pending','paid','cancelled','done')),
      paid_at timestamptz, verified boolean default true, pay_method text default 'card',
      payment_provider text constraint orders_payment_provider_check check (payment_provider is null or payment_provider in ('mock','toss','portone')));
    create table memberships(id uuid primary key default gen_random_uuid(), profile_id uuid, center_id uuid, product_id uuid, product_name text, pass_type text, total_count int, remaining_count int,
      expires_at date, starts_at date, status text default 'active', bound_day_of_week int, bound_start_time time, selected_size text, auto_book_requested boolean, pg_refund_started_at timestamptz);
    create table payments(id uuid primary key default gen_random_uuid(), center_id uuid, profile_id uuid, membership_id uuid, order_id uuid, sale_type text, revenue_category text,
      card_amount int, cash_amount int, transfer_amount int, point_amount int, direct_amount int, total_amount int, unpaid_amount int, pg_transaction_id text, paid_at timestamptz, status text, memo text,
      payment_provider text constraint payments_payment_provider_check check (payment_provider is null or payment_provider in ('mock','toss','portone')));
    create table member_coupons(id uuid primary key, status text, used_at timestamptz, order_id uuid);
    create table center_members(center_id uuid, profile_id uuid, status text default 'active');
    create table restored_points(order_id uuid, reason text);
    create function _refund_block_reason(m memberships, b boolean default false) returns text language sql as $$ select null::text $$;
    create function _restore_order_points(o uuid, r text) returns void language sql as $$ insert into restored_points values (o, r) $$;
    create function ensure_center_member(uuid, uuid) returns void language sql as $$ select 1 $$;
    create function member_can_purchase_product(uuid, uuid) returns boolean language sql as $$ select true $$;
    create function _order_expected_amount(o orders, b boolean) returns int language sql as $$ select o.amount $$;
    create function _order_auto_book(uuid, boolean) returns jsonb language sql as $$ select '{}'::jsonb $$;
    insert into centers values ('${C1}', 'c1', false), ('${CI}', 'ci', true);
    insert into accounts values ('${ACC}', '${AUTH}', null);
    insert into profiles values ('${P1}', '${ACC}');
    insert into products(id, center_id, name) values ('${PROD}', '${C1}', 'p');
    insert into perms values ('${MGR}', '${C1}', 'pass.payment.create'), ('${MGR}', '${CI}', 'pass.payment.create');
    insert into center_settlement_accounts values ('${C1}', 'bank', '123', 'holder');
    ${liveAccountFor}
    ${liveForceInsert}
    ${liveStatusGuard}
    ${liveRestoreTrigger}
    ${shape(liveHelper)}
    ${shape(liveFulfill)}
    ${liveRefundWrappers}
    ${liveConfirmReal}
    ${liveCancelReal}
    ${liveConfirmTest}
    ${shape(liveSettlement)}
    revoke all on function public._issue_membership_and_record_payment(orders, text, text) from public, anon, authenticated, service_role;
  `);
  await db.exec(shape(liveCore));
  await db.exec(`revoke all on function public._refund_membership_core(uuid, uuid, boolean, boolean) from public, anon, authenticated, service_role;`);
  if (refundFixApplied) await db.exec(refundFix);   // 적용 순서: ① 환불 차단 수정 → ② NICEPAY 지원(환불 core 패치 포함)
  if (supportApplied) await db.exec(support);
  return db;
}
const asUser = async (db, fn) => { await db.exec(`select set_config('app.uid','${AUTH}',false), set_config('app.account_id','${ACC}',false);`); try { return await fn(); } finally { await db.exec(`select set_config('app.uid','',false), set_config('app.account_id','',false);`); } };
const asManager = async (db, fn) => { await db.exec(`select set_config('app.uid','${MGR}',false), set_config('app.account_id','${MGR}',false);`); try { return await fn(); } finally { await db.exec(`select set_config('app.uid','',false), set_config('app.account_id','',false);`); } };
const mkOrder = async (db, provider, { center = C1, amount = 10000, status = 'pending' } = {}) => {
  const oid = id(5, Math.floor(Math.random() * 1e9));
  await db.exec(`insert into orders(id, profile_id, center_id, product_id, product_name, amount, status, payment_provider) values ('${oid}','${P1}','${center}','${PROD}','p',${amount},'${status}',${provider ? `'${provider}'` : 'null'})`);
  return oid;
};
const q1 = async (db, sql) => (await db.query(sql)).rows[0];
const count = async (db, t, where = 'true') => Number((await q1(db, `select count(*)::int c from ${t} where ${where}`)).c);
const rejects = async (p, re) => { try { await p; } catch (e) { if (re) assert.match(String(e.message), re); return; } assert.fail('예외가 나야 한다'); };
const asServer = (db, sql) => db.exec(sql);   // service_role 대리: app.uid 없음(auth.uid() null)
async function paidMembership(db, provider, { amount = 10000 } = {}) {   // 환불 시나리오용: 완료 주문 + 수강권 + 매출을 직접 구성
  const oid = await mkOrder(db, provider, { amount, status: 'done' });
  const mid = id(6, Math.floor(Math.random() * 1e9));
  if (provider === 'nicepay') await db.exec(`update orders set pg_tid = 'NP-${oid.slice(-9)}' where id='${oid}'`);
  await db.exec(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ('${mid}','${P1}','${C1}','${PROD}','p',10,10);
    insert into payments(center_id, profile_id, membership_id, order_id, sale_type, total_amount, pg_transaction_id, paid_at, status) values ('${C1}','${P1}','${mid}','${oid}','new',${amount},'tid-${mid.slice(-6)}',now(),'paid');`);
  return { oid, mid };
}
const recordCancel = (db, oid, amount = 10000, tid = 'CXL-' + oid.slice(-8)) => db.query(`select nicepay_record_pg_cancel('${oid}', '${tid}', ${amount}, 'api_response', 'system') r`);
const claim = async (db, oid) => (await q1(db, `select nicepay_claim_order('${oid}') c`)).c;

// ---------------------------------------------------------------- 환불(A) ----
test('A. 일반 환불: 수정 전 라이브 정의는 nicepay를 막지 못한다(우회 재현), 수정 후에는 모든 PG 값을 막고 NULL/mock은 유지', async () => {
  const before = await world({ refundFixApplied: false });
  try {
    await before.exec(liveCore);   // 수정 전(라이브) 환불 core 재설치 — 허용 목록 수정도, NICEPAY 취소 확인 가드도 없는 상태
    await before.exec(`revoke all on function public._refund_membership_core(uuid, uuid, boolean, boolean) from public, anon, authenticated, service_role;`);
    const n = await paidMembership(before, 'nicepay');
    const r = await asUser(before, () => before.query(`select refund_membership('${n.mid}') r`));
    assert.equal(r.rows[0].r.refunded, true, '수정 전: nicepay 결제 건이 PG 취소 없이 DB에서만 환불된다(= 우회 위험)');
  } finally { await before.close(); }
  const db = await world();
  try {
    for (const p of ['nicepay', 'toss', 'portone']) {
      const { mid } = await paidMembership(db, p);
      await asUser(db, () => rejects(db.query(`select refund_membership('${mid}')`), /환불 요청 기능/));
      assert.equal((await q1(db, `select status from memberships where id='${mid}'`)).status, 'active', `${p}: 수강권 상태 불변`);
      assert.equal(await count(db, 'payments', `membership_id='${mid}' and sale_type='refund'`), 0, `${p}: 환불 매출 행 없음`);
    }
    for (const p of [null, 'mock']) {
      const { mid } = await paidMembership(db, p);
      assert.equal((await asUser(db, () => db.query(`select refund_membership('${mid}') r`))).rows[0].r.refunded, true, `${p}: 환불 유지`);
    }
    const mid = id(6, 777); await db.exec(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ('${mid}','${P1}','${C1}','${PROD}','p',10,10)`);
    assert.equal((await asUser(db, () => db.query(`select refund_membership('${mid}') r`))).rows[0].r.refunded, true);
  } finally { await db.close(); }
});

test('A2. 서버 경로(refund_membership_server, p_allow_pg=true)는 PG 건도 환불 마무리 가능, 서버 전용 권한 유지', async () => {
  const db = await world();
  try {
    for (const p of ['nicepay', 'toss']) {
      const { oid, mid } = await paidMembership(db, p);
      if (p === 'nicepay') {   // 실제 PG 취소 확인 기록 전에는 서버 경로(allow_pg=true)도 내부 환불 불가
        await rejects(db.query(`select refund_membership_server('${mid}','${AUTH}', true, false)`), /PG 승인 취소가 확인된 뒤에만/);
        assert.equal((await q1(db, `select status from memberships where id='${mid}'`)).status, 'active');
        await recordCancel(db, oid);
      }
      assert.equal((await db.query(`select refund_membership_server('${mid}','${AUTH}', true, false) r`)).rows[0].r.refunded, true, p);
      const { mid: m2 } = await paidMembership(db, p);
      await rejects(db.query(`select refund_membership_server('${m2}','${AUTH}', false, false)`), /환불 요청 기능/);
    }
    const priv = await q1(db, `select has_function_privilege('authenticated','public._refund_membership_core(uuid,uuid,boolean,boolean)','execute') a, has_function_privilege('service_role','public._refund_membership_core(uuid,uuid,boolean,boolean)','execute') s, has_function_privilege('authenticated','refund_membership_server(uuid,uuid,boolean,boolean)','execute') sv`);
    assert.deepEqual(priv, { a: false, s: false, sv: false });
  } finally { await db.close(); }
});

// ---------------------------------------------------------------- CHECK(B) ----
test('B. CHECK 제약: nicepay 추가, 기존 값·기존 데이터 호환, 잘못된 값 거부 (기존 행이 있는 상태에서 적용 가능)', async () => {
  const db = await world({ supportApplied: false, refundFixApplied: false });
  try {
    await rejects(mkOrder(db, 'nicepay'), /orders_payment_provider_check/);
    await mkOrder(db, 'toss'); await mkOrder(db, 'portone'); await mkOrder(db, 'mock'); await mkOrder(db, null);
    await db.exec(support);
    await mkOrder(db, 'nicepay');
    assert.equal(await count(db, 'orders', "payment_provider = 'toss'"), 1); assert.equal(await count(db, 'orders', "payment_provider = 'portone'"), 1);
    await rejects(mkOrder(db, 'kakao'), /orders_payment_provider_check/);
    await rejects(db.exec(`insert into payments(id, payment_provider) values (gen_random_uuid(), 'stripe')`), /payments_payment_provider_check/);
    await db.exec(`insert into payments(id, payment_provider) values (gen_random_uuid(), 'nicepay'), (gen_random_uuid(), 'toss')`);
    await rejects(mkOrder(db, 'mock', { status: 'weird' }), /orders_status_check/);
  } finally { await db.close(); }
});

// ---------------------------------------------------------------- 레거시 호환(C, D) ----
test('C. 기존 Toss/PortOne 호환: 같은 라이브 helper로 만든 payments 행이 적용 전/후 동일(provider NULL 유지), nicepay 주문은 confirm_real_payment 거부', async () => {
  const snapshot = async (db, p) => {
    const oid = await mkOrder(db, p, { amount: 7000 });
    const r = (await db.query(`select confirm_real_payment('${oid}', 'pk_${p}', 7000) r`)).rows[0].r;
    assert.equal(r.already_done, false);
    assert.equal((await q1(db, `select status from orders where id='${oid}'`)).status, 'done');
    assert.equal((await db.query(`select confirm_real_payment('${oid}', 'pk_${p}', 7000) r`)).rows[0].r.already_done, true, '멱등');
    return q1(db, `select sale_type, revenue_category, card_amount, total_amount, pg_transaction_id, status, memo, payment_provider from payments where order_id='${oid}'`);
  };
  const before = await world({ supportApplied: false, refundFixApplied: false });
  const after = await world();
  try {
    for (const p of ['toss', 'portone']) {
      const a = await snapshot(before, p), b = await snapshot(after, p);
      assert.deepEqual(b, a, `${p}: 적용 전/후 결제 행이 완전히 같다`);
      assert.equal(b.payment_provider, null, `${p}: 기존 기록 방식(NULL) 유지 — 과거 거래 일괄 수정 없음`);
      assert.equal(await count(after, 'memberships'), await count(after, 'payments', "sale_type='new'"));
    }
    const n = await mkOrder(after, 'nicepay');
    await rejects(after.query(`select confirm_real_payment('${n}', 'pk', 10000)`), /실제 PG 주문에만/);
    await rejects(after.query(`select cancel_real_payment('${n}')`), /실제 PG 주문에만/);
    const t = await mkOrder(after, 'toss');
    assert.deepEqual((await after.query(`select cancel_real_payment('${t}') r`)).rows[0].r, { cancelled: true });
    assert.equal(/nicepay/.test((await q1(after, `select pg_get_functiondef('confirm_real_payment(uuid,text,integer)'::regprocedure) d`)).d), false);
  } finally { await before.close(); await after.close(); }
});

test('C2. 과거 Toss 완료 거래의 환불 호환: 완료된 toss 주문은 일반 환불 차단·서버 경로 환불 가능, 환불 행/수강권 상태는 기존과 동일', async () => {
  const db = await world();
  try {
    const oid = await mkOrder(db, 'toss', { amount: 9000 });
    await db.query(`select confirm_real_payment('${oid}', 'pk_t', 9000)`);
    const mid = (await q1(db, `select membership_id m from payments where order_id='${oid}'`)).m;
    await asUser(db, () => rejects(db.query(`select refund_membership('${mid}')`), /환불 요청 기능/));
    const r = (await db.query(`select refund_membership_server('${mid}','${AUTH}', true, false) r`)).rows[0].r;
    assert.deepEqual(r, { refunded: true, amount: 9000 });
    assert.equal(await count(db, 'payments', `membership_id='${mid}' and sale_type='refund' and total_amount=-9000`), 1);
    assert.equal((await q1(db, `select status from memberships where id='${mid}'`)).status, 'refunded');
  } finally { await db.close(); }
});

test('D. Mock QA 유지: confirm_test_payment는 mock + 내부 QA 센터에서만, nicepay/toss 주문 불가, mock 결제 행 provider는 기존대로 NULL', async () => {
  const db = await world();
  try {
    const ok = await mkOrder(db, 'mock', { center: CI });
    assert.equal((await asUser(db, () => db.query(`select confirm_test_payment('${ok}', 'mock_ref') r`))).rows[0].r.already_done, false);
    assert.equal((await q1(db, `select payment_provider p from payments where order_id='${ok}'`)).p, null);
    const nonInternal = await mkOrder(db, 'mock', { center: C1 });
    await asUser(db, () => rejects(db.query(`select confirm_test_payment('${nonInternal}', 'mock_ref')`), /내부 QA 센터/));
    for (const p of ['nicepay', 'toss']) { const o = await mkOrder(db, p, { center: CI }); await asUser(db, () => rejects(db.query(`select confirm_test_payment('${o}', 'x')`), /Mock 결제 주문에만/)); }
  } finally { await db.close(); }
});

// ---------------------------------------------------------------- 상태 전이(E) — 실제 트리거 ----
test('E1. 실제 orders_guard_status_transition 위에서: 확장 전에는 approving 전이가 막힌다(문제 재현), 확장 후 NICEPAY RPC가 정상 동작', async () => {
  const db = await world();
  try {
    const o = await mkOrder(db, 'nicepay');
    assert.ok(await claim(db, o), '확장된 트리거에서 claim 성공');
    // 확장 전 트리거(라이브 원본)로 되돌리면 같은 RPC가 실패 — 보완이 없으면 NICEPAY가 동작하지 않았을 것
    await db.exec(`${liveStatusGuard}`);
    const o2 = await mkOrder(db, 'nicepay');
    await rejects(db.query(`select nicepay_claim_order('${o2}')`), /허용되지 않는 주문 상태 변경이에요\(pending → approving\)/);
  } finally { await db.close(); }
});

test('E2. 기존 전이 보존: toss/portone/mock/직접결제(NULL) — pending→paid/done/cancelled, paid→done/cancelled 허용, done/cancelled에서 이탈 불가, approving 진입 불가(표시 있어도 provider≠nicepay)', async () => {
  const db = await world();
  try {
    for (const p of ['toss', 'portone', 'mock', null]) {
      for (const [from, to, ok] of [['pending', 'paid', true], ['pending', 'done', true], ['pending', 'cancelled', true], ['paid', 'done', true], ['paid', 'cancelled', true], ['paid', 'pending', false], ['pending', 'approving', false]]) {
        const o = await mkOrder(db, p, { status: 'pending' });
        if (from === 'paid') await db.exec(`update orders set status='paid' where id='${o}'`);
        const run = db.exec(`update orders set status='${to}' where id='${o}'`);
        if (ok) await run; else await rejects(run, /허용되지 않는|서버 승인 처리로만|approving 상태는/);
      }
      const d = await mkOrder(db, p); await db.exec(`update orders set status='done' where id='${d}'`);
      await rejects(db.exec(`update orders set status='cancelled' where id='${d}'`), /이미 발급된 주문/);
      const c = await mkOrder(db, p); await db.exec(`update orders set status='cancelled' where id='${c}'`);
      await rejects(db.exec(`update orders set status='pending' where id='${c}'`), /이미 취소된 주문/);
    }
    // 표시(app.nicepay_write)를 세워도 provider가 nicepay가 아니면 approving 불가
    const o = await mkOrder(db, 'toss'); await db.exec(`select set_config('app.nicepay_write','on',false)`);
    await rejects(db.exec(`update orders set status='approving' where id='${o}'`), /NICEPAY 주문에만/);
    await db.exec(`select set_config('app.nicepay_write','',false)`);
    // 취소 시 포인트 복원 트리거는 그대로
    const cn = await mkOrder(db, 'toss'); await db.exec(`update orders set status='cancelled' where id='${cn}'`);
    assert.equal(await count(db, 'restored_points', `order_id='${cn}'`), 1);
  } finally { await db.close(); }
});

test('E3. NICEPAY 주문 전이: 표시 없이는 pending→cancelled만(회원 취소 경로), 표시 있으면 승인 흐름 전이만 허용', async () => {
  const db = await world();
  try {
    const o = await mkOrder(db, 'nicepay');
    // 표시 없는 직접 UPDATE(서버 포함)는 paid/done/approving 모두 거부
    for (const to of ['paid', 'done', 'approving']) await rejects(db.exec(`update orders set status='${to}' where id='${o}'`), /서버 승인 처리로만/);
    // 회원 본인 취소 경로(pending→cancelled)는 유지되고 포인트 복원도 동작
    const c = await mkOrder(db, 'nicepay');
    await asUser(db, () => db.exec(`update orders set status='cancelled' where id='${c}'`));
    assert.equal(await count(db, 'restored_points', `order_id='${c}'`), 1);
    // 표시 있을 때의 허용/거부 전이
    await db.exec(`select set_config('app.nicepay_write','on',false)`);
    try {
      await db.exec(`update orders set status='approving' where id='${o}'`);
      await rejects(db.exec(`update orders set status='done' where id='${o}'`), /허용되지 않는 주문 상태 변경/);       // approving→done 직접 불가
      await rejects(db.exec(`update orders set status='paid' where id='${o}'`), /허용되지 않는 주문 상태 변경/);        // pg_tid 없이 approving→paid 불가
      await db.exec(`update orders set pg_tid='T1', pg_claim_id=gen_random_uuid() where id='${o}'`);
      await db.exec(`update orders set status='paid' where id='${o}'`);
      await db.exec(`update orders set status='done' where id='${o}'`);
      await rejects(db.exec(`update orders set status='pending' where id='${o}'`), /이미 발급된 주문/);
    } finally { await db.exec(`select set_config('app.nicepay_write','',false)`); }
  } finally { await db.close(); }
});

test('E4. 일반 로그인 사용자 경계: approving 진입/이탈, pg_* 변경, nicepay provider 변경, 위조 INSERT 모두 불가. RPC는 service_role만', async () => {
  const db = await world();
  try {
    const oid = id(5, 4242);
    await asUser(db, () => db.exec(`insert into orders(id, profile_id, center_id, product_id, product_name, amount, status, payment_provider, pg_tid, pg_claim_id, pg_review_at)
      values ('${oid}','${P1}','${C1}','${PROD}','p',1000,'approving','nicepay','forged-tid', gen_random_uuid(), now())`));
    assert.deepEqual(await q1(db, `select status, pg_tid, pg_claim_id, pg_review_at from orders where id='${oid}'`), { status: 'pending', pg_tid: null, pg_claim_id: null, pg_review_at: null });
    for (const sql of [`status='approving'`, `pg_tid='x'`, `pg_review_at=now()`, `payment_provider='mock'`]) await asUser(db, () => rejects(db.exec(`update orders set ${sql} where id='${oid}'`), /서버|바꿀 수 없어요/));
    const m = await mkOrder(db, 'mock'); await asUser(db, () => rejects(db.exec(`update orders set payment_provider='nicepay' where id='${m}'`), /바꿀 수 없어요/));
    // 서버가 선점한 주문: 클라이언트가 어떤 상태로도 못 바꾼다
    const n = await mkOrder(db, 'nicepay'); assert.ok(await claim(db, n));
    for (const st of ['cancelled', 'pending', 'done', 'paid']) await asUser(db, () => rejects(db.exec(`update orders set status='${st}' where id='${n}'`), /서버/));
    assert.equal((await q1(db, `select status from orders where id='${n}'`)).status, 'approving');
    // 클라이언트(authenticated 롤)는 RPC/감사 테이블 접근 불가
    await db.exec('set role authenticated');
    try {
      await rejects(db.query(`select nicepay_claim_order('${n}')`), /permission denied/);
      await rejects(db.query(`select * from nicepay_review_actions`), /permission denied/);
    } finally { await db.exec('reset role'); }
    // mock 확정(pending→paid→done) 등 기존 서버 작업은 영향 없음
    const mk = await mkOrder(db, 'mock', { center: CI });
    await asUser(db, () => db.query(`select confirm_test_payment('${mk}', 'r')`));
    assert.equal((await q1(db, `select status from orders where id='${mk}'`)).status, 'done');
  } finally { await db.close(); }
});

// ---------------------------------------------------------------- 선점·검토·감사(F) ----
test('F1. claim/release(근거 필수)/검토 대기/만료: 동시 승인 방지, fencing, 자동 복귀 금지, 감사 기록', async () => {
  const db = await world();
  try {
    const o = await mkOrder(db, 'nicepay');
    const c1 = await claim(db, o); assert.ok(c1);
    assert.equal(await claim(db, o), null, '두 번째 선점 거부');
    await rejects(db.query(`select nicepay_release_order('${o}', '${c1}', 'because')`), /복귀 근거/);
    assert.equal((await q1(db, `select nicepay_release_order('${o}', '${id(9, 1)}', 'approve_rejected') r`)).r, false, '다른 claim으로 복귀 불가');
    assert.equal((await q1(db, `select nicepay_release_order('${o}', '${c1}', 'netcancel_confirmed') r`)).r, true);
    const c2 = await claim(db, o); assert.notEqual(c1, c2);
    assert.equal((await q1(db, `select nicepay_mark_review('${o}', '${c2}', 'netcancel_failed') r`)).r, true);
    assert.equal((await q1(db, `select nicepay_release_order('${o}', '${c2}', 'approve_rejected') r`)).r, false, '검토 대기 주문은 자동 복귀 불가');
    assert.equal(await claim(db, o), null);
    await rejects(db.query(`select nicepay_mark_review('${o}', '${c2}', 'whatever')`), /알 수 없는 검토 사유/);
    assert.equal((await q1(db, `select nicepay_order_context('${o}') c`)).c.reviewPending, true);
    // 감사 기록: release(system, 근거) → mark_review
    const acts = (await db.query(`select action, evidence_type, actor from nicepay_review_actions where order_id='${o}' order by id`)).rows;
    assert.deepEqual(acts, [{ action: 'release', evidence_type: 'netcancel_confirmed', actor: 'system' }, { action: 'mark_review', evidence_type: 'netcancel_failed', actor: 'system' }]);
    // 오래된 선점은 자동 복귀가 아니라 검토 대기로
    const s = await mkOrder(db, 'nicepay'); await claim(db, s);
    await db.exec(`update orders set pg_claimed_at = now() - interval '2 hours' where id='${s}'`);
    assert.equal((await q1(db, `select nicepay_expire_stale_claims('30 minutes') n`)).n, 1);
    assert.deepEqual(await q1(db, `select status, pg_review_reason from orders where id='${s}'`), { status: 'approving', pg_review_reason: 'stale_claim' });
    assert.equal(await count(db, 'nicepay_review_actions', `order_id='${s}' and evidence_type='stale_claim'`), 1);
    for (const [p, st] of [['toss', 'pending'], ['mock', 'pending'], [null, 'pending'], ['nicepay', 'done'], ['nicepay', 'cancelled']]) assert.equal(await claim(db, await mkOrder(db, p, { status: st })), null, `${p}/${st}`);
  } finally { await db.close(); }
});

test('F2. 수동 해소: 증거 유형/번호/처리자 필수, 거래번호 있는 주문 불가, 포인트 복원, 추가 전용 감사 기록(수정·삭제 불가)', async () => {
  const db = await world();
  try {
    const o = await mkOrder(db, 'nicepay'); const c = await claim(db, o); await db.query(`select nicepay_mark_review('${o}', '${c}', 'netcancel_failed')`);
    const R = (action, type, ref, actor, note = null) => db.query(`select nicepay_resolve_review('${o}', '${action}', ${type ? `'${type}'` : 'null'}, ${ref ? `'${ref}'` : 'null'}, ${actor ? `'${actor}'` : 'null'}, ${note ? `'${note}'` : 'null'}) r`);
    await rejects(R('confirm', 'netcancel_confirmed', 'NC-0001', 'op'), /지원하지 않는 처리/);
    await rejects(R('release', null, 'NC-0001', 'op'), /증거 유형/);
    await rejects(R('release', 'pg_cancel_confirmed', 'NC-0001', 'op'), /증거 유형/);   // release에는 '취소 완료' 증거 불가(재시도 시 이중 결제 위험)
    await rejects(R('release', 'netcancel_confirmed', 'x', 'op'), /증거 번호/);
    await rejects(R('release', 'netcancel_confirmed', 'NC-0001', 'o'), /처리자/);
    assert.equal((await q1(db, `select status from orders where id='${o}'`)).status, 'approving', '증거 없는 시도는 아무것도 바꾸지 못한다');
    assert.equal(await count(db, 'nicepay_review_actions', `order_id='${o}' and action like 'resolve_%'`), 0);
    assert.deepEqual((await R('release', 'not_approved_confirmed', 'ADMIN-77', 'op-kim', '관리자 화면에서 미승인 확인')).rows[0].r, { resolved: 'release' });
    assert.deepEqual(await q1(db, `select status, pg_claim_id, pg_review_at from orders where id='${o}'`), { status: 'pending', pg_claim_id: null, pg_review_at: null });
    const row = await q1(db, `select action, evidence_type, evidence_ref, actor, note, status_before, status_after from nicepay_review_actions where order_id='${o}' and action='resolve_release'`);
    assert.deepEqual(row, { action: 'resolve_release', evidence_type: 'not_approved_confirmed', evidence_ref: 'ADMIN-77', actor: 'op-kim', note: '관리자 화면에서 미승인 확인', status_before: 'approving', status_after: 'pending' });
    // cancel: 포인트 복원(기존 취소 트리거), 거래번호 있는 주문은 불가
    const x = await mkOrder(db, 'nicepay'); const cx = await claim(db, x); await db.query(`select nicepay_mark_review('${x}', '${cx}', 'confirm_state_unknown')`);
    await db.query(`select nicepay_resolve_review('${x}', 'cancel', 'pg_cancel_confirmed', 'CXL-9999', 'op-lee', null)`);
    assert.equal((await q1(db, `select status from orders where id='${x}'`)).status, 'cancelled'); assert.equal(await count(db, 'restored_points', `order_id='${x}'`), 1);
    await rejects(db.query(`select nicepay_resolve_review('${x}', 'cancel', 'pg_cancel_confirmed', 'CXL-9999', 'op-lee', null)`), /검토 대기 중인 NICEPAY 주문이 아니에요/);
    const t = await mkOrder(db, 'nicepay'); const ct = await claim(db, t); await db.query(`select nicepay_mark_review('${t}', '${ct}', 'confirm_state_unknown')`);
    await db.exec(`update orders set pg_tid='TT-1' where id='${t}'`);
    await rejects(db.query(`select nicepay_resolve_review('${t}', 'release', 'netcancel_confirmed', 'NC-0002', 'op-lee', null)`), /거래번호가 기록된 주문/);
    // 추가 전용: superuser도 수정/삭제 불가
    await rejects(db.exec(`update nicepay_review_actions set actor='hacker'`), /수정하거나 삭제할 수 없어요/);
    await rejects(db.exec(`delete from nicepay_review_actions`), /수정하거나 삭제할 수 없어요/);
    await rejects(db.exec(`insert into nicepay_review_actions(order_id, action, evidence_type, actor) values ('${o}', 'resolve_cancel', 't', 'x')`), /nicepay_review_actions_actor_check|violates check/);
  } finally { await db.close(); }
});

// ---------------------------------------------------------------- 확정·provider 저장(G) — 실제 helper ----
test('G1. confirm_nicepay_payment: 실제 helper로 수강권 1개·결제 1행(provider=nicepay, TID, 금액), 중복 승인 멱등, fencing, 금액/provider/TID 검증', async () => {
  const db = await world();
  try {
    const o = await mkOrder(db, 'nicepay', { amount: 12000 });
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${id(9, 1)}', 'TID-1', 12000)`), /승인 처리 중인 주문이 아니에요/);   // 선점 전 확정 불가(PG 승인 전 발급 없음)
    assert.equal(await count(db, 'memberships'), 0);
    const c = await claim(db, o);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${id(9, 1)}', 'TID-1', 12000)`), /선점이 일치하지 않아요/);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-1', 11999)`), /금액이 주문 금액과 일치하지 않아요/);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', '', 12000)`), /거래번호가 올바르지 않아요/);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', null, 12000)`), /거래번호가 올바르지 않아요/);
    assert.equal(await count(db, 'memberships'), 0, '실패 호출은 수강권을 만들지 않는다');
    const r = (await q1(db, `select confirm_nicepay_payment('${o}', '${c}', 'TID-1', 12000) r`)).r;
    assert.equal(r.already_done, false); assert.equal(r.amount, 12000);
    assert.deepEqual(await q1(db, `select status, pg_tid from orders where id='${o}'`), { status: 'done', pg_tid: 'TID-1' });
    assert.deepEqual(await q1(db, `select payment_provider, pg_transaction_id, total_amount, sale_type, status from payments where order_id='${o}'`), { payment_provider: 'nicepay', pg_transaction_id: 'TID-1', total_amount: 12000, sale_type: 'new', status: 'paid' });
    for (let i = 0; i < 3; i++) assert.equal((await q1(db, `select confirm_nicepay_payment('${o}', '${c}', 'TID-1', 12000) r`)).r.already_done, true);
    await Promise.all([1, 2].map(() => db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-1', 12000)`)));
    assert.equal(await count(db, 'payments', `order_id='${o}' and sale_type='new'`), 1); assert.equal(await count(db, 'memberships'), 1);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-OTHER', 12000)`), /이미 다른 거래로 완료된 주문/);
    // TID 재사용 금지(롤백되어 수강권 없음), 오래된 claim 금지
    const o2 = await mkOrder(db, 'nicepay', { amount: 12000 }); const c2 = await claim(db, o2);
    await rejects(db.query(`select confirm_nicepay_payment('${o2}', '${c2}', 'TID-1', 12000)`), /orders_pg_tid_unique|duplicate key/);
    assert.deepEqual(await q1(db, `select status, pg_tid from orders where id='${o2}'`), { status: 'approving', pg_tid: null });
    assert.equal(await count(db, 'payments', `order_id='${o2}'`), 0); assert.equal(await count(db, 'memberships'), 1);
    await db.query(`select nicepay_release_order('${o2}', '${c2}', 'netcancel_confirmed')`); const c3 = await claim(db, o2);
    await rejects(db.query(`select confirm_nicepay_payment('${o2}', '${c2}', 'TID-2', 12000)`), /선점이 일치하지 않아요/);
    await db.query(`select confirm_nicepay_payment('${o2}', '${c3}', 'TID-2', 12000)`);
    for (const p of ['toss', 'mock', null]) await rejects(db.query(`select confirm_nicepay_payment('${await mkOrder(db, p)}', '${id(9, 1)}', 'T', 10000)`), /NICEPAY 주문에만/);
    await rejects(db.query(`select confirm_nicepay_payment('${id(9, 9)}', '${id(9, 1)}', 'T', 1)`), /주문을 찾을 수 없어요/);
  } finally { await db.close(); }
});

test('G2. provider 저장/일치 검증: 패치가 없으면(helper가 provider를 안 남기면) 확정은 전체 롤백 — 수강권 없음', async () => {
  const db = await world();
  try {
    await db.exec(liveHelper);   // 패치 이전 라이브 helper로 되돌림(payment_provider 미기록)
    const o = await mkOrder(db, 'nicepay'); const c = await claim(db, o);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-9', 10000)`), /결제 기록이 주문과 일치하지 않아요/);
    assert.equal(await count(db, 'memberships'), 0); assert.equal(await count(db, 'payments'), 0);
    assert.deepEqual(await q1(db, `select status, pg_tid from orders where id='${o}'`), { status: 'approving', pg_tid: null }, '전체 롤백');
  } finally { await db.close(); }
});

test('G3. 검토 대기 주문은 직접 확정 불가, nicepay_confirm_reviewed(증거·감사)로만 — 오래된 claim으로는 불가', async () => {
  const db = await world();
  try {
    const o = await mkOrder(db, 'nicepay', { amount: 5000 }); const c = await claim(db, o);
    await db.query(`select nicepay_mark_review('${o}', '${c}', 'confirm_state_unknown')`);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-R', 5000)`), /수동 확정 절차/);
    assert.equal(await count(db, 'memberships'), 0);
    await rejects(db.query(`select nicepay_confirm_reviewed('${o}', 'TID-R', 5000, 'x', 'op-kim', null)`), /증거 번호/);
    await rejects(db.query(`select nicepay_confirm_reviewed('${o}', 'TID-R', 5000, 'ADMIN-1', 'o', null)`), /처리자/);
    await rejects(db.query(`select nicepay_confirm_reviewed('${o}', 'TID-R', 4999, 'ADMIN-1', 'op-kim', null)`), /금액이 주문 금액과 일치하지 않아요/);
    assert.equal(await count(db, 'nicepay_review_actions', `action='resolve_confirm'`), 0, '실패한 시도는 기록이 롤백된다(증거 없는 확정 없음)');
    const r = (await q1(db, `select nicepay_confirm_reviewed('${o}', 'TID-R', 5000, 'ADMIN-1', 'op-kim', '관리자 화면 승인 확인') r`)).r;
    assert.equal(r.already_done, false);
    assert.deepEqual(await q1(db, `select status, pg_tid, pg_review_at from orders where id='${o}'`), { status: 'done', pg_tid: 'TID-R', pg_review_at: null });
    assert.deepEqual(await q1(db, `select action, evidence_type, evidence_ref, actor, tid from nicepay_review_actions where action='resolve_confirm'`), { action: 'resolve_confirm', evidence_type: 'pg_approved_confirmed', evidence_ref: 'ADMIN-1', actor: 'op-kim', tid: 'TID-R' });
    assert.equal(await count(db, 'memberships'), 1); assert.equal((await q1(db, `select payment_provider p from payments where order_id='${o}'`)).p, 'nicepay');
    // 표시(app.nicepay_review_ok)는 호출 후 남지 않는다 → 다음 검토 주문은 다시 직접 확정 불가
    const o2 = await mkOrder(db, 'nicepay'); const c2 = await claim(db, o2); await db.query(`select nicepay_mark_review('${o2}', '${c2}', 'stale_claim')`);
    await rejects(db.query(`select confirm_nicepay_payment('${o2}', '${c2}', 'TID-R2', 10000)`), /수동 확정 절차/);
  } finally { await db.close(); }
});

test('G4. PG 승인 전 수강권 발급 방지: 매니저 fulfill_order는 NICEPAY 주문(pending/approving) 거부, 기존 직접결제·toss·mock 주문은 그대로 발급, 완료 주문은 멱등', async () => {
  const db = await world();
  try {
    for (const st of ['pending', 'approving']) {
      const n = await mkOrder(db, 'nicepay'); if (st === 'approving') await claim(db, n);
      await asManager(db, () => rejects(db.query(`select fulfill_order('${n}')`), /PG 승인으로만 발급/));
    }
    assert.equal(await count(db, 'memberships'), 0);
    for (const p of [null, 'toss', 'mock']) {
      const o = await mkOrder(db, p);
      const r = (await asManager(db, () => db.query(`select fulfill_order('${o}') r`))).rows[0].r;
      assert.equal(r.already_done, false, `${p}: 기존 직접 발급 유지`);
      assert.equal((await q1(db, `select payment_provider p from payments where order_id='${o}'`)).p ?? null, null, `${p}: 기존 기록 방식 유지(NULL)`);
    }
    const o = await mkOrder(db, 'nicepay'); const c = await claim(db, o); await db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-F', 10000)`);
    assert.equal((await asManager(db, () => db.query(`select fulfill_order('${o}') r`))).rows[0].r.already_done, true);
    assert.equal(await count(db, 'payments', `order_id='${o}'`), 1);
  } finally { await db.close(); }
});

test('G5. 정산/매출 호환: 정산 요약은 nicepay 결제도 포함(toss/portone 유지, NULL·mock 제외), 매출 집계 조건(mock 제외)은 nicepay를 실매출로 취급', async () => {
  const db = await world();
  try {
    const mk = async (p, amt) => { const o = await mkOrder(db, p, { amount: amt }); if (p === 'nicepay') { const c = await claim(db, o); await db.query(`select confirm_nicepay_payment('${o}', '${c}', 'T-${amt}', ${amt})`); } else if (p === 'mock') { await asUser(db, () => db.query(`select confirm_test_payment('${o}', 'm')`)); } else await db.query(`select confirm_real_payment('${o}', 'pk', ${amt})`); };
    await mk('nicepay', 1000);
    await db.exec(`insert into payments(center_id, profile_id, sale_type, total_amount, paid_at, status, payment_provider) values ('${C1}','${P1}','new',200,now(),'paid','toss'), ('${C1}','${P1}','new',30,now(),'paid','portone'), ('${C1}','${P1}','new',4,now(),'paid',null), ('${C1}','${P1}','new',5,now(),'paid','mock')`);
    await db.exec(`select set_config('app.platform_admin','on',false)`);
    const sum = (await q1(db, `select total_amount t from admin_center_settlement_summary(current_date - 1, current_date + 1) where center_id = '${C1}'`)).t;
    assert.equal(Number(sum), 1000 + 200 + 30, 'nicepay+toss+portone만 정산 대상, NULL/mock 제외');
    await db.exec(`select set_config('app.platform_admin','',false)`);
    const real = await q1(db, `select sum(total_amount)::int s from payments where payment_provider is distinct from 'mock' and sale_type <> 'refund'`);
    assert.equal(real.s, 1000 + 200 + 30 + 4, '매출 통계 조건(mock 제외)은 nicepay를 실매출로 포함');
    // 환불 호환: nicepay 결제 환불 행(서버 경로)은 기존 환불 정책과 같은 형태(sale_type=refund, 음수)
    const { rows: [m] } = await db.query(`select membership_id from payments where pg_transaction_id = 'T-1000'`);
    const nOid = (await q1(db, `select order_id o from payments where pg_transaction_id = 'T-1000'`)).o;
    await rejects(db.query(`select refund_membership_server('${m.membership_id}','${AUTH}', true, false)`), /PG 승인 취소가 확인된 뒤에만/);
    await recordCancel(db, nOid, 1000);
    await db.query(`select refund_membership_server('${m.membership_id}','${AUTH}', true, false)`);
    assert.equal(await count(db, 'payments', `membership_id='${m.membership_id}' and sale_type='refund' and total_amount=-1000`), 1);
  } finally { await db.close(); }
});

// ---------------------------------------------------------------- 권한(H) / 적용·롤백·멱등(I, J) ----
test('H. 권한: 새 RPC 9개는 service_role 전용·SECURITY DEFINER·search_path 고정, 감사 테이블은 RLS+클라이언트 접근 불가', async () => {
  const db = await world();
  try {
    const fns = ['nicepay_record_pg_cancel(uuid,text,integer,text,text)', 'confirm_nicepay_payment(uuid,uuid,text,integer)', 'nicepay_confirm_reviewed(uuid,text,integer,text,text,text)', 'nicepay_order_context(uuid)', 'nicepay_claim_order(uuid)', 'nicepay_release_order(uuid,uuid,text)', 'nicepay_mark_review(uuid,uuid,text)', 'nicepay_expire_stale_claims(interval)', 'nicepay_resolve_review(uuid,text,text,text,text,text)'];
    for (const f of fns) {
      const r = await q1(db, `select has_function_privilege('anon','${f}','execute') a, has_function_privilege('authenticated','${f}','execute') u, has_function_privilege('service_role','${f}','execute') s, (select prosecdef and 'search_path=public' = any(proconfig) from pg_proc where oid='${f}'::regprocedure) d`);
      assert.deepEqual(r, { a: false, u: false, s: true, d: true }, f);
    }
    const t = await q1(db, `select has_table_privilege('anon','nicepay_review_actions','select') a, has_table_privilege('authenticated','nicepay_review_actions','insert') u, has_table_privilege('service_role','nicepay_review_actions','insert') s, (select relrowsecurity from pg_class where oid='nicepay_review_actions'::regclass) rls`);
    assert.deepEqual(t, { a: false, u: false, s: true, rls: true });
    // 내부 helper는 외부 롤이 직접 호출할 수 없다
    assert.equal((await q1(db, `select has_function_privilege('service_role','public._issue_membership_and_record_payment(orders,text,text)','execute') x`)).x, false);
  } finally { await db.close(); }
});

test('I. 제자리 패치 안전성: 정의가 예상과 다르면 중단하고 아무것도 바꾸지 않는다 / 두 번 적용해도 안전(멱등)', async () => {
  // 1) 예상과 다른 helper → 전체 중단(트랜잭션 롤백): provider CHECK도 바뀌지 않아야 한다
  const drift = await world({ supportApplied: false, refundFixApplied: false });
  try {
    await drift.exec(liveHelper.replace('p_memo\n    );', 'p_memo /* drift */\n    );'));
    await rejects(drift.exec(support), /패치 위치/);
    await drift.exec('rollback');
    await rejects(mkOrder(drift, 'nicepay'), /orders_payment_provider_check/);
    assert.equal(await count(drift, 'pg_proc', "proname like 'nicepay_%'"), 0);
  } finally { await drift.close(); }
  // 2) 상태 전이 트리거가 예상과 다르면 중단
  const drift2 = await world({ supportApplied: false, refundFixApplied: false });
  try {
    await drift2.exec(`create or replace function orders_guard_status_transition() returns trigger language plpgsql as $$ begin return new; end $$;`);
    await rejects(drift2.exec(support), /orders_guard_status_transition 정의가 예상/);
    await drift2.exec('rollback');
  } finally { await drift2.close(); }
  // 3) 멱등
  const db = await world();
  try {
    await db.exec(support);
    const d1 = (await q1(db, `select pg_get_functiondef('public._issue_membership_and_record_payment(orders,text,text)'::regprocedure) d`)).d;
    assert.equal(d1.split("case when p_order.payment_provider = 'nicepay'").length - 1, 1, '패치는 한 번만 들어간다');
    assert.equal((await q1(db, `select pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure) d`)).d.split('PG 승인으로만 발급할 수 있어요').length - 1, 1);
    assert.equal((await q1(db, `select pg_get_functiondef('public.admin_center_settlement_summary(date,date)'::regprocedure) d`)).d.split("'nicepay'").length - 1, 1);
  } finally { await db.close(); }
});

test('J. verify SQL 전부 true / 롤백은 nicepay 데이터·감사 기록이 있으면 중단, 없으면 원본(라이브) 정의로 정확히 복원', async () => {
  const db = await world();
  try {
    const v1 = (await db.query(stripComments(read('verify_fix_refund_block_all_pg_providers_20261016.sql')))).rows[0];
    assert.ok(Object.values(v1).every(x => x === true), JSON.stringify(v1));
    const v2 = (await db.query(stripComments(read('verify_add_nicepay_provider_support_20261016.sql')))).rows[0];
    assert.ok(Object.values(v2).every(x => x === true), JSON.stringify(v2));
    const o = await mkOrder(db, 'nicepay'); await claim(db, o);
    await rejects(db.exec(supportRollback), /롤백하지 않습니다/); await db.exec('rollback');
    assert.equal(await count(db, 'orders', `id='${o}'`), 1);
    // 감사 기록은 삭제 불가가 정상 — 테스트에서만 트리거를 잠시 끄고 정리해 '데이터 없음' 상태를 만든다(롤백은 감사 기록이 남아 있으면 중단함을 위에서 확인)
    await db.exec(`alter table nicepay_review_actions disable trigger nicepay_review_actions_append_only; delete from nicepay_review_actions; alter table nicepay_review_actions enable trigger nicepay_review_actions_append_only; delete from orders where payment_provider = 'nicepay';`);
    await db.exec(supportRollback);
    await rejects(mkOrder(db, 'nicepay'), /orders_payment_provider_check/);
    await rejects(mkOrder(db, 'mock', { status: 'approving' }), /orders_status_check/);
    assert.equal(await count(db, 'pg_proc', "proname like 'nicepay_%' or proname = 'confirm_nicepay_payment'"), 0);
    assert.equal(await count(db, 'pg_class', "relname = 'nicepay_review_actions'"), 0);
    // 복원 확인: 상태 전이 트리거는 원본과 같은 허용 전이, helper/fulfill/정산은 패치 이전
    const sg = (await q1(db, `select pg_get_functiondef('public.orders_guard_status_transition()'::regprocedure) d`)).d;
    assert.ok(!/approving|nicepay/.test(sg) && /old.status = 'paid' and new.status in \('done', 'cancelled'\)/.test(sg));
    assert.ok(!/nicepay/.test((await q1(db, `select pg_get_functiondef('public._issue_membership_and_record_payment(orders,text,text)'::regprocedure) d`)).d));
    assert.ok(!/NICEPAY/.test((await q1(db, `select pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure) d`)).d));
    assert.ok(!/nicepay/.test((await q1(db, `select pg_get_functiondef('public.admin_center_settlement_summary(date,date)'::regprocedure) d`)).d));
    // 기존 토스 흐름은 롤백 후에도 그대로
    const t = await mkOrder(db, 'toss'); assert.equal((await q1(db, `select confirm_real_payment('${t}', 'pk', 10000) r`)).r.already_done, false);
    // 환불 수정 롤백: 이전(라이브) 차단 조건으로 복귀
    await db.exec(refundRollback);
    assert.ok(/in \('toss', 'portone'\)/.test((await q1(db, `select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) d`)).d));
  } finally { await db.close(); }
});

// ================================================================ 운영 DB 호환성 보완(CRLF / 주석 없는 fulfill_order / create_order_secure / PG 취소 확인) ====
const defOf = async (db, sig) => (await q1(db, `select pg_get_functiondef('${sig}'::regprocedure) d`)).d;
const SIGS = { helper: 'public._issue_membership_and_record_payment(orders,text,text)', fulfill: 'public.fulfill_order(uuid)', core: 'public._refund_membership_core(uuid,uuid,boolean,boolean)',
  trigger: 'public.orders_guard_status_transition()', settlement: 'public.admin_center_settlement_summary(date,date)' };
const snapshotDefs = async db => Object.fromEntries(await Promise.all(Object.entries(SIGS).map(async ([k, v]) => [k, await defOf(db, v)])));
const SHAPES = [['LF+주석(저장소)', {}], ['LF+주석없음', { noComment: true }], ['CRLF+주석', { crlf: true }], ['CRLF+주석없음(운영 형태)', { crlf: true, noComment: true }]];
const stripBlock = (d, name) => d.replace(new RegExp(`\\r?\\n[ \\t]*-- ${name} begin[\\s\\S]*?-- ${name} end`), '');

test('K1. NICEPAY 환불: 실제 PG 취소 확인 기록 전에는 서버 경로(allow_pg=true)도 내부 환불 불가, 기록 후 가능, 다른 provider·0원은 영향 없음', async () => {
  const db = await world();
  try {
    const n = await paidMembership(db, 'nicepay');
    await asUser(db, () => rejects(db.query(`select refund_membership('${n.mid}')`), /환불 요청 기능/));                                   // 회원 일반 환불은 계속 차단
    await rejects(db.query(`select refund_membership_server('${n.mid}','${AUTH}', true, false)`), /PG 승인 취소가 확인된 뒤에만/);       // 서버 경로도 취소 확인 전 차단
    await rejects(db.query(`select refund_membership_server('${n.mid}','${AUTH}', true, true)`), /PG 승인 취소가 확인된 뒤에만/);        // 시간 조건 생략 경로도 동일
    assert.equal((await q1(db, `select status from memberships where id='${n.mid}'`)).status, 'active');
    assert.equal(await count(db, 'payments', `membership_id='${n.mid}' and sale_type='refund'`), 0);
    // 취소 확인 기록 규칙
    const rec = (oid, tid, amt, src = 'api_response', actor = 'system') => db.query(`select nicepay_record_pg_cancel('${oid}', ${tid ? `'${tid}'` : 'null'}, ${amt}, '${src}', '${actor}') r`);
    await rejects(rec(n.oid, 'CXL-0001', 10000, 'guess'), /출처/);
    await rejects(rec(n.oid, 'x', 10000), /취소 거래번호/);
    await rejects(rec(n.oid, 'CXL-0001', 10000, 'api_response', 'a'), /처리자/);
    await rejects(rec(n.oid, 'CXL-0001', 5000), /전액 취소만/);
    const pgTid = (await q1(db, `select pg_tid t from orders where id='${n.oid}'`)).t;
    await rejects(rec(n.oid, pgTid, 10000), /승인 거래번호와 같아요/);
    await rejects(rec(await mkOrder(db, 'nicepay'), 'CXL-0002', 10000), /승인 완료된 NICEPAY 주문이 아니에요/);   // 승인 안 된 주문
    await rejects(rec(await mkOrder(db, 'toss', { status: 'done' }), 'CXL-0003', 10000), /승인 완료된 NICEPAY 주문이 아니에요/);
    assert.equal((await rec(n.oid, 'CXL-0001', 10000, 'admin_console', 'op-kim')).rows[0].r.already_recorded, false);
    assert.equal((await rec(n.oid, 'CXL-0001', 10000)).rows[0].r.already_recorded, true, '멱등');
    await rejects(rec(n.oid, 'CXL-OTHER', 10000), /이미 다른 취소 거래/);
    const n2 = await paidMembership(db, 'nicepay');
    await rejects(rec(n2.oid, 'CXL-0001', 10000), /duplicate key|nicepay_pg_cancels_cancel_tid_key/);                                     // 취소 거래번호 재사용 불가
    await rejects(db.exec(`update nicepay_pg_cancels set actor='x1'`), /수정하거나 삭제할 수 없어요/);
    await rejects(db.exec(`delete from nicepay_pg_cancels`), /수정하거나 삭제할 수 없어요/);
    // 기록 후: 회원 일반 환불은 여전히 차단, 서버 경로는 가능
    await asUser(db, () => rejects(db.query(`select refund_membership('${n.mid}')`), /환불 요청 기능/));
    assert.deepEqual((await db.query(`select refund_membership_server('${n.mid}','${AUTH}', true, false) r`)).rows[0].r, { refunded: true, amount: 10000 });
    // 다른 provider는 취소 확인 기록과 무관하게 기존대로(서버 경로)
    for (const p of ['toss', 'portone']) { const x = await paidMembership(db, p); assert.equal((await db.query(`select refund_membership_server('${x.mid}','${AUTH}', true, false) r`)).rows[0].r.refunded, true, p); }
    // 0원 NICEPAY 주문은 돈 이동이 없어 취소 확인 불필요(서버 경로)
    const z = await paidMembership(db, 'nicepay', { amount: 0 });
    assert.equal((await db.query(`select refund_membership_server('${z.mid}','${AUTH}', true, false) r`)).rows[0].r.refunded, true);
    // 클라이언트 접근 불가
    await db.exec('set role authenticated');
    try { await rejects(db.query(`select * from nicepay_pg_cancels`), /permission denied/); await rejects(db.query(`select nicepay_record_pg_cancel('${n.oid}','CXL-9999',10000,'api_response','system')`), /permission denied/); } finally { await db.exec('reset role'); }
  } finally { await db.close(); }
});

for (const [label, opts] of SHAPES) {
  test(`L. fulfill_order 패치 [${label}]: 정확히 한 위치만 추가, 본문 전후 비교(삽입분 제거 시 원문과 동일), done 멱등/cancelled 차단 유지, NICEPAY만 차단`, async () => {
    const db = await world({ supportApplied: false, refundFixApplied: false, ...opts });
    try {
      const before = await defOf(db, SIGS.fulfill);
      assert.equal(/\[NEW 2026-10-02\]/.test(before), !opts.noComment, '형태 재현 확인(주석 유무)');
      assert.equal(before.includes('\r\n'), !!opts.crlf, '형태 재현 확인(CRLF)');
      await db.exec(support);
      const after = await defOf(db, SIGS.fulfill);
      assert.equal((after.match(/-- fulfill_nicepay_guard begin/g) ?? []).length, 1, '패치는 정확히 한 위치');
      assert.equal(stripBlock(after, 'fulfill_nicepay_guard'), before, '삽입분만 제거하면 수정 전 본문과 한 글자도 다르지 않다');
      const block = after.slice(after.indexOf('-- fulfill_nicepay_guard begin'), after.indexOf('-- fulfill_nicepay_guard end'));
      if (opts.crlf) assert.ok(block.includes('\r\n') && !/(?<!\r)\n/.test(block), 'CRLF 본문에는 CRLF로 삽입');
      // 삽입 위치: done 멱등 처리와 cancelled 차단이 모두 블록보다 앞
      assert.ok(after.search(/status\s*=\s*'done'\s+then\s+return/) < after.indexOf('-- fulfill_nicepay_guard begin'));
      assert.ok(after.search(/취소된 주문은 발급할 수 없어요/) < after.indexOf('-- fulfill_nicepay_guard begin'));
      // 동작
      const n = await mkOrder(db, 'nicepay'); await asManager(db, () => rejects(db.query(`select fulfill_order('${n}')`), /PG 승인으로만 발급/));
      const c = await mkOrder(db, 'toss', { status: 'cancelled' }); await asManager(db, () => rejects(db.query(`select fulfill_order('${c}')`), /취소된 주문은 발급할 수 없어요/));
      for (const p of [null, 'toss', 'portone', 'mock']) { const o = await mkOrder(db, p); assert.equal((await asManager(db, () => db.query(`select fulfill_order('${o}') r`))).rows[0].r.already_done, false, `${p}`); const again = await asManager(db, () => db.query(`select fulfill_order('${o}') r`)); assert.equal(again.rows[0].r.already_done, true, `${p} 멱등`); }
      const nd = await mkOrder(db, 'nicepay'); const cl = await claim(db, nd); await db.query(`select confirm_nicepay_payment('${nd}', '${cl}', 'TID-L', 10000)`);
      assert.equal((await asManager(db, () => db.query(`select fulfill_order('${nd}') r`))).rows[0].r.already_done, true, 'NICEPAY 완료 주문도 done 멱등');
    } finally { await db.close(); }
  });
}

test('L2. fulfill_order 예상과 다른 구조면 전체 트랜잭션 중단(아무것도 바뀌지 않음)', async () => {
  const drifts = {
    'cancelled 차단 없음': t => t.replace(/if v_order\.status = 'cancelled' then\s+raise exception '취소된 주문은 발급할 수 없어요';\s+end if;/, ''),
    'cancelled 차단 2곳': t => t.replace(/(if v_order\.status = 'cancelled' then\s+raise exception '취소된 주문은 발급할 수 없어요';\s+end if;)/, '$1\n    $1'),
    'done 멱등 없음': t => t.replace(/if v_order\.status = 'done' then\s+return json_build_object\('already_done', true\);\s+end if;/, ''),
    'done 멱등이 cancelled 뒤': t => { const done = t.match(/if v_order\.status = 'done' then\s+return json_build_object\('already_done', true\);\s+end if;/)[0]; const canc = t.match(/if v_order\.status = 'cancelled' then\s+raise exception '취소된 주문은 발급할 수 없어요';\s+end if;/)[0]; return t.replace(done, '').replace(canc, canc + '\n    ' + done); },
  };
  for (const [name, f] of Object.entries(drifts)) {
    const db = await world({ supportApplied: false, refundFixApplied: false });
    try {
      await db.exec(f(liveFulfill)); const before = await snapshotDefs(db);
      await rejects(db.exec(support), /fulfill_order/); await db.exec('rollback');
      assert.deepEqual(await snapshotDefs(db), before, `${name}: 아무 함수도 바뀌지 않음`);
      await rejects(mkOrder(db, 'nicepay'), /orders_payment_provider_check/);   // CHECK 변경도 롤백
      assert.equal(await count(db, 'pg_proc', "proname like 'nicepay_%'"), 0, name);
    } finally { await db.close(); }
  }
});

for (const [label, opts] of SHAPES.filter(x => x[1].crlf !== undefined)) {
  test(`M. 발급 helper 패치 [${label}]: CRLF/LF 모두 치환 성공, 삽입분 제거 시 원문 동일, NICEPAY만 provider 기록(그 외 NULL 유지)`, async () => {
    const db = await world({ supportApplied: false, refundFixApplied: false, ...opts });
    try {
      const before = await defOf(db, SIGS.helper);
      assert.equal(before.includes('\r\n'), !!opts.crlf);
      await db.exec(support);
      const after = await defOf(db, SIGS.helper);
      assert.equal((after.match(/case when p_order\.payment_provider = 'nicepay'/g) ?? []).length, 1);
      assert.equal(after.replace(/(pg_transaction_id,\s*paid_at,\s*status,\s*memo), payment_provider/, '$1').replace(/(p_memo), case when p_order\.payment_provider = 'nicepay' then 'nicepay' else null end/, '$1'), before, '정확히 두 조각만 추가');
      for (const p of ['toss', 'portone']) { const o = await mkOrder(db, p, { amount: 3000 }); await db.query(`select confirm_real_payment('${o}', 'pk', 3000)`); assert.equal((await q1(db, `select payment_provider p from payments where order_id='${o}'`)).p, null, `${p} 기존 기록 방식 유지`); }
      const m = await mkOrder(db, 'mock', { center: CI }); await asUser(db, () => db.query(`select confirm_test_payment('${m}', 'r')`)); assert.equal((await q1(db, `select payment_provider p from payments where order_id='${m}'`)).p, null);
      const d = await mkOrder(db, null); await asManager(db, () => db.query(`select fulfill_order('${d}')`)); assert.equal((await q1(db, `select payment_provider p from payments where order_id='${d}'`)).p, null);
      const n = await mkOrder(db, 'nicepay', { amount: 4000 }); const c = await claim(db, n); await db.query(`select confirm_nicepay_payment('${n}', '${c}', 'TID-M', 4000)`);
      assert.deepEqual(await q1(db, `select payment_provider, pg_transaction_id from payments where order_id='${n}'`), { payment_provider: 'nicepay', pg_transaction_id: 'TID-M' });
    } finally { await db.close(); }
  });
}

test('M2. 발급 helper 예상과 다른 구조(INSERT 열 목록 다름 / p_memo 위치 0곳·2곳)면 중단', async () => {
  const drifts = {
    '열 목록 변형': t => t.replace('pg_transaction_id, paid_at, status, memo', 'pg_transaction_id, status, paid_at, memo'),
    'p_memo 위치 없음': t => t.replace(/p_memo(\s*)\)(\s*);/, "p_memo || ''$1)$2;"),
    'p_memo 2곳': t => t.replace(/\n(\s*)return \(jsonb_build_object/, '\n$1perform (p_memo);\n$1return (jsonb_build_object'),
  };
  for (const [name, f] of Object.entries(drifts)) {
    const db = await world({ supportApplied: false, refundFixApplied: false });
    try {
      const drifted = f(liveHelper); assert.notEqual(drifted, liveHelper, `${name}: 변형이 실제로 적용됨`); await db.exec(drifted);
      const before = await snapshotDefs(db);
      await rejects(db.exec(support), /_issue_membership_and_record_payment/); await db.exec('rollback');
      assert.deepEqual(await snapshotDefs(db), before, name);
    } finally { await db.close(); }
  }
});

for (const [label, opts] of [['LF', {}], ['CRLF', { crlf: true }]]) {
  test(`N. 환불 core 패치 [${label}]: 허용 목록 수정 전 CRLF 정의에서도 1곳 패치, 삽입분 제거 시 원문 동일, 취소 확인 전 NICEPAY 환불 불가`, async () => {
    const db = await world({ supportApplied: false, refundFixApplied: false, ...opts });
    try {
      const before = await defOf(db, SIGS.core);
      await db.exec(support);
      const after = await defOf(db, SIGS.core);
      assert.equal((after.match(/-- nicepay_pg_cancel_guard begin/g) ?? []).length, 1);
      assert.equal(stripBlock(after, 'nicepay_pg_cancel_guard'), before);
      assert.ok(after.search(/앱의 환불 요청 기능으로 환불해주세요/) < after.indexOf('-- nicepay_pg_cancel_guard begin'), '기존 PG 일반환불 차단 뒤에 위치');
      const n = await paidMembership(db, 'nicepay');
      await rejects(db.query(`select refund_membership_server('${n.mid}','${AUTH}', true, false)`), /PG 승인 취소가 확인된 뒤에만/);
      await recordCancel(db, n.oid);
      assert.equal((await db.query(`select refund_membership_server('${n.mid}','${AUTH}', true, false) r`)).rows[0].r.refunded, true);
    } finally { await db.close(); }
  });
}

test('N2. 환불 core 예상과 다른 구조(일반환불 차단 문구 없음)면 중단', async () => {
  const db = await world({ supportApplied: false, refundFixApplied: false });
  try {
    await db.exec(liveCore.replace(/raise exception '카드\/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요';/, "raise exception 'x';"));
    const before = await snapshotDefs(db);
    await rejects(db.exec(support), /_refund_membership_core/); await db.exec('rollback');
    assert.deepEqual(await snapshotDefs(db), before);
  } finally { await db.close(); }
});

for (const [label, opts] of SHAPES) {
  test(`P. 롤백 정확 복원 [${label}]: 적용 전 5개 함수 정의가 롤백 후 한 글자도 다르지 않다`, async () => {
    const db = await world({ supportApplied: false, refundFixApplied: false, ...opts });
    try {
      const before = await snapshotDefs(db);
      await db.exec(support);
      const applied = await snapshotDefs(db);
      assert.notDeepEqual(applied, before);
      await db.exec(supportRollback);
      const after = await snapshotDefs(db);
      for (const k of ['helper', 'fulfill', 'core', 'settlement']) assert.equal(after[k], before[k], `${k} 복원`);
      assert.equal(after.trigger.replace(/\s+/g, ' '), before.trigger.replace(/\s+/g, ' '), 'trigger 복원(공백 무관)');
      // 복원 후 기존 Toss 발급·환불은 그대로
      const o = await mkOrder(db, 'toss', { amount: 6000 }); await db.query(`select confirm_real_payment('${o}', 'pk', 6000)`);
      const mid = (await q1(db, `select membership_id m from payments where order_id='${o}'`)).m;
      assert.equal((await db.query(`select refund_membership_server('${mid}','${AUTH}', true, false) r`)).rows[0].r.refunded, true);
    } finally { await db.close(); }
  });
}

// ---- create_order_secure (정의가 저장소에 없음 → 가정한 형태로 패치 로직을 검증. 실제 운영 정의는 preflight로 사전 확인) ----
const cos = (listExpr, nl = '\n') => `create or replace function public.create_order_secure(a uuid, b text, c text, d integer, e boolean, p_provider text) returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  ${listExpr}
  insert into orders(profile_id, center_id, product_id, product_name, amount, auto_book, payment_provider) values ('${P1}','${C1}','${PROD}','p', d, e, p_provider) returning id into v;
  return v;
end $$;`.replace(/\n/g, nl);
const COS_SHAPES = {
  'IN 목록': nl => cos("if p_provider is not null and p_provider not in ('mock', 'toss', 'portone') then raise exception 'invalid provider'; end if;", nl),
  'ARRAY 목록(공백 없음)': nl => cos("if p_provider is not null and not (p_provider = any(array['mock','toss','portone'])) then raise exception 'invalid provider'; end if;", nl),
  '줄바꿈이 낀 목록': nl => cos("if p_provider is not null and p_provider not in (\n    'mock',\n    'toss',\n    'portone') then raise exception 'invalid provider'; end if;", nl),
};
for (const [name, mk] of Object.entries(COS_SHAPES)) for (const nl of ['\n', '\r\n']) {
  test(`O. create_order_secure 패치 [${name}${nl === '\r\n' ? ' CRLF' : ''}]: 목록 1곳에만 nicepay 추가, 나머지 로직 불변, 롤백 정확 복원`, async () => {
    const db = await world();   // support 적용 상태(CHECK에 nicepay 있음)
    try {
      await db.exec(mk(nl));
      const before = await defOf(db, 'public.create_order_secure(uuid,text,text,integer,boolean,text)');
      await rejects(db.query(`select create_order_secure('${id(7, 1)}','a','b',1000,false,'nicepay')`), /invalid provider/);
      await db.exec(cosFix);
      const after = await defOf(db, 'public.create_order_secure(uuid,text,text,integer,boolean,text)');
      assert.equal(after.replace(/(\x27mock\x27\s*,\s*\x27toss\x27\s*,\s*\x27portone\x27), \x27nicepay\x27/, '$1'), before, '목록에 nicepay 한 단어만 추가');
      assert.ok(await q1(db, `select create_order_secure('${id(7, 1)}','a','b',1000,false,'nicepay') o`));
      assert.equal(await count(db, 'orders', "payment_provider = 'nicepay' and amount = 1000"), 1);
      for (const p of ['mock', 'toss', 'portone', null]) await db.query(`select create_order_secure('${id(7, 1)}','a','b',1000,false,${p ? `'${p}'` : 'null'})`);
      await rejects(db.query(`select create_order_secure('${id(7, 1)}','a','b',1000,false,'stripe')`), /invalid provider/);
      await db.exec(cosFix);   // 멱등
      assert.equal(await defOf(db, 'public.create_order_secure(uuid,text,text,integer,boolean,text)'), after);
      await db.exec(`delete from orders where payment_provider = 'nicepay'`);
      await db.exec(cosRollback);
      assert.equal(await defOf(db, 'public.create_order_secure(uuid,text,text,integer,boolean,text)'), before, '롤백 후 원문 동일');
    } finally { await db.close(); }
  });
}

test('O2. create_order_secure 예상과 다른 구조(목록 없음/2곳/함수 없음/NICEPAY 지원 SQL 미적용)면 중단', async () => {
  const cases = {
    '목록 없음': cos("if p_provider is not null and length(p_provider) > 20 then raise exception 'invalid provider'; end if;"),
    '목록 2곳': cos("if p_provider not in ('mock','toss','portone') then raise exception 'x'; end if; if p_provider not in ('mock', 'toss', 'portone') then raise exception 'y'; end if;"),
  };
  for (const [name, def] of Object.entries(cases)) {
    const db = await world();
    try { await db.exec(def); const before = await defOf(db, 'public.create_order_secure(uuid,text,text,integer,boolean,text)'); await rejects(db.exec(cosFix), /create_order_secure/); await db.exec('rollback'); assert.equal(await defOf(db, 'public.create_order_secure(uuid,text,text,integer,boolean,text)'), before, name); } finally { await db.close(); }
  }
  const none = await world();
  try { await rejects(none.exec(cosFix), /create_order_secure\(uuid,text,text,integer,boolean,text\) 가 없어요/); await none.exec('rollback'); } finally { await none.close(); }
  const noSupport = await world({ supportApplied: false });
  try { await noSupport.exec(COS_SHAPES['IN 목록']('\n')); await rejects(noSupport.exec(cosFix), /add_nicepay_provider_support_20261016\.sql 을 먼저/); await noSupport.exec('rollback'); } finally { await noSupport.close(); }
});

test('Q. 읽기 전용 사전 점검(preflight)이 운영 형태(CRLF+주석없음)에서 모두 true, 예상과 다른 구조에서는 false, 적용 후에도 true', async () => {
  const okCols = r => Object.entries(r).filter(([k]) => k.endsWith('_ok') || k.endsWith('_ok_or_absent')).map(([k, v]) => [k, v]);
  const db = await world({ supportApplied: false, refundFixApplied: false, crlf: true, noComment: true });
  try {
    await db.exec(COS_SHAPES['IN 목록']('\r\n'));
    const r = (await db.query(preflight)).rows[0];
    assert.equal(r.info_helper_has_crlf, true); assert.equal(r.info_fulfill_has_crlf, true);
    for (const [k, v] of okCols(r)) assert.equal(v, true, k);
    // 읽기 전용: 함수/데이터가 바뀌지 않았다
    assert.equal(await count(db, 'pg_proc', "proname like 'nicepay_%'"), 0);
    await db.exec(support); await db.exec(cosFix);
    for (const [k, v] of okCols((await db.query(preflight)).rows[0])) assert.equal(v, true, `적용 후 ${k}`);
  } finally { await db.close(); }
  const bad = await world({ supportApplied: false, refundFixApplied: false });
  try {
    await bad.exec(liveFulfill.replace(/if v_order\.status = 'cancelled' then\s+raise exception '취소된 주문은 발급할 수 없어요';\s+end if;/, ''));
    const r = (await bad.query(preflight)).rows[0];
    assert.equal(r.fulfill_patch_ok, false); assert.notEqual(r.create_order_secure_patch_ok, true);
  } finally { await bad.close(); }
});
