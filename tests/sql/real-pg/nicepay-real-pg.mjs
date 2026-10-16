// 실제 PostgreSQL 2세션 동시성 + 회귀 테스트 (오프라인·격리 환경 전용, 기본 테스트 스위트(`npm run test:sql`)에는 포함되지 않음).
// 목적: PGlite(단일 세션)로는 재현할 수 없는 "행 잠금 대기/커밋 후 재평가"를 실제 PostgreSQL에서 검증한다.
// 안전장치: 접속 대상이 loopback(127.0.0.1/localhost/::1)이 아니면 즉시 종료한다. 테스트는 매 실행마다 새 DB(qa_nicepay_<난수>)를 만들고 끝나면 지운다. 운영/공유 DEV 접속 불가.
// 준비: docker run -d --name nicepay-qa-pg -e POSTGRES_PASSWORD=<임의> -p 127.0.0.1:55432:5432 postgres:16-alpine ; npm i --no-save pg
// 실행: REAL_PG_URL=postgres://postgres:<임의>@127.0.0.1:55432/postgres node tests/sql/real-pg/nicepay-real-pg.mjs
import assert from 'node:assert/strict';
import * as W from '../helpers/nicepayWorld.mjs';

const URL_ = process.env.REAL_PG_URL;
if (!URL_) { console.log('SKIP: REAL_PG_URL 미설정 (격리 로컬 PostgreSQL에서만 실행)'); process.exit(0); }
const u = new URL(URL_);
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) { console.error(`REFUSED: loopback 이외 호스트(${u.hostname})에는 접속하지 않습니다`); process.exit(2); }
const { default: pg } = await import('pg');
const { id, C1, CI, P1, ACC, AUTH, MGR, PROD } = W;

const DB = `qa_nicepay_${Math.random().toString(36).slice(2, 10)}`;
const adminUrl = URL_;
const dbUrl = (() => { const x = new URL(URL_); x.pathname = '/' + DB; return x.toString(); })();
const connect = async url => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; };
const COS_DEF = `create or replace function public.create_order_secure(a uuid, b text, c text, d integer, e boolean, p_provider text) returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if p_provider is not null and p_provider not in ('mock', 'toss', 'portone') then raise exception 'invalid provider'; end if;
  insert into orders(profile_id, center_id, product_id, product_name, amount, auto_book, payment_provider) values ('${P1}','${C1}','${PROD}','p', d, e, p_provider) returning id into v;
  return v;
end $$;`;
const extraDbs = [];
const freshDb = async () => {
  const name = `qa_nicepay_${Math.random().toString(36).slice(2, 10)}`;
  await admin.query(`create database ${name}`); extraDbs.push(name);
  const x = new URL(URL_); x.pathname = '/' + name; const c = await connect(x.toString()); sessions.push(c);
  await c.query(W.baseWorldSql({}).replace('create role anon; create role authenticated; create role service_role bypassrls;', ''));
  await c.query(W.coreInstallSql({}));
  return c;
};
const results = []; let failed = 0;
const rec = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const t = async (name, fn) => { try { await fn(); rec(name, true); } catch (e) { rec(name, false, String(e.message).split('\n')[0]); } };

const admin = await connect(adminUrl);
await admin.query(`create database ${DB}`);
const base = await connect(dbUrl);
const sessions = [base];
const newSession = async () => { const c = await connect(dbUrl); sessions.push(c); return c; };
const q1 = async (c, sql, params) => (await c.query(sql, params)).rows[0];
const asService = c => c;   // JWT 없음(auth.uid() null) = service_role 대리 (슈퍼유저 세션이지만 앱 서버 경로와 동일하게 auth.uid()가 없다)

try {
  // ---- 월드 설치: 롤은 클러스터 단위라 이미 있으면 건너뜀. 나머지는 PGlite 테스트와 동일한 SQL.
  await base.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
    end $$;`);
  const worldSql = W.baseWorldSql({}).replace('create role anon; create role authenticated; create role service_role bypassrls;', '');
  await base.query(worldSql);
  await base.query(W.coreInstallSql({}));
  const snapOriginal = async c => Object.fromEntries(await Promise.all(Object.entries({
    helper: 'public._issue_membership_and_record_payment(orders,text,text)', fulfill: 'public.fulfill_order(uuid)', core: 'public._refund_membership_core(uuid,uuid,boolean,boolean)',
    trigger: 'public.orders_guard_status_transition()', settlement: 'public.admin_center_settlement_summary(date,date)' }).map(async ([k, v]) => [k, (await q1(c, `select pg_get_functiondef('${v}'::regprocedure) d`)).d])));
  const original = await snapOriginal(base);
  await base.query(W.refundFix);
  await base.query(W.support);
  await base.query(COS_DEF);
  await base.query(W.cosFix);
  const COS_EXISTS = true;

  const mkOrder = async (c, provider, { amount = 10000, status = 'pending', center = C1 } = {}) => {
    const oid = id(5, Math.floor(Math.random() * 1e9));
    await c.query(`insert into orders(id, profile_id, center_id, product_id, product_name, amount, status, payment_provider) values ($1,$2,$3,$4,'p',$5,$6,$7)`, [oid, P1, center, PROD, amount, status, provider]);
    return oid;
  };
  const claim = async (c, oid) => (await q1(c, `select nicepay_claim_order($1) c`, [oid])).c;
  const DIG = 'a'.repeat(64);
  const approve = (c, oid, cl, tid, amt) => c.query(`select nicepay_record_verified_approval($1,$2,$3,$4,$5)`, [oid, cl, tid, amt, DIG]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pendingAfter = async (p, ms = 500) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); await sleep(ms); return !done; };

  // ================= 동시성 =================
  await t('R1. release ↔ 승인 기록 저장 경합(신규 구현): A가 승인 기록 저장(미커밋, 행 잠금) 중 B의 release는 대기하고, A 커밋 뒤 false — 승인된 선점이 풀리지 않는다', async () => {
    const [A, B] = [await newSession(), await newSession()];
    const o = await mkOrder(base, 'nicepay'); const c = await claim(base, o);
    await A.query('begin'); await approve(A, o, c, 'TID-R1', 10000);
    const bp = B.query(`select nicepay_release_order($1,$2,'netcancel_confirmed') r`, [o, c]);
    assert.equal(await pendingAfter(bp), true, 'B가 A의 행 잠금 때문에 대기해야 한다');
    await A.query('commit');
    assert.equal((await bp).rows[0].r, false, 'A 커밋 후 B는 승인 기록을 보고 거부');
    assert.equal((await q1(base, `select status from orders where id=$1`, [o])).status, 'approving');
    assert.equal(Number((await q1(base, `select count(*)::int c from nicepay_review_actions where order_id=$1 and action='release'`, [o])).c), 0);
  });

  await t('R1-neg. 같은 경합을 구 구현(승인 기록 조회 → 갱신)에 적용하면 승인된 선점이 풀린다 — 테스트가 결함을 실제로 잡는다(음성 대조)', async () => {
    const [A, B] = [await newSession(), await newSession()];
    await base.query(`create or replace function nicepay_release_order_legacy(p_order_id uuid, p_claim_id uuid, p_basis text) returns boolean language plpgsql security definer set search_path = public as $$
      declare v_n int;
      begin
        if exists (select 1 from nicepay_pg_approvals a where a.order_id = p_order_id and a.claim_id = p_claim_id and not exists (select 1 from nicepay_pg_cancels c where c.order_id = a.order_id and c.pg_tid = a.tid)) then return false; end if;
        perform set_config('app.nicepay_write','on',true);
        update orders set status = 'pending', pg_claim_id = null, pg_claimed_at = null where id = p_order_id and status = 'approving' and pg_claim_id = p_claim_id and pg_tid is null and pg_review_at is null;
        get diagnostics v_n = row_count; perform set_config('app.nicepay_write','',true); return v_n = 1;
      end; $$;`);
    const o = await mkOrder(base, 'nicepay'); const c = await claim(base, o);
    await A.query('begin'); await approve(A, o, c, 'TID-R1N', 10000);
    const bp = B.query(`select nicepay_release_order_legacy($1,$2,'netcancel_confirmed') r`, [o, c]);
    assert.equal(await pendingAfter(bp), true);
    await A.query('commit');
    const r = (await bp).rows[0].r;
    const st = (await q1(base, `select status from orders where id=$1`, [o])).status;
    const appr = Number((await q1(base, `select count(*)::int c from nicepay_pg_approvals where order_id=$1`, [o])).c);
    assert.deepEqual([r, st, appr], [true, 'pending', 1], '구 구현: 승인 기록이 있는데도 pending으로 풀림(= 이중 청구 위험)');
    await base.query('drop function nicepay_release_order_legacy(uuid, uuid, text)');
  });

  await t('R2. 반대 방향: A의 release(행 잠금 보유)와 B의 승인 기록 저장 — B는 대기 후 "승인 선점이 일치하지 않아요"로 거부, 승인 기록 없음', async () => {
    const [A, B] = [await newSession(), await newSession()];
    const o = await mkOrder(base, 'nicepay'); const c = await claim(base, o);
    await A.query('begin'); assert.equal((await q1(A, `select nicepay_release_order($1,$2,'approve_rejected') r`, [o, c])).r, true);
    const bp = approve(B, o, c, 'TID-R2', 10000).then(() => 'ok', e => e.message);
    assert.equal(await pendingAfter(bp), true);
    await A.query('commit');
    assert.match(await bp, /승인 선점이 일치하지 않아요/);
    assert.equal(Number((await q1(base, `select count(*)::int c from nicepay_pg_approvals where order_id=$1`, [o])).c), 0);
  });

  await t('R3. 동시 선점(claim) 20회: 매번 정확히 1개 세션만 claim id를 얻는다', async () => {
    const [A, B] = [await newSession(), await newSession()];
    for (let i = 0; i < 20; i++) {
      const o = await mkOrder(base, 'nicepay');
      const [x, y] = await Promise.all([A.query(`select nicepay_claim_order($1) c`, [o]), B.query(`select nicepay_claim_order($1) c`, [o])]);
      const got = [x.rows[0].c, y.rows[0].c].filter(Boolean);
      assert.equal(got.length, 1, `반복 ${i}: 선점 성공 ${got.length}건`);
    }
  });

  await t('R4. 동시 확정(같은 주문·같은 TID) 2세션: 수강권·결제 각 1건, 한쪽은 already_done', async () => {
    const [A, B] = [await newSession(), await newSession()];
    const o = await mkOrder(base, 'nicepay', { amount: 12000 }); const c = await claim(base, o); await approve(base, o, c, 'TID-R4', 12000);
    const [x, y] = await Promise.all([A.query(`select confirm_nicepay_payment($1,$2,'TID-R4',12000) r`, [o, c]), B.query(`select confirm_nicepay_payment($1,$2,'TID-R4',12000) r`, [o, c])]);
    const dones = [x.rows[0].r.already_done, y.rows[0].r.already_done].sort();
    assert.deepEqual(dones, [false, true]);
    assert.equal(Number((await q1(base, `select count(*)::int c from payments where order_id=$1 and sale_type='new'`, [o])).c), 1);
    assert.equal(Number((await q1(base, `select count(*)::int c from memberships where id in (select membership_id from payments where order_id=$1)`, [o])).c), 1);
  });

  await t('R5. 서로 다른 두 주문이 같은 TID를 동시에 승인 기록: 정확히 1건만 성공(TID 재사용 불가)', async () => {
    const [A, B] = [await newSession(), await newSession()];
    const o1 = await mkOrder(base, 'nicepay'), o2 = await mkOrder(base, 'nicepay'); const c1 = await claim(base, o1), c2 = await claim(base, o2);
    const res = await Promise.all([approve(A, o1, c1, 'TID-R5', 10000).then(() => 'ok', e => 'err'), approve(B, o2, c2, 'TID-R5', 10000).then(() => 'ok', e => 'err')]);
    assert.deepEqual(res.slice().sort(), ['err', 'ok']);
    assert.equal(Number((await q1(base, `select count(*)::int c from nicepay_pg_approvals where tid='TID-R5'`)).c), 1);
  });

  await t('R6. 동시 환불(같은 수강권) 2세션: 정확히 1건만 환불, 환불 매출 행 1개', async () => {
    const [A, B] = [await newSession(), await newSession()];
    const o = await mkOrder(base, 'toss', { amount: 7000 }); await base.query(`select confirm_real_payment($1,'pk_r6',7000)`, [o]);
    const mid = (await q1(base, `select membership_id m from payments where order_id=$1`, [o])).m;
    const run = c => c.query(`select refund_membership_server($1,$2,true,false) r`, [mid, AUTH]).then(() => 'ok', e => e.message);
    const res = await Promise.all([run(A), run(B)]);
    assert.equal(res.filter(x => x === 'ok').length, 1, JSON.stringify(res));
    assert.match(res.find(x => x !== 'ok'), /이미 환불/);
    assert.equal(Number((await q1(base, `select count(*)::int c from payments where membership_id=$1 and sale_type='refund'`, [mid])).c), 1);
  });

  await t('R7. 동시 PG 취소 확인 기록(같은 주문·같은 취소 TID): 두 호출 모두 성공하되 기록은 1건(한쪽 already_recorded)', async () => {
    const [A, B] = [await newSession(), await newSession()];
    const o = await mkOrder(base, 'nicepay'); const c = await claim(base, o); await approve(base, o, c, 'TID-R7', 10000); await base.query(`select confirm_nicepay_payment($1,$2,'TID-R7',10000)`, [o, c]);
    const rc = s => s.query(`select nicepay_record_pg_cancel($1,'TID-R7','CXL-R7-0001',10000,'api_response','system',null,$2) r`, [o, DIG]);
    const [x, y] = await Promise.all([rc(A), rc(B)]);
    assert.deepEqual([x.rows[0].r.already_recorded, y.rows[0].r.already_recorded].sort(), [false, true]);
    assert.equal(Number((await q1(base, `select count(*)::int c from nicepay_pg_cancels where order_id=$1`, [o])).c), 1);
  });

  await t('R8. 확정(미커밋) 중 release: B는 대기 후 false(이미 done) — 완료된 주문은 풀리지 않는다', async () => {
    const [A, B] = [await newSession(), await newSession()];
    const o = await mkOrder(base, 'nicepay'); const c = await claim(base, o); await approve(base, o, c, 'TID-R8', 10000);
    await A.query('begin'); await A.query(`select confirm_nicepay_payment($1,$2,'TID-R8',10000)`, [o, c]);
    const bp = B.query(`select nicepay_release_order($1,$2,'netcancel_confirmed') r`, [o, c]);
    assert.equal(await pendingAfter(bp), true);
    await A.query('commit');
    assert.equal((await bp).rows[0].r, false);
    assert.equal((await q1(base, `select status from orders where id=$1`, [o])).status, 'done');
  });

  await t('R9. 검토 표시(mark_review, 미커밋)와 release 경합: release는 대기 후 false(검토 대기 주문은 자동 복귀 불가)', async () => {
    const [A, B] = [await newSession(), await newSession()];
    const o = await mkOrder(base, 'nicepay'); const c = await claim(base, o);
    await A.query('begin'); await A.query(`select nicepay_mark_review($1,$2,'netcancel_failed')`, [o, c]);
    const bp = B.query(`select nicepay_release_order($1,$2,'netcancel_confirmed') r`, [o, c]);
    assert.equal(await pendingAfter(bp), true);
    await A.query('commit');
    assert.equal((await bp).rows[0].r, false);
    assert.equal((await q1(base, `select status from orders where id=$1`, [o])).status, 'approving');
  });

  await t('R10. 수동 확정(미커밋)과 수동 해소 경합: 해소는 대기 후 "검토 대기 중인 NICEPAY 주문이 아니에요"로 거부, 수강권 1개', async () => {
    const [A, B] = [await newSession(), await newSession()];
    const o = await mkOrder(base, 'nicepay', { amount: 5000 }); const c = await claim(base, o); await approve(base, o, c, 'TID-R10', 5000);
    await base.query(`select nicepay_mark_review($1,$2,'confirm_state_unknown')`, [o, c]);
    await A.query('begin'); await A.query(`select nicepay_confirm_reviewed($1,'TID-R10',5000,'ADMIN-10','op-kim','op-park','memo')`, [o]);
    const bp = B.query(`select nicepay_resolve_review($1,'release','not_approved_confirmed','ADMIN-11','op-lee','op-park',null)`, [o]).then(() => 'ok', e => e.message);
    assert.equal(await pendingAfter(bp), true);
    await A.query('commit');
    assert.match(await bp, /검토 대기 중인 NICEPAY 주문이 아니에요/);
    assert.equal(Number((await q1(base, `select count(*)::int c from payments where order_id=$1 and sale_type='new'`, [o])).c), 1);
  });

  // ================= 실제 PostgreSQL 회귀 =================
  await t('G1. 기존 Toss: 발급(confirm_real_payment) 멱등, 회원 일반 환불 차단, 서버 경로 환불 가능, 정산 요약 동작', async () => {
    const o = await mkOrder(base, 'toss', { amount: 33000 });
    assert.equal((await q1(base, `select confirm_real_payment($1,'pk_g1',33000) r`, [o])).r.already_done, false);
    assert.equal((await q1(base, `select confirm_real_payment($1,'pk_g1',33000) r`, [o])).r.already_done, true);
    const mid = (await q1(base, `select membership_id m from payments where order_id=$1`, [o])).m;
    const U = await newSession(); await U.query(`select set_config('app.uid',$1,false), set_config('app.account_id',$2,false)`, [AUTH, ACC]);
    await assert.rejects(U.query(`select refund_membership($1)`, [mid]), /환불 요청 기능/);
    assert.deepEqual((await q1(base, `select refund_membership_server($1,$2,true,false) r`, [mid, AUTH])).r, { refunded: true, amount: 33000 });
    await base.query(`select set_config('app.platform_admin','on',false)`);
    await base.query(`select * from admin_center_settlement_summary(current_date - 1, current_date + 1)`);
    await base.query(`select set_config('app.platform_admin','',false)`);
  });

  await t('G2. 운영 형태 재현(Toss 완료 3건 중 32만 원 건은 결제 order_id 없음): 일반 환불 차단, 데이터 불변, 서버 경로 가능, 정상 직접결제는 환불', async () => {
    const mk = async amt => { const o = await mkOrder(base, 'toss', { amount: amt }); await base.query(`select confirm_real_payment($1,$2,$3)`, [o, `pk_${amt}`, amt]); return (await q1(base, `select membership_id m from payments where order_id=$1`, [o])).m; };
    const m1 = await mk(111000), m2 = await mk(222000);
    const orphan = await mkOrder(base, 'toss', { amount: 320000, status: 'done' }); const m3 = id(6, 9320);
    await base.query(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ($1,$2,$3,$4,'p',10,10)`, [m3, P1, C1, PROD]);
    await base.query(`insert into payments(center_id, profile_id, membership_id, order_id, sale_type, total_amount, paid_at, status) values ($1,$2,$3,null,'new',320000,now(),'paid')`, [C1, P1, m3]);
    const snap = async () => JSON.stringify([(await base.query('select * from orders order by id')).rows, (await base.query('select * from payments order by id')).rows]);
    const before = await snap();
    const U = await newSession(); await U.query(`select set_config('app.uid',$1,false), set_config('app.account_id',$2,false)`, [AUTH, ACC]);
    await assert.rejects(U.query(`select refund_membership($1)`, [m3]), /PG 결제 출처를 확인할 수 없는 수강권/);
    for (const m of [m1, m2]) await assert.rejects(U.query(`select refund_membership($1)`, [m]), /환불 요청 기능/);
    assert.equal(await snap(), before, '차단 시 데이터 불변');
    assert.equal(Number((await q1(base, `select count(*)::int c from payments where membership_id=$1 and order_id is null`, [m3])).c), 1, '자동 연결 없음');
    assert.equal((await q1(base, `select refund_membership_server($1,$2,true,false) r`, [m3, AUTH])).r.refunded, true);
    // 다른 상품의 정상 직접결제 환불(고아 주문과 무관)
    const PROD2 = id(4, 2); await base.query(`insert into products(id, center_id, name) values ($1,$2,'p2') on conflict do nothing`, [PROD2, C1]);
    const dm = id(6, 9321); await base.query(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ($1,$2,$3,$4,'p2',10,10)`, [dm, P1, C1, PROD2]);
    await base.query(`insert into payments(center_id, profile_id, membership_id, sale_type, total_amount, paid_at, status) values ($1,$2,$3,'new',50000,now(),'paid')`, [C1, P1, dm]);
    assert.equal((await q1(U, `select refund_membership($1) r`, [dm])).r.refunded, true);
    void orphan;
  });

  await t('G3. 적용 후 preflight(이미 패치됨 포함)·verify SQL이 실제 PostgreSQL에서 전부 true', async () => {
    await base.query(`select 1`);
    const pf = (await base.query(W.stripComments(W.preflight))).rows[0];
    for (const [k, v] of Object.entries(pf)) if (k.endsWith('_ok') || k.endsWith('_ok_or_absent')) assert.equal(v, true, k);
    for (const f of ['verify_fix_refund_pg_origin_guard_20261017.sql', 'verify_add_nicepay_provider_support_20261016.sql']) {
      const r = (await base.query(W.stripComments(W.read(f)))).rows[0];
      assert.ok(Object.values(r).every(x => x === true), `${f}: ${JSON.stringify(r)}`);
    }
  });

  await t('G4. 롤백 보호: nicepay 데이터가 있으면 롤백이 중단되고 아무것도 바뀌지 않는다', async () => {
    const before = await snapOriginal(base);
    await assert.rejects(base.query(W.supportRollback), /롤백하지 않습니다/);
    await base.query('rollback');   // 스크립트가 begin 안에서 중단되어 트랜잭션이 열려 있다
    const after = await snapOriginal(base);
    assert.deepEqual(after, before);
  });

  await t('G5. 새 DB에서 정순서 적용 → 역순 롤백이 실제 PostgreSQL에서도 함수 정의를 원문 그대로 복원(트리거·core는 공백 무관), 기존 Toss 흐름 유지', async () => {
    const c = await freshDb();
    await c.query(COS_DEF);
    const snapAll = async () => ({ ...(await snapOriginal(c)), cos: (await q1(c, `select pg_get_functiondef('public.create_order_secure(uuid,text,text,integer,boolean,text)'::regprocedure) d`)).d });
    const orig = await snapAll();
    await c.query(W.refundFix); await c.query(W.support); await c.query(W.cosFix);
    const applied = await snapAll();
    assert.notDeepEqual(applied, orig);
    await c.query(W.cosRollback); await c.query(W.supportRollback); await c.query(W.refundRollback);
    const after = await snapAll();
    for (const k of ['helper', 'fulfill', 'settlement', 'cos']) assert.equal(after[k], orig[k], `${k} 원문 복원`);
    const norm = x => x.replace(/\s+/g, ' ');
    assert.equal(norm(after.trigger), norm(orig.trigger)); assert.equal(norm(after.core), norm(orig.core));
    const o = await mkOrder(c, 'toss', { amount: 4000 }); assert.equal((await q1(c, `select confirm_real_payment($1,'pk_g5',4000) r`, [o])).r.already_done, false);
  });

  await t('G6. 순서 독립: support를 먼저, 환불 패치를 나중에 적용해도 두 가드가 모두 남는다(함수 통째 교체 없음)', async () => {
    const c = await freshDb();
    await c.query(W.support); await c.query(W.refundFix);
    const d = (await q1(c, `select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) d`)).d;
    assert.ok(d.includes('-- nicepay_pg_cancel_guard begin') && d.includes('-- pg_unknown_origin_guard begin'));
  });
  void COS_EXISTS;
} finally {
  for (const c of sessions) { try { await c.end(); } catch {} }
  for (const n of [DB, ...extraDbs]) { try { await admin.query(`drop database if exists ${n} with (force)`); } catch (e) { console.error('DB 정리 실패:', e.message); } }
  await admin.end();
}
console.log(`\n실제 PostgreSQL 테스트: PASS ${results.filter(r => r.ok).length} / FAIL ${failed} / 총 ${results.length}`);
process.exit(failed ? 1 : 0);
