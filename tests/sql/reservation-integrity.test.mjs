// 격리 PostgreSQL(PGlite) — 예약 무결성 Release Blocker 수정(F1~F5, F7). Production 라이브 함수 정의(fix_*.sql 안의 본문)를 그대로 실행한다.
// 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/reservation-integrity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const migration = read('fix_reservation_integrity_20261003.sql');
const rollback = read('rollback_fix_reservation_integrity_20261003.sql');
const verify = read('verify_reservation_integrity_20261003.sql').replace(/--.*$/gm, '');
const id = (k, n) => `${String(k).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const CENTER = id(1, 1), OTHER_CENTER = id(1, 2), ACC1 = id(2, 1), ACC2 = id(2, 2), PROF1 = id(3, 1), PROF2 = id(3, 2);
const asRole = async (db, role, accountId, fn) => {
  await db.exec(`set role ${role}; select set_config('app.account_id', '${accountId ?? ''}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('app.account_id', '', false);`); }
};

// Production과 같은 형태의 최소 스키마(컬럼은 라이브 함수가 쓰는 것만) + Production과 같은 reservations 권한/RLS
async function world({ apply = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create function my_account_id() returns uuid language sql stable as $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;
    create table centers(id uuid primary key, name text, status text default 'approved');
    create table profiles(id uuid primary key, account_id uuid, is_primary boolean default true, name text);
    create function my_profile_ids() returns setof uuid language sql stable security definer as $$ select id from profiles where account_id = my_account_id() $$;
    create table products(id uuid primary key default gen_random_uuid(), center_id uuid, name text, product_kind text default 'pass');
    create table classes(id uuid primary key default gen_random_uuid(), center_id uuid, title text, start_time timestamptz, end_time timestamptz, capacity int default 10,
      class_format text default 'group', status text default 'open', pass_selection_mode text default 'all', booking_deadline_min int);
    create table class_allowed_products(class_id uuid, product_id uuid);
    create table membership_schedule_rules(id uuid primary key default gen_random_uuid(), product_id uuid not null, day_of_week int, start_time time, class_title text);
    create table memberships(id uuid primary key default gen_random_uuid(), profile_id uuid, center_id uuid, product_id uuid, product_name text, remaining_count int, starts_at date, expires_at date,
      status text default 'active', bound_day_of_week int, bound_start_time time, issued_at date default current_date);
    create table center_settings(center_id uuid primary key, allow_same_day_booking boolean default true, daily_book_limit_enabled boolean default false, daily_book_limit int,
      private_max_concurrent_enabled boolean default false, private_max_concurrent int, waitlist_weekly_limit int default 0);
    create table center_holidays(center_id uuid, holiday_date date);
    create function calc_deadline(uuid, text, timestamptz, text) returns timestamptz language sql as $$ select null::timestamptz $$;
    create table reservations(id uuid primary key default gen_random_uuid(), class_id uuid, profile_id uuid, membership_id uuid, status text, waitlist_order int, reservation_type text, reservation_source text,
      created_by_account_id uuid, membership_consumed boolean, member_memo text, cancelled_at timestamptz, cancel_reason text, created_at timestamptz default now());
    -- Production과 동일: 테이블 권한이 넓고(authenticated UPDATE 전체, anon 쓰기까지) RLS가 행만 제한
    grant select, insert, update, delete, truncate, references, trigger on reservations to anon, authenticated;
    grant select, insert, update, delete on reservations to service_role;
    alter table reservations enable row level security;
    create policy "내 프로필 예약 조회" on reservations for select using (profile_id in (select my_profile_ids()));
    create policy "본인 예약 메모 수정" on reservations for update using (profile_id in (select my_profile_ids())) with check (profile_id in (select my_profile_ids()));
    grant select on memberships, classes, products, profiles to authenticated;
    insert into centers values ('${CENTER}','A센터','approved'), ('${OTHER_CENTER}','B센터','approved');
    insert into center_settings(center_id) values ('${CENTER}'), ('${OTHER_CENTER}');
    insert into profiles values ('${PROF1}','${ACC1}',true,'회원1'), ('${PROF2}','${ACC2}',true,'회원2');
    -- 라이브 함수의 "수정 전" 상태를 먼저 만든다(rollback 파일 = 직전 라이브 정의). 그 위에 migration을 적용한다.
    -- (권한은 Production처럼 PUBLIC EXECUTE 기본값)
  `);
  await db.exec(rollback);                // 라이브 원본 정의 설치
  if (apply) await db.exec(migration);
  return db;
}
let seq = 100;
const newProduct = async (db, { kind = 'pass', center = CENTER, rules = [] } = {}) => {
  const pid = id(4, ++seq);
  await db.exec(`insert into products(id, center_id, name, product_kind) values ('${pid}','${center}','p${seq}','${kind}');`);
  for (const [dow, time, title] of rules) await db.exec(`insert into membership_schedule_rules(product_id, day_of_week, start_time, class_title) values ('${pid}', ${dow ?? 'null'}, ${time ? `'${time}'` : 'null'}, ${title === null || title === undefined ? 'null' : `$q$${title}$q$`});`);
  return pid;
};
const newMembership = async (db, pid, o = {}) => {
  const mid = id(5, ++seq);
  const exp = o.expires ?? `((now() at time zone 'Asia/Seoul')::date + 30)`;
  const st = o.starts ?? 'null';
  await db.exec(`insert into memberships(id, profile_id, center_id, product_id, product_name, remaining_count, starts_at, expires_at, status, bound_day_of_week, bound_start_time)
    values ('${mid}','${o.profile ?? PROF1}','${o.center ?? CENTER}', ${pid ? `'${pid}'` : 'null'}, 'm', ${o.remaining ?? 5}, ${st}, ${exp}, '${o.status ?? 'active'}', ${o.boundDow ?? 'null'}, ${o.boundTime ? `'${o.boundTime}'` : 'null'});`);
  return mid;
};
// KST 기준 dow(0=일..6=토)·시각의 가까운 미래 수업(2~9일 뒤)
const newClass = async (db, { title = '정규반', dow = 1, time = '19:00', mode = 'all', allowed = [], center = CENTER } = {}) => {
  const cid = id(6, ++seq);
  await db.exec(`insert into classes(id, center_id, title, start_time, end_time, pass_selection_mode)
    select '${cid}','${center}', $q$${title}$q$, ((d::date + time '${time}') at time zone 'Asia/Seoul'), ((d::date + time '${time}' + interval '1 hour') at time zone 'Asia/Seoul'), '${mode}'
    from generate_series((now() at time zone 'Asia/Seoul')::date + 2, (now() at time zone 'Asia/Seoul')::date + 9, interval '1 day') d where extract(dow from d) = ${dow} limit 1;`);
  for (const p of allowed) await db.exec(`insert into class_allowed_products values ('${cid}','${p}');`);
  return cid;
};
const elig = async (db, mid, cid) => (await db.query(`select is_membership_eligible_for_class('${mid}','${cid}') as e`)).rows[0].e;
const reserveWith = (db, cid, mid, prof = PROF1, acc = ACC1) => asRole(db, 'authenticated', acc, () => db.query(`select reserve_with_membership('${cid}','${prof}','${mid}') as r`));
const reserveAuto = (db, cid, prof = PROF1, acc = ACC1) => asRole(db, 'authenticated', acc, () => db.query(`select reserve_class('${cid}','${prof}') as r`));
const count = async (db, sql) => (await db.query(sql)).rows[0].c;

test('F1 수업명은 정확 일치: 정규반≠정규반 심화, "%"/"_" wildcard 무력, 일부 포함도 거부(정확히 같은 title만 허용)', async () => {
  const db = await world();
  try {
    const cases = [
      // [규칙 title, 수업 title, 기대]
      ['정규반', '정규반', true], ['정규반', '정규반 심화', false], ['정규', '정규반', false], ['정규반 심화', '정규반', false],
      ['%', '정규반', false], ['%', '%', true], ['%정규%', '정규반', false], ['_', 'a', false], ['_', '_', true], ['정규_', '정규반', false], ['A반', 'a반', false],
      [null, '아무수업', true],   // class_title null = 모든 수업
    ];
    for (const [rule, title, expected] of cases) {
      const p = await newProduct(db, { rules: [[1, '19:00', rule]] });
      const m = await newMembership(db, p);
      const c = await newClass(db, { title, dow: 1, time: '19:00' });
      assert.equal(await elig(db, m, c), expected, `규칙 ${JSON.stringify(rule)} / 수업 ${JSON.stringify(title)}`);
    }
  } finally { await db.close(); }
});

test('F1 서버 reserve 직접 호출도 "정규반" 규칙으로 "정규반 심화" 예약 불가(reservation 0행, 횟수 불변), 정확히 같은 수업은 성공 후 1회 차감', async () => {
  const db = await world();
  try {
    const p = await newProduct(db, { rules: [[1, '19:00', '정규반']] });
    const m = await newMembership(db, p, { remaining: 3 });
    const bad = await newClass(db, { title: '정규반 심화', dow: 1, time: '19:00' });
    const good = await newClass(db, { title: '정규반', dow: 1, time: '19:00' });
    await assert.rejects(reserveWith(db, bad, m), /사용할 수 없는 수강권/);
    await assert.rejects(reserveAuto(db, bad), /사용할 수 있는 수강권이 없어요/);
    assert.equal(await count(db, `select count(*)::int c from reservations`), 0);
    assert.equal(await count(db, `select remaining_count c from memberships where id='${m}'`), 3);
    await reserveWith(db, good, m);
    assert.equal(await count(db, `select count(*)::int c from reservations where class_id='${good}'`), 1);
    assert.equal(await count(db, `select remaining_count c from memberships where id='${m}'`), 2);
  } finally { await db.close(); }
});

test('F2 selected 수업: 허용 상품이어도 예약조건(요일/시간/title)이 하나라도 다르면 거부, 모두 일치하면 허용, 규칙 없는 허용 상품은 허용, 허용 목록에 없으면 규칙이 맞아도 거부', async () => {
  const db = await world();
  try {
    const p = await newProduct(db, { rules: [[1, '19:00', '정규반']] });
    const m = await newMembership(db, p);
    const selected = async (o) => newClass(db, { mode: 'selected', allowed: [p], ...o });
    assert.equal(await elig(db, m, await selected({ dow: 2, time: '19:00', title: '정규반' })), false, '다른 요일');
    assert.equal(await elig(db, m, await selected({ dow: 1, time: '20:00', title: '정규반' })), false, '다른 시간');
    assert.equal(await elig(db, m, await selected({ dow: 1, time: '19:00', title: '고급반' })), false, '다른 title');
    assert.equal(await elig(db, m, await selected({ dow: 1, time: '19:00', title: '정규반' })), true, '모두 일치');
    const free = await newProduct(db, {});                                  // 예약조건 없는 상품
    const mf = await newMembership(db, free);
    assert.equal(await elig(db, mf, await newClass(db, { mode: 'selected', allowed: [free], dow: 3, time: '07:00', title: '아무거나' })), true, '규칙 없음 + 허용');
    const other = await newProduct(db, { rules: [[1, '19:00', '정규반']] });
    const mo = await newMembership(db, other);
    assert.equal(await elig(db, mo, await newClass(db, { mode: 'selected', allowed: [p], dow: 1, time: '19:00', title: '정규반' })), false, '허용 목록에 없음');
    // 서버 reserve 직접 호출
    const badClass = await selected({ dow: 2, time: '19:00', title: '정규반' });
    await assert.rejects(reserveWith(db, badClass, m), /사용할 수 없는 수강권/);
    assert.equal(await count(db, `select count(*)::int c from reservations`), 0);
  } finally { await db.close(); }
});

test('F3 goods membership: 서버 자격 거부, reserve_with_membership/reserve_class 모두 거부(차감 없음), 자동선택은 pass만 고름, product_id 없는 legacy membership은 기존 동작 보존', async () => {
  const db = await world();
  try {
    const goods = await newProduct(db, { kind: 'goods' });
    const pass = await newProduct(db, { kind: 'pass' });
    const c = await newClass(db, { dow: 1, time: '19:00' });
    const mg = await newMembership(db, goods, { remaining: 4, expires: `((now() at time zone 'Asia/Seoul')::date + 5)` });   // 더 빨리 만료 → 자동선택 1순위가 될 뻔함
    assert.equal(await elig(db, mg, c), false);
    await assert.rejects(reserveWith(db, c, mg), /사용할 수 없는 수강권/);
    await assert.rejects(reserveAuto(db, c), /사용할 수 있는 수강권이 없어요/);
    assert.equal(await count(db, `select count(*)::int c from reservations`), 0);
    assert.equal(await count(db, `select remaining_count c from memberships where id='${mg}'`), 4);
    const mp = await newMembership(db, pass, { remaining: 4 });
    await reserveAuto(db, c);                                                        // goods가 더 일찍 만료돼도 pass가 선택돼야 한다
    assert.equal(await count(db, `select count(*)::int c from reservations where membership_id='${mp}'`), 1);
    assert.equal(await count(db, `select remaining_count c from memberships where id='${mg}'`), 4);
    // legacy: product_id 없는 membership은 'all' 수업에서 기존처럼 허용
    const legacy = await newMembership(db, null, { remaining: 2 });
    assert.equal(await elig(db, legacy, await newClass(db, { dow: 4, time: '10:00' })), true);
    assert.equal(await elig(db, legacy, await newClass(db, { mode: 'selected', allowed: [pass], dow: 4, time: '11:00' })), false);   // selected에서는 기존에도 거부
  } finally { await db.close(); }
});

test('UI↔서버 일치: usable_memberships / usable_memberships_for_classes 후보 == is_membership_eligible_for_class 판정(조합 전수, selected override 제거 반영)', async () => {
  const db = await world();
  try {
    const prods = [
      await newProduct(db, {}), await newProduct(db, { rules: [[1, '19:00', '정규반']] }), await newProduct(db, { rules: [[1, null, null], [3, '20:30', '정규반']] }),
      await newProduct(db, { rules: [[null, '19:00', null]] }), await newProduct(db, { kind: 'goods' }), await newProduct(db, { rules: [[5, '19:40', '개인안무반']] }),
    ];
    const mems = []; for (const p of prods) mems.push([p, await newMembership(db, p)]);
    const classes = [];
    for (const [title, dow, time] of [['정규반', 1, '19:00'], ['정규반 심화', 1, '19:00'], ['정규반', 1, '20:00'], ['정규반', 2, '19:00'], ['정규반', 3, '20:30'], ['개인안무반', 5, '19:40'], ['정규반', 5, '19:40']]) {
      classes.push(await newClass(db, { title, dow, time }));
      classes.push(await newClass(db, { title, dow, time, mode: 'selected', allowed: prods.slice(0, 3) }));   // selected + 일부 허용
    }
    let compared = 0;
    for (const cid of classes) {
      const ui = await asRole(db, 'authenticated', ACC1, async () => (await db.query(`select membership_id from usable_memberships('${cid}','${PROF1}')`)).rows.map(r => r.membership_id));
      const uiMany = await asRole(db, 'authenticated', ACC1, async () => (await db.query(`select membership_id from usable_memberships_for_classes(array['${cid}']::uuid[],'${PROF1}')`)).rows.map(r => r.membership_id));
      assert.deepEqual([...uiMany].sort(), [...ui].sort());
      for (const [, mid] of mems) { assert.equal(ui.includes(mid), await elig(db, mid, cid), `class ${cid} membership ${mid}`); compared++; }
    }
    assert.ok(compared >= 80, `비교 ${compared}건`);
  } finally { await db.close(); }
});

test('F5 KST 날짜 경계: DB session TimeZone(UTC/UTC-12/UTC+14)이 달라도 expires_at·starts_at를 한국 날짜 기준으로 판정(reserve + usable 목록)', async () => {
  for (const tz of ['UTC', 'Etc/GMT+12', 'Pacific/Kiritimati']) {   // UTC-12와 UTC+14는 어느 순간에도 날짜가 달라 둘 중 하나는 반드시 KST 날짜와 다르다 → 옛 current_date 구현이면 실패
    const db = await world();
    try {
      await db.exec(`set time zone '${tz}'`);
      const p = await newProduct(db, {});
      const c = await newClass(db, { dow: 1, time: '19:00' });
      const today = `((now() at time zone 'Asia/Seoul')::date)`;
      const cases = [
        ['expires KST 오늘 → 유효', { expires: today }, true],
        ['expires KST 어제 → 거부', { expires: `(${today} - 1)` }, false],
        ['starts KST 오늘 → 유효', { starts: today }, true],
        ['starts KST 내일 → 거부', { starts: `(${today} + 1)` }, false],
      ];
      for (const [label, o, ok] of cases) {
        await db.exec('delete from reservations; delete from memberships');
        const m = await newMembership(db, p, { remaining: 2, ...o });
        const listed = await asRole(db, 'authenticated', ACC1, async () => (await db.query(`select membership_id from usable_memberships_for_classes(array['${c}']::uuid[],'${PROF1}')`)).rows.length);
        if (ok) { await reserveWith(db, c, m); assert.equal(await count(db, `select count(*)::int c from reservations`), 1, `${tz} ${label}`); assert.equal(listed, 1, `${tz} ${label} (목록)`); }
        else { await assert.rejects(reserveWith(db, c, m), /사용할 수 없는 수강권/, `${tz} ${label}`); assert.equal(await count(db, `select count(*)::int c from reservations`), 0); assert.equal(listed, 0, `${tz} ${label} (목록)`); }
      }
    } finally { await db.close(); }
  }
});

test('F4 reservations 직접 UPDATE: member_memo만 가능, class_id/membership_id/profile_id/status/waitlist_order 등 전부 거부 + 행 불변, cancelled→confirmed 부활 불가', async () => {
  const db = await world();
  try {
    const p = await newProduct(db, {});
    const m = await newMembership(db, p, { remaining: 3 });
    const c1 = await newClass(db, { dow: 1, time: '19:00' });
    const otherCenterClass = await newClass(db, { dow: 2, time: '19:00', center: OTHER_CENTER });
    await reserveWith(db, c1, m);
    const rid = (await db.query(`select id from reservations limit 1`)).rows[0].id;
    await db.exec(`insert into reservations(id, class_id, profile_id, membership_id, status, waitlist_order) values ('${id(7, 1)}','${c1}','${PROF1}','${m}','cancelled', null)`);   // 취소된 다른 예약
    const snapshot = async () => JSON.stringify((await db.query(`select id, class_id, profile_id, membership_id, status, waitlist_order, membership_consumed, member_memo from reservations order by id`)).rows);
    const before = await snapshot();
    const attempts = [
      `class_id='${c1}'`, `class_id='${otherCenterClass}'`, `membership_id='${id(5, 999)}'`, `profile_id='${PROF2}'`, `status='cancelled'`, `status='attended'`, `waitlist_order=1`,
      `membership_consumed=false`, `cancelled_at=now()`, `cancel_reason='x'`, `created_at=now()`, `member_memo='ok', status='confirmed'`, `member_memo='ok', class_id='${otherCenterClass}'`,
    ];
    for (const set of attempts) {
      await assert.rejects(asRole(db, 'authenticated', ACC1, () => db.exec(`update reservations set ${set} where id='${rid}'`)), /permission denied/, set);
    }
    await assert.rejects(asRole(db, 'authenticated', ACC1, () => db.exec(`update reservations set status='confirmed' where id='${id(7, 1)}'`)), /permission denied/);   // cancelled → confirmed 부활
    await assert.rejects(asRole(db, 'authenticated', ACC1, () => db.exec(`update reservations set status='waitlisted' where id='${id(7, 1)}'`)), /permission denied/);
    assert.equal(await snapshot(), before);                                   // 실패한 시도 후에도 행이 그대로
    // 의도된 유일한 직접 UPDATE: 본인 예약의 member_memo
    const ok = await asRole(db, 'authenticated', ACC1, () => db.query(`update reservations set member_memo='내 메모' where id='${rid}' returning id`));
    assert.equal(ok.rows.length, 1);
    // 남의 예약 메모는 RLS로 0행
    const other = await asRole(db, 'authenticated', ACC2, () => db.query(`update reservations set member_memo='침범' where id='${rid}' returning id`));
    assert.equal(other.rows.length, 0);
    assert.equal(await count(db, `select count(*)::int c from reservations where member_memo='내 메모'`), 1);
    assert.equal(await count(db, `select remaining_count c from memberships where id='${m}'`), 2);   // 횟수 불변(부활/이동으로 공짜 예약 없음)
  } finally { await db.close(); }
});

test('F4 anon은 reservations 쓰기 불가, 정상 경로(SECURITY DEFINER RPC·service_role)는 계속 동작, 관리자성 상태 변경은 RPC만', async () => {
  const db = await world();
  try {
    const p = await newProduct(db, {});
    const m = await newMembership(db, p, { remaining: 3 });
    const c = await newClass(db, { dow: 1, time: '19:00' });
    await reserveWith(db, c, m);                                                          // 정상 예약 RPC
    const rid = (await db.query(`select id from reservations limit 1`)).rows[0].id;
    for (const sql of [`update reservations set member_memo='x'`, `insert into reservations(class_id, profile_id, status) values ('${c}','${PROF1}','confirmed')`, `delete from reservations`, `truncate reservations`]) {
      await assert.rejects(asRole(db, 'anon', null, () => db.exec(sql)), /permission denied/, sql);
    }
    await assert.rejects(asRole(db, 'authenticated', ACC1, () => db.exec('truncate reservations')), /permission denied/);
    // 취소 RPC(SECURITY DEFINER, owner 권한)가 status를 바꾸는 것은 그대로 동작
    await db.exec(`create function fake_cancel(p_id uuid) returns void language sql security definer set search_path = public as $$ update reservations set status='cancelled', cancelled_at=now() where id = p_id $$; grant execute on function fake_cancel(uuid) to authenticated;`);
    await asRole(db, 'authenticated', ACC1, () => db.query(`select fake_cancel('${rid}')`));
    assert.equal(await count(db, `select count(*)::int c from reservations where id='${rid}' and status='cancelled'`), 1);
    // service_role은 그대로 UPDATE 가능
    await asRole(db, 'service_role', null, () => db.exec(`update reservations set status='confirmed' where id='${rid}'`));
    assert.equal(await count(db, `select count(*)::int c from reservations where id='${rid}' and status='confirmed'`), 1);
  } finally { await db.close(); }
});

test('함수 권한: is_membership_eligible_for_class는 PUBLIC/anon 실행 불가·authenticated/service_role 가능, 나머지 함수 권한/search_path 불변, verify는 읽기 전용이고 적용 후 APPLIED', async () => {
  const db = await world();
  try {
    const fns = ['is_membership_eligible_for_class(uuid,uuid)', 'usable_memberships(uuid,uuid)', 'usable_memberships_for_classes(uuid[],uuid)', 'reserve_class(uuid,uuid)', 'reserve_with_membership(uuid,uuid,uuid)'];
    for (const f of fns) {
      const r = (await db.query(`select p.prosecdef sd, p.proconfig::text cfg, has_function_privilege('anon', p.oid,'execute') a, has_function_privilege('authenticated', p.oid,'execute') u, has_function_privilege('service_role', p.oid,'execute') s from pg_proc p where p.oid='public.${f}'::regprocedure`)).rows[0];
      assert.equal(r.sd, true, f); assert.match(r.cfg, /search_path=public/, f); assert.equal(r.u, true, f);
      if (f.startsWith('is_membership')) { assert.equal(r.a, false); assert.equal(r.s, true); }
    }
    // verify는 SELECT만, 적용 후 기대값(roles가 PGlite에서 table 권한 조회 가능)
    assert.doesNotMatch(verify, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
    assert.match(verify.trim(), /^with\b/i); assert.equal((verify.match(/;/g) || []).length, 1);   // 단일 SELECT
    const v = (await db.query(verify)).rows[0];
    assert.equal(v.verdict, 'APPLIED');
    const okCols = Object.keys(v).filter(k => k.endsWith('_ok'));
    assert.ok(okCols.length >= 19, `*_ok 컬럼 ${okCols.length}개`);
    for (const k of okCols) assert.equal(v[k], true, k);
    assert.ok('info_auth_reservations_insert_privilege' in v && 'info_auth_reservations_delete_privilege' in v && 'info_null_product_memberships' in v);   // 정보용 컬럼은 verdict와 무관
  } finally { await db.close(); }
});

test('migration 재실행 안전(idempotent) + rollback은 직전 라이브 상태로 복원(negative control: 복원하면 취약점이 다시 재현됨 → 테스트가 실제로 취약점을 잡는다)', async () => {
  const db = await world();
  try {
    await db.exec(migration);   // 두 번째 적용
    assert.equal((await db.query(verify)).rows[0].verdict, 'APPLIED');
    await db.exec(rollback);
    assert.equal((await db.query(verify)).rows[0].verdict, 'NOT_APPLIED');
    // 복원 후: F1(부분일치/wildcard), F2(selected override), F3(goods), F4(직접 UPDATE)가 다시 열린다
    const p = await newProduct(db, { rules: [[1, '19:00', '정규반']] });
    const m = await newMembership(db, p);
    assert.equal(await elig(db, m, await newClass(db, { title: '정규반 심화', dow: 1, time: '19:00' })), true, 'F1 재현');
    assert.equal(await elig(db, m, await newClass(db, { title: '정규반', dow: 2, time: '19:00', mode: 'selected', allowed: [p] })), true, 'F2 재현');
    const g = await newMembership(db, await newProduct(db, { kind: 'goods' }));
    assert.equal(await elig(db, g, await newClass(db, { dow: 3, time: '19:00' })), true, 'F3 재현');
    const free = await newMembership(db, await newProduct(db, {}));
    const c = await newClass(db, { dow: 4, time: '10:00' });
    await reserveWith(db, c, free);
    const rid = (await db.query(`select id from reservations limit 1`)).rows[0].id;
    await asRole(db, 'authenticated', ACC1, () => db.exec(`update reservations set status='cancelled' where id='${rid}'`));   // F4 재현(직접 UPDATE 성공)
    assert.equal(await count(db, `select count(*)::int c from reservations where status='cancelled'`), 1);
    await db.exec(migration);
    assert.equal((await db.query(verify)).rows[0].verdict, 'APPLIED');
  } finally { await db.close(); }
});

test('보완: reserve_class 자동선택은 status=active만(paused/expired/refunded/transferred 거부) — 환불 lifecycle 트리거 없이 SELECT 조건만으로', async () => {
  const db = await world();   // fixture에는 reservations_guard_pg_refund_lock 같은 트리거가 없다 → 거부는 reserve_class 자체의 조건 때문
  try {
    assert.equal(await count(db, `select count(*)::int c from pg_trigger where tgrelid='reservations'::regclass and not tgisinternal`), 0);
    const p = await newProduct(db, {});
    const c = await newClass(db, { dow: 1, time: '19:00' });
    for (const status of ['paused', 'expired', 'refunded', 'transferred']) {
      await db.exec('delete from reservations; delete from memberships');
      const m = await newMembership(db, p, { status, remaining: 3 });
      await assert.rejects(reserveAuto(db, c), /사용할 수 있는 수강권이 없어요/, status);
      assert.equal(await count(db, `select count(*)::int c from reservations`), 0, status);
      assert.equal(await count(db, `select remaining_count c from memberships where id='${m}'`), 3, status);
    }
    await db.exec('delete from memberships');
    const paused = await newMembership(db, p, { status: 'paused', remaining: 5, expires: `((now() at time zone 'Asia/Seoul')::date + 3)` });   // 더 일찍 만료 → 상태 조건이 없으면 1순위
    const active = await newMembership(db, p, { status: 'active', remaining: 5 });
    await reserveAuto(db, c);                                              // active → 예약 가능, paused는 건드리지 않는다
    assert.equal(await count(db, `select count(*)::int c from reservations where membership_id='${active}'`), 1);
    assert.equal(await count(db, `select remaining_count c from memberships where id='${paused}'`), 5);
    // negative control: 수정 전 live 정의(rollback)에서는 paused membership으로도 예약된다(트리거가 없을 때) → 이 테스트가 실제 조건을 검증함
    await db.exec(rollback);
    await db.exec('delete from reservations; delete from memberships');
    await newMembership(db, p, { status: 'paused', remaining: 3 });
    await reserveAuto(db, c);
    assert.equal(await count(db, `select count(*)::int c from reservations`), 1);
  } finally { await db.close(); }
});

test('보완: usable_memberships()와 usable_memberships_for_classes()의 날짜 semantics 일치(NULL 만료 허용, KST 오늘 허용, KST 어제/미래 시작 제외)', async () => {
  const db = await world();
  try {
    const p = await newProduct(db, {});
    const c = await newClass(db, { dow: 1, time: '19:00' });
    const today = `((now() at time zone 'Asia/Seoul')::date)`;
    const cases = [
      ['expires NULL + starts NULL', { expires: 'null' }, true],
      ['expires KST 오늘', { expires: today }, true],
      ['expires KST 어제', { expires: `(${today} - 1)` }, false],
      ['starts KST 오늘', { starts: today }, true],
      ['starts KST 내일', { starts: `(${today} + 1)` }, false],
    ];
    for (const tz of ['UTC', 'Etc/GMT+12', 'Pacific/Kiritimati']) {
      await db.exec(`set time zone '${tz}'`);
      for (const [label, o, ok] of cases) {
        await db.exec('delete from reservations; delete from memberships');
        await newMembership(db, p, { remaining: 2, ...o });
        const single = await asRole(db, 'authenticated', ACC1, async () => (await db.query(`select membership_id from usable_memberships('${c}','${PROF1}')`)).rows.length);
        const batch = await asRole(db, 'authenticated', ACC1, async () => (await db.query(`select membership_id from usable_memberships_for_classes(array['${c}']::uuid[],'${PROF1}')`)).rows.length);
        assert.equal(single, ok ? 1 : 0, `${tz} single ${label}`);
        assert.equal(batch, single, `${tz} batch==single ${label}`);
      }
    }
  } finally { await db.close(); }
});

test('verify negative-control: 보안 상태를 하나씩 깨뜨리면 verdict가 반드시 NOT_APPLIED, 원복하면 APPLIED(정보성 값은 verdict에 영향 없음)', async () => {
  const db = await world();
  try {
    const verdict = async () => (await db.query(verify)).rows[0].verdict;
    assert.equal(await verdict(), 'APPLIED');
    const breaks = [
      ['A authenticated status 컬럼 UPDATE', `grant update (status) on reservations to authenticated`, `revoke update (status) on reservations from authenticated`],
      ['A2 authenticated 테이블 UPDATE', `grant update on reservations to authenticated`, `revoke update on reservations from authenticated; grant update (member_memo) on reservations to authenticated`],
      ['B anon UPDATE', `grant update on reservations to anon`, `revoke update on reservations from anon`],
      ['B2 anon INSERT', `grant insert on reservations to anon`, `revoke insert on reservations from anon`],
      ['B3 anon DELETE', `grant delete on reservations to anon`, `revoke delete on reservations from anon`],
      ['B4 anon TRUNCATE', `grant truncate on reservations to anon`, `revoke truncate on reservations from anon`],
      ['B5 authenticated TRUNCATE', `grant truncate on reservations to authenticated`, `revoke truncate on reservations from authenticated`],
      ['C anon eligible 함수 EXECUTE', `grant execute on function is_membership_eligible_for_class(uuid,uuid) to anon`, `revoke execute on function is_membership_eligible_for_class(uuid,uuid) from anon`],
      ['C2 authenticated eligible 함수 EXECUTE 제거', `revoke execute on function is_membership_eligible_for_class(uuid,uuid) from authenticated`, `grant execute on function is_membership_eligible_for_class(uuid,uuid) to authenticated`],
      ['C3 service_role eligible 함수 EXECUTE 제거', `revoke execute on function is_membership_eligible_for_class(uuid,uuid) from service_role`, `grant execute on function is_membership_eligible_for_class(uuid,uuid) to service_role`],
      ['D authenticated member_memo UPDATE 제거', `revoke update (member_memo) on reservations from authenticated`, `grant update (member_memo) on reservations to authenticated`],
      ['E service_role UPDATE 제거', `revoke update on reservations from service_role`, `grant update on reservations to service_role`],
      ['F memo RLS 정책 제거', `drop policy "본인 예약 메모 수정" on reservations`, `create policy "본인 예약 메모 수정" on reservations for update using (profile_id in (select my_profile_ids())) with check (profile_id in (select my_profile_ids()))`],
    ];
    for (const [label, breakSql, restoreSql] of breaks) {
      await db.exec(breakSql);
      assert.equal(await verdict(), 'NOT_APPLIED', label);
      await db.exec(restoreSql);
      assert.equal(await verdict(), 'APPLIED', `${label} 원복`);
    }
    // 정보성 값(authenticated INSERT/DELETE 권한)은 verdict에 영향이 없다
    const before = (await db.query(verify)).rows[0];
    await db.exec(`revoke insert, delete on reservations from authenticated`);
    const after = (await db.query(verify)).rows[0];
    assert.equal(after.verdict, 'APPLIED');
    assert.equal(after.info_auth_reservations_insert_privilege, false);
    assert.equal(before.info_auth_reservations_insert_privilege, true);
    await db.exec(`grant insert, delete on reservations to authenticated`);
    // 함수 정의가 되돌려지면(F1/F2/F3/F5/보완 항목) NOT_APPLIED
    await db.exec(rollback);
    assert.equal(await verdict(), 'NOT_APPLIED');
  } finally { await db.close(); }
});
