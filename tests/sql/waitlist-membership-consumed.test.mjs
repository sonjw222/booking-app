// 격리 PostgreSQL(PGlite) — 대기 → 확정 시 membership_consumed 일관성. 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/waitlist-membership-consumed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const integrity = read('fix_reservation_integrity_20261003.sql');
const grantMig = read('fix_grant_schedule_and_kst_dates_20261003.sql');
const grantRb = read('rollback_fix_grant_schedule_and_kst_dates_20261003.sql');
const waitMig = read('fix_waitlist_membership_consumed_20261003.sql');
const waitRb = read('rollback_fix_waitlist_membership_consumed_20261003.sql');
const verify = read('verify_waitlist_membership_consumed_20261003.sql').replace(/--.*$/gm, '');
const diagnose = read('diagnose_membership_consumed_20261003.sql').replace(/--.*$/gm, '');
const fnText = (sql, name) => { const a = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); const b = sql.indexOf('$function$;', sql.indexOf('AS $function$', a)); return sql.slice(a, b + '$function$;'.length); };
const id = (k, n) => `${String(k).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C1 = id(1, 1), ACC1 = id(2, 1), ACC2 = id(2, 2), MGR = id(2, 3), P1 = id(3, 1), P2 = id(3, 2);
const KST = `(now() at time zone 'Asia/Seoul')::date`;

// opts.reserveClass: 'live'(수정 전 = rollback 정의) | 'fixed'; opts.promotion: 'old'(수정 전) | 'new'
async function world({ reserveClass = 'fixed', promotion = 'new' } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create function my_account_id() returns uuid language sql stable as $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;
    create table perms(account_id uuid, center_id uuid, perm text);
    create function has_permission(p_center_id uuid, p_permission text) returns boolean language sql stable as $$ select exists (select 1 from perms where account_id = my_account_id() and center_id = p_center_id and perm = p_permission) $$;
    create function is_platform_admin() returns boolean language sql stable as $$ select false $$;
    create table centers(id uuid primary key, status text default 'approved');
    create table profiles(id uuid primary key, account_id uuid, is_primary boolean default true);
    create table products(id uuid primary key default gen_random_uuid(), center_id uuid, product_kind text default 'pass');
    create table membership_schedule_rules(id uuid primary key default gen_random_uuid(), product_id uuid, day_of_week int, start_time time, class_title text);
    create table class_allowed_products(class_id uuid, product_id uuid);
    create table class_trainers(class_id uuid, account_id uuid);
    create table classes(id uuid primary key default gen_random_uuid(), center_id uuid, title text default '정규반', description text, start_time timestamptz, end_time timestamptz, capacity int default 1,
      class_format text default 'group', status text default 'open', pass_selection_mode text default 'all', allow_goods boolean default true, room_id uuid, allow_cancel boolean, cancel_deadline_min int, booking_deadline_min int);
    create table memberships(id uuid primary key default gen_random_uuid(), profile_id uuid, center_id uuid, product_id uuid, remaining_count int, expires_at date, starts_at date, status text default 'active', bound_day_of_week int, bound_start_time time);
    create table center_settings(center_id uuid primary key, allow_same_day_booking boolean default true, daily_book_limit_enabled boolean default false, daily_book_limit int, private_max_concurrent_enabled boolean default false,
      private_max_concurrent int, waitlist_weekly_limit int default 5, same_day_change_hours int, same_day_change_minutes int, deduct_on_late_cancel boolean default false, waitlist_auto_hours int default 0, waitlist_auto_minutes int default 0);
    create table center_holidays(center_id uuid, holiday_date date);
    create function calc_deadline(uuid, text, timestamptz, text) returns timestamptz language sql as $$ select null::timestamptz $$;
    -- Production과 같은 기본값: reservation_type 'MEMBER', reservation_source 'USER', membership_consumed 기본 true
    create table reservations(id uuid primary key default gen_random_uuid(), class_id uuid, profile_id uuid, membership_id uuid, status text, waitlist_order int, cancel_source text,
      reservation_type text default 'MEMBER', reservation_source text default 'USER', created_by_account_id uuid, membership_consumed boolean not null default true, created_at timestamptz default now());
    insert into centers values ('${C1}','approved'); insert into center_settings(center_id) values ('${C1}');
    insert into profiles values ('${P1}','${ACC1}',true), ('${P2}','${ACC2}',true);
    insert into perms values ('${MGR}','${C1}','schedule.own.group.update');
  `);
  // 선행 상태 = 예약 무결성 SQL 적용 후(자격 함수 + reserve_*). 그 위에 이번 변경을 적용/미적용.
  await db.exec(fnText(integrity, 'is_membership_eligible_for_class'));
  await db.exec(fnText(integrity, 'reserve_with_membership'));
  await db.exec(fnText(integrity, 'reserve_class'));
  await db.exec(promotion === 'new' ? fnText(grantMig, 'cancel_reservation') : fnText(grantRb, 'cancel_reservation'));
  await db.exec(promotion === 'new' ? fnText(grantMig, 'update_class_safe') : fnText(grantRb, 'update_class_safe'));
  if (reserveClass === 'fixed') await db.exec(fnText(waitMig, 'reserve_class'));
  return db;
}
const as = async (db, acc, fn) => { await db.exec(`select set_config('app.account_id','${acc ?? ''}', false);`); try { return await fn(); } finally { await db.exec(`select set_config('app.account_id','', false);`); } };
let seq = 100;
// 정원 1 수업: A(P1) 확정 + B(P2) 대기. via: 'with'(reserve_with_membership) | 'auto'(reserve_class). 반환: ids
async function setup(db, via, { bSpec = {} } = {}) {
  await db.exec('delete from reservations; delete from memberships; delete from classes; delete from products');
  const cls = id(6, ++seq), mA = id(5, ++seq), mB = id(5, ++seq), prod = id(4, ++seq);
  await db.exec(`insert into classes(id, center_id, start_time, end_time, capacity) values ('${cls}','${C1}', now() + interval '3 days', now() + interval '3 days 1 hour', 1);
    insert into products(id, center_id) values ('${prod}','${C1}');
    insert into memberships(id, profile_id, center_id, product_id, remaining_count, expires_at, status) values ('${mA}','${P1}','${C1}','${prod}',5,${KST}+30,'active');
    insert into memberships(id, profile_id, center_id, product_id, remaining_count, expires_at, starts_at, status) values ('${mB}','${P2}','${C1}','${prod}', ${'remaining' in bSpec ? (bSpec.remaining === null ? 'null' : bSpec.remaining) : 5}, ${KST}+30, ${bSpec.starts ?? 'null'}, 'active');`);
  const reserve = (acc, prof, mem) => via === 'with' ? as(db, acc, () => db.query(`select reserve_with_membership('${cls}','${prof}','${mem}') r`)) : as(db, acc, () => db.query(`select reserve_class('${cls}','${prof}') r`));
  const ra = (await reserve(ACC1, P1, mA)).rows[0].r;     // A: 확정
  const rb = (await reserve(ACC2, P2, mB)).rows[0].r;     // B: 대기
  return { cls, mA, mB, ridA: ra.reservation_id, ridB: rb.reservation_id, ra, rb };
}
const row = async (db, rid) => (await db.query(`select status, waitlist_order, membership_consumed c from reservations where id='${rid}'`)).rows[0];
const rem = async (db, mid) => (await db.query(`select remaining_count r from memberships where id='${mid}'`)).rows[0].r;
const promote = (db, how, s) => how === 'cancel'
  ? as(db, ACC1, () => db.query(`select cancel_reservation('${s.ridA}')`))
  : as(db, MGR, () => db.query(`select update_class_safe('${s.cls}', '정규반', null, (select start_time from classes where id='${s.cls}'), (select end_time from classes where id='${s.cls}'), 2, true, null, 0, null, 'group', 'all', true)`));

for (const via of ['with', 'auto']) for (const how of ['cancel', 'update']) {
  test(`A/B/C/D 대기 → 확정(${via === 'with' ? 'reserve_with_membership' : 'reserve_class'} 대기 생성, ${how === 'cancel' ? 'cancel_reservation' : 'update_class_safe'} 승격): 대기 false → 승격 true, 차감 1회, waitlist_order NULL`, async () => {
    const db = await world();
    try {
      const s = await setup(db, via);
      assert.equal(s.ra.status, 'confirmed'); assert.equal(s.rb.status, 'waitlisted');
      assert.deepEqual(await row(db, s.ridA), { status: 'confirmed', waitlist_order: null, c: true });
      assert.deepEqual(await row(db, s.ridB), { status: 'waitlisted', waitlist_order: 1, c: false });       // 대기 = 차감 없음 = consumed false
      assert.equal(await rem(db, s.mB), 5);                                                               // 대기는 차감 없음
      await promote(db, how, s);
      assert.deepEqual(await row(db, s.ridB), { status: 'confirmed', waitlist_order: null, c: true });     // 승격: confirmed + consumed true
      assert.equal(await rem(db, s.mB), 4);                                                               // 정확히 1회 차감
      if (how === 'cancel') assert.equal(await rem(db, s.mA), 5 + 0);                                     // A 취소 환급(+1)로 5 → 5(4에서 +1)
      else assert.equal(await rem(db, s.mA), 4);
    } finally { await db.close(); }
  });
}

test('E: 자격 실패 대기자는 승격 안 됨 — waitlisted 유지, consumed false 유지, 횟수 그대로(두 경로 모두, 대기 등록 이후 상태가 바뀐 경우)', async () => {
  const db = await world();
  try {
    const breakers = {
      paused: id0 => `update memberships set status = 'paused' where id='${id0}'`,
      '시작일이 미래': id0 => `update memberships set starts_at = ${KST} + 1 where id='${id0}'`,
      '만료(어제)': id0 => `update memberships set expires_at = ${KST} - 1 where id='${id0}'`,
      '횟수 소진': id0 => `update memberships set remaining_count = 0 where id='${id0}'`,
    };
    for (const how of ['cancel', 'update']) for (const [label, sql] of Object.entries(breakers)) {
      const s = await setup(db, 'with');
      await db.exec(sql(s.mB));
      const before = await rem(db, s.mB);
      await promote(db, how, s);
      assert.deepEqual(await row(db, s.ridB), { status: 'waitlisted', waitlist_order: 1, c: false }, `${how} ${label}`);
      assert.equal(await rem(db, s.mB), before, `${how} ${label} 횟수 불변`);
    }
  } finally { await db.close(); }
});

test('F: 횟수 무제한(remaining_count NULL) 수강권 — 대기 생성 false, 승격 성공 + consumed true, remaining_count는 NULL 유지(reserve_with_membership 확정과 같은 semantics)', async () => {
  const db = await world();
  try {
    for (const how of ['cancel', 'update']) {
      // 확정 직접 예약의 기준 semantics: NULL 수강권으로 바로 확정되면 consumed=true + remaining NULL 유지
      const s = await setup(db, 'with', { bSpec: { remaining: null } });
      assert.deepEqual(await row(db, s.ridB), { status: 'waitlisted', waitlist_order: 1, c: false });
      await promote(db, how, s);
      assert.deepEqual(await row(db, s.ridB), { status: 'confirmed', waitlist_order: null, c: true }, how);
      assert.equal(await rem(db, s.mB), null);
    }
    // 기준: 같은 NULL 수강권으로 처음부터 확정 예약해도 consumed=true, NULL 유지
    await db.exec('delete from reservations; delete from classes');
    const cls = id(6, ++seq); const mem = (await db.query(`select id from memberships where profile_id='${P2}' limit 1`)).rows[0].id;
    await db.exec(`insert into classes(id, center_id, start_time, end_time, capacity) values ('${cls}','${C1}', now() + interval '3 days', now() + interval '3 days 1 hour', 5)`);
    const r = (await as(db, ACC2, () => db.query(`select reserve_with_membership('${cls}','${P2}','${mem}') r`))).rows[0].r;
    assert.deepEqual(await row(db, r.reservation_id), { status: 'confirmed', waitlist_order: null, c: true });
    assert.equal(await rem(db, mem), null);
  } finally { await db.close(); }
});

test('B-2: reserve_class 확정은 consumed true, 대기는 false(명시) — 컬럼 기본값(true)에 의존하지 않는다', async () => {
  const db = await world();
  try {
    const s = await setup(db, 'auto');
    assert.equal((await row(db, s.ridA)).c, true);
    assert.equal((await row(db, s.ridB)).c, false);
    const body = waitMig.replace(/--.*$/gm, '');
    assert.ok(body.includes("values (p_class_id, v_profile_id, v_membership.id, 'confirmed', true)"));
    assert.ok(body.includes("values (p_class_id, v_profile_id, v_membership.id, 'waitlisted', v_wait_order, false)"));
  } finally { await db.close(); }
});

test('G: downstream — 휴무일 수강권 복구(add_holiday_safe)·휴무 알림 판정은 consumed로 "실제 차감된 예약"을 찾는다: 승격 예약이 복구 대상에 포함된다', async () => {
  // add_holiday_safe / trg_notify_reservation_update의 판정식(Production 정의): status in (confirmed, attended) and membership_consumed and membership_id is not null
  const restoreTargets = `select r.membership_id, count(*)::int n from reservations r where r.status in ('confirmed','attended') and r.membership_consumed and r.membership_id is not null group by r.membership_id order by 1`;
  const db = await world();
  try {
    const s = await setup(db, 'with');
    await promote(db, 'update', s);                                   // B 승격(A는 그대로 확정)
    const targets = (await db.query(restoreTargets)).rows;
    assert.deepEqual(targets.map(t => t.membership_id).sort(), [s.mA, s.mB].sort());   // 승격된 B의 차감 1회도 복구 대상
    assert.equal(await rem(db, s.mB), 4);
  } finally { await db.close(); }
  // negative control: 수정 전 승격 정의에서는 B가 confirmed + consumed=false → 휴무 취소 시 차감된 1회가 복구되지 않고 알림도 "복구 안 됨"으로 나갔다
  const old = await world({ promotion: 'old', reserveClass: 'live' });
  try {
    const s = await setup(old, 'with');
    await promote(old, 'update', s);
    assert.deepEqual(await row(old, s.ridB), { status: 'confirmed', waitlist_order: null, c: false });   // 모순: 확정인데 consumed false
    assert.equal(await rem(old, s.mB), 4);                                                                 // 차감은 실제로 됐다
    const targets = (await old.query(restoreTargets)).rows;
    assert.deepEqual(targets.map(t => t.membership_id), [s.mA]);                                           // B의 차감은 복구 대상에서 빠진다(회원이 1회 손해)
  } finally { await old.close(); }
});

test('negative control: 수정 전 reserve_class는 대기 예약을 consumed=true(기본값)로 저장 — 수정 후 false', async () => {
  const live = await world({ reserveClass: 'live' });
  try {
    const s = await setup(live, 'auto');
    assert.deepEqual(await row(live, s.ridB), { status: 'waitlisted', waitlist_order: 1, c: true });   // 반대 방향 모순: 대기인데 consumed=true
    assert.equal(await rem(live, s.mB), 5);                                                             // 실제 차감은 없음
  } finally { await live.close(); }
  const fixed = await world();
  try {
    const s = await setup(fixed, 'auto');
    assert.deepEqual(await row(fixed, s.ridB), { status: 'waitlisted', waitlist_order: 1, c: false });
  } finally { await fixed.close(); }
});

test('negative control: 수정 전 승격 정의(cancel_reservation/update_class_safe)는 confirmed + consumed=false를 만든다', async () => {
  const db = await world({ promotion: 'old' });
  try {
    for (const how of ['cancel', 'update']) {
      const s = await setup(db, 'with');
      await promote(db, how, s);
      assert.deepEqual(await row(db, s.ridB), { status: 'confirmed', waitlist_order: null, c: false }, how);
      assert.equal(await rem(db, s.mB), 4);
    }
  } finally { await db.close(); }
});

test('verify/diagnose/rollback: 왕복 + 읽기 전용, 진단은 모순 건수를 보여주고 UPDATE 없음', async () => {
  assert.doesNotMatch(verify, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
  assert.doesNotMatch(diagnose, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
  const db = await world();
  try {
    const v = async () => (await db.query(verify)).rows[0];
    let r = await v(); assert.equal(r.verdict, 'APPLIED');
    for (const k of Object.keys(r).filter(k => k.endsWith('_ok'))) assert.equal(r[k], true, k);
    await db.exec(waitRb); assert.equal((await v()).verdict, 'NOT_APPLIED');                         // reserve_class만 원복해도 NOT_APPLIED
    await db.exec(waitMig); assert.equal((await v()).verdict, 'APPLIED');
    await db.exec(waitMig);                                                                          // idempotent
    await db.exec(fnText(grantRb, 'cancel_reservation')); assert.equal((await v()).verdict, 'NOT_APPLIED');   // 승격 경로 하나라도 원복되면 NOT_APPLIED
    await db.exec(fnText(grantMig, 'cancel_reservation')); assert.equal((await v()).verdict, 'APPLIED');
    await db.exec(fnText(grantRb, 'update_class_safe')); assert.equal((await v()).verdict, 'NOT_APPLIED');
    await db.exec(fnText(grantMig, 'update_class_safe')); assert.equal((await v()).verdict, 'APPLIED');
    // 진단: 모순 데이터가 있을 때 건수로 보인다(보정하지 않음)
    const bad = await db.query(`select count(*)::int c from reservations`);
    await db.exec(`insert into reservations(class_id, profile_id, status, membership_consumed, reservation_type, reservation_source) values (null,'${P1}','waitlisted',true,'MEMBER','USER'), (null,'${P1}','confirmed',false,'ADMIN_ASSIGNMENT','ADMIN'), (null,'${P1}','confirmed',false,'ADMIN_FREE','ADMIN')`);
    const rows = (await db.query(diagnose)).rows;
    assert.ok(rows.some(x => x.assessment === 'INCONSISTENT: waitlisted + consumed=true' && Number(x.reservations) === 1));
    assert.ok(rows.some(x => x.assessment === 'INCONSISTENT: confirmed + consumed=false' && x.reservation_source === 'ADMIN'));
    assert.ok(!rows.some(x => x.reservation_type === 'ADMIN_FREE' && x.assessment !== 'ok'));          // ADMIN_FREE는 차감 없는 예약이라 정상
    assert.equal((await db.query(`select count(*)::int c from reservations`)).rows[0].c, bad.rows[0].c + 3);   // 진단은 데이터를 바꾸지 않는다
  } finally { await db.close(); }
});

test('정적 계약: 승격은 같은 성공 경로에서 consumed=true + 차감, 이미 적용된 integrity SQL은 수정하지 않았다, 이번 migration은 reserve_class만 재정의', () => {
  const g = grantMig.replace(/--.*$/gm, '');
  const cancelBlock = g.slice(g.indexOf('FUNCTION public.cancel_reservation'), g.indexOf('FUNCTION public.update_class_safe'));
  const updateBlock = g.slice(g.indexOf('FUNCTION public.update_class_safe'), g.indexOf('FUNCTION public.reserve_with_goods'));
  for (const b of [cancelBlock, updateBlock]) {
    assert.match(b, /if found then\s+update reservations\s+set status = 'confirmed', waitlist_order = null, membership_consumed = true\s+where id = v_next\.id;\s+update memberships set remaining_count = remaining_count - 1\s+where id = v_next_mem\.id and remaining_count is not null;/);
  }
  const w = waitMig.replace(/--.*$/gm, '');
  assert.equal((w.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 1);
  assert.ok(w.includes('public.reserve_class('));
    assert.match(waitRb, /begin;[\s\S]*commit;/);
  assert.ok(!waitRb.includes("'waitlisted', v_wait_order, false"));        // rollback = 수정 전(생략) 정의
});
