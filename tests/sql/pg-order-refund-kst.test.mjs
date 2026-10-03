// 격리 PostgreSQL(PGlite) — PG/주문/환불 날짜 KST 정합성(세 함수). Production 라이브 정의(fix_*/rollback_* 안의 본문)를 그대로 실행한다.
// 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/pg-order-refund-kst.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('fix_pg_order_refund_kst_dates_20261004.sql');
const rollback = read('rollback_fix_pg_order_refund_kst_dates_20261004.sql');
const verifySql = read('verify_pg_order_refund_kst_dates_20261004.sql').replace(/^\s*--.*$/gm, '');
const id = (k, n) => `${String(k).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C1 = id(1, 1), P1 = id(2, 1), ACC = id(3, 1), MGR = id(3, 2), PROD = id(4, 1);
const KST = `(now() at time zone 'Asia/Seoul')::date`;
const TZS = ['UTC', 'Etc/GMT+12', 'Pacific/Kiritimati'];   // UTC-12 와 UTC+14는 어느 순간에도 날짜가 달라 둘 중 하나는 반드시 KST 날짜와 어긋난다

async function world(apply = true) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create function my_account_id() returns uuid language sql stable as $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;
    create table perms(account_id uuid, center_id uuid, perm text);
    create function has_permission(c uuid, p text) returns boolean language sql stable as $$ select exists (select 1 from perms where account_id = my_account_id() and center_id = c and perm = p) $$;
    create function is_platform_admin() returns boolean language sql stable as $$ select false $$;
    create table profiles(id uuid primary key, account_id uuid);
    create table products(id uuid primary key, center_id uuid, name text, purchase_count_selectable boolean default false, unlimited_pass boolean default false, total_count int default 10,
      expiry_mode text, expiry_date date, expiry_days int, rolling_month_cutoff_day int default 15, rolling_month_allow_early_use boolean default false);
    create table orders(id uuid primary key default gen_random_uuid(), profile_id uuid, center_id uuid, product_id uuid, product_name text, amount int default 10000, selected_count int,
      selected_day_of_week int, selected_start_time time, selected_size text, auto_book boolean, member_coupon_id uuid, status text default 'pending', paid_at timestamptz, verified boolean default true,
      pay_method text default 'card', payment_provider text);
    create table memberships(id uuid primary key default gen_random_uuid(), profile_id uuid, center_id uuid, product_id uuid, product_name text, pass_type text, total_count int, remaining_count int,
      expires_at date, starts_at date, status text default 'active', bound_day_of_week int, bound_start_time time, selected_size text, auto_book_requested boolean, pg_refund_started_at timestamptz);
    create table payments(id uuid primary key default gen_random_uuid(), center_id uuid, profile_id uuid, membership_id uuid, order_id uuid, sale_type text, revenue_category text, card_amount int, cash_amount int,
      transfer_amount int, point_amount int, direct_amount int, total_amount int, unpaid_amount int, pg_transaction_id text, paid_at timestamptz, status text, memo text);
    create table member_coupons(id uuid primary key, status text, used_at timestamptz, order_id uuid);
    create table center_members(center_id uuid, profile_id uuid, status text default 'active');
    -- 수정 대상이 아닌 helper(스텁): 날짜와 무관
    create function member_can_purchase_product(uuid, uuid) returns boolean language sql as $$ select true $$;
    create function _order_expected_amount(o orders, b boolean) returns int language sql as $$ select o.amount $$;
    create function _order_auto_book(uuid, boolean) returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function ensure_center_member(uuid, uuid) returns void language sql as $$ select 1 $$;
    create function _refund_block_reason(m memberships, b boolean) returns text language sql as $$ select null::text $$;
    create function _restore_order_points(uuid, text) returns void language sql as $$ select 1 $$;
    CREATE OR REPLACE FUNCTION public.calc_rolling_month_dates(p_purchase_ts timestamp with time zone, p_cutoff_day integer) RETURNS TABLE(starts_at date, expires_at date) LANGUAGE sql STABLE AS $f$
      select case when extract(day from (p_purchase_ts at time zone 'Asia/Seoul')) >= p_cutoff_day then (date_trunc('month', (p_purchase_ts at time zone 'Asia/Seoul')::date) + interval '1 month')::date else date_trunc('month', (p_purchase_ts at time zone 'Asia/Seoul')::date)::date end as starts_at,
             case when extract(day from (p_purchase_ts at time zone 'Asia/Seoul')) >= p_cutoff_day then (date_trunc('month', (p_purchase_ts at time zone 'Asia/Seoul')::date) + interval '2 months' - interval '1 day')::date else (date_trunc('month', (p_purchase_ts at time zone 'Asia/Seoul')::date) + interval '1 month' - interval '1 day')::date end as expires_at; $f$;
    insert into profiles values ('${P1}','${ACC}');
    insert into perms values ('${MGR}','${C1}','pass.payment.create');
    insert into center_members(center_id, profile_id) values ('${C1}','${P1}');
  `);
  await db.exec(rollback);          // 직전 라이브 정의 설치
  if (apply) await db.exec(migration);
  return db;
}
const as = async (db, acc, fn) => { await db.exec(`select set_config('app.account_id','${acc ?? ''}', false);`); try { return await fn(); } finally { await db.exec(`select set_config('app.account_id','', false);`); } };
const product = (db, o) => db.exec(`delete from products; insert into products(id, center_id, name, expiry_mode, expiry_date, expiry_days, unlimited_pass, total_count) values ('${PROD}','${C1}','p','${o.mode}', ${o.date ? `'${o.date}'` : 'null'}, ${o.days ?? 'null'}, ${o.unlimited ?? false}, 10)`);
const order = async (db) => { const oid = id(5, Math.floor(Math.random() * 1e9)); await db.exec(`insert into orders(id, profile_id, center_id, product_id, product_name, status) values ('${oid}','${P1}','${C1}','${PROD}','p','pending')`); return oid; };
const issue = (db, oid) => db.query(`select _issue_membership_and_record_payment((select o from orders o where o.id='${oid}'), 'ref-1', 'memo') r`);
const fulfill = (db, oid) => as(db, MGR, () => db.query(`select fulfill_order('${oid}') r`));
const lastMem = async (db) => (await db.query(`select (starts_at = ${KST}) s_today, (expires_at = ${KST} + 30) e_30, starts_at::text s, expires_at::text e from memberships order by starts_at desc limit 1`)).rows[0];

for (const [label, fn] of [['_issue_membership_and_record_payment', issue], ['fulfill_order', fulfill]]) {
  test(`A/B ${label}: 시작일/days형 만료는 DB TimeZone(UTC/UTC-12/UTC+14)과 무관하게 KST 기준(KST 오늘, KST 오늘 + N일), 다른 expiry 모드는 기존 의미 그대로`, async () => {
    const db = await world();
    try {
      for (const tz of TZS) {
        await db.exec(`set time zone '${tz}'; delete from memberships; delete from payments; delete from orders;`);
        await product(db, { mode: 'days', days: 30 });
        await fn(db, await order(db));
        assert.deepEqual(await lastMem(db), { ...(await lastMem(db)), s_today: true, e_30: true }, `${tz} days`);
        // date형: 상품 만료일 그대로, 시작일은 KST 오늘
        await db.exec('delete from memberships; delete from payments; delete from orders;');
        await product(db, { mode: 'date', date: '2030-05-05' });
        await fn(db, await order(db));
        const d = (await db.query(`select expires_at::text e, (starts_at = ${KST}) s from memberships`)).rows[0];
        assert.deepEqual(d, { e: '2030-05-05', s: true }, `${tz} date`);
        // 무제한(만료 NULL)
        await db.exec('delete from memberships; delete from payments; delete from orders;');
        await product(db, { mode: 'none' });
        await fn(db, await order(db));
        assert.deepEqual((await db.query(`select expires_at e, (starts_at = ${KST}) s from memberships`)).rows[0], { e: null, s: true }, `${tz} unlimited`);
        // rolling_month: 이미 KST 기반인 calc_rolling_month_dates 결과와 정확히 같다(early use 시 시작일은 KST 오늘)
        await db.exec('delete from memberships; delete from payments; delete from orders;');
        await product(db, { mode: 'rolling_month' });
        await fn(db, await order(db));
        const rm = (await db.query(`select (m.starts_at = r.starts_at and m.expires_at = r.expires_at) same from memberships m, calc_rolling_month_dates(now(), 15) r`)).rows[0];
        assert.equal(rm.same, true, `${tz} rolling`);
        await db.exec('delete from memberships; delete from payments; delete from orders;');
        await db.exec(`update products set rolling_month_allow_early_use = true`);
        await fn(db, await order(db));
        const early = (await db.query(`select (m.starts_at = ${KST}) kst_today, (m.expires_at = r.expires_at) same_exp from memberships m, calc_rolling_month_dates(now(), 15) r`)).rows[0];
        assert.deepEqual(early, { kst_today: true, same_exp: true }, `${tz} rolling early-use`);
      }
    } finally { await db.close(); }
  });
  test(`negative control — ${label}: 수정 전(rollback) 정의는 UTC-12/UTC+14 중 적어도 한 곳에서 KST 날짜와 어긋난다`, async () => {
    const db = await world(false);
    try {
      const bad = [];
      for (const tz of ['Etc/GMT+12', 'Pacific/Kiritimati']) {
        await db.exec(`set time zone '${tz}'; delete from memberships; delete from payments; delete from orders;`);
        await product(db, { mode: 'days', days: 30 });
        await fn(db, await order(db));
        const m = await lastMem(db); bad.push(!m.s_today || !m.e_30);
      }
      assert.ok(bad.some(Boolean), '수정 전에는 시작일/만료일이 KST와 어긋나는 시간대가 있어야 한다');
    } finally { await db.close(); }
  });
}

test('C _refund_membership_core: 환불 후 "다른 활성 수강권" 판정은 KST 오늘 기준(만료=KST 오늘 → 활성 유지, KST 어제 → expired), 세션 TimeZone 무관, 환불 정책은 그대로', async () => {
  for (const tz of TZS) {
    const db = await world();
    try {
      await db.exec(`set time zone '${tz}'`);
      for (const [label, expires, active] of [['KST 오늘', KST, true], ['KST 어제', `(${KST} - 1)`, false], ['NULL(무기한)', 'null', true]]) {
        await db.exec(`delete from memberships; delete from payments; update center_members set status = 'active'`);
        const A = id(6, 1), B = id(6, 2);
        await db.exec(`insert into memberships(id, profile_id, center_id, product_id, remaining_count, expires_at, status) values ('${A}','${P1}','${C1}','${PROD}',3,${KST}+10,'active'), ('${B}','${P1}','${C1}','${PROD}',5,${expires},'active');
          insert into payments(center_id, profile_id, membership_id, total_amount, paid_at, status) values ('${C1}','${P1}','${A}', 10000, now(), 'paid');`);
        const r = (await db.query(`select _refund_membership_core('${A}', '${ACC}', true, true) r`)).rows[0].r;
        assert.deepEqual([r.refunded, r.amount], [true, 10000], `${tz} ${label}`);
        assert.equal((await db.query(`select status from center_members where profile_id='${P1}'`)).rows[0].status, active ? 'active' : 'expired', `${tz} ${label}`);
        // 기존 환불 동작 보존: 환불 상태/횟수 0, 환불 payment(-금액) 1건
        assert.deepEqual((await db.query(`select status, remaining_count from memberships where id='${A}'`)).rows[0], { status: 'refunded', remaining_count: 0 });
        assert.equal((await db.query(`select count(*)::int c from payments where sale_type='refund' and total_amount = -10000`)).rows[0].c, 1);
        assert.equal((await db.query(`select status from memberships where id='${B}'`)).rows[0].status, 'active');   // 다른 수강권은 건드리지 않음
      }
      // 다른 활성 수강권이 없으면(횟수 소진/환불됨) expired — 날짜 외 판정(remaining_count/status) 유지
      await db.exec(`delete from memberships; delete from payments; update center_members set status = 'active'`);
      const A = id(6, 3), B = id(6, 4);
      await db.exec(`insert into memberships(id, profile_id, center_id, remaining_count, expires_at, status) values ('${A}','${P1}','${C1}',3,${KST}+10,'active'), ('${B}','${P1}','${C1}',0,${KST}+10,'active')`);
      await db.query(`select _refund_membership_core('${A}', '${ACC}', true, true)`);
      assert.equal((await db.query(`select status from center_members where profile_id='${P1}'`)).rows[0].status, 'expired');
    } finally { await db.close(); }
  }
});

test('negative control — _refund_membership_core: 수정 전 정의는 KST 경계에서 활성 수강권을 잘못 판정(UTC+14/UTC-12 중 한 곳 이상)', async () => {
  const db = await world(false);
  try {
    const wrong = [];
    for (const [tz, expires, active] of [['Pacific/Kiritimati', KST, true], ['Etc/GMT+12', `(${KST} - 1)`, false]]) {
      await db.exec(`set time zone '${tz}'; delete from memberships; delete from payments; update center_members set status = 'active'`);
      const A = id(6, 5), B = id(6, 6);
      await db.exec(`insert into memberships(id, profile_id, center_id, remaining_count, expires_at, status) values ('${A}','${P1}','${C1}',3,${KST}+10,'active'), ('${B}','${P1}','${C1}',5,${expires},'active')`);
      await db.query(`select _refund_membership_core('${A}', '${ACC}', true, true)`);
      const st = (await db.query(`select status from center_members where profile_id='${P1}'`)).rows[0].status;
      wrong.push(st !== (active ? 'active' : 'expired'));
    }
    assert.ok(wrong.some(Boolean));
  } finally { await db.close(); }
});

test('날짜 외 동작 보존: fulfill_order 멱등/취소 주문/권한, 환불 정책(이미 환불됨/타 계정)은 수정 전후 동일', async () => {
  const db = await world();
  try {
    await product(db, { mode: 'days', days: 30 });
    const o = await order(db);
    const r1 = (await fulfill(db, o)).rows[0].r;
    assert.equal(r1.already_done, false);
    assert.equal((await fulfill(db, o)).rows[0].r.already_done, true);                                   // 멱등: 두 번째는 already_done
    assert.equal((await db.query(`select count(*)::int c from memberships`)).rows[0].c, 1);
    assert.equal((await db.query(`select count(*)::int c from payments`)).rows[0].c, 1);
    const cancelled = await order(db); await db.exec(`update orders set status='cancelled' where id='${cancelled}'`);
    await assert.rejects(fulfill(db, cancelled), /취소된 주문은 발급할 수 없어요/);
    const o3 = await order(db);
    await assert.rejects(as(db, ACC, () => db.query(`select fulfill_order('${o3}')`)), /처리할 권한이 없어요/);   // 권한 없는 사용자
    const m = r1.membership_id;
    await db.query(`select _refund_membership_core('${m}', '${ACC}', true, true)`);
    await assert.rejects(db.query(`select _refund_membership_core('${m}', '${ACC}', true, true)`), /이미 환불된 수강권이에요/);
    await assert.rejects(db.query(`select _refund_membership_core('${m}', '${MGR}', true, true)`), /수강권을 찾을 수 없어요/);   // 다른 계정 소유 수강권
  } finally { await db.close(); }
});

test('보안 계약: 시그니처/SECURITY DEFINER/search_path 불변, 내부 helper는 owner 외 실행 불가, fulfill_order는 authenticated만 — 수정 전·후 동일', async () => {
  const snap = async (db) => (await db.query(`select p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef, p.proconfig::text cfg, has_function_privilege('anon', p.oid,'execute') a, has_function_privilege('authenticated', p.oid,'execute') u, has_function_privilege('service_role', p.oid,'execute') s, has_function_privilege('public', p.oid,'execute') pub
    from pg_proc p where p.proname in ('_issue_membership_and_record_payment','fulfill_order','_refund_membership_core') order by 1`)).rows;
  const before = await world(false), after = await world(true);
  try {
    // 수정 전(rollback 직후)의 Production 기본 ACL 재현: 내부 helper는 owner 전용, fulfill_order는 authenticated
    const b = await snap(before), a = await snap(after);
    assert.deepEqual(a.map(r => [r.proname, r.args, r.prosecdef, r.cfg]), b.map(r => [r.proname, r.args, r.prosecdef, r.cfg]));
    for (const r of a) {
      assert.equal(r.prosecdef, true); assert.match(r.cfg, /search_path=public/);
      assert.deepEqual([r.a, r.s, r.pub], [false, false, false], r.proname);
      assert.equal(r.u, r.proname === 'fulfill_order', r.proname);
    }
  } finally { await before.close(); await after.close(); }
});

test('범위 계약: migration은 세 함수만 정의하고 current_date를 쓰지 않으며 rollback은 직전 정의로 복원 + 재실행 안전', async () => {
  const sql = migration.replace(/--.*$/gm, '');
  assert.deepEqual([...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map(m => m[1]).sort(), ['_issue_membership_and_record_payment', '_refund_membership_core', 'fulfill_order']);
  assert.doesNotMatch(sql, /\bcurrent_date\b/);
  assert.doesNotMatch(sql, /\b(create policy|drop policy|alter table|create table|create trigger|drop function|insert into public\.(?!memberships|payments)|truncate)\b/i);
  assert.match(sql, /begin;[\s\S]*commit;/);
  const rb = rollback.replace(/--.*$/gm, '');
  assert.equal((rb.match(/\bcurrent_date\b/g) || []).length, 3);   // 수정 전 정의 = 세 군데
  assert.ok(rb.includes("(now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval)::date"));
  const db = await world();
  try {
    await db.exec(migration);   // idempotent
    await db.exec(rollback); await db.exec(rollback);
    await db.exec(migration);
  } finally { await db.close(); }
});

// ---- verify: 왕복 + formatting-safe + 조건 하나 제거 시 NOT_APPLIED
const fnText = (sql, name) => { const a = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); const b = sql.indexOf('$function$;', sql.indexOf('AS $function$', a)); return sql.slice(a, b + '$function$;'.length); };
const crlf = s => s.replace(/\r?\n/g, '\r\n');
const reindent = s => s.split('\n').map((l, i) => (i % 2 ? '\t\t  ' : '        ') + l.trim().replace(/[ \t]{2,}/g, ' ')).join('\n');
const noComments = s => s.split('\n').map(l => l.replace(/\s*--.*$/, '')).join('\n');
const qualify = s => s.replace(/\b(from|join|into|update) (?!public\.)(memberships|payments|orders|products|profiles|center_members|member_coupons)\b/g, '$1 public.$2');
async function installFrom(transform, mutate = s => s) {
  const db = await world(false);
  const t = s => transform(mutate(s));
  await db.exec(t(migration));
  return db;
}
test('verify: 원본 적용 후 APPLIED(모든 *_ok true), rollback 후 NOT_APPLIED(보안/보존 항목은 true), 포맷이 달라도 APPLIED', async () => {
  const db = await world();
  try {
    const r = (await db.query(verifySql)).rows[0];
    assert.equal(r.verdict, 'APPLIED');
    for (const k of Object.keys(r).filter(k => k.endsWith('_ok'))) assert.equal(r[k], true, k);
    assert.ok(Object.keys(r).filter(k => k.endsWith('_ok')).length >= 11);
    assert.match(r.info_remaining_current_date_functions, /^$/);   // 이 fixture에는 evaluate_notification_rules가 없다
    await db.exec(rollback);
    const b = (await db.query(verifySql)).rows[0];
    assert.equal(b.verdict, 'NOT_APPLIED');
    for (const k of ['issue_kst_starts_and_expiry_ok', 'fulfill_kst_starts_and_expiry_ok', 'refund_remaining_active_kst_ok']) assert.equal(b[k], false, k);
    for (const k of ['issue_behavior_preserved_ok', 'fulfill_behavior_preserved_ok', 'refund_behavior_preserved_ok', 'all_security_definer_ok', 'all_search_path_pinned_ok', 'internal_helpers_not_executable_ok', 'fulfill_order_execute_contract_ok']) assert.equal(b[k], true, `${k} (적용 전에도 true여야 한다)`);
  } finally { await db.close(); }
  for (const [label, tf] of Object.entries({ CRLF: crlf, '들여쓰기·공백': reindent, '주석 없음': noComments, 'public. 접두사': qualify, 전부: s => qualify(noComments(crlf(reindent(s)))) })) {
    const d = await installFrom(tf);
    try { assert.equal((await d.query(verifySql)).rows[0].verdict, 'APPLIED', label); } finally { await d.close(); }
  }
});
test('verify negative-control: 날짜/보존/보안 조건을 하나씩 깨뜨리면 NOT_APPLIED', async () => {
  const MUT = [
    ['refund에 current_date 복귀', s => s.replace("m.expires_at >= (now() at time zone 'Asia/Seoul')::date", 'm.expires_at >= current_date'), 'refund_remaining_active_kst_ok'],
    ['issue 시작일 current_date', s => s.replace(/(_issue_membership_and_record_payment[\s\S]*?)v_starts := \(now\(\) at time zone 'Asia\/Seoul'\)::date;/, '$1v_starts := current_date;'), 'issue_kst_starts_and_expiry_ok'],
    ['fulfill days형 만료를 UTC date cast로', s => s.replace(/(CREATE OR REPLACE FUNCTION public\.fulfill_order[\s\S]*?)\(\(now\(\) \+ \(coalesce\(v_product\.expiry_days, 0\) \|\| ' days'\)::interval\) at time zone 'Asia\/Seoul'\)::date/, "$1(now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval)::date"), 'fulfill_kst_starts_and_expiry_ok'],
    ['환불에서 포인트 복원 호출 제거(동작 보존 위반)', s => s.replace("perform _restore_order_points(v_order_id, '환불 포인트 복원');", ''), 'refund_behavior_preserved_ok'],
    ['fulfill 취소 주문 거부 제거', s => s.replace("if v_order.status = 'cancelled' then", 'if false then'), 'fulfill_behavior_preserved_ok'],
    ['issue 금액 검증 제거', s => s.replace('v_expected_amount := _order_expected_amount(p_order, true);', 'v_expected_amount := p_order.amount;'), 'issue_behavior_preserved_ok'],
    ['환불 search_path 제거', s => s.replace(/(CREATE OR REPLACE FUNCTION public\._refund_membership_core[\s\S]*?SECURITY DEFINER\n) SET search_path TO 'public'\n/, '$1'), 'all_search_path_pinned_ok'],
  ];
  for (const [label, mutate, col] of MUT) {
    const d = await installFrom(s => s, mutate);
    try { const r = (await d.query(verifySql)).rows[0]; assert.equal(r.verdict, 'NOT_APPLIED', label); assert.equal(r[col], false, `${label} → ${col}`); } finally { await d.close(); }
  }
  const db = await world();
  try {
    for (const [label, brk, fix, col] of [
      ['내부 helper를 authenticated에게', 'grant execute on function _issue_membership_and_record_payment(orders, text, text) to authenticated', 'revoke execute on function _issue_membership_and_record_payment(orders, text, text) from authenticated', 'internal_helpers_not_executable_ok'],
      ['환불 helper를 anon에게', 'grant execute on function _refund_membership_core(uuid, uuid, boolean, boolean) to anon', 'revoke execute on function _refund_membership_core(uuid, uuid, boolean, boolean) from anon', 'internal_helpers_not_executable_ok'],
      ['fulfill_order를 anon에게', 'grant execute on function fulfill_order(uuid) to anon', 'revoke execute on function fulfill_order(uuid) from anon', 'fulfill_order_execute_contract_ok'],
      ['fulfill_order authenticated 회수', 'revoke execute on function fulfill_order(uuid) from authenticated', 'grant execute on function fulfill_order(uuid) to authenticated', 'fulfill_order_execute_contract_ok'],
    ]) {
      await db.exec(brk);
      const r = (await db.query(verifySql)).rows[0];
      assert.equal(r.verdict, 'NOT_APPLIED', label); assert.equal(r[col], false, `${label} → ${col}`);
      await db.exec(fix);
      assert.equal((await db.query(verifySql)).rows[0].verdict, 'APPLIED', `${label} 원복`);
    }
    assert.doesNotMatch(verifySql, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
    assert.match(verifySql.trim(), /^with\b/i);
  } finally { await db.close(); }
});
