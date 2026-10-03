// 격리 PostgreSQL(PGlite) — Batch B(manager_grant_product 예약조건 검증) + Batch C(KST 날짜). 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/grant-schedule-kst.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('fix_grant_schedule_and_kst_dates_20261003.sql');
const rollback = read('rollback_fix_grant_schedule_and_kst_dates_20261003.sql');
const verify = read('verify_grant_schedule_and_kst_dates_20261003.sql').replace(/--.*$/gm, '');
const id = (k, n) => `${String(k).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C1 = id(1, 1), C2 = id(1, 2), MGR = id(2, 1), NOPERM = id(2, 2), MEMBER_ACC = id(2, 3), OTHER_ACC = id(2, 4);
const P_MEMBER = id(3, 1), P_OTHER_CENTER = id(3, 2), P_WAIT = id(3, 3);
// 대기 승격은 예약 무결성 migration이 이미 적용한 is_membership_eligible_for_class를 "재사용"한다(이 migration은 재정의하지 않음) — 그 정의를 integrity SQL에서 그대로 꺼내 설치
const integritySql = read('fix_reservation_integrity_20261003.sql');
const ELIGIBLE_FN = integritySql.slice(integritySql.indexOf('CREATE OR REPLACE FUNCTION public.is_membership_eligible_for_class'), integritySql.indexOf('$function$;', integritySql.indexOf('CREATE OR REPLACE FUNCTION public.is_membership_eligible_for_class')) + '$function$;'.length);
const LIVE_ORDER_TRIGGER = String.raw`CREATE OR REPLACE FUNCTION public.orders_require_schedule_selection()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_weekday boolean;
    v_time    boolean;
    v_kind    text;
begin
    if new.product_id is null then
        return new;
    end if;
    select coalesce(weekday_selectable, false), coalesce(time_selectable, false), product_kind
      into v_weekday, v_time, v_kind
      from products where id = new.product_id;
    if not found or not v_weekday or v_kind = 'goods' then
        return new;
    end if;

    if new.selected_day_of_week is null then
        raise exception '이용할 요일을 선택해 주세요';
    end if;
    if not exists (
        select 1 from membership_schedule_rules r
         where r.product_id = new.product_id and r.day_of_week = new.selected_day_of_week
    ) then
        raise exception '선택할 수 없는 요일이에요. 센터에 문의해주세요';
    end if;
    if v_time then
        if new.selected_start_time is null then
            raise exception '이용할 시간을 선택해 주세요';
        end if;
        if not exists (
            select 1 from membership_schedule_rules r
             where r.product_id = new.product_id and r.day_of_week = new.selected_day_of_week and r.start_time = new.selected_start_time
        ) then
            raise exception '선택할 수 없는 시간이에요. 센터에 문의해주세요';
        end if;
    end if;
    return new;
end;
$function$`;

async function world({ apply = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create function my_account_id() returns uuid language sql stable as $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;
    create table perms(account_id uuid, center_id uuid, perm text);
    create function has_permission(p_center_id uuid, p_permission text) returns boolean language sql stable as $$ select exists (select 1 from perms where account_id = my_account_id() and center_id = p_center_id and perm = p_permission) $$;
    create function is_platform_admin() returns boolean language sql stable as $$ select false $$;
    create table accounts(id uuid primary key, name text);
    create table profiles(id uuid primary key, account_id uuid);
    create table center_members(center_id uuid, profile_id uuid);
    create table products(id uuid primary key default gen_random_uuid(), center_id uuid, name text, product_kind text default 'pass', is_active boolean default true, is_on_sale boolean default true,
      sizes text[], weekday_selectable boolean default false, time_selectable boolean default false, max_quantity int, unlimited boolean default false, unlimited_pass boolean default false,
      purchase_count_selectable boolean default false, total_count int default 10, expiry_mode text default 'days', expiry_days int default 30, expiry_date date, rolling_month_cutoff_day int, rolling_month_allow_early_use boolean);
    create table product_count_prices(product_id uuid, count int, price int);
    create table membership_schedule_rules(id uuid primary key default gen_random_uuid(), product_id uuid not null, day_of_week int, start_time time, class_title text);
    create table memberships(id uuid primary key default gen_random_uuid(), profile_id uuid, center_id uuid, product_id uuid, product_name text, pass_type text, total_count int, remaining_count int,
      expires_at date, starts_at date, status text, bound_day_of_week int, bound_start_time time, selected_size text);
    create table payments(id uuid primary key default gen_random_uuid(), center_id uuid, profile_id uuid, membership_id uuid, sale_type text, revenue_category text, card_amount int, cash_amount int,
      transfer_amount int, point_amount int, total_amount int, unpaid_amount int, trainer_account_id uuid, paid_at timestamptz, memo text, status text);
    create table orders(id uuid primary key default gen_random_uuid(), product_id uuid, selected_day_of_week int, selected_start_time time);
    -- 구매 checkout 트리거(Production 라이브 정의) — 관리자 지급 검증과 같은 의미인지 비교하는 기준
    ${LIVE_ORDER_TRIGGER};
    create trigger t_orders_schedule before insert on orders for each row execute function orders_require_schedule_selection();
    -- cancel_reservation 용
    create table classes(id uuid primary key default gen_random_uuid(), center_id uuid, title text default '정규반', description text, start_time timestamptz, end_time timestamptz, capacity int default 10, class_format text default 'group', status text default 'open',
      pass_selection_mode text default 'all', allow_goods boolean default true, room_id uuid, allow_cancel boolean, cancel_deadline_min int, booking_deadline_min int);
    create table class_allowed_products(class_id uuid, product_id uuid);
    create table class_trainers(class_id uuid, account_id uuid);
    create table center_settings(center_id uuid primary key, same_day_change_hours int, same_day_change_minutes int, deduct_on_late_cancel boolean default false, waitlist_auto_hours int default 0, waitlist_auto_minutes int default 0);
    create table reservations(id uuid primary key default gen_random_uuid(), class_id uuid, profile_id uuid, membership_id uuid, status text, waitlist_order int, cancel_source text, created_at timestamptz default now());
    create function calc_deadline(uuid, text, timestamptz, text) returns timestamptz language sql as $$ select null::timestamptz $$;
    ${ELIGIBLE_FN}
    insert into accounts values ('${MGR}','관리자'), ('${NOPERM}','권한없음'), ('${MEMBER_ACC}','회원'), ('${OTHER_ACC}','대기회원');
    insert into profiles values ('${P_MEMBER}','${MEMBER_ACC}'), ('${P_OTHER_CENTER}','${OTHER_ACC}'), ('${P_WAIT}','${OTHER_ACC}');
    insert into center_members values ('${C1}','${P_MEMBER}'), ('${C2}','${P_OTHER_CENTER}'), ('${C1}','${P_WAIT}');
    insert into perms values ('${MGR}','${C1}','schedule.own.group.update'), ('${MGR}','${C1}','customer.member.issue_pass'), ('${MGR}','${C1}','pass.payment.create'), ('${NOPERM}','${C1}','customer.member.view');
    insert into center_settings(center_id) values ('${C1}');
  `);
  await db.exec(rollback);               // 직전 라이브 정의 설치(rollback 파일 = 수정 전 정의)
  if (apply) await db.exec(migration);
  return db;
}
let seq = 100;
const newProduct = async (db, { weekday = false, time = false, kind = 'pass', center = C1, rules = [], expiryDays = 30 } = {}) => {
  const pid = id(4, ++seq);
  await db.exec(`insert into products(id, center_id, name, product_kind, weekday_selectable, time_selectable, expiry_days) values ('${pid}','${center}','p${seq}','${kind}',${weekday},${time},${expiryDays});`);
  for (const [dow, t] of rules) await db.exec(`insert into membership_schedule_rules(product_id, day_of_week, start_time) values ('${pid}', ${dow === null ? 'null' : dow}, ${t ? `'${t}'` : 'null'});`);
  return pid;
};
const as = async (db, acc, fn) => { await db.exec(`select set_config('app.account_id','${acc ?? ''}', false);`); try { return await fn(); } finally { await db.exec(`select set_config('app.account_id','', false);`); } };
const grant = (db, { acc = MGR, center = C1, profile = P_MEMBER, product, day = null, time = null }) =>
  as(db, acc, () => db.query(`select manager_grant_product('${center}','${profile}','${product}', 10000, 'cash', null, null, null, ${day === null ? 'null' : day}, ${time ? `'${time}'` : 'null'}, null, null) as r`));
const count = async (db, sql) => (await db.query(sql)).rows[0].c;
const orderAccepts = async (db, product, day, time) => { try { await db.exec(`insert into orders(product_id, selected_day_of_week, selected_start_time) values ('${product}', ${day === null ? 'null' : day}, ${time ? `'${time}'` : 'null'})`); return true; } catch { return false; } };
const grantAccepts = async (db, args) => { try { await grant(db, args); return true; } catch { return false; } };

test('B: 요일 선택형(시간 선택 없음) — 규칙에 있는 요일만 지급, 없는 요일/요일 누락/범위 밖은 거부(membership 0행)', async () => {
  const db = await world();
  try {
    const p = await newProduct(db, { weekday: true, rules: [[1, '19:00'], [1, '20:00'], [3, '16:00']] });
    for (const day of [1, 3]) {
      const r = (await grant(db, { product: p, day })).rows[0].r;
      assert.ok(r.membership_id);
    }
    for (const day of [0, 2, 5, 6, null, 7, -1]) await assert.rejects(grant(db, { product: p, day }), /이용 요일|선택할 수 없는 요일/, `day=${day}`);
    assert.equal(await count(db, `select count(*)::int c from memberships`), 2);
    assert.equal(await count(db, `select count(*)::int c from payments`), 2);
    // 지급된 bound 값
    const rows = (await db.query(`select bound_day_of_week d, bound_start_time t from memberships order by bound_day_of_week`)).rows;
    assert.deepEqual(rows.map(r => [r.d, r.t]), [[1, null], [3, null]]);   // 시간 선택형이 아니므로 시간 귀속 없음
  } finally { await db.close(); }
});

test('B: 요일+시간 선택형 — 요일/시간 조합이 규칙에 있어야 지급(유효 요일+무효 시간/다른 요일의 시간 거부), 시간 누락 거부', async () => {
  const db = await world();
  try {
    const p = await newProduct(db, { weekday: true, time: true, rules: [[1, '19:00'], [1, '20:00'], [3, '16:00'], [4, null]] });
    for (const [day, time] of [[1, '19:00'], [1, '20:00'], [3, '16:00']]) assert.ok((await grant(db, { product: p, day, time })).rows[0].r.membership_id);
    for (const [day, time, why] of [[1, '16:00', '유효 요일+다른 요일의 시간'], [3, '19:00', '다른 요일의 시간'], [1, '21:30', '규칙에 없는 시간'], [2, '19:00', '규칙에 없는 요일'], [4, '19:00', '시간 NULL 규칙은 시간 후보가 아님'], [4, null, '시간 선택형인데 시간 누락']]) {
      await assert.rejects(grant(db, { product: p, day, time }), /선택할 수 없는|이용 시간|이용 요일/, why);
    }
    assert.equal(await count(db, `select count(*)::int c from memberships`), 3);
    const t = (await db.query(`select bound_day_of_week d, to_char(bound_start_time,'HH24:MI') t from memberships order by bound_day_of_week, bound_start_time`)).rows;
    assert.deepEqual(t.map(r => [r.d, r.t]), [[1, '19:00'], [1, '20:00'], [3, '16:00']]);
  } finally { await db.close(); }
});

test('B: 다른 상품의 규칙은 소용없음, 규칙이 없는 선택형 상품/"모든 요일" 규칙만 있는 상품은 지급 불가(구매와 동일)', async () => {
  const db = await world();
  try {
    const other = await newProduct(db, { weekday: true, rules: [[2, null]] });
    const mine = await newProduct(db, { weekday: true, rules: [[1, null]] });
    await assert.rejects(grant(db, { product: mine, day: 2 }), /선택할 수 없는 요일/);          // 다른 상품(other)의 규칙(화요일)은 mine에 적용되지 않는다
    assert.ok((await grant(db, { product: other, day: 2 })).rows[0].r.membership_id);
    const none = await newProduct(db, { weekday: true, rules: [] });
    await assert.rejects(grant(db, { product: none, day: 1 }), /선택할 수 없는 요일/);
    const allDays = await newProduct(db, { weekday: true, rules: [[null, '19:00']] });          // 모든 요일 규칙은 선택 후보가 아님
    await assert.rejects(grant(db, { product: allDays, day: 1, time: '19:00' }), /선택할 수 없는 요일/);
  } finally { await db.close(); }
});

test('B: 선택형이 아닌 상품/goods/시간 선택 안 하는 상품은 기존 동작 유지(bound 없으면 검증 없음, 시간 값은 무시)', async () => {
  const db = await world();
  try {
    const plain = await newProduct(db, { rules: [[1, '19:00']] });                               // weekday_selectable=false: 규칙이 있어도 bound 불필요
    const r = (await grant(db, { product: plain })).rows[0].r;
    assert.ok(r.membership_id);
    assert.deepEqual((await db.query(`select bound_day_of_week d, bound_start_time t from memberships where id='${r.membership_id}'`)).rows[0], { d: null, t: null });
    assert.ok((await grant(db, { product: plain, day: 6, time: '03:00' })).rows[0].r.membership_id);   // 선택형이 아니면 전달된 값은 무시된다(기존 동작)
    assert.deepEqual((await db.query(`select bound_day_of_week d from memberships order by id desc limit 1`)).rows[0], { d: null });
    const goods = await newProduct(db, { kind: 'goods', weekday: true, rules: [] });
    assert.ok((await grant(db, { product: goods })).rows[0].r.membership_id);                    // goods는 요일/시간 선택 대상이 아님
    const dayOnly = await newProduct(db, { weekday: true, time: false, rules: [[1, '19:00']] });
    assert.ok((await grant(db, { product: dayOnly, day: 1, time: '03:00' })).rows[0].r.membership_id);   // 시간 선택형이 아니면 시간 값은 무시(검증/저장 안 함)
  } finally { await db.close(); }
});

test('B: 권한/소속 검증은 그대로 — 권한 없는 manager, 다른 센터 회원/상품, 익명 거부(지급 0건)', async () => {
  const db = await world();
  try {
    const p = await newProduct(db, { weekday: true, rules: [[1, null]] });
    const pOther = await newProduct(db, { weekday: true, rules: [[1, null]], center: C2 });
    await assert.rejects(grant(db, { acc: NOPERM, product: p, day: 1 }), /권한이 없어요/);
    await assert.rejects(grant(db, { acc: null, product: p, day: 1 }), /권한이 없어요/);
    await assert.rejects(grant(db, { product: p, day: 1, profile: P_OTHER_CENTER }), /이 센터의 회원이 아니에요/);   // 다른 센터 회원
    await assert.rejects(grant(db, { product: pOther, day: 1 }), /이 센터의 상품이 아니에요/);                     // 다른 센터 상품
    assert.equal(await count(db, `select count(*)::int c from memberships`), 0);
    // helper는 내부 전용: 직접 호출 불가
    await db.exec(`set role authenticated`);
    await assert.rejects(db.query(`select validate_product_schedule_selection('${p}', 1, null)`), /permission denied/);
    await db.exec(`reset role`);
  } finally { await db.close(); }
});

test('B: 관리자 지급 검증 == 구매 checkout 트리거 검증(요일/시간 조합 전수 비교, 선택형 상품 두 종류)', async () => {
  const db = await world();
  try {
    const rulesets = [[[1, '19:00'], [1, '20:00'], [3, '16:00'], [4, null], [null, '19:00']], []];
    let compared = 0;
    for (const rules of rulesets) for (const time of [false, true]) {
      const p = await newProduct(db, { weekday: true, time, rules });
      for (const day of [0, 1, 2, 3, 4, 5, 6]) for (const t of (time ? [null, '16:00', '19:00', '20:00', '23:00'] : [null])) {
        const ord = await orderAccepts(db, p, day, t);
        const gr = await grantAccepts(db, { product: p, day, time: t });
        assert.equal(gr, ord, `rules=${JSON.stringify(rules)} time=${time} day=${day} t=${t}`);
        compared++;
      }
    }
    assert.ok(compared >= 80, `비교 ${compared}건`);
  } finally { await db.close(); }
});

test('C: manager_grant_product 날짜는 DB TimeZone(UTC/UTC-12/UTC+14)과 무관하게 KST 기준(starts_at=KST 오늘, days형 expires_at=KST 오늘+N) — 수정 전은 달랐다', async () => {
  const kst = `(now() at time zone 'Asia/Seoul')::date`;
  const run = async (db, tz) => {
    await db.exec(`set time zone '${tz}'; delete from memberships; delete from payments;`);
    const p = await newProduct(db, { expiryDays: 30 });
    const m = (await grant(db, { product: p })).rows[0].r.membership_id;
    return (await db.query(`select (starts_at = ${kst}) s_ok, (expires_at = ${kst} + 30) e_ok from memberships where id='${m}'`)).rows[0];
  };
  const fixed = await world();
  try { for (const tz of ['UTC', 'Etc/GMT+12', 'Pacific/Kiritimati']) assert.deepEqual(await run(fixed, tz), { s_ok: true, e_ok: true }, tz); } finally { await fixed.close(); }
  const old = await world({ apply: false });   // negative control: 수정 전 정의에서는 UTC-12와 UTC+14 중 적어도 하나가 KST 날짜와 어긋난다
  try {
    const results = []; for (const tz of ['Etc/GMT+12', 'Pacific/Kiritimati']) results.push(await run(old, tz));
    assert.ok(results.some(r => !r.s_ok), '수정 전 starts_at이 KST 날짜와 어긋나는 경우가 있어야 한다');
  } finally { await old.close(); }
});

test('C: cancel_reservation 대기 승격의 수강권 만료 검사는 KST 날짜 기준(만료=KST 오늘 → 승격, KST 어제 → 승격 안 함), 세션 TimeZone 무관', async () => {
  for (const tz of ['UTC', 'Etc/GMT+12', 'Pacific/Kiritimati']) {
    const db = await world();
    try {
      await db.exec(`set time zone '${tz}'`);
      const kst = `(now() at time zone 'Asia/Seoul')::date`;
      for (const [label, expires, promoted] of [['KST 오늘', kst, true], ['KST 어제', `(${kst} - 1)`, false]]) {
        await db.exec('delete from reservations; delete from memberships; delete from classes');
        const cls = id(6, ++seq); const mCancel = id(5, ++seq); const mWait = id(5, ++seq); const rCancel = id(7, ++seq); const rWait = id(7, ++seq);
        await db.exec(`insert into classes(id, center_id, start_time) values ('${cls}','${C1}', now() + interval '3 days');
          insert into memberships(id, profile_id, center_id, product_id, remaining_count, expires_at, starts_at, status) values ('${mCancel}','${P_MEMBER}','${C1}',null,5,${kst}+10,null,'active'), ('${mWait}','${P_WAIT}','${C1}',null,5,${expires},null,'active');
          insert into reservations(id, class_id, profile_id, membership_id, status) values ('${rCancel}','${cls}','${P_MEMBER}','${mCancel}','confirmed');
          insert into reservations(id, class_id, profile_id, membership_id, status, waitlist_order) values ('${rWait}','${cls}','${P_WAIT}','${mWait}','waitlisted',1);`);
        const res = await as(db, MEMBER_ACC, () => db.query(`select cancel_reservation('${rCancel}') r`));
        assert.equal(res.rows[0].r.waitlist_promoted, promoted, `${tz} ${label}`);
        assert.equal(await count(db, `select count(*)::int c from reservations where id='${rWait}' and status='confirmed'`), promoted ? 1 : 0, `${tz} ${label}`);
        assert.equal(await count(db, `select remaining_count c from memberships where id='${mWait}'`), promoted ? 4 : 5, `${tz} ${label}`);
      }
    } finally { await db.close(); }
  }
});

test('C: 정적 계약 — 대상 4개 함수에서 current_date 제거(KST 표현 사용), cancel_reservation search_path 고정, 결제/환불/주문 발급 함수는 건드리지 않음', () => {
  const sql = migration.replace(/--.*$/gm, '');
  assert.doesNotMatch(sql, /\bcurrent_date\b/);
  for (const forbidden of ['_issue_membership_and_record_payment', 'fulfill_order', '_refund_membership_core', 'evaluate_notification_rules', 'refund_', 'settlement', 'orders_require_schedule_selection']) assert.ok(!sql.includes(forbidden), forbidden);
  assert.match(sql, /FUNCTION public\.cancel_reservation\(p_reservation_id uuid\)[\s\S]*?SET search_path TO 'public'/);
  assert.equal((sql.match(/\(now\(\) at time zone 'Asia\/Seoul'\)::date/g) || []).length >= 5, true);
  assert.match(sql, /begin;[\s\S]*commit;/);
  const rb = rollback.replace(/--.*$/gm, '');
  assert.ok(rb.includes('current_date'));   // rollback = 직전(수정 전) 정의
  assert.ok(!rb.includes('validate_product_schedule_selection(v_product.id'));
});

test('verify 왕복: migration → APPLIED, rollback → NOT_APPLIED, 재적용/재실행 안전, 읽기 전용 단일 SELECT', async () => {
  assert.doesNotMatch(verify, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
  assert.match(verify.trim(), /^with\b/i);
  const db = await world();
  try {
    const v = async () => (await db.query(verify)).rows[0];
    let r = await v(); assert.equal(r.verdict, 'APPLIED');
    for (const k of Object.keys(r).filter(k => k.endsWith('_ok'))) assert.equal(r[k], true, k);
    await db.exec(migration); assert.equal((await v()).verdict, 'APPLIED');            // idempotent
    await db.exec(`grant execute on function validate_product_schedule_selection(uuid,integer,time) to authenticated`); assert.equal((await v()).verdict, 'NOT_APPLIED');   // negative control
    await db.exec(`revoke execute on function validate_product_schedule_selection(uuid,integer,time) from authenticated`); assert.equal((await v()).verdict, 'APPLIED');
    await db.exec(rollback); assert.equal((await v()).verdict, 'NOT_APPLIED');
    assert.equal(await count(db, `select count(*)::int c from pg_proc where proname='validate_product_schedule_selection'`), 0);
    await db.exec(migration); assert.equal((await v()).verdict, 'APPLIED');
  } finally { await db.close(); }
});


// ---------------- 대기 승격 자격(cancel_reservation / update_class_safe 공통 계약) ----------------
const KST = `(now() at time zone 'Asia/Seoul')::date`;
const dowOf = `extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int`;
// 시나리오: 정원 1 수업에 A(확정) + B(대기, membership mB). cancel: A가 취소 → B 승격? / update: 정원 1→2 → B 승격?
async function promotion(db, mode, spec = {}) {
  await db.exec('delete from reservations; delete from memberships; delete from classes; delete from class_allowed_products; delete from membership_schedule_rules; delete from products');
  const cls = id(6, ++seq), mA = id(5, ++seq), mB = id(5, ++seq), rA = id(7, ++seq), rB = id(7, ++seq), prod = id(4, ++seq);
  await db.exec(`insert into classes(id, center_id, start_time, end_time, capacity, pass_selection_mode, title) values ('${cls}','${C1}', now() + interval '3 days', now() + interval '3 days 1 hour', 1, '${spec.mode ?? 'all'}', '정규반');
    insert into products(id, center_id, name, product_kind) values ('${prod}','${C1}','p','pass');
    insert into memberships(id, profile_id, center_id, product_id, remaining_count, expires_at, starts_at, status) values ('${mA}','${P_MEMBER}','${C1}',null,5,${KST}+10,null,'active');
    insert into reservations(id, class_id, profile_id, membership_id, status) values ('${rA}','${cls}','${P_MEMBER}','${mA}','confirmed');`);
  const remaining = 'remaining' in spec ? spec.remaining : 5;
  await db.exec(`insert into memberships(id, profile_id, center_id, product_id, remaining_count, expires_at, starts_at, status, bound_day_of_week, bound_start_time)
    select '${mB}','${P_WAIT}','${C1}','${prod}', ${remaining === null ? 'null' : remaining}, ${spec.expires ?? `${KST}+10`}, ${spec.starts ?? 'null'}, '${spec.status ?? 'active'}',
           ${spec.boundDow === 'other' ? `(${dowOf} + 1) % 7` : 'null'}, ${spec.boundTime === 'other' ? `((c.start_time at time zone 'Asia/Seoul')::time + interval '1 hour')::time` : 'null'} from classes c where c.id='${cls}';
    insert into reservations(id, class_id, profile_id, membership_id, status, waitlist_order) values ('${rB}','${cls}','${P_WAIT}','${mB}','waitlisted',1);`);
  if (spec.ruleOtherDay) await db.exec(`insert into membership_schedule_rules(product_id, day_of_week, start_time) select '${prod}', (${dowOf} + 1) % 7, null from classes c where c.id='${cls}'`);
  if (spec.ruleMatch) await db.exec(`insert into membership_schedule_rules(product_id, day_of_week, start_time) select '${prod}', ${dowOf}, (c.start_time at time zone 'Asia/Seoul')::time from classes c where c.id='${cls}'`);
  if (spec.notAllowed) await db.exec(`insert into class_allowed_products values ('${cls}','${id(4, 9999)}')`);   // selected 모드: B의 상품은 허용 목록에 없음
  if (mode === 'cancel') await as(db, MEMBER_ACC, () => db.query(`select cancel_reservation('${rA}')`));
  else await as(db, MGR, () => db.query(`select update_class_safe('${cls}', '정규반', null, (select start_time from classes where id='${cls}'), (select end_time from classes where id='${cls}'), 2, true, null, 0, null, 'group', '${spec.mode ?? 'all'}', true)`));
  const promoted = (await db.query(`select status from reservations where id='${rB}'`)).rows[0].status === 'confirmed';
  const rem = (await db.query(`select remaining_count r from memberships where id='${mB}'`)).rows[0].r;
  return { promoted, rem };
}
const PROMOTION_CASES = [
  ['1 정상 active 횟수권 → 승격(차감 5→4)', {}, true, 4],
  ['2 expires_at NULL → 승격', { expires: 'null' }, true, 4],
  ['3 remaining_count NULL(횟수 무제한) → 승격, NULL 유지', { remaining: null }, true, null],
  ['4 expires_at KST 오늘 → 승격', { expires: KST }, true, 4],
  ['5 expires_at KST 어제 → 승격 안 됨', { expires: `(${KST} - 1)` }, false, 5],
  ['6 starts_at KST 오늘 → 승격', { starts: KST }, true, 4],
  ['7 starts_at KST 내일 → 승격 안 됨', { starts: `(${KST} + 1)` }, false, 5],
  ['8 paused → 승격 안 됨', { status: 'paused' }, false, 5],
  ['9 expired → 승격 안 됨', { status: 'expired' }, false, 5],
  ['10 refunded → 승격 안 됨', { status: 'refunded' }, false, 5],
  ['11 transferred → 승격 안 됨', { status: 'transferred' }, false, 5],
  ['12 현재 수업 예약조건 불일치(규칙은 다른 요일) → 승격 안 됨', { ruleOtherDay: true }, false, 5],
  ['12b 현재 수업과 일치하는 예약조건 → 승격', { ruleMatch: true }, true, 4],
  ['13 class_allowed_products 불일치(selected 모드) → 승격 안 됨', { mode: 'selected', notAllowed: true }, false, 5],
  ['14 bound 요일 불일치 → 승격 안 됨', { boundDow: 'other' }, false, 5],
  ['14b bound 시간 불일치 → 승격 안 됨', { boundTime: 'other' }, false, 5],
];

for (const mode of ['cancel', 'update']) {
  test(`대기 승격 자격 — ${mode === 'cancel' ? 'cancel_reservation' : 'update_class_safe'}: 예약 자격과 같은 조건(active/횟수 NULL/만료 NULL/시작일/현재 수업 자격)`, async () => {
    const db = await world();
    try {
      for (const [label, spec, promoted, rem] of PROMOTION_CASES) {
        const r = await promotion(db, mode, spec);
        assert.equal(r.promoted, promoted, label);
        assert.equal(r.rem, rem, `${label} (남은 횟수)`);
      }
    } finally { await db.close(); }
  });
}

test('대기 승격 timezone 15: UTC / Etc/GMT+12 / Pacific/Kiritimati에서 두 경로 결과가 모두 같다(만료·시작 KST 경계 포함)', async () => {
  const db = await world();
  try {
    const expected = PROMOTION_CASES.map(c => c[2]);
    for (const tz of ['UTC', 'Etc/GMT+12', 'Pacific/Kiritimati']) {
      await db.exec(`set time zone '${tz}'`);
      for (const mode of ['cancel', 'update']) {
        const got = []; for (const [, spec] of PROMOTION_CASES) got.push((await promotion(db, mode, spec)).promoted);
        assert.deepEqual(got, expected, `${tz} ${mode}`);
      }
    }
  } finally { await db.close(); }
});

test('negative control: 수정 전 정의(rollback)에서는 NULL 만료/NULL 횟수/paused/미래 시작/수업 불일치가 승격됐다 — 위 테스트가 실제로 갭을 잡는다', async () => {
  const db = await world({ apply: false });
  try {
    for (const mode of ['cancel', 'update']) {
      const nullExpiry = await promotion(db, mode, { expires: 'null' });
      assert.equal(nullExpiry.promoted, false, `${mode}: 수정 전에는 만료 NULL이 승격되지 않았다(무기한 수강권이 영구 대기)`);
      assert.equal((await promotion(db, mode, { remaining: null })).promoted, false, `${mode}: 수정 전 횟수 NULL 승격 불가`);
      assert.equal((await promotion(db, mode, { status: 'paused' })).promoted, true, `${mode}: 수정 전에는 paused도 승격`);
      assert.equal((await promotion(db, mode, { starts: `(${KST} + 1)` })).promoted, true, `${mode}: 수정 전에는 미래 시작도 승격`);
      assert.equal((await promotion(db, mode, { ruleOtherDay: true })).promoted, true, `${mode}: 수정 전에는 현재 수업과 맞지 않아도 승격`);
    }
    await db.exec(migration);
    for (const mode of ['cancel', 'update']) {
      assert.equal((await promotion(db, mode, { expires: 'null' })).promoted, true);
      assert.equal((await promotion(db, mode, { status: 'paused' })).promoted, false);
    }
  } finally { await db.close(); }
});

test('두 승격 경로가 같은 자격 계약(고정 문자열)을 쓰고, 이 migration은 is_membership_eligible_for_class를 재정의하지 않는다', () => {
  const sql = migration.replace(/--.*$/gm, '');
  assert.ok(!/CREATE OR REPLACE FUNCTION public\.is_membership_eligible_for_class/i.test(sql), '자격 함수는 재정의하지 않는다');
  const contract = ["m.status = 'active'", 'm.remaining_count is null or m.remaining_count > 0', "m.expires_at is null or m.expires_at >= (now() at time zone 'Asia/Seoul')::date", "m.starts_at is null or m.starts_at <= (now() at time zone 'Asia/Seoul')::date"];
  const cancelBlock = sql.slice(sql.indexOf('FUNCTION public.cancel_reservation'), sql.indexOf('FUNCTION public.update_class_safe'));
  const updateBlock = sql.slice(sql.indexOf('FUNCTION public.update_class_safe'), sql.indexOf('FUNCTION public.reserve_with_goods'));
  for (const c of contract) { assert.ok(cancelBlock.includes(c), `cancel_reservation: ${c}`); assert.ok(updateBlock.includes(c), `update_class_safe: ${c}`); }
  assert.ok(cancelBlock.includes('is_membership_eligible_for_class(m.id, v_res.class_id)'));
  assert.ok(updateBlock.includes('is_membership_eligible_for_class(m.id, p_class_id)'));
  // 승격 차감은 횟수 무제한(NULL)을 그대로 둔다(reserve_with_membership과 동일)
  assert.equal((sql.match(/where id = v_next_mem\.id and remaining_count is not null;/g) || []).length, 2);
});
