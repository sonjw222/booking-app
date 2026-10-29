import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

/* 만료 상품 기존 pending 주문 처리(add_expired_order_resolution_20261031.sql) — PGlite(실제 PostgreSQL 엔진)로 RPC 규칙을 검증한다.
   해시 가드·fulfill_order 제자리 패치는 운영 함수가 없어 시험하지 않고(격리 Supabase 스택 시험 scripts/isolated/expiredOrder/verify.mjs 가 한다),
   테이블+RPC 본문만 적용하고 fulfill_order 는 "같은 계약"(GUC 로 지정된 만료일 적용, 이미 done 이면 already_done)을 흉내 낸 스텁으로 둔다. */
const SQL = readFileSync(new URL('../../add_expired_order_resolution_20261031.sql', import.meta.url), 'utf8');
const FIX = readFileSync(new URL('../../fix_expired_fixed_date_products_20261031.sql', import.meta.url), 'utf8');
const tableAndRpc = SQL.slice(SQL.indexOf('create table if not exists public.order_expiry_resolutions'), SQL.indexOf('-- ── fulfill_order 제자리 패치 ──'));
const helper = FIX.slice(FIX.indexOf('create or replace function public.fixed_expiry_passed'), FIX.indexOf('comment on function public.fixed_expiry_passed'));
const KST = "(now() at time zone 'Asia/Seoul')::date";
const C1 = '00000000-0000-0000-0000-0000000000c1', C2 = '00000000-0000-0000-0000-0000000000c2';
const PROF = '00000000-0000-0000-0000-0000000000f1', ACC_ADMIN = '00000000-0000-0000-0000-0000000000a1', ACC_OTHER = '00000000-0000-0000-0000-0000000000a2', ACC_MEMBER = '00000000-0000-0000-0000-0000000000a3';
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

const schema = `
create role authenticated; create role anon; create role service_role;
create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create table centers(id uuid primary key, name text); create table accounts(id uuid primary key, auth_id uuid);
create table products(id uuid primary key, center_id uuid, name text, expiry_mode text, expiry_date date);
create table memberships(id uuid primary key default gen_random_uuid(), profile_id uuid, center_id uuid, product_id uuid, expires_at date);
create table payments(id uuid primary key default gen_random_uuid(), order_id uuid, membership_id uuid, total_amount int, memo text);
create table orders(id uuid primary key default gen_random_uuid(), center_id uuid not null, profile_id uuid not null, product_id uuid, product_name text, pg_tid text, pg_claim_id uuid, amount int, pay_method text default 'direct', payment_provider text, status text default 'pending', created_at timestamptz default now());
create table perms(account_id uuid, center_id uuid, key text);
create function my_account_id() returns uuid language sql stable as $$ select id from accounts where auth_id = auth.uid() $$;
create function has_permission(p_center uuid, p_key text) returns boolean language sql stable as $$ select exists (select 1 from perms where account_id = my_account_id() and center_id = p_center and key = p_key) $$;
create function is_platform_admin() returns boolean language sql stable as $$ select false $$;
create function my_managed_center_ids() returns setof uuid language sql stable as $$ select center_id from perms where account_id = my_account_id() $$;
${helper}
grant usage on schema public to authenticated, anon; grant select, update on orders to authenticated, anon, service_role; grant select on products, perms, accounts to authenticated, anon;
-- fulfill_order 스텁: 운영 fulfill_order 가 하는 일 중 RPC 계약에 필요한 부분(수강권·결제 생성, GUC 로 지정된 만료일, done 처리, 멱등)
create function fulfill_order(p_order_id uuid) returns json language plpgsql security definer as $$
declare o orders; mid uuid; exp date; begin
  select * into o from orders where id = p_order_id for update;
  if o.status = 'done' then return json_build_object('already_done', true); end if;
  select expiry_date into exp from products where id = o.product_id;
  if exists (select 1 from order_expiry_authz a where a.txid = txid_current() and a.order_id = p_order_id) then exp := (select new_expires_on from order_expiry_authz a where a.txid = txid_current() and a.order_id = p_order_id limit 1); end if;
  insert into memberships(profile_id, center_id, product_id, expires_at) values (o.profile_id, o.center_id, o.product_id, exp) returning id into mid;
  insert into payments(order_id, membership_id, total_amount, memo) values (p_order_id, mid, o.amount, '앱 주문 자동 발급');
  update orders set status = 'done' where id = p_order_id;
  return json_build_object('already_done', false, 'membership_id', mid);
end $$;
${tableAndRpc}
`;
const as = async (db, acc, fn) => { await db.exec(`select set_config('test.uid', '${acc ?? ''}', false)`); try { return await fn(); } finally { await db.exec(`select set_config('test.uid', '${ACC_ADMIN}', false)`); } };
async function seed(db) {
  await db.exec(`insert into centers values ('${C1}','센터1'),('${C2}','센터2');
    insert into accounts values ('${ACC_ADMIN}','${ACC_ADMIN}'),('${ACC_OTHER}','${ACC_OTHER}'),('${ACC_MEMBER}','${ACC_MEMBER}');
    insert into perms values ('${ACC_ADMIN}','${C1}','pass.payment.create'),('${ACC_OTHER}','${C2}','pass.payment.create');
    insert into products values ('${id(1)}','${C1}','만료','date', ${KST} - 1), ('${id(2)}','${C1}','오늘','date', ${KST}), ('${id(3)}','${C1}','30일','days', null);`);
}
const order = async (db, n, product, extra = '') => { await db.exec(`insert into orders(id, center_id, profile_id, product_id, amount ${extra ? ',' + extra.split('=')[0] : ''}) values ('${id(n)}','${C1}','${PROF}','${id(product)}', 80000 ${extra ? ',' + extra.split('=')[1] : ''})`); return id(n); };
const call = (db, oid, action, args = '') => db.query(`select manager_resolve_expired_order('${oid}', '${action}', '사유 입니다' ${args}) as r`);
const rec = async (db) => ({ recv: `, 80000, ${KST}, 'cash'`, adj: `, 80000, ${KST}, 'cash', ${KST} + 30` });
const err = async (p) => { try { await p; return null; } catch (e) { return String(e.message); } };
const status = async (db, oid) => (await db.query(`select status from orders where id='${oid}'`)).rows[0].status;
const n = async (db, t, oid) => Number((await db.query(`select count(*)::int c from ${t} where order_id='${oid}'`)).rows[0].c);

test('만료 상품 주문 처리 RPC: 미수납 취소·환불 예정/완료·기간 조정, 권한·검증·멱등·원자성', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema); await seed(db); await db.exec(`select set_config('test.uid', '${ACC_ADMIN}', false)`);
    const R = await rec(db);
    // 권한: 일반 회원·타 센터 관리자·로그인 없음 거부
    const o1 = await order(db, 11, 1);
    for (const acc of [ACC_MEMBER, ACC_OTHER]) assert.match(await as(db, acc, () => err(call(db, o1, 'unpaid_cancel'))), /권한/);
    assert.match(await as(db, null, () => err(call(db, o1, 'unpaid_cancel'))), /로그인/);
    assert.equal(await status(db, o1), 'pending');
    // 검증: 사유·알 수 없는 방식·만료 아닌 상품(오늘 만료·일수 만료)
    assert.match(await err(db.query(`select manager_resolve_expired_order('${o1}','unpaid_cancel',' ')`)), /사유/);
    assert.match(await err(call(db, o1, 'drop_table')), /알 수 없는 처리 방식/);
    const oToday = await order(db, 12, 2), oDays = await order(db, 13, 3);
    for (const o of [oToday, oDays]) assert.match(await err(call(db, o, 'unpaid_cancel')), /판매 기간이 지난 상품의 주문만/);
    // PG 주문 제외
    const oPg = await order(db, 14, 1, `payment_provider='toss'`); assert.match(await err(call(db, oPg, 'unpaid_cancel')), /직접결제 주문만/);
    // 미수납 취소
    await call(db, o1, 'unpaid_cancel');
    assert.equal(await status(db, o1), 'cancelled'); assert.equal(await n(db, 'memberships', o1).catch(() => 0), 0);
    assert.equal((await db.query(`select count(*)::int c from payments where order_id='${o1}'`)).rows[0].c, 0);
    assert.equal(await n(db, 'order_expiry_resolutions', o1), 1);
    assert.match(await err(call(db, o1, 'unpaid_cancel')), /확인 대기 상태의 주문만/);     // 중복 클릭
    // 환불: 금액 불일치·누락·미래 수납일 거부 → 예정 → pending 유지·매출 없음 → 환불 완료
    const o2 = await order(db, 21, 1);
    assert.match(await err(call(db, o2, 'refund_plan', `, 1000, ${KST}, 'cash'`)), /주문 금액/);
    assert.match(await err(call(db, o2, 'refund_plan')), /수납 금액·수납일·수납 수단/);
    assert.match(await err(call(db, o2, 'refund_plan', `, 80000, ${KST} + 1, 'cash'`)), /수납일은 오늘 이후일 수 없어요/);
    await call(db, o2, 'refund_plan', R.recv);
    assert.equal(await status(db, o2), 'pending'); assert.equal((await db.query(`select count(*)::int c from payments where order_id='${o2}'`)).rows[0].c, 0);
    assert.match(await err(call(db, o2, 'adjust_period', R.adj)), /이미 처리가 기록된/);
    assert.match(await as(db, ACC_OTHER, () => err(call(db, o2, 'refund_complete'))), /권한/);
    assert.match(await err(db.query(`select manager_resolve_expired_order('${o2}','refund_complete','환불함', null, null, null, null, ${KST} - 5)`)), /환불일은 수납일보다/);
    await db.query(`select manager_resolve_expired_order('${o2}','refund_complete','현금 환불 완료')`);
    assert.equal(await status(db, o2), 'cancelled'); assert.equal((await db.query(`select resolution from order_expiry_resolutions where order_id='${o2}'`)).rows[0].resolution, 'refund_completed');
    assert.match(await err(call(db, o2, 'refund_complete')), /환불 예정으로 기록된 주문만/);
    const oNo = await order(db, 22, 1); assert.match(await err(call(db, oNo, 'refund_complete')), /환불 예정으로 기록된 주문만/);
    // 기간 조정: 오늘/과거 거부, 성공(수강권 1건에 새 만료일, 상품 만료일 불변, 매출 1건), 재처리 거부
    const o3 = await order(db, 31, 1);
    assert.match(await err(call(db, o3, 'adjust_period', `, 80000, ${KST}, 'cash', ${KST}`)), /오늘\(KST\)보다 뒤/);
    assert.match(await err(call(db, o3, 'adjust_period', `, 80000, ${KST}, 'cash', ${KST} - 3`)), /오늘\(KST\)보다 뒤/);
    assert.equal(await status(db, o3), 'pending');
    const before = (await db.query(`select expiry_date::text d from products where id='${id(1)}'`)).rows[0].d;
    const r = (await call(db, o3, 'adjust_period', R.adj)).rows[0].r;
    assert.equal(r.order_status, 'done'); assert.equal(await status(db, o3), 'done');
    assert.equal((await db.query(`select count(*)::int c from payments where order_id='${o3}'`)).rows[0].c, 1);
    assert.equal((await db.query(`select count(*)::int c from memberships where profile_id='${PROF}' and product_id='${id(1)}'`)).rows[0].c, 1);
    assert.equal((await db.query(`select (expires_at = ${KST} + 30) ok from memberships where id='${r.membership_id}'`)).rows[0].ok, true);
    assert.equal((await db.query(`select expiry_date::text d from products where id='${id(1)}'`)).rows[0].d, before);
    assert.match((await db.query(`select memo from payments where order_id='${o3}'`)).rows[0].memo, /이용기간 조정\(수납 확인: cash/);
    assert.match(await err(call(db, o3, 'adjust_period', R.adj)), /확인 대기 상태의 주문만/);
    // 원자성: 이력 INSERT 실패 → 수강권·결제·주문 상태 모두 롤백, 임시 설정 흔적 없음
    const o4 = await order(db, 41, 1);
    await db.exec(`create function failer() returns trigger language plpgsql as $$ begin raise exception 'FORCED'; end $$; create trigger t before insert on order_expiry_resolutions for each row execute function failer()`);
    assert.match(await err(call(db, o4, 'adjust_period', R.adj)), /FORCED/);
    await db.exec(`drop trigger t on order_expiry_resolutions`);
    assert.equal(await status(db, o4), 'pending'); assert.equal((await db.query(`select count(*)::int c from payments where order_id='${o4}'`)).rows[0].c, 0);
    assert.equal((await db.query(`select count(*)::int c from memberships where profile_id='${PROF}' and product_id='${id(1)}'`)).rows[0].c, 1);   // o3 의 1건만
    assert.equal((await db.query(`select coalesce(current_setting('app.expired_order_resolution', true), '') v`)).rows[0].v, '');
    // 상품 데이터·다른 주문 불변
    assert.equal((await db.query(`select count(*)::int c from orders where status='pending'`)).rows[0].c, 5);   // o4, oToday, oDays, oPg, oNo
  } finally { await db.close(); }
});

test('클라이언트 UPDATE 가드: 환불 예정·만료 주문의 일반 취소/확정/제공자·결제수단·상품 변경 우회 차단, 일반 주문·서버 경로 정상, 내부 인증 위조 불가', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema); await seed(db); await db.exec(`select set_config('test.uid', '${ACC_ADMIN}', false)`);
    const R = await rec(db);
    const client = async (sql) => { await db.exec('set role authenticated'); try { return await err(db.query(sql)); } finally { await db.exec('reset role'); } };
    const upd = (oid, set) => client(`update orders set ${set} where id = '${oid}'`);
    const pass = (e) => assert.equal(e, null);
    const oRef = await order(db, 51, 1); await call(db, oRef, 'refund_plan', R.recv);
    for (const st of ['cancelled', 'done', 'paid']) assert.match(await upd(oRef, `status = '${st}'`), /판매 기간이 지난 상품의 주문/);
    assert.match(await upd(oRef, `payment_provider = 'mock', status = 'done'`), /바꿀 수 없어요/);
    assert.equal(await status(db, oRef), 'pending');
    await db.query(`select manager_resolve_expired_order('${oRef}','refund_complete','환불 완료')`);   // RPC(definer, 실행 역할=소유자)는 가드 대상이 아님
    assert.equal(await status(db, oRef), 'cancelled');
    const oExp = await order(db, 52, 1);                                                             // 기록 없는 만료 직접결제 주문
    for (const set of [`status = 'done'`, `status = 'paid'`, `status = 'cancelled'`, `payment_provider = 'mock'`, `payment_provider = 'mock', status = 'done'`, `pay_method = 'card'`, `product_id = '${id(3)}'`, `product_name = 'x'`, `amount = 1`, `product_id = '${id(3)}', status = 'done'`, `center_id = '${C2}'`])
      assert.ok(await upd(oExp, set), `거부돼야 함: ${set}`);
    assert.equal(await status(db, oExp), 'pending');
    assert.deepEqual((await db.query(`select payment_provider, pay_method, product_id from orders where id='${oExp}'`)).rows[0], { payment_provider: null, pay_method: 'direct', product_id: id(1) });
    await call(db, oExp, 'unpaid_cancel'); assert.equal(await status(db, oExp), 'cancelled');         // 미수납 취소는 RPC 로만 정상
    // 일반(만료 아님) 상품 주문: 취소·확정 기존대로, 정체성 컬럼은 대기 주문에서 잠금
    const oN = await order(db, 53, 3), oN2 = await order(db, 54, 3), oN3 = await order(db, 56, 3);
    pass(await upd(oN, `status = 'cancelled'`)); pass(await upd(oN2, `status = 'done'`));
    assert.match(await upd(oN3, `payment_provider = 'mock'`), /바꿀 수 없어요/);
    // 서버(service_role / 소유자) 경로: PG 승인 이력이 있는 주문 취소 등은 이 가드의 대상이 아님
    const oPg = await order(db, 55, 1, `payment_provider='nicepay'`);
    await db.exec(`set role service_role`); try { await db.query(`update orders set status = 'cancelled' where id = '${oPg}'`); } finally { await db.exec('reset role'); }
    assert.equal(await status(db, oPg), 'cancelled');
    // 위조 불가: 클라이언트는 인증 테이블을 읽거나 쓸 수 없고, 세션 설정만으로 가드를 통과할 수 없다
    const oF = await order(db, 57, 1);
    assert.match(await client(`insert into order_expiry_authz(txid, order_id) values (txid_current(), '${oF}')`), /permission denied/);
    assert.match(await client(`select * from order_expiry_authz`), /permission denied/);
    await db.exec(`select set_config('app.expired_order_resolution', '${oF}', false), set_config('app.expired_order_new_expiry', '2099-01-01', false)`);
    assert.ok(await upd(oF, `status = 'done'`));   // 설정값을 위조해도 PATCH 는 막힘(fulfill_order 가드는 격리 스택 F3 에서 검증)
    assert.equal(await status(db, oF), 'pending');
    await db.exec(`select set_config('app.expired_order_resolution', '', false)`);
    // 기간 조정 발급 후 인증 행이 남지 않는다
    const oA = await order(db, 58, 1); await call(db, oA, 'adjust_period', R.adj);
    assert.equal((await db.query(`select count(*)::int c from order_expiry_authz`)).rows[0].c, 0);
    assert.equal(await status(db, oA), 'done');
  } finally { await db.close(); }
});
test('SQL 계약: 롤백 파일은 환불 예정 주문이 있으면 중단하고 처리 이력은 보존, fulfill_order 패치는 해시·치환 위치 가드를 가진다', () => {
  const RB = readFileSync(new URL('../../rollback_add_expired_order_resolution_20261031.sql', import.meta.url), 'utf8');
  assert.match(RB, /롤백 중단: 환불 예정으로 기록된 주문이/); assert.match(RB, /order_expiry_resolutions 에 처리 이력이 있어 테이블은 남겼어요/);
  assert.match(SQL, /삽입 위치 ①이 1곳이 아니에요/); assert.match(SQL, /삽입 위치 ②가 1곳이 아니에요/); assert.match(SQL, /패치 결과 해시가 기대값과 달라요 — 트랜잭션 전체를 롤백/);
  assert.match(SQL, /has_permission\(v_order\.center_id, 'pass\.payment\.create'\) or is_platform_admin\(\)/);   // 기존 fulfill_order 와 같은 권한 키(확대 없음)
  assert.match(SQL, /create trigger orders_guard_expired_resolution before update on public\.orders/); assert.doesNotMatch(SQL, /current_setting\('app\.expired|set_config\('app\.expired/); assert.match(RB, /drop trigger if exists orders_guard_expired_resolution/);
  assert.doesNotMatch(SQL, /update\s+products|delete\s+from\s+(orders|memberships|payments)/i);                 // 상품·기존 데이터 직접 변경 없음
  assert.match(SQL, /grant execute on function public\.manager_resolve_expired_order\([^)]*\) to authenticated, service_role/);
  assert.match(SQL, /revoke all on function public\.manager_resolve_expired_order\([^)]*\) from public, anon/);
});
