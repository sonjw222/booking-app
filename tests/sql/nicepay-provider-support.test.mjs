// 격리 PostgreSQL(PGlite) — NICEPAY provider DB 기반 + 일반 환불 PG 우회 차단. 저장소의 라이브 정의(extract)와 이번 초안 SQL을 그대로 실행한다. DEV/Production 접속 없음.
// 실행: node --test tests/sql/nicepay-provider-support.test.mjs
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
const refundFix = read('fix_refund_block_all_pg_providers_20261016.sql');
const refundRollback = read('rollback_fix_refund_block_all_pg_providers_20261016.sql');
const support = read('add_nicepay_provider_support_20261016.sql');
const supportRollback = read('rollback_add_nicepay_provider_support_20261016.sql');
const stripComments = s => s.replace(/^\s*--.*$/gm, '');

const id = (k, n) => `${String(k).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C1 = id(1, 1), CI = id(1, 2), P1 = id(2, 1), ACC = id(3, 1), AUTH = id(3, 9), PROD = id(4, 1);

// 라이브 정의 그대로(저장소 계보의 최신 파일에서 잘라 온다)
const liveCore = slice(kst, /CREATE OR REPLACE FUNCTION public\._refund_membership_core/, '$function$;').replace(/^(CREATE OR REPLACE FUNCTION[\s\S]*?AS \$function\$)/, '$1');
const liveForceInsert = slice(lifecycle, /create or replace function orders_force_server_fields_on_insert\(\)/, 'execute function orders_force_server_fields_on_insert();');
const liveRefundWrappers = slice(lifecycle, /create or replace function refund_membership\(p_membership_id uuid\)/, 'grant execute on function refund_membership_server(uuid, uuid, boolean, boolean) to service_role;');
const liveAccountFor = slice(lifecycle, /create or replace function _account_id_for_auth/, "revoke all on function _account_id_for_auth(uuid) from public, anon, authenticated;");
const liveConfirmReal = slice(issuance, /create or replace function public\.confirm_real_payment/, '$function$;');
const liveCancelReal = slice(confirmReal, /create or replace function cancel_real_payment/, '$$;');
const liveConfirmTest = slice(lifecycle, /CREATE OR REPLACE FUNCTION public\.confirm_test_payment/, '$function$;');

async function world({ refundFixApplied = true, supportApplied = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    create function my_account_id() returns uuid language sql stable as $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;
    create table accounts(id uuid primary key, auth_id uuid, merged_into uuid);
    create table account_auth_identities(account_id uuid, auth_id uuid);
    create table profiles(id uuid primary key, account_id uuid);
    create function my_profile_ids() returns setof uuid language sql stable as $$ select id from profiles where account_id = my_account_id() $$;
    create table centers(id uuid primary key, is_internal boolean not null default false);
    create table products(id uuid primary key, center_id uuid, name text);
    create table orders(id uuid primary key default gen_random_uuid(), profile_id uuid, center_id uuid, product_id uuid, product_name text, amount int default 10000,
      status text default 'pending' constraint orders_status_check check (status in ('pending','paid','cancelled','done')),
      paid_at timestamptz, verified boolean default true, pay_method text default 'card', member_coupon_id uuid,
      payment_provider text constraint orders_payment_provider_check check (payment_provider is null or payment_provider in ('mock','toss','portone')));
    create table memberships(id uuid primary key default gen_random_uuid(), profile_id uuid, center_id uuid, product_id uuid, product_name text, total_count int, remaining_count int,
      expires_at date, status text default 'active', pg_refund_started_at timestamptz);
    create table payments(id uuid primary key default gen_random_uuid(), center_id uuid, profile_id uuid, membership_id uuid, order_id uuid, sale_type text, revenue_category text,
      card_amount int, cash_amount int, transfer_amount int, point_amount int, total_amount int, unpaid_amount int, pg_transaction_id text, paid_at timestamptz, status text, memo text,
      payment_provider text constraint payments_payment_provider_check check (payment_provider is null or payment_provider in ('mock','toss','portone')));
    create table member_coupons(id uuid primary key, status text, used_at timestamptz, order_id uuid);
    create table center_members(center_id uuid, profile_id uuid, status text default 'active');
    create function _refund_block_reason(m memberships, b boolean default false) returns text language sql as $$ select null::text $$;
    create function _restore_order_points(uuid, text) returns void language sql as $$ select 1 $$;
    create function ensure_center_member(uuid, uuid) returns void language sql as $$ select 1 $$;
    -- 공통 발급 helper 스텁: 실제 helper와 같은 상태 전이(pending→paid→done) + 수강권 1개 + 매출 1행
    create function _issue_membership_and_record_payment(p_order orders, p_provider_ref text, p_memo text) returns json language plpgsql security definer as $f$
    declare m uuid;
    begin
      update orders set status = 'paid', paid_at = now() where id = p_order.id;
      insert into memberships(profile_id, center_id, product_id, product_name, total_count, remaining_count) values (p_order.profile_id, p_order.center_id, p_order.product_id, p_order.product_name, 10, 10) returning id into m;
      insert into payments(center_id, profile_id, membership_id, order_id, sale_type, total_amount, pg_transaction_id, paid_at, status, memo)
        values (p_order.center_id, p_order.profile_id, m, p_order.id, 'new', p_order.amount, p_provider_ref, now(), 'paid', p_memo);
      update orders set status = 'done' where id = p_order.id;
      return json_build_object('membership_id', m, 'amount', p_order.amount);
    end $f$;
    insert into centers values ('${C1}', false), ('${CI}', true);
    insert into accounts values ('${ACC}', '${AUTH}', null);
    insert into profiles values ('${P1}', '${ACC}');
    insert into products values ('${PROD}', '${C1}', 'p');
    ${liveAccountFor}
    ${liveForceInsert}
    ${liveRefundWrappers}
    ${liveConfirmReal}
    ${liveCancelReal}
    ${liveConfirmTest}
  `);
  await db.exec(liveCore);   // 라이브 _refund_membership_core
  await db.exec(`revoke all on function public._refund_membership_core(uuid, uuid, boolean, boolean) from public, anon, authenticated, service_role;`);
  if (supportApplied) await db.exec(support);
  if (refundFixApplied) await db.exec(refundFix);
  return db;
}
const asUser = async (db, fn) => { await db.exec(`select set_config('app.uid','${AUTH}',false), set_config('app.account_id','${ACC}',false);`); try { return await fn(); } finally { await db.exec(`select set_config('app.uid','',false), set_config('app.account_id','',false);`); } };
const mkOrder = async (db, provider, { center = C1, amount = 10000, status = 'pending' } = {}) => {
  const oid = id(5, Math.floor(Math.random() * 1e9));
  await db.exec(`insert into orders(id, profile_id, center_id, product_id, product_name, amount, status, payment_provider) values ('${oid}','${P1}','${center}','${PROD}','p',${amount},'${status}',${provider ? `'${provider}'` : 'null'})`);
  return oid;
};
const count = async (db, t, where = 'true') => Number((await db.query(`select count(*)::int c from ${t} where ${where}`)).rows[0].c);
const rejects = async (p, re) => { try { await p; } catch (e) { if (re) assert.match(String(e.message), re); return; } assert.fail('예외가 나야 한다'); };
// 완료된 주문 + 수강권 + 매출(provider별 환불 시나리오용): confirm 경로 대신 직접 만든다
async function paidMembership(db, provider, { amount = 10000 } = {}) {
  const oid = await mkOrder(db, provider, { amount, status: 'done' });
  const mid = id(6, Math.floor(Math.random() * 1e9));
  await db.exec(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ('${mid}','${P1}','${C1}','${PROD}','p',10,10);
    insert into payments(center_id, profile_id, membership_id, order_id, sale_type, total_amount, pg_transaction_id, paid_at, status) values ('${C1}','${P1}','${mid}','${oid}','new',${amount},'tid-${mid.slice(-6)}',now(),'paid');`);
  return { oid, mid };
}

test('A. 일반 환불: 수정 전 라이브 정의는 nicepay를 막지 못한다(우회 재현), 수정 후에는 모든 PG 값을 막고 NULL/mock은 유지', async () => {
  const before = await world({ refundFixApplied: false });
  try {
    const n = await paidMembership(before, 'nicepay');
    const r = await asUser(before, () => before.query(`select refund_membership('${n.mid}') r`));
    assert.equal(r.rows[0].r.refunded, true, '수정 전: nicepay 결제 건이 PG 취소 없이 DB에서만 환불된다(= 우회 위험)');
  } finally { await before.close(); }

  const db = await world();
  try {
    for (const p of ['nicepay', 'toss', 'portone']) {
      const { mid } = await paidMembership(db, p);
      await asUser(db, () => rejects(db.query(`select refund_membership('${mid}')`), /환불 요청 기능/));
      assert.equal((await db.query(`select status from memberships where id='${mid}'`)).rows[0].status, 'active', `${p}: 수강권 상태 불변`);
      assert.equal(await count(db, 'payments', `membership_id='${mid}' and sale_type='refund'`), 0, `${p}: 환불 매출 행 없음`);
    }
    for (const p of [null, 'mock']) {   // 직접결제(NULL)·Mock QA 환불은 그대로
      const { mid } = await paidMembership(db, p);
      const r = await asUser(db, () => db.query(`select refund_membership('${mid}') r`));
      assert.equal(r.rows[0].r.refunded, true, `${p}: 환불 유지`);
      assert.equal((await db.query(`select status from memberships where id='${mid}'`)).rows[0].status, 'refunded');
    }
    // order 연결이 없는 수강권(order_id null)도 기존대로
    const mid = id(6, 777); await db.exec(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ('${mid}','${P1}','${C1}','${PROD}','p',10,10)`);
    assert.equal((await asUser(db, () => db.query(`select refund_membership('${mid}') r`))).rows[0].r.refunded, true);
  } finally { await db.close(); }
});

test('A2. 서버 경로(refund_membership_server, p_allow_pg=true)는 외부 취소가 끝난 뒤 PG 건도 환불 마무리 가능 — 서버 전용 권한 유지', async () => {
  const db = await world();
  try {
    for (const p of ['nicepay', 'toss']) {
      const { mid } = await paidMembership(db, p);
      const r = await db.query(`select refund_membership_server('${mid}','${AUTH}', true, false) r`);
      assert.equal(r.rows[0].r.refunded, true, p);
      const { mid: m2 } = await paidMembership(db, p);
      await rejects(db.query(`select refund_membership_server('${m2}','${AUTH}', false, false)`), /환불 요청 기능/);
    }
    const priv = (await db.query(`select has_function_privilege('authenticated','public._refund_membership_core(uuid,uuid,boolean,boolean)','execute') a, has_function_privilege('service_role','public._refund_membership_core(uuid,uuid,boolean,boolean)','execute') s,
      has_function_privilege('authenticated','refund_membership_server(uuid,uuid,boolean,boolean)','execute') sv`)).rows[0];
    assert.deepEqual(priv, { a: false, s: false, sv: false }, 'core는 owner 외 실행 불가, 서버 환불 함수는 authenticated 실행 불가(service_role 전용)');
  } finally { await db.close(); }
});

test('B. CHECK 제약: nicepay 추가, 기존 값(mock/toss/portone/NULL)과 기존 데이터 호환, 잘못된 값은 거부', async () => {
  const db = await world({ supportApplied: false, refundFixApplied: false });
  try {
    await rejects(mkOrder(db, 'nicepay'), /orders_payment_provider_check/);   // 적용 전: 거부
    await mkOrder(db, 'toss'); await mkOrder(db, 'portone'); await mkOrder(db, 'mock'); await mkOrder(db, null);   // 기존 데이터
    await db.exec(support);   // 기존 행이 있는 상태에서 적용 가능(검증 통과)
    await mkOrder(db, 'nicepay');
    assert.equal(await count(db, 'orders', "payment_provider = 'toss'"), 1);
    assert.equal(await count(db, 'orders', "payment_provider = 'portone'"), 1);
    await rejects(mkOrder(db, 'kakao'), /orders_payment_provider_check/);
    await rejects(db.exec(`insert into payments(id, payment_provider) values (gen_random_uuid(), 'stripe')`), /payments_payment_provider_check/);
    await db.exec(`insert into payments(id, payment_provider) values (gen_random_uuid(), 'nicepay'), (gen_random_uuid(), 'toss')`);
    await rejects(mkOrder(db, 'mock', { status: 'weird' }), /orders_status_check/);
  } finally { await db.close(); }
});

test('C. 기존 Toss/PortOne 레거시 호환: confirm_real_payment(라이브)는 toss/portone만, NICEPAY 주문에는 동작하지 않는다', async () => {
  const db = await world();
  try {
    for (const p of ['toss', 'portone']) {
      const oid = await mkOrder(db, p);
      const r = await db.query(`select confirm_real_payment('${oid}', 'pk_${p}', 10000) r`);
      assert.equal(r.rows[0].r.already_done, false); assert.equal((await db.query(`select status from orders where id='${oid}'`)).rows[0].status, 'done');
      assert.equal((await db.query(`select confirm_real_payment('${oid}', 'pk_${p}', 10000) r`)).rows[0].r.already_done, true, '멱등');
    }
    const n = await mkOrder(db, 'nicepay');
    await rejects(db.query(`select confirm_real_payment('${n}', 'pk', 10000)`), /실제 PG 주문에만/);
    await rejects(db.query(`select cancel_real_payment('${n}')`), /실제 PG 주문에만/);
    assert.equal(await count(db, 'memberships', `product_name='p' and id in (select membership_id from payments where order_id='${n}')`), 0);
    const t = await mkOrder(db, 'toss');
    assert.deepEqual((await db.query(`select cancel_real_payment('${t}') r`)).rows[0].r, { cancelled: true });
    assert.equal(/nicepay/.test((await db.query(`select pg_get_functiondef('confirm_real_payment(uuid,text,integer)'::regprocedure) d`)).rows[0].d), false, 'confirm_real_payment는 확장하지 않았다');
  } finally { await db.close(); }
});

test('D. Mock QA 동작 유지: confirm_test_payment는 mock + 내부 QA 센터에서만, nicepay/toss 주문에는 사용 불가', async () => {
  const db = await world();
  try {
    const ok = await mkOrder(db, 'mock', { center: CI });
    assert.equal((await asUser(db, () => db.query(`select confirm_test_payment('${ok}', 'mock_ref') r`))).rows[0].r.already_done, false);
    const nonInternal = await mkOrder(db, 'mock', { center: C1 });
    await asUser(db, () => rejects(db.query(`select confirm_test_payment('${nonInternal}', 'mock_ref')`), /내부 QA 센터/));
    for (const p of ['nicepay', 'toss']) { const o = await mkOrder(db, p, { center: CI }); await asUser(db, () => rejects(db.query(`select confirm_test_payment('${o}', 'x')`), /Mock 결제 주문에만/)); }
  } finally { await db.close(); }
});

test('E. 주문 상태 전이 보안: 로그인 사용자는 approving/pg_* 를 만들거나 바꾸거나 벗어날 수 없고, 기존 전이(pending→cancelled 등)는 영향 없음', async () => {
  const db = await world();
  try {
    // 클라이언트 INSERT: 서버 전용 컬럼은 null로 강제, status는 기존 트리거가 pending으로 강제
    const oid = id(5, 4242);
    await asUser(db, () => db.exec(`insert into orders(id, profile_id, center_id, product_id, product_name, amount, status, payment_provider, pg_tid, pg_claim_id, pg_review_at)
      values ('${oid}','${P1}','${C1}','${PROD}','p',1000,'approving','nicepay','forged-tid', gen_random_uuid(), now())`));
    assert.deepEqual((await db.query(`select status, pg_tid, pg_claim_id, pg_review_at from orders where id='${oid}'`)).rows[0], { status: 'pending', pg_tid: null, pg_claim_id: null, pg_review_at: null });
    // 클라이언트 UPDATE: approving 진입/pg_* 변경 거부
    await asUser(db, () => rejects(db.exec(`update orders set status = 'approving' where id='${oid}'`), /서버에서만/));
    await asUser(db, () => rejects(db.exec(`update orders set pg_tid = 'x' where id='${oid}'`), /서버에서만/));
    await asUser(db, () => rejects(db.exec(`update orders set pg_review_at = now() where id='${oid}'`), /서버에서만/));
    // 기존 전이는 유지: 본인 pending 취소
    await asUser(db, () => db.exec(`update orders set status = 'cancelled' where id='${oid}'`));
    assert.equal((await db.query(`select status from orders where id='${oid}'`)).rows[0].status, 'cancelled');
    // 서버(auth.uid 없음)가 선점한 approving 주문: 클라이언트가 취소/복귀/완료로 바꿀 수 없다(승인-취소 경합 차단)
    const n = await mkOrder(db, 'nicepay'); const claim = (await db.query(`select nicepay_claim_order('${n}') c`)).rows[0].c;
    assert.ok(claim);
    for (const st of ['cancelled', 'pending', 'done', 'paid']) await asUser(db, () => rejects(db.exec(`update orders set status = '${st}' where id='${n}'`), /서버에서만/));
    assert.equal((await db.query(`select status from orders where id='${n}'`)).rows[0].status, 'approving');
    // 서버 작업의 일반 상태 갱신(mock 확정의 pending→paid→done)은 영향 없음
    const m = await mkOrder(db, 'mock', { center: CI });
    await asUser(db, () => db.query(`select confirm_test_payment('${m}', 'r')`));
    assert.equal((await db.query(`select status from orders where id='${m}'`)).rows[0].status, 'done');
  } finally { await db.close(); }
});

test('F. 승인 선점(claim)/release/검토 대기/만료/수동 해소', async () => {
  const db = await world();
  try {
    const o = await mkOrder(db, 'nicepay');
    const c1 = (await db.query(`select nicepay_claim_order('${o}') c`)).rows[0].c;
    assert.ok(c1);
    assert.equal((await db.query(`select nicepay_claim_order('${o}') c`)).rows[0].c, null, '두 번째 선점은 거부(동시 승인 방지)');
    assert.equal((await db.query(`select nicepay_release_order('${o}', '${id(9, 1)}') r`)).rows[0].r, false, '다른 claim으로는 복귀 불가');
    assert.equal((await db.query(`select nicepay_release_order('${o}', '${c1}') r`)).rows[0].r, true);
    const c2 = (await db.query(`select nicepay_claim_order('${o}') c`)).rows[0].c;
    assert.notEqual(c1, c2, '재선점은 새 claim id (이전 요청의 fencing 무효화)');
    // 검토 대기: release 불가, 재선점 불가, 만료 함수는 이미 표시된 건 건드리지 않음
    assert.equal((await db.query(`select nicepay_mark_review('${o}', '${c2}', 'netcancel_failed') r`)).rows[0].r, true);
    assert.equal((await db.query(`select nicepay_release_order('${o}', '${c2}') r`)).rows[0].r, false);
    await rejects(db.query(`select nicepay_mark_review('${o}', '${c2}', 'whatever')`), /알 수 없는 검토 사유/);
    assert.equal((await db.query(`select nicepay_mark_review('${o}', '${id(9, 2)}', 'netcancel_failed') r`)).rows[0].r, false, '다른 claim으로 표시 불가');
    assert.equal((await db.query(`select nicepay_order_context('${o}') c`)).rows[0].c.reviewPending, true);
    // 수동 해소
    await rejects(db.query(`select nicepay_resolve_review('${o}', 'confirm')`), /지원하지 않는 처리/);
    assert.deepEqual((await db.query(`select nicepay_resolve_review('${o}', 'release') r`)).rows[0].r, { resolved: 'release' });
    assert.deepEqual((await db.query(`select status, pg_claim_id, pg_review_at from orders where id='${o}'`)).rows[0], { status: 'pending', pg_claim_id: null, pg_review_at: null });
    await rejects(db.query(`select nicepay_resolve_review('${o}', 'release')`), /검토 대기 중인 NICEPAY 주문이 아니에요/);
    // 오래된 선점은 자동 복귀가 아니라 검토 대기로
    const s = await mkOrder(db, 'nicepay'); await db.query(`select nicepay_claim_order('${s}')`);
    await db.exec(`update orders set pg_claimed_at = now() - interval '2 hours' where id='${s}'`);
    assert.equal((await db.query(`select nicepay_expire_stale_claims('30 minutes') n`)).rows[0].n, 1);
    assert.deepEqual((await db.query(`select status, pg_review_reason from orders where id='${s}'`)).rows[0], { status: 'approving', pg_review_reason: 'stale_claim' });
    assert.deepEqual((await db.query(`select nicepay_resolve_review('${s}', 'cancel') r`)).rows[0].r, { resolved: 'cancel' });
    assert.equal((await db.query(`select status from orders where id='${s}'`)).rows[0].status, 'cancelled');
    // 비 NICEPAY / 완료·취소 주문은 선점 불가
    for (const [p, st] of [['toss', 'pending'], ['mock', 'pending'], [null, 'pending'], ['nicepay', 'done'], ['nicepay', 'cancelled']]) {
      const x = await mkOrder(db, p, { status: st }); assert.equal((await db.query(`select nicepay_claim_order('${x}') c`)).rows[0].c, null, `${p}/${st}`);
    }
  } finally { await db.close(); }
});

test('G. confirm_nicepay_payment: 중복 승인·중복 수강권 방지, fencing, 금액/provider/TID 검증', async () => {
  const db = await world();
  try {
    const o = await mkOrder(db, 'nicepay', { amount: 12000 });
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${id(9, 1)}', 'TID-1', 12000)`), /승인 처리 중인 주문이 아니에요/);   // 선점 전 확정 불가
    const c = (await db.query(`select nicepay_claim_order('${o}') c`)).rows[0].c;
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${id(9, 1)}', 'TID-1', 12000)`), /선점이 일치하지 않아요/);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-1', 11999)`), /금액이 주문 금액과 일치하지 않아요/);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', '', 12000)`), /거래번호가 올바르지 않아요/);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', null, 12000)`), /거래번호가 올바르지 않아요/);
    assert.equal(await count(db, 'memberships', `id in (select membership_id from payments where order_id='${o}')`), 0, '실패 호출은 수강권을 만들지 않는다');
    const r = (await db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-1', 12000) r`)).rows[0].r;
    assert.equal(r.already_done, false); assert.equal(r.amount, 12000);
    assert.deepEqual((await db.query(`select status, pg_tid from orders where id='${o}'`)).rows[0], { status: 'done', pg_tid: 'TID-1' });
    // 중복 승인(웹훅 중복·재시도·동시 요청): 같은 TID → 멱등, 수강권/매출 각 1개
    for (let i = 0; i < 3; i++) assert.equal((await db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-1', 12000) r`)).rows[0].r.already_done, true);
    await Promise.all([1, 2].map(() => db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-1', 12000)`)));
    assert.equal(await count(db, 'payments', `order_id='${o}' and sale_type='new'`), 1);
    assert.equal(await count(db, 'memberships', `id in (select membership_id from payments where order_id='${o}')`), 1);
    // 완료된 주문을 다른 거래로 덮어쓸 수 없다
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-OTHER', 12000)`), /이미 다른 거래로 완료된 주문/);
    // 다른 주문이 같은 TID를 재사용할 수 없다(롤백되어 수강권 없음)
    const o2 = await mkOrder(db, 'nicepay', { amount: 12000 }); const c2 = (await db.query(`select nicepay_claim_order('${o2}') c`)).rows[0].c;
    await rejects(db.query(`select confirm_nicepay_payment('${o2}', '${c2}', 'TID-1', 12000)`), /orders_pg_tid_unique|duplicate key/);
    assert.deepEqual((await db.query(`select status, pg_tid from orders where id='${o2}'`)).rows[0], { status: 'approving', pg_tid: null });
    assert.equal(await count(db, 'payments', `order_id='${o2}'`), 0);
    // 오래된 claim(해제 후 재선점)으로 확정 불가
    await db.query(`select nicepay_release_order('${o2}', '${c2}')`); const c3 = (await db.query(`select nicepay_claim_order('${o2}') c`)).rows[0].c;
    await rejects(db.query(`select confirm_nicepay_payment('${o2}', '${c2}', 'TID-2', 12000)`), /선점이 일치하지 않아요/);
    // 운영자 확인 대기 중이어도 올바른 claim으로는 확정 가능(승인된 거래 복구), 확정 후 검토 표시 해제
    await db.query(`select nicepay_mark_review('${o2}', '${c3}', 'confirm_state_unknown')`);
    await db.query(`select confirm_nicepay_payment('${o2}', '${c3}', 'TID-2', 12000)`);
    assert.deepEqual((await db.query(`select status, pg_review_at from orders where id='${o2}'`)).rows[0], { status: 'done', pg_review_at: null });
    // provider 불일치
    for (const p of ['toss', 'mock', null]) { const x = await mkOrder(db, p); await rejects(db.query(`select confirm_nicepay_payment('${x}', '${id(9, 1)}', 'T', 10000)`), /NICEPAY 주문에만/); }
    await rejects(db.query(`select confirm_nicepay_payment('${id(9, 9)}', '${id(9, 1)}', 'T', 1)`), /주문을 찾을 수 없어요/);
  } finally { await db.close(); }
});

test('H. 권한: 새 RPC는 service_role 전용(authenticated/anon 실행 불가), 보호 트리거는 SECURITY DEFINER', async () => {
  const db = await world();
  try {
    const fns = ['confirm_nicepay_payment(uuid,uuid,text,integer)', 'nicepay_order_context(uuid)', 'nicepay_claim_order(uuid)', 'nicepay_release_order(uuid,uuid)', 'nicepay_mark_review(uuid,uuid,text)', 'nicepay_expire_stale_claims(interval)', 'nicepay_resolve_review(uuid,text)'];
    for (const f of fns) {
      const r = (await db.query(`select has_function_privilege('anon','${f}','execute') a, has_function_privilege('authenticated','${f}','execute') u, has_function_privilege('service_role','${f}','execute') s, (select prosecdef and 'search_path=public' = any(proconfig) from pg_proc where oid='${f}'::regprocedure) d`)).rows[0];
      assert.deepEqual(r, { a: false, u: false, s: true, d: true }, f);
    }
    // 일반 사용자가 REST처럼 직접 호출하면 권한 오류
    await db.exec('set role authenticated');
    try { await rejects(db.query(`select nicepay_claim_order('${id(5, 1)}')`), /permission denied/); } finally { await db.exec('reset role'); }
  } finally { await db.close(); }
});

test('I. verify SQL이 적용 후 전부 true, 롤백은 nicepay 데이터가 있으면 중단 / 없으면 원복', async () => {
  const db = await world();
  try {
    // verify는 라이브 전용 함수 시그니처(confirm_real_payment(uuid,text,integer))를 쓰므로 PGlite 월드에서도 그대로 실행된다
    const v1 = (await db.query(stripComments(read('verify_fix_refund_block_all_pg_providers_20261016.sql')))).rows[0];
    assert.ok(Object.values(v1).every(x => x === true), JSON.stringify(v1));
    const v2 = (await db.query(stripComments(read('verify_add_nicepay_provider_support_20261016.sql')))).rows[0];
    assert.ok(Object.values(v2).every(x => x === true), JSON.stringify(v2));
    const o = await mkOrder(db, 'nicepay');
    await rejects(db.exec(supportRollback), /롤백하지 않습니다/);
    await db.exec('rollback');   // 롤백 SQL이 begin 안에서 중단됐으므로 트랜잭션을 정리
    assert.equal(await count(db, 'orders', `id='${o}'`), 1, '롤백 거부 시 데이터 유지');
    await db.exec(`delete from orders where payment_provider = 'nicepay'`);
    await db.exec(supportRollback);
    await rejects(mkOrder(db, 'nicepay'), /orders_payment_provider_check/);
    await rejects(mkOrder(db, 'mock', { status: 'approving' }), /orders_status_check/);
    assert.equal(Number((await db.query(`select count(*)::int c from pg_proc where proname like 'nicepay_%' or proname = 'confirm_nicepay_payment'`)).rows[0].c), 0);
    // 환불 수정 롤백: 이전(라이브) 차단 조건으로 복귀
    await db.exec(refundRollback);
    assert.ok(/in \('toss', 'portone'\)/.test((await db.query(`select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) d`)).rows[0].d));
  } finally { await db.close(); }
});
