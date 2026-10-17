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
import * as W from './helpers/nicepayWorld.mjs';
const { gateFix, gateRollback, gateVerify, roleGuardFix, roleGuardRollback, amountFix, amountRollback, serverFix, serverRollback, read, slice, lifecycle, kst, issuance, confirmReal, pointLife, settlementSrc, refundFix, refundRollback, cosFix, cosRollback, preflight, support, supportRollback, stripComments, id, C1, CI, P1, ACC, AUTH, MGR, PROD, liveHelper, liveFulfill, liveCore, liveForceInsert, liveStatusGuard, liveRestoreTrigger, liveRefundWrappers, liveRefundContext, liveAccountFor, liveConfirmReal, liveCancelReal, liveConfirmTest, liveSettlement, toCrlf, dropNewComment } = W;

async function world({ refundFixApplied = true, supportApplied = true, serverFixApplied = true, amountFixApplied = true, roleGuardApplied = true, gateApplied = true, crlf = false, noComment = false } = {}) {
  const db = new PGlite();
  await db.exec(W.baseWorldSql({ crlf, noComment }));
  await db.exec(W.coreInstallSql({ crlf, noComment }));
  if (refundFixApplied) await db.exec(refundFix);   // 적용 순서: ① 환불 차단 수정 → ② NICEPAY 지원(환불 core 패치 포함)
  if (gateApplied) await db.exec(gateFix);   // NICEPAY 주문 생성 DB 게이트 — support/create_order_secure 보다 먼저(없으면 둘 다 중단)
  if (supportApplied) await db.exec(support);
  if (serverFixApplied && refundFixApplied) await db.exec(serverFix);   // 서버 경로 fail-closed (선행: 출처 가드)
  if (amountFixApplied && serverFixApplied && refundFixApplied) await db.exec(amountFix);   // 환불 금액 정합성 (선행: 위 둘)
  if (roleGuardApplied) await db.exec(roleGuardFix);   // orders INSERT 보정의 anon/authenticated 롤 경계(독립)
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
  if (provider === 'nicepay') await db.exec(`update orders set pg_tid = 'NP-${oid.slice(-9)}', pg_claim_id = gen_random_uuid() where id='${oid}'; insert into nicepay_pg_approvals(order_id, claim_id, tid, amount, response_digest) select id, pg_claim_id, pg_tid, greatest(${amount}, 1), '${'a'.repeat(64)}' from orders where id='${oid}';`);
  await db.exec(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ('${mid}','${P1}','${C1}','${PROD}','p',10,10);
    insert into payments(center_id, profile_id, membership_id, order_id, sale_type, total_amount, pg_transaction_id, paid_at, status, payment_provider) values ('${C1}','${P1}','${mid}','${oid}','new',${amount},${provider === 'mock' ? `'mock_${mid.slice(-6)}'` : provider === 'nicepay' ? `'NP-${oid.slice(-9)}'` : provider ? `'tid-${mid.slice(-6)}'` : 'null'},now(),'paid',${provider === 'nicepay' ? `'nicepay'` : 'null'});`);
  return { oid, mid };
}
const DIG = 'a'.repeat(64);
const approve = (db, oid, claimId, tid, amount) => db.query(`select nicepay_record_verified_approval('${oid}', '${claimId}', '${tid}', ${amount}, '${DIG}') r`);
const recordCancel = async (db, oid, amount = 10000, cancelTid = 'CXL-' + oid.slice(-8)) => {
  const pgTid = (await q1(db, `select tid t from nicepay_pg_approvals where order_id='${oid}' order by id desc limit 1`)).t;
  return db.query(`select nicepay_record_pg_cancel('${oid}', '${pgTid}', '${cancelTid}', ${amount}, 'api_response', 'system', null, '${DIG}') r`);
};
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
    await db.exec("update nicepay_checkout_gate set mode = 'public' where id");   // 이 테스트는 "게이트가 열린 뒤에도" 위조 필드가 지워지는지 본다(게이트 자체는 GT 테스트)
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
    const R = (action, type, ref, actor, note = null, approver = 'op-park') => db.query(`select nicepay_resolve_review('${o}', '${action}', ${type ? `'${type}'` : 'null'}, ${ref ? `'${ref}'` : 'null'}, ${actor ? `'${actor}'` : 'null'}, ${approver ? `'${approver}'` : 'null'}, ${note ? `'${note}'` : 'null'}) r`);
    await rejects(R('confirm', 'netcancel_confirmed', 'NC-0001', 'op'), /지원하지 않는 처리/);
    await rejects(R('release', null, 'NC-0001', 'op'), /증거 유형/);
    await rejects(R('release', 'pg_cancel_confirmed', 'NC-0001', 'op'), /증거 유형/);   // release에는 '취소 완료' 증거 불가(재시도 시 이중 결제 위험)
    await rejects(R('release', 'netcancel_confirmed', 'x', 'op'), /증거 번호/);
    await rejects(R('release', 'netcancel_confirmed', 'NC-0001', 'o'), /처리자를/);
    await rejects(R('release', 'netcancel_confirmed', 'NC-0001', 'op-kim', null, null), /다른 승인자/);
    await rejects(R('release', 'netcancel_confirmed', 'NC-0001', 'op-kim', null, 'op-kim'), /다른 승인자/);   // 같은 사람의 2인 승인 불가
    assert.equal((await q1(db, `select status from orders where id='${o}'`)).status, 'approving', '증거 없는 시도는 아무것도 바꾸지 못한다');
    assert.equal(await count(db, 'nicepay_review_actions', `order_id='${o}' and action like 'resolve_%'`), 0);
    assert.deepEqual((await R('release', 'not_approved_confirmed', 'ADMIN-77', 'op-kim', '관리자 화면에서 미승인 확인')).rows[0].r, { resolved: 'release' });
    assert.deepEqual(await q1(db, `select status, pg_claim_id, pg_review_at from orders where id='${o}'`), { status: 'pending', pg_claim_id: null, pg_review_at: null });
    const row = await q1(db, `select action, evidence_type, evidence_ref, actor, approver, note, status_before, status_after from nicepay_review_actions where order_id='${o}' and action='resolve_release'`);
    assert.deepEqual(row, { action: 'resolve_release', evidence_type: 'not_approved_confirmed', evidence_ref: 'ADMIN-77', actor: 'op-kim', approver: 'op-park', note: '관리자 화면에서 미승인 확인', status_before: 'approving', status_after: 'pending' });
    // cancel: 포인트 복원(기존 취소 트리거), 거래번호 있는 주문은 불가
    const x = await mkOrder(db, 'nicepay'); const cx = await claim(db, x); await db.query(`select nicepay_mark_review('${x}', '${cx}', 'confirm_state_unknown')`);
    await db.query(`select nicepay_resolve_review('${x}', 'cancel', 'pg_cancel_confirmed', 'CXL-9999', 'op-lee', 'op-park', null)`);
    assert.equal((await q1(db, `select status from orders where id='${x}'`)).status, 'cancelled'); assert.equal(await count(db, 'restored_points', `order_id='${x}'`), 1);
    await rejects(db.query(`select nicepay_resolve_review('${x}', 'cancel', 'pg_cancel_confirmed', 'CXL-9999', 'op-lee', 'op-park', null)`), /검토 대기 중인 NICEPAY 주문이 아니에요/);
    const t = await mkOrder(db, 'nicepay'); const ct = await claim(db, t); await db.query(`select nicepay_mark_review('${t}', '${ct}', 'confirm_state_unknown')`);
    await db.exec(`update orders set pg_tid='TT-1' where id='${t}'`);
    await rejects(db.query(`select nicepay_resolve_review('${t}', 'release', 'netcancel_confirmed', 'NC-0002', 'op-lee', 'op-park', null)`), /거래번호가 기록된 주문/);
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
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-1', 12000)`), /서버가 검증한 PG 승인 기록이 없어요/);   // 서버 검증 승인 기록 없이는 확정 불가
    assert.equal(await count(db, 'memberships'), 0);
    await approve(db, o, c, 'TID-1', 12000);
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
    await rejects(approve(db, o2, c2, 'TID-1', 12000), /이미 다른 주문\/선점에 기록된 거래번호/);   // 다른 주문이 쓴 TID는 승인 기록 단계에서 거부
    assert.deepEqual(await q1(db, `select status, pg_tid from orders where id='${o2}'`), { status: 'approving', pg_tid: null });
    assert.equal(await count(db, 'payments', `order_id='${o2}'`), 0); assert.equal(await count(db, 'memberships'), 1);
    await db.query(`select nicepay_release_order('${o2}', '${c2}', 'netcancel_confirmed')`); const c3 = await claim(db, o2);
    await rejects(db.query(`select confirm_nicepay_payment('${o2}', '${c2}', 'TID-2', 12000)`), /선점이 일치하지 않아요/);
    await approve(db, o2, c3, 'TID-2', 12000);
    await db.query(`select confirm_nicepay_payment('${o2}', '${c3}', 'TID-2', 12000)`);
    for (const p of ['toss', 'mock', null]) await rejects(db.query(`select confirm_nicepay_payment('${await mkOrder(db, p)}', '${id(9, 1)}', 'T', 10000)`), /NICEPAY 주문에만/);
    await rejects(db.query(`select confirm_nicepay_payment('${id(9, 9)}', '${id(9, 1)}', 'T', 1)`), /주문을 찾을 수 없어요/);
  } finally { await db.close(); }
});

test('G2. provider 저장/일치 검증: 패치가 없으면(helper가 provider를 안 남기면) 확정은 전체 롤백 — 수강권 없음', async () => {
  const db = await world();
  try {
    await db.exec(liveHelper);   // 패치 이전 라이브 helper로 되돌림(payment_provider 미기록)
    const o = await mkOrder(db, 'nicepay'); const c = await claim(db, o); await approve(db, o, c, 'TID-9', 10000);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-9', 10000)`), /결제 기록이 주문과 일치하지 않아요/);
    assert.equal(await count(db, 'memberships'), 0); assert.equal(await count(db, 'payments'), 0);
    assert.deepEqual(await q1(db, `select status, pg_tid from orders where id='${o}'`), { status: 'approving', pg_tid: null }, '전체 롤백');
  } finally { await db.close(); }
});

test('G3. 검토 대기 주문은 직접 확정 불가, 수동 확정은 서버가 검증한 승인 기록 + 2인 승인 + 증거가 모두 있을 때만 — 증빙 문자열만으로는 수강권 불가', async () => {
  const db = await world();
  try {
    const o = await mkOrder(db, 'nicepay', { amount: 5000 }); const c = await claim(db, o);
    await db.query(`select nicepay_mark_review('${o}', '${c}', 'confirm_state_unknown')`);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-R', 5000)`), /수동 확정 절차/);
    const CR = (tid, amt, ref, actor, approver) => db.query(`select nicepay_confirm_reviewed('${o}', '${tid}', ${amt}, ${ref ? `'${ref}'` : 'null'}, ${actor ? `'${actor}'` : 'null'}, ${approver ? `'${approver}'` : 'null'}, 'memo') r`);
    // 서버가 검증한 승인 기록이 없으면(응답 유실 등) 아무리 증빙·2인 승인을 갖춰도 수강권 발급 불가
    await rejects(CR('TID-R', 5000, 'ADMIN-1', 'op-kim', 'op-park'), /서버가 검증한 PG 승인 기록이 없는 거래/);
    assert.equal(await count(db, 'memberships'), 0); assert.equal(await count(db, 'nicepay_review_actions', `action='resolve_confirm'`), 0);
    await approve(db, o, c, 'TID-R', 5000);       // 서버가 승인 응답을 검증·기록(이후 DB 확정만 실패한 상황)
    await rejects(CR('TID-R', 5000, 'x', 'op-kim', 'op-park'), /증거 번호/);
    await rejects(CR('TID-R', 5000, 'ADMIN-1', 'o', 'op-park'), /처리자를/);
    await rejects(CR('TID-R', 5000, 'ADMIN-1', 'op-kim', null), /다른 승인자/);
    await rejects(CR('TID-R', 5000, 'ADMIN-1', 'op-kim', 'op-kim'), /다른 승인자/);
    await rejects(CR('TID-R', 4999, 'ADMIN-1', 'op-kim', 'op-park'), /서버가 검증한 PG 승인 기록이 없는 거래/);   // 금액이 기록과 다르면 불가
    await rejects(CR('TID-OTHER', 5000, 'ADMIN-1', 'op-kim', 'op-park'), /서버가 검증한 PG 승인 기록이 없는 거래/);   // 임의 TID 불가
    assert.equal(await count(db, 'memberships'), 0);
    assert.equal(await count(db, 'nicepay_review_actions', `action='resolve_confirm'`), 0, '실패한 시도는 감사 행도 롤백');
    const r = (await CR('TID-R', 5000, 'ADMIN-1', 'op-kim', 'op-park')).rows[0].r;
    assert.equal(r.already_done, false);
    assert.deepEqual(await q1(db, `select status, pg_tid, pg_review_at from orders where id='${o}'`), { status: 'done', pg_tid: 'TID-R', pg_review_at: null });
    assert.deepEqual(await q1(db, `select action, evidence_type, evidence_ref, actor, approver, tid from nicepay_review_actions where action='resolve_confirm'`), { action: 'resolve_confirm', evidence_type: 'pg_approved_confirmed', evidence_ref: 'ADMIN-1', actor: 'op-kim', approver: 'op-park', tid: 'TID-R' });
    assert.equal(await count(db, 'memberships'), 1); assert.equal((await q1(db, `select payment_provider p from payments where order_id='${o}'`)).p, 'nicepay');
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
    const o = await mkOrder(db, 'nicepay'); const c = await claim(db, o); await approve(db, o, c, 'TID-F', 10000); await db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-F', 10000)`);
    assert.equal((await asManager(db, () => db.query(`select fulfill_order('${o}') r`))).rows[0].r.already_done, true);
    assert.equal(await count(db, 'payments', `order_id='${o}'`), 1);
  } finally { await db.close(); }
});

test('G5. 정산/매출 호환: 정산 요약은 nicepay 결제도 포함(toss/portone 유지, NULL·mock 제외), 매출 집계 조건(mock 제외)은 nicepay를 실매출로 취급', async () => {
  const db = await world();
  try {
    const mk = async (p, amt) => { const o = await mkOrder(db, p, { amount: amt }); if (p === 'nicepay') { const c = await claim(db, o); await approve(db, o, c, `T-${amt}`, amt); await db.query(`select confirm_nicepay_payment('${o}', '${c}', 'T-${amt}', ${amt})`); } else if (p === 'mock') { await asUser(db, () => db.query(`select confirm_test_payment('${o}', 'm')`)); } else await db.query(`select confirm_real_payment('${o}', 'pk', ${amt})`); };
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
test('H. 권한: 새 RPC 10개는 service_role 전용·SECURITY DEFINER·search_path 고정, 감사 테이블은 RLS+클라이언트 접근 불가', async () => {
  const db = await world();
  try {
    const fns = ['nicepay_record_verified_approval(uuid,uuid,text,integer,text)', 'nicepay_record_pg_cancel(uuid,text,text,integer,text,text,text,text)', 'confirm_nicepay_payment(uuid,uuid,text,integer)', 'nicepay_confirm_reviewed(uuid,text,integer,text,text,text,text)', 'nicepay_order_context(uuid)', 'nicepay_claim_order(uuid)', 'nicepay_release_order(uuid,uuid,text)', 'nicepay_mark_review(uuid,uuid,text)', 'nicepay_expire_stale_claims(interval)', 'nicepay_resolve_review(uuid,text,text,text,text,text,text)'];
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
    assert.equal(await count(drift, 'pg_proc', "proname like 'nicepay_%' and proname not like 'nicepay_checkout%'"), 0);
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
    const v1 = (await db.query(stripComments(read('verify_fix_refund_pg_origin_guard_20261017.sql')))).rows[0];
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
    assert.equal(await count(db, 'pg_proc', "proname like 'nicepay_%' and proname not like 'nicepay_checkout%' or proname = 'confirm_nicepay_payment'"), 0);
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

test('K1. NICEPAY 환불: 실제 PG 취소 확인 기록(서버 검증 승인에 대한) 전에는 서버 경로(allow_pg=true)도 내부 환불 불가, 증빙 문자열만으로 환불 불가, 2인 승인/응답 요약 필수', async () => {
  const db = await world();
  try {
    const n = await paidMembership(db, 'nicepay');
    const pgTid = (await q1(db, `select pg_tid t from orders where id='${n.oid}'`)).t;
    await asUser(db, () => rejects(db.query(`select refund_membership('${n.mid}')`), /환불 요청 기능/));
    await rejects(db.query(`select refund_membership_server('${n.mid}','${AUTH}', true, false)`), /PG 승인 취소가 확인된 뒤에만/);
    await rejects(db.query(`select refund_membership_server('${n.mid}','${AUTH}', true, true)`), /PG 승인 취소가 확인된 뒤에만/);
    assert.equal((await q1(db, `select status from memberships where id='${n.mid}'`)).status, 'active');
    const rec = (oid, tid, ctid, amt, src, actor, approver, dig) => db.query(`select nicepay_record_pg_cancel('${oid}', ${tid ? `'${tid}'` : 'null'}, ${ctid ? `'${ctid}'` : 'null'}, ${amt}, '${src}', ${actor ? `'${actor}'` : 'null'}, ${approver ? `'${approver}'` : 'null'}, ${dig ? `'${dig}'` : 'null'}) r`);
    await rejects(rec(n.oid, pgTid, 'CXL-0001', 10000, 'guess', 'system', null, DIG), /출처/);
    await rejects(rec(n.oid, pgTid, 'x', 10000, 'api_response', 'system', null, DIG), /취소 거래번호/);
    await rejects(rec(n.oid, pgTid, 'CXL-0001', 10000, 'api_response', 'a', null, DIG), /처리자를/);
    await rejects(rec(n.oid, pgTid, 'CXL-0001', 10000, 'api_response', 'system', null, null), /응답 요약값/);        // 서버 경로는 검증한 응답의 요약값 필수
    await rejects(rec(n.oid, pgTid, 'CXL-0001', 10000, 'admin_console', 'op-kim', null, null), /다른 승인자/);       // 운영자 확인은 2인 승인 필수 — 증빙 문자열 하나로는 불가
    await rejects(rec(n.oid, pgTid, 'CXL-0001', 10000, 'admin_console', 'op-kim', 'op-kim', null), /다른 승인자/);
    await rejects(rec(n.oid, pgTid, 'CXL-0001', 5000, 'api_response', 'system', null, DIG), /전액 취소만/);
    await rejects(rec(n.oid, pgTid, pgTid, 10000, 'api_response', 'system', null, DIG), /승인 거래번호와 같아요/);
    await rejects(rec(n.oid, 'FORGED-TID', 'CXL-0001', 10000, 'api_response', 'system', null, DIG), /서버가 검증한 PG 승인 기록이 없는 거래/);   // 서버가 검증한 적 없는 TID
    const un = await mkOrder(db, 'nicepay'); await rejects(rec(un, 'NP-whatever', 'CXL-0002', 10000, 'api_response', 'system', null, DIG), /서버가 검증한 PG 승인 기록이 없는 거래/);
    await rejects(rec(await mkOrder(db, 'toss', { status: 'done' }), pgTid, 'CXL-0003', 10000, 'api_response', 'system', null, DIG), /NICEPAY 주문이 아니에요/);
    // 아직 환불 불가 확인 (실패한 시도는 아무 기록도 남기지 않음)
    assert.equal(await count(db, 'nicepay_pg_cancels'), 0);
    await rejects(db.query(`select refund_membership_server('${n.mid}','${AUTH}', true, false)`), /PG 승인 취소가 확인된 뒤에만/);
    assert.equal((await rec(n.oid, pgTid, 'CXL-0001', 10000, 'admin_console', 'op-kim', 'op-park', null)).rows[0].r.already_recorded, false);
    assert.equal((await rec(n.oid, pgTid, 'CXL-0001', 10000, 'api_response', 'system', null, DIG)).rows[0].r.already_recorded, true, '멱등');
    await rejects(rec(n.oid, pgTid, 'CXL-OTHER', 10000, 'api_response', 'system', null, DIG), /이미 다른 취소 거래/);
    const n2 = await paidMembership(db, 'nicepay'); const tid2 = (await q1(db, `select pg_tid t from orders where id='${n2.oid}'`)).t;
    await rejects(rec(n2.oid, tid2, 'CXL-0001', 10000, 'api_response', 'system', null, DIG), /duplicate key|nicepay_pg_cancels_cancel_tid_key/);   // 취소 거래번호 재사용 불가
    await rejects(rec(n2.oid, pgTid, 'CXL-0009', 10000, 'api_response', 'system', null, DIG), /서버가 검증한 PG 승인 기록이 없는 거래/);   // 다른 주문의 승인 TID로 기록 불가
    await rejects(db.exec(`update nicepay_pg_cancels set actor='x1'`), /수정하거나 삭제할 수 없어요/);
    await rejects(db.exec(`delete from nicepay_pg_cancels`), /수정하거나 삭제할 수 없어요/);
    await asUser(db, () => rejects(db.query(`select refund_membership('${n.mid}')`), /환불 요청 기능/));   // 기록 후에도 회원 일반 환불은 차단
    assert.deepEqual((await db.query(`select refund_membership_server('${n.mid}','${AUTH}', true, false) r`)).rows[0].r, { refunded: true, amount: 10000 });
    for (const p of ['toss', 'portone']) { const x = await paidMembership(db, p); assert.equal((await db.query(`select refund_membership_server('${x.mid}','${AUTH}', true, false) r`)).rows[0].r.refunded, true, p); }
    const z = await paidMembership(db, 'nicepay', { amount: 0 });   // 0원 NICEPAY 주문은 돈 이동이 없어 취소 확인 불필요(서버 경로)
    assert.equal((await db.query(`select refund_membership_server('${z.mid}','${AUTH}', true, false) r`)).rows[0].r.refunded, true);
    await db.exec('set role authenticated');
    try { await rejects(db.query(`select * from nicepay_pg_cancels`), /permission denied/); await rejects(db.query(`select * from nicepay_pg_approvals`), /permission denied/); await rejects(db.query(`select nicepay_record_pg_cancel('${n.oid}','${pgTid}','CXL-9999',10000,'api_response','system',null,'${DIG}')`), /permission denied/); } finally { await db.exec('reset role'); }
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
      const nd = await mkOrder(db, 'nicepay'); const cl = await claim(db, nd); await approve(db, nd, cl, 'TID-L', 10000); await db.query(`select confirm_nicepay_payment('${nd}', '${cl}', 'TID-L', 10000)`);
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
      assert.equal(await count(db, 'pg_proc', "proname like 'nicepay_%' and proname not like 'nicepay_checkout%'"), 0, name);
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
      const n = await mkOrder(db, 'nicepay', { amount: 4000 }); const c = await claim(db, n); await approve(db, n, c, 'TID-M', 4000); await db.query(`select confirm_nicepay_payment('${n}', '${c}', 'TID-M', 4000)`);
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
    for (const [k, v] of okCols(r)) if (!['refund_server_path_patch_ok', 'refund_amount_patch_ok'].includes(k)) assert.equal(v, true, k);
    assert.equal(r.refund_amount_patch_ok, false, '서버 경로 패치가 없으면 금액 패치 점검도 false');
    assert.equal(r.refund_server_path_patch_ok, false, '선행 패치(fix_refund_pg_origin_guard)가 없으면 서버 경로 패치 점검은 false');
    await db.exec(refundFix);
    assert.equal((await db.query(preflight)).rows[0].refund_server_path_patch_ok, true, '선행 패치 후 true');
    await db.exec(serverFix);
    assert.equal((await db.query(preflight)).rows[0].refund_amount_patch_ok, true, '서버 경로 패치 후 true');
    // 읽기 전용: 함수/데이터가 바뀌지 않았다
    assert.equal(await count(db, 'pg_proc', "proname like 'nicepay_%' and proname not like 'nicepay_checkout%'"), 0);
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

// ================================================================ 최종 SQL 안전 검증 ====
test('T1. 승인 기록 게이트: 서버가 검증한 승인 기록(주문·선점·TID·금액) 없이는 수강권이 발급되지 않는다', async () => {
  const db = await world();
  try {
    const o = await mkOrder(db, 'nicepay', { amount: 8000 }); const c = await claim(db, o);
    const rv = (oid, cl, tid, amt, dig = DIG) => db.query(`select nicepay_record_verified_approval('${oid}', '${cl}', ${tid ? `'${tid}'` : 'null'}, ${amt}, ${dig ? `'${dig}'` : 'null'}) r`);
    await rejects(rv(o, c, 'x', 8000), /거래번호가 올바르지 않아요/);
    await rejects(rv(o, c, 'TID-T1', 8000, 'zz'), /요약값/);
    await rejects(rv(o, id(9, 1), 'TID-T1', 8000), /승인 선점이 일치하지 않아요/);
    await rejects(rv(o, c, 'TID-T1', 7999), /금액이 주문 금액과 일치하지 않아요/);
    await rejects(rv(await mkOrder(db, 'toss'), c, 'TID-T1', 10000), /NICEPAY 주문이 아니에요/);
    await rejects(rv(await mkOrder(db, 'nicepay'), c, 'TID-T1', 10000), /승인 선점이 일치하지 않아요/);   // 선점 전
    // 기록 전: 어떤 TID/금액으로도 확정 불가
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-T1', 8000)`), /서버가 검증한 PG 승인 기록이 없어요/);
    assert.equal((await rv(o, c, 'TID-T1', 8000)).rows[0].r.already_recorded, false);
    assert.equal((await rv(o, c, 'TID-T1', 8000)).rows[0].r.already_recorded, true, '멱등');
    // 기록과 다른 TID/금액으로는 확정 불가
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-FORGED', 8000)`), /서버가 검증한 PG 승인 기록이 없어요/);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-T1', 7000)`), /금액이 주문 금액과 일치하지 않아요/);
    assert.equal(await count(db, 'memberships'), 0); assert.equal(await count(db, 'payments'), 0);
    // 다른 주문이 같은 TID를 승인 기록에 올릴 수 없음
    const o2 = await mkOrder(db, 'nicepay', { amount: 8000 }); const c2 = await claim(db, o2);
    await rejects(rv(o2, c2, 'TID-T1', 8000), /이미 다른 주문\/선점에 기록된 거래번호/);
    await db.query(`select confirm_nicepay_payment('${o}', '${c}', 'TID-T1', 8000)`);
    assert.equal(await count(db, 'memberships'), 1);
    await rejects(db.exec(`update nicepay_pg_approvals set amount = 1`), /수정하거나 삭제할 수 없어요/);
    await rejects(db.exec(`delete from nicepay_pg_approvals`), /수정하거나 삭제할 수 없어요/);
  } finally { await db.close(); }
});

test('T2. release/수동 해소: 서버가 검증한 승인이 있었던 선점은 PG 취소 확인 기록 없이는 풀 수 없다(증빙 문자열만으로 재결제 유도 불가), 2인 승인 필수', async () => {
  const db = await world();
  try {
    const o = await mkOrder(db, 'nicepay'); const c = await claim(db, o);
    // 승인 기록이 없는 선점(승인 거절/검증 실패)은 기존대로 복귀 가능
    assert.equal((await q1(db, `select nicepay_release_order('${o}', '${c}', 'approve_rejected') r`)).r, true);
    const c2 = await claim(db, o); await approve(db, o, c2, 'TID-T2', 10000);
    // 승인 기록이 있으면: 자동 복귀 불가(= 망취소 확인 기록 필요)
    assert.equal((await q1(db, `select nicepay_release_order('${o}', '${c2}', 'netcancel_confirmed') r`)).r, false);
    assert.equal((await q1(db, `select status from orders where id='${o}'`)).status, 'approving');
    await db.query(`select nicepay_mark_review('${o}', '${c2}', 'netcancel_failed')`);
    await rejects(db.query(`select nicepay_resolve_review('${o}', 'release', 'netcancel_confirmed', 'NC-0001', 'op-kim', 'op-park', null)`), /PG 취소 확인 기록 뒤에만/);
    await rejects(db.query(`select nicepay_resolve_review('${o}', 'cancel', 'pg_cancel_confirmed', 'CXL-0001', 'op-kim', 'op-park', null)`), /PG 취소 확인 기록 뒤에만/);   // 증빙 문자열만으로는 안 됨
    assert.equal((await q1(db, `select status from orders where id='${o}'`)).status, 'approving');
    // PG 취소 확인(승인 기록의 TID에 대해, 검토 대기 중인 선점) 후에는 풀 수 있다
    await db.query(`select nicepay_record_pg_cancel('${o}', 'TID-T2', 'NC-T2-0001', 10000, 'admin_console', 'op-kim', 'op-park', null)`);
    assert.deepEqual((await db.query(`select nicepay_resolve_review('${o}', 'release', 'netcancel_confirmed', 'NC-0001', 'op-kim', 'op-park', null) r`)).rows[0].r, { resolved: 'release' });
    // 풀린 뒤 재결제는 새 선점/새 TID로: 이전 TID는 재사용 불가, 취소된 거래의 승인 기록으로 확정 불가
    const c3 = await claim(db, o);
    await rejects(db.query(`select confirm_nicepay_payment('${o}', '${c3}', 'TID-T2', 10000)`), /서버가 검증한 PG 승인 기록이 없어요/);
    await rejects(approve(db, o, c3, 'TID-T2', 10000), /이미 다른 주문\/선점에 기록된 거래번호/);
    await approve(db, o, c3, 'TID-T2B', 10000); await db.query(`select confirm_nicepay_payment('${o}', '${c3}', 'TID-T2B', 10000)`);
    assert.equal(await count(db, 'memberships'), 1);
    // 완료된 주문의 환불: 새 거래(TID-T2B)의 취소 확인이 있어야 하고, 이전 거래의 취소 기록으로는 안 된다
    const mid = (await q1(db, `select membership_id m from payments where order_id='${o}'`)).m;
    await rejects(db.query(`select refund_membership_server('${mid}','${AUTH}', true, false)`), /PG 승인 취소가 확인된 뒤에만/);
    await db.query(`select nicepay_record_pg_cancel('${o}', 'TID-T2B', 'CXL-T2B-1', 10000, 'api_response', 'system', null, '${DIG}')`);
    assert.equal((await db.query(`select refund_membership_server('${mid}','${AUTH}', true, false) r`)).rows[0].r.refunded, true);
  } finally { await db.close(); }
});

test('U1. 기존 Toss 완료 주문 3건 보호: 전체 적용 체인(환불수정 → NICEPAY 지원 → create_order_secure) 전후 orders/payments/memberships가 1바이트도 변하지 않는다', async () => {
  const db = await world({ supportApplied: false, refundFixApplied: false });
  try {
    for (const amt of [11000, 22000, 33000]) { const o = await mkOrder(db, 'toss', { amount: amt }); await db.query(`select confirm_real_payment('${o}', 'pk_${amt}', ${amt})`); }
    await db.exec(COS_SHAPES['IN 목록']('\n'));
    const snap = async () => JSON.stringify([
      (await db.query(`select * from orders where payment_provider = 'toss' order by id`)).rows.map(r => ({ ...r, pg_claim_id: undefined, pg_claimed_at: undefined, pg_tid: undefined, pg_review_reason: undefined, pg_review_at: undefined })),
      (await db.query(`select * from payments order by id`)).rows, (await db.query(`select * from memberships order by id`)).rows]);
    const before = await snap();
    await db.exec(refundFix); await db.exec(support); await db.exec(cosFix);
    assert.equal(await snap(), before, '적용 후 기존 Toss 데이터 동일(신규 pg_* 컬럼은 모두 NULL)');
    assert.equal(await count(db, 'orders', `payment_provider = 'toss' and (pg_tid is not null or pg_claim_id is not null or pg_review_at is not null)`), 0);
    // 적용 후에도 완료 Toss 주문의 환불 경로(서버 allow_pg)는 그대로, 일반 환불은 차단
    const tm = (await db.query(`select membership_id m from payments where pg_transaction_id = 'pk_11000'`)).rows[0].m;
    await asUser(db, () => rejects(db.query(`select refund_membership('${tm}')`), /환불 요청 기능/));
    assert.equal((await db.query(`select refund_membership_server('${tm}','${AUTH}', true, false) r`)).rows[0].r.refunded, true);
    // 역순 롤백 후에도 나머지 2건은 그대로
    await db.exec(cosRollback); await db.exec(supportRollback); await db.exec(refundRollback);
    const rest = (await db.query(`select count(*)::int c from payments where sale_type = 'new' and pg_transaction_id in ('pk_22000','pk_33000')`)).rows[0].c;
    assert.equal(rest, 2);
  } finally { await db.close(); }
});

test('U2. 적용 순서/역순 롤백: 정순서 적용 → 역순 롤백이 전체 함수 정의를 원문 그대로 복원, 순서가 뒤바뀌면 verify가 잡는다', async () => {
  const db = await world({ supportApplied: false, refundFixApplied: false, crlf: true, noComment: true });
  try {
    await db.exec(COS_SHAPES['IN 목록']('\r\n'));
    const sigCos = 'public.create_order_secure(uuid,text,text,integer,boolean,text)';
    const before = { ...(await snapshotDefs(db)), cos: await defOf(db, sigCos) };
    await db.exec(refundFix); await db.exec(support); await db.exec(cosFix);
    const v1 = (await db.query(stripComments(read('verify_add_nicepay_provider_support_20261016.sql')))).rows[0];
    assert.ok(Object.values(v1).every(x => x === true), JSON.stringify(v1));
    await db.exec(cosRollback); await db.exec(supportRollback); await db.exec(refundRollback);
    const after = { ...(await snapshotDefs(db)), cos: await defOf(db, sigCos) };
    for (const k of ['helper', 'fulfill', 'settlement', 'cos']) assert.equal(after[k], before[k], `${k} 원문 복원`);
    assert.equal(after.trigger.replace(/\s+/g, ' '), before.trigger.replace(/\s+/g, ' '));
    assert.equal(after.core.replace(/\s+/g, ' '), before.core.replace(/\s+/g, ' '), 'core(환불 수정 롤백 포함) 공백 무관 동일');
  } finally { await db.close(); }
  // 순서 독립: 이번 환불 패치는 현재 정의를 제자리 패치하므로 support 뒤에 적용해도 NICEPAY 취소 확인 가드가 지워지지 않는다(이전의 함수 통째 교체 방식과의 차이)
  const swapped = await world({ supportApplied: true, refundFixApplied: false });
  try {
    await swapped.exec(refundFix); await swapped.exec(serverFix); await swapped.exec(amountFix);
    const v = (await swapped.query(stripComments(read('verify_add_nicepay_provider_support_20261016.sql')))).rows[0];
    assert.equal(v.refund_core_requires_pg_cancel_must_be_true, true);
    const v2 = (await swapped.query(stripComments(read('verify_fix_refund_pg_origin_guard_20261017.sql')))).rows[0];
    assert.ok(Object.values(v2).every(x => x === true), JSON.stringify(v2));
    const [a1, a2] = [await defOf(swapped, SIGS.core), null];
    await swapped.exec(refundFix);   // 멱등
    assert.equal(await defOf(swapped, SIGS.core), a1);
    const fwd = await world();       // 정순서 결과와 동일한 최종 정의
    try {
      const b1 = await defOf(fwd, SIGS.core);
      const base = d => ['nicepay_pg_cancel_guard', 'pg_unknown_origin_guard', 'pg_server_path_guard', 'pg_refund_amount'].reduce(stripBlock, d);
      assert.equal(base(b1), base(a1), '순서가 달라도 가드 블록을 뺀 나머지 정의는 같다');
      for (const d of [a1, b1]) for (const m of ['nicepay_pg_cancel_guard', 'pg_unknown_origin_guard', 'pg_server_path_guard', 'pg_refund_amount']) assert.equal((d.match(new RegExp(`-- ${m} begin`, 'g')) ?? []).length, 1, `${m} 블록은 정확히 1개`);
    } finally { await fwd.close(); }
  } finally { await swapped.close(); }
});

test('V. 정적 SQL 검토: 모든 새 함수가 SECURITY DEFINER + search_path 고정 + 클라이언트 권한 회수, 롤백은 DROP TABLE을 데이터 보호 가드 뒤에서만, DELETE/TRUNCATE 없음', async () => {
  const code = stripComments(support);
  const defs = [...code.matchAll(/create or replace function (\w+)\(([\s\S]*?)\)\s*returns[\s\S]*?\$\$;/g)];
  assert.equal(defs.length, 15, `새/교체 함수 정의 수 ${defs.length}`);
  for (const m of defs) {
    assert.match(m[0], /security definer/i, `${m[1]} SECURITY DEFINER`);
    assert.match(m[0], /set search_path = public/i, `${m[1]} search_path 고정`);
    assert.match(code, new RegExp(`revoke all on function ${m[1]}\\([^)]*\\) from public, anon, authenticated;`), `${m[1]} 클라이언트 권한 회수`);
  }
  assert.doesNotMatch(code, /\b(truncate|drop\s+table|delete\s+from)\b/i, '지원 SQL에는 데이터 삭제 구문이 없다');
  assert.doesNotMatch(code, /grant\s+[^;]*\bto\s+(anon|authenticated|public)\b/i, '클라이언트 롤에 권한 부여 없음');
  const rb = stripComments(supportRollback);
  assert.ok(rb.indexOf('raise exception') < rb.indexOf('drop table'), '롤백의 데이터 보호 가드가 DROP TABLE보다 앞');
  assert.match(code, /begin;[\s\S]*commit;\s*$/, '단일 트랜잭션');
  assert.match(stripComments(cosFix), /begin;[\s\S]*commit;\s*$/);
  // SECURITY DEFINER 안에서 호출자 입력으로 동적 SQL을 만들지 않는다
  assert.equal((code.match(/(?<!grant\s)\bexecute\b(?!\s+function)/gi) ?? []).length, (code.match(/execute v_def;|execute regexp_replace\([^;]*;/g) ?? []).length, 'execute는 pg_get_functiondef 제자리 패치 4+1곳뿐(호출자 입력 동적 SQL 없음)');
});

// ================================================================ 동시성: release와 승인 기록 저장 ====
// PGlite는 단일 세션이라 두 트랜잭션의 실제 인터리빙은 재현할 수 없다. 대신 (1) 경합을 막는 핵심 불변식 — "승인·취소 기록을 읽는 모든 함수는 주문 행을 먼저 FOR UPDATE로 잠근다" —
// 을 함수 정의에서 기계적으로 검사하고(구 구현은 이 검사에 걸림), (2) 잠금 후 재검증·같은 트랜잭션 재확인의 결과를 행동으로 검증한다. 실제 2세션 절차는 docs/payments/NICEPAY_DB_SAFETY_DESIGN_20261016.md §11.
const lockOrderFirst = def => {
  const full = def.replace(/--[^\n]*/g, '');
  const body = full.slice(Math.max(0, full.search(/\bbegin\b/i)));   // declare 절의 타입 선언(r nicepay_pg_cancels)은 읽기가 아니므로 제외
  const lock = body.search(/for\s+update/i);
  const refs = ['nicepay_pg_approvals', 'nicepay_pg_cancels'].map(t => body.indexOf(t)).filter(i => i >= 0);
  return lock >= 0 && refs.length > 0 && lock < Math.min(...refs);
};
const OLD_RELEASE_DEF = `create or replace function nicepay_release_order(p_order_id uuid, p_claim_id uuid, p_basis text) returns boolean language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if exists (select 1 from nicepay_pg_approvals a where a.order_id = p_order_id and a.claim_id = p_claim_id and not exists (select 1 from nicepay_pg_cancels c where c.order_id = a.order_id and c.pg_tid = a.tid)) then return false; end if;
  update orders set status = 'pending' where id = p_order_id and status = 'approving' and pg_claim_id = p_claim_id;
  get diagnostics v_n = row_count; return v_n = 1;
end; $$;`;

test('X1. 잠금 순서 불변식: 승인·취소 기록을 읽는 모든 NICEPAY 함수는 주문 행 FOR UPDATE가 기록 조회보다 앞 (구 release 구현은 위반)', async () => {
  const db = await world();
  try {
    const fns = ['nicepay_release_order(uuid,uuid,text)', 'nicepay_resolve_review(uuid,text,text,text,text,text,text)', 'confirm_nicepay_payment(uuid,uuid,text,integer)',
      'nicepay_confirm_reviewed(uuid,text,integer,text,text,text,text)', 'nicepay_record_pg_cancel(uuid,text,text,integer,text,text,text,text)', 'nicepay_record_verified_approval(uuid,uuid,text,integer,text)'];
    for (const f of fns) assert.equal(lockOrderFirst(await defOf(db, `public.${f}`)), true, `${f}: 주문 행 잠금이 기록 조회보다 먼저`);
    assert.equal(lockOrderFirst(OLD_RELEASE_DEF), false, '구 구현(조회 → 갱신)은 검사에 걸린다(경합 창 존재)');
    // 잠금 대상은 orders 행이어야 한다(다른 테이블 FOR UPDATE로 대체 불가)
    const rel = (await defOf(db, 'public.nicepay_release_order(uuid,uuid,text)')).replace(/--[^\n]*/g, '');
    assert.match(rel, /from orders where id = p_order_id for update/i);
    // 적용 후 verify의 해당 검사도 true
    const v = (await db.query(stripComments(read('verify_add_nicepay_provider_support_20261016.sql')))).rows[0];
    assert.equal(v.release_locks_order_before_reading_approvals_must_be_true, true);
  } finally { await db.close(); }
});

test('X2. release: 잠금 후 claim/status 재검증 + 같은 트랜잭션에서 승인·취소 기록 재확인 — 승인 기록 저장 직후(같은 트랜잭션/직전 커밋)에는 항상 거부', async () => {
  const db = await world();
  try {
    const rel = (oid, cl, basis = 'netcancel_confirmed') => q1(db, `select nicepay_release_order('${oid}', '${cl}', '${basis}') r`);
    const o = await mkOrder(db, 'nicepay'); const c = await claim(db, o);
    // 같은 트랜잭션 안에서 승인 기록 저장 → release: 방금 쓴 기록이 보여 거부(구 구현의 "조회 → 갱신" 사이에 끼어든 승인 기록을 놓치는 문제가 없다)
    await db.exec('begin');
    await approve(db, o, c, 'TID-X1', 10000);
    assert.equal((await rel(o, c)).r, false);
    await db.exec('commit');
    assert.deepEqual(await q1(db, `select status, pg_claim_id = '${c}' same from orders where id='${o}'`), { status: 'approving', same: true });
    assert.equal(await count(db, 'nicepay_review_actions', `order_id='${o}' and action='release'`), 0, '거부된 release는 감사 행/상태 변경 없음');
    // 커밋 이후에도 동일, 취소 확인 기록 뒤에는 복귀 가능
    assert.equal((await rel(o, c)).r, false);
    await db.query(`select nicepay_record_pg_cancel('${o}', 'TID-X1', 'NC-X1-0001', 10000, 'api_response', 'system', null, '${DIG}')`);
    assert.equal((await rel(o, c)).r, true);
    assert.equal(await count(db, 'nicepay_review_actions', `order_id='${o}' and action='release'`), 1);
    // 잠금 후 재검증: 존재하지 않는 주문 / 이미 풀린 주문(상태 pending) / 다른 claim / 다른 provider / 완료 주문 / 검토 대기 / 거래번호 기록됨 → 전부 false(예외 없음)
    assert.equal((await rel(id(9, 9), c)).r, false);
    assert.equal((await rel(o, c)).r, false, '이미 pending');
    const c2 = await claim(db, o);
    assert.equal((await rel(o, c)).r, false, '이전 claim');
    for (const p of ['toss', 'mock', null]) assert.equal((await rel(await mkOrder(db, p), c2)).r, false, `${p}`);
    const dn = await mkOrder(db, 'nicepay'); const cd = await claim(db, dn); await approve(db, dn, cd, 'TID-X2', 10000); await db.query(`select confirm_nicepay_payment('${dn}', '${cd}', 'TID-X2', 10000)`);
    assert.equal((await rel(dn, cd)).r, false, '완료 주문');
    const rv = await mkOrder(db, 'nicepay'); const cr = await claim(db, rv); await db.query(`select nicepay_mark_review('${rv}', '${cr}', 'stale_claim')`);
    assert.equal((await rel(rv, cr)).r, false, '검토 대기');
    // 이전 선점(c)의 승인 기록은 새 선점(c2)의 release를 막지 않는다(선점별 판단), 새 선점에 승인 기록이 생기면 막는다
    assert.equal((await rel(o, c2)).r, true);
    const c3 = await claim(db, o); await approve(db, o, c3, 'TID-X3', 10000);
    assert.equal((await rel(o, c3)).r, false);
    assert.equal((await rel(o, c3, 'approve_rejected')).r, false, '근거 종류와 무관하게 거부');
    await rejects(db.query(`select nicepay_release_order('${o}', '${c3}', 'because')`), /복귀 근거/);
  } finally { await db.close(); }
});

test('X3. 승인 기록 저장도 같은 잠금 순서: release가 먼저 끝났다면 승인 기록 저장은 선점 불일치로 거부(경합의 반대 방향도 안전)', async () => {
  const db = await world();
  try {
    const o = await mkOrder(db, 'nicepay'); const c = await claim(db, o);
    assert.equal((await q1(db, `select nicepay_release_order('${o}', '${c}', 'approve_rejected') r`)).r, true);   // 승인 기록 없음 → 복귀
    await rejects(approve(db, o, c, 'TID-X4', 10000), /승인 선점이 일치하지 않아요/);                            // 풀린 선점으로는 승인 기록 불가
    assert.equal(await count(db, 'nicepay_pg_approvals', `order_id='${o}'`), 0);
    assert.equal((await q1(db, `select status from orders where id='${o}'`)).status, 'pending');
    // 기존 로직 유지: 정상 승인 흐름과 Toss 확정은 영향 없음
    const c2 = await claim(db, o); await approve(db, o, c2, 'TID-X5', 10000); await db.query(`select confirm_nicepay_payment('${o}', '${c2}', 'TID-X5', 10000)`);
    assert.equal((await q1(db, `select status from orders where id='${o}'`)).status, 'done');
    const t = await mkOrder(db, 'toss', { amount: 5000 }); assert.equal((await q1(db, `select confirm_real_payment('${t}', 'pk', 5000) r`)).r.already_done, false);
  } finally { await db.close(); }
});

// ================================================================ 결제 기록 정합성: order_id 연결 없는 PG 결제의 일반 환불 우회 ====
// 운영 실측: Toss 완료 주문 3건 / 연결된 결제 기록 2건 / 32만 원 주문 1건은 payments.order_id 없음 / 같은 회원·센터·상품의 수강권·환불 기록 존재.
const memOf = async (db, oid) => (await q1(db, `select membership_id m from payments where order_id='${oid}'`)).m;
async function prodLike(db, { pgKeyOnUnlinked = true } = {}) {
  const linked = [];
  for (const amt of [100000, 200000]) { const o = await mkOrder(db, 'toss', { amount: amt }); await db.query(`select confirm_real_payment('${o}', 'pk_${amt}', ${amt})`); linked.push({ oid: o, mid: await memOf(db, o), amt }); }
  // 32만 원 Toss 완료 주문: 결제 행이 order_id 없이 존재
  const orphan = await mkOrder(db, 'toss', { amount: 320000, status: 'done' });
  const m3 = id(6, 3200);
  await db.exec(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ('${m3}','${P1}','${C1}','${PROD}','p',10,10);
    insert into payments(center_id, profile_id, membership_id, order_id, sale_type, total_amount, pg_transaction_id, paid_at, status) values ('${C1}','${P1}','${m3}',null,'new',320000,${pgKeyOnUnlinked ? "'tosskey_320k'" : 'null'},now(),'paid');`);
  // 같은 회원·센터·상품의 과거 수강권 + 환불 기록
  const m0 = id(6, 3199);
  await db.exec(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count, status) values ('${m0}','${P1}','${C1}','${PROD}','p',10,0,'refunded');
    insert into payments(center_id, profile_id, membership_id, sale_type, total_amount, paid_at, status) values ('${C1}','${P1}','${m0}','new',320000,now() - interval '30 days','paid'), ('${C1}','${P1}','${m0}','refund',-320000,now() - interval '29 days','paid');`);
  return { linked, orphan, m3, m0 };
}
const memberRefund = (db, mid) => asUser(db, () => db.query(`select refund_membership('${mid}') r`));

for (const pgKey of [true, false]) {
  test(`Y1. order_id 없는 Toss 결제(${pgKey ? 'pg_transaction_id 있음' : '키도 없음 — 고아 PG 주문 신호만'}): 수정 전 회원 일반 환불로 우회 가능(재현), 수정 후 차단, 서버 경로·연결된 Toss·정산·데이터는 그대로`, async () => {
    const before = await world({ supportApplied: false, refundFixApplied: false });
    try {
      const f = await prodLike(before, { pgKeyOnUnlinked: pgKey });
      const r = await memberRefund(before, f.m3);
      assert.equal(r.rows[0].r.refunded, true, '수정 전: 연결 없는 PG 결제 건이 PG 취소 없이 DB에서만 환불된다(우회)');
    } finally { await before.close(); }

    const db = await world({ supportApplied: false, refundFixApplied: false });
    try {
      const f = await prodLike(db, { pgKeyOnUnlinked: pgKey });
      const snap = async () => JSON.stringify([(await db.query(`select * from orders order by id`)).rows, (await db.query(`select * from payments order by id`)).rows, (await db.query(`select * from memberships order by id`)).rows]);
      const dataBefore = await snap();
      await db.exec(refundFix);
      assert.equal(await snap(), dataBefore, '패치는 데이터를 1바이트도 바꾸지 않는다(자동 연결·백필 없음)');
      assert.equal(await count(db, 'payments', `membership_id='${f.m3}' and order_id is null and total_amount = 320000`), 1, '32만 원 결제의 order_id는 NULL 그대로');
      // 차단: 회원 일반 환불
      await rejects(memberRefund(db, f.m3), /PG 결제 출처를 확인할 수 없는 수강권/);
      assert.equal((await q1(db, `select status from memberships where id='${f.m3}'`)).status, 'active');
      assert.equal(await count(db, 'payments', `membership_id='${f.m3}' and sale_type='refund'`), 0);
      // 연결된 Toss 2건도 일반 환불 차단(기존), 서버 경로(allow_pg=true)는 둘 다 가능(운영자/서버가 PG 취소 후 마무리)
      for (const l of f.linked) await rejects(memberRefund(db, l.mid), /환불 요청 기능/);
      assert.deepEqual((await db.query(`select refund_membership_server('${f.m3}','${AUTH}', true, false) r`)).rows[0].r, { refunded: true, amount: 320000 });
      assert.equal((await db.query(`select refund_membership_server('${f.linked[0].mid}','${AUTH}', true, false) r`)).rows[0].r.refunded, true);
      // 정산 호환: 기존 payments 행(provider NULL)은 정산 대상이 아니던 기존 동작 그대로, 패치로 변하지 않음
      await db.exec(`select set_config('app.platform_admin','on',false)`);
      const sum = await q1(db, `select coalesce(sum(total_amount),0)::int t from admin_center_settlement_summary(current_date - 1, current_date + 1)`);
      assert.equal(sum.t, 0, '기존 동작과 동일(정산은 payments.payment_provider 기준 — 이 패치는 건드리지 않음)');
    } finally { await db.close(); }
  });
}

test('Y2. 정상 직접결제·Mock·수기 결제 환불은 유지, 연결 없는 PG 주문과 무관한 수강권(다른 상품/회원)도 유지', async () => {
  const db = await world();
  try {
    // 고아 PG 주문이 있는 상황(다른 상품 ↔ 같은 상품)
    const PROD2 = id(4, 2); await db.exec(`insert into products(id, center_id, name) values ('${PROD2}', '${C1}', 'p2')`);
    const orphan = await mkOrder(db, 'toss', { amount: 77000, status: 'done' });   // PROD(상품 1)의 고아 PG 완료 주문
    const mk = async (provider, { product = PROD, key } = {}) => {
      const oid = id(5, Math.floor(Math.random() * 1e9)); const mid = id(6, Math.floor(Math.random() * 1e9));
      await db.exec(`insert into orders(id, profile_id, center_id, product_id, product_name, amount, status, payment_provider) values ('${oid}','${P1}','${C1}','${product}','p',10000,'done',${provider ? `'${provider}'` : 'null'});
        insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ('${mid}','${P1}','${C1}','${product}','p',10,10);
        insert into payments(center_id, profile_id, membership_id, order_id, sale_type, total_amount, pg_transaction_id, paid_at, status) values ('${C1}','${P1}','${mid}','${oid}','new',10000,${key ? `'${key}'` : 'null'},now(),'paid');`);
      return mid;
    };
    // 같은 상품 수강권은 고아 PG 주문 때문에 보수적으로 차단, 다른 상품은 정상 환불
    await rejects(memberRefund(db, await mk(null)), /PG 결제 출처를 확인할 수 없는 수강권/);
    await rejects(memberRefund(db, await mk('mock', { key: 'mock_x1' })), /PG 결제 출처를 확인할 수 없는 수강권/);
    for (const [p, key] of [[null, null], ['mock', 'mock_abc']]) assert.equal((await memberRefund(db, await mk(p, { product: PROD2, key }))).rows[0].r.refunded, true, `${p}: 다른 상품은 정상 환불`);
    // 고아 PG 주문이 없으면(= 정상 상태) 같은 상품이라도 직접결제/Mock/수기 환불 유지
    await db.exec(`delete from orders where id='${orphan}'`);
    for (const [p, key] of [[null, null], ['mock', 'mock_abc']]) assert.equal((await memberRefund(db, await mk(p, { key }))).rows[0].r.refunded, true, `${p}: 정상 환불`);
    const manual = id(6, 4242);   // 수기 입력 결제(주문·PG 키 없음)
    await db.exec(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ('${manual}','${P1}','${C1}','${PROD}','p',10,10);
      insert into payments(center_id, profile_id, membership_id, sale_type, total_amount, paid_at, status) values ('${C1}','${P1}','${manual}','new',50000,now(),'paid');`);
    assert.equal((await memberRefund(db, manual)).rows[0].r.refunded, true, '수기 결제 환불 유지');
    // 환불 행(refund)에 남은 PG 흔적은 신호가 아니다: 이미 환불된 건과 새 수강권이 섞여도 영향 없음
    const old = id(6, 4243);
    await db.exec(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ('${old}','${P1}','${C1}','${PROD}','p',10,10);
      insert into payments(center_id, profile_id, membership_id, sale_type, total_amount, pg_transaction_id, paid_at, status) values ('${C1}','${P1}','${old}','new',10000,null,now(),'paid'), ('${C1}','${P1}','${old}','refund',-1,'x_refund_key',now(),'paid');`);
    assert.equal((await memberRefund(db, old)).rows[0].r.refunded, true);
  } finally { await db.close(); }
});

test('Y3. 가장 최근 결제 행만 보던 허점: PG 결제 뒤에 order_id 없는 수기/후속 결제 행이 더 최근에 있어도, 주문 삭제로 order_id가 NULL이 돼도 일반 환불 차단', async () => {
  const before = await world({ supportApplied: false, refundFixApplied: false });
  try {
    const o = await mkOrder(before, 'toss', { amount: 9000 }); await before.query(`select confirm_real_payment('${o}', 'pk_y3', 9000)`);
    const mid = await memOf(before, o);
    await before.exec(`insert into payments(center_id, profile_id, membership_id, sale_type, total_amount, paid_at, status) values ('${C1}','${P1}','${mid}','new',1000,now() + interval '1 minute','paid');`);
    assert.equal((await memberRefund(before, mid)).rows[0].r.refunded, true, '수정 전: 후속 수기 결제 행이 최신이면 PG 가드를 건너뛴다(우회)');
  } finally { await before.close(); }
  const db = await world();
  try {
    const o = await mkOrder(db, 'toss', { amount: 9000 }); await db.query(`select confirm_real_payment('${o}', 'pk_y3', 9000)`);
    const mid = await memOf(db, o);
    await db.exec(`insert into payments(center_id, profile_id, membership_id, sale_type, total_amount, paid_at, status) values ('${C1}','${P1}','${mid}','new',1000,now() + interval '1 minute','paid');`);
    await rejects(memberRefund(db, mid), /환불 요청 기능|PG 결제 출처를 확인할 수 없는 수강권/);
    // 주문 연결이 SET NULL 로 끊긴 경우(pg_transaction_id는 남음)
    const o2 = await mkOrder(db, 'toss', { amount: 8000 }); await db.query(`select confirm_real_payment('${o2}', 'pk_y3b', 8000)`);
    const mid2 = await memOf(db, o2);
    await db.exec(`update payments set order_id = null where membership_id = '${mid2}'`);
    await db.exec(`update orders set status = 'done' where id = '${o2}'`);
    await rejects(memberRefund(db, mid2), /PG 결제 출처를 확인할 수 없는 수강권/);
    await rejects(db.query(`select refund_membership_server('${mid2}','${AUTH}', true, false)`), /pg_refund_begin/);   // 출처 불명확 PG 결제는 서버 경로도 환불 진행 표시 필요(fail-closed)
    assert.equal((await db.query(`select pg_refund_begin('${mid2}','${AUTH}') r`)).rows[0].r.state, 'locked');
    assert.equal((await db.query(`select refund_membership_server('${mid2}','${AUTH}', true, false) r`)).rows[0].r.refunded, true, '운영자가 begin → PG 취소 확인 → 서버 경로로 마무리하는 흐름은 가능');
  } finally { await db.close(); }
});

test('Y4. 롤백은 현재 정의 위에서 패치만 제거: 환불 core를 원문 그대로 복원(사이에 다른 패치가 있어도 보존), 패치는 멱등', async () => {
  for (const opts of [{}, { crlf: true }]) {
    const db = await world({ supportApplied: false, refundFixApplied: false, ...opts });
    try {
      const orig = await defOf(db, SIGS.core);
      await db.exec(refundFix); await db.exec(refundFix);
      const patched = await defOf(db, SIGS.core);
      assert.equal((patched.match(/-- pg_unknown_origin_guard begin/g) ?? []).length, 1, '멱등');
      assert.ok(/\/\*was:/.test(patched) && /payment_provider is not null and o\.payment_provider <> 'mock'/.test(patched));
      await db.exec(support);   // 사이에 다른 패치(NICEPAY 취소 확인 가드)가 들어가도
      await db.exec(refundRollback);
      const after = await defOf(db, SIGS.core);
      assert.equal(stripBlock(after, 'nicepay_pg_cancel_guard'), orig, `${JSON.stringify(opts)}: 우리 패치만 제거되고 원문(옛 'toss','portone' 조건 포함)으로 복원`);
      assert.ok(/-- nicepay_pg_cancel_guard begin/.test(after), '다른 패치는 보존');
    } finally { await db.close(); }
  }
  // 예상과 다른 구조면 중단(아무것도 바뀌지 않음)
  const drift = await world({ supportApplied: false, refundFixApplied: false });
  try {
    await drift.exec(liveCore.replace("o.payment_provider in ('toss', 'portone')", "o.payment_provider in ('toss', 'portone', 'x')"));
    const before = await defOf(drift, SIGS.core);
    await rejects(drift.exec(refundFix), /PG 판별 조건이 예상과 달라요/); await drift.exec('rollback');
    assert.equal(await defOf(drift, SIGS.core), before);
  } finally { await drift.close(); }
});

// ================================================================ 서버 환불 경로 fail-closed / pg_refund_context 출처 판별 (2026-10-17) ====
const serverRefund = (db, mid, skip = false) => db.query(`select refund_membership_server('${mid}','${AUTH}', true, ${skip}) r`);
const ctxOf = async (db, mid) => (await q1(db, `select pg_refund_context('${mid}','${AUTH}') c`)).c;
// 구버전(v1) NICEPAY 취소 확인 가드 — 가장 최근 결제 행의 order_id/금액에 의존. 음성 대조용으로 현재 core에 되돌려 심는다.
async function swapGuardToV1(db) {
  const d = await defOf(db, SIGS.core);
  const noV2 = stripBlock(d, 'nicepay_pg_cancel_guard');
  const v1 = `\n    -- nicepay_pg_cancel_guard begin\n    if v_order_id is not null and v_amount > 0\n       and exists (select 1 from orders o where o.id = v_order_id and o.payment_provider = 'nicepay')\n       and not exists (select 1 from nicepay_pg_cancels c join orders o2 on o2.id = c.order_id and o2.pg_tid = c.pg_tid where c.order_id = v_order_id and c.cancel_amount = v_amount) then\n        raise exception 'NICEPAY 결제는 PG 승인 취소가 확인된 뒤에만 환불할 수 있어요';\n    end if;\n    -- nicepay_pg_cancel_guard end`;
  const out = noV2.replace(/(raise\s+exception\s+'카드\/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요'\s*;\s*end\s+if;)/, `$1${v1}`);
  assert.notEqual(out, noV2); await db.exec(out);
}

test('Z1. NICEPAY 서버 환불: 최근 결제 행의 order_id가 NULL이어도(후속 수기 결제 행 / 주문 연결 끊김) PG 취소 확인 기록 없이는 불가 — v1 가드는 우회됨(재현), v2는 차단, v1→v2 업그레이드', async () => {
  const db = await world({ amountFixApplied: false });   // 금액 패치는 v_order_id 도 바로잡아 v1 우회를 우연히 막으므로, v1 우회 재현은 금액 패치 전 상태에서

  try {
    // (1) 최근 행이 후속 수기 결제(order_id 없음)
    const n = await paidMembership(db, 'nicepay');
    await db.exec(`insert into payments(center_id, profile_id, membership_id, sale_type, total_amount, paid_at, status) values ('${C1}','${P1}','${n.mid}','new',1000,now() + interval '1 minute','paid');`);
    await swapGuardToV1(db);
    // v1: 최근 행(v_order_id null)이라 가드를 건너뛴다 → 서버 경로가 PG 취소 확인 없이 환불(우회 재현)
    const bypass = await paidMembership(db, 'nicepay');
    await db.exec(`insert into payments(center_id, profile_id, membership_id, sale_type, total_amount, paid_at, status) values ('${C1}','${P1}','${bypass.mid}','new',1000,now() + interval '1 minute','paid');`);
    assert.equal((await serverRefund(db, bypass.mid)).rows[0].r.refunded, true, 'v1 가드: 최근 행 order_id NULL이면 취소 확인 없이 환불(= 결함)');
    // 업그레이드: support 재실행이 v1 블록을 제거하고 v2로 교체
    await db.exec(support);
    const d = await defOf(db, SIGS.core);
    assert.equal((d.match(/-- nicepay_pg_cancel_guard begin/g) ?? []).length, 1); assert.ok(d.includes('begin (v2)'));
    // v2: 같은 상황 차단 → 취소 확인 기록 후 가능
    await rejects(serverRefund(db, n.mid), /NICEPAY 결제는 PG 승인 취소가 확인된 뒤에만/);
    await rejects(serverRefund(db, n.mid, true), /NICEPAY 결제는 PG 승인 취소가 확인된 뒤에만/);
    assert.equal((await q1(db, `select status from memberships where id='${n.mid}'`)).status, 'active');
    await recordCancel(db, n.oid);
    assert.equal((await serverRefund(db, n.mid)).rows[0].r.refunded, true);
    // (2) 주문 연결이 끊긴 NICEPAY 결제(payments.payment_provider·pg_transaction_id 보존)
    const u = await paidMembership(db, 'nicepay');
    await recordCancel(db, u.oid, 10000, 'CXL-Z1-U-1');   // 취소 기록은 승인 기록(주문 기준) 존재 필요 — 연결을 끊기 전에 생성하지 않고 먼저 차단 확인
  } finally { await db.close(); }
  const db2 = await world();
  try {
    const u = await paidMembership(db2, 'nicepay');
    await db2.exec(`update payments set order_id = null where membership_id = '${u.mid}'`);
    await rejects(serverRefund(db2, u.mid), /NICEPAY 결제는 PG 승인 취소가 확인된 뒤에만/);   // payments.payment_provider='nicepay' + 키로 식별
    await recordCancel(db2, u.oid, 10000, 'CXL-Z1-U-2');
    assert.equal((await serverRefund(db2, u.mid)).rows[0].r.refunded, true);
    // 0원 NICEPAY 결제는 돈 이동이 없어 취소 확인 불필요
    const z = await paidMembership(db2, 'nicepay', { amount: 0 });
    assert.equal((await serverRefund(db2, z.mid)).rows[0].r.refunded, true);
  } finally { await db2.close(); }
});

test('Z2. 출처 불명확 PG 결제(연결 없는 Toss)의 서버 경로: 환불 진행 표시(pg_refund_begin) 없이는 불가, 표시 후 가능. 연결된 Toss·직접결제·Mock·수기 서버 환불은 기존대로', async () => {
  const before = await world({ serverFixApplied: false });
  try {
    const f = await prodLike(before);
    assert.equal((await serverRefund(before, f.m3)).rows[0].r.refunded, true, '패치 전: 서버 경로(allow_pg=true) 단독 호출로 출처 불명확 PG 결제가 환불된다');
  } finally { await before.close(); }
  const db = await world();
  try {
    const f = await prodLike(db);
    await rejects(serverRefund(db, f.m3), /pg_refund_begin/);
    await rejects(serverRefund(db, f.m3, true), /pg_refund_begin/);
    assert.equal(await count(db, 'payments', `membership_id='${f.m3}' and sale_type='refund'`), 0);
    assert.equal((await q1(db, `select pg_refund_begin('${f.m3}','${AUTH}') r`)).r.state, 'locked');
    assert.deepEqual((await serverRefund(db, f.m3)).rows[0].r, { refunded: true, amount: 320000 });
    // 연결된 Toss: 기존 서버 흐름(begin → Toss 취소 → 환불)도, begin이 'blocked'였던 뒤 Toss가 이미 취소된 복구 흐름(표시 없음, skipTime)도 그대로
    for (const l of f.linked) assert.equal((await serverRefund(db, l.mid, true)).rows[0].r.refunded, true);
  } finally { await db.close(); }
  // 직접결제/Mock 서버 경로 환불 유지 (고아 PG 주문이 없는 정상 상태)
  const clean = await world();
  try {
    for (const p of [null, 'mock']) { const m = await paidMembership(clean, p); assert.equal((await serverRefund(clean, m.mid)).rows[0].r.refunded, true, `${p}`); }
  } finally { await clean.close(); }
});

test('Z3. pg_refund_context: 최근 결제 행이 아니라 PG 원거래 행 기준, 출처 불명확하면 unknown_pg, 직접결제/Mock 출력은 변하지 않는다', async () => {
  const mkBoth = async (opts) => { const d = await world({ serverFixApplied: opts.fixed }); return d; };
  const snapshotOf = async (db) => {
    const out = {};
    const direct = await paidMembership(db, null); out.direct = await ctxOf(db, direct.mid);
    const mock = await paidMembership(db, 'mock'); out.mock = await ctxOf(db, mock.mid);
    // 연결된 Toss + 후속 수기 결제(최신)
    const o = await mkOrder(db, 'toss', { amount: 9000 }); await db.query(`select confirm_real_payment('${o}', 'pk_z3', 9000)`);
    const mid = await memOf(db, o);
    await db.exec(`insert into payments(center_id, profile_id, membership_id, sale_type, total_amount, paid_at, status) values ('${C1}','${P1}','${mid}','new',1000,now() + interval '1 minute','paid');`);
    out.tossLaterManual = await ctxOf(db, mid);
    // 정상 Toss(최신 행이 PG 원거래)
    const o2 = await mkOrder(db, 'toss', { amount: 7000 }); await db.query(`select confirm_real_payment('${o2}', 'pk_z3b', 7000)`);
    out.tossPlain = await ctxOf(db, await memOf(db, o2));
    // 연결 없는 Toss(키 있음)
    const m3 = id(6, 9330);
    await db.exec(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ('${m3}','${P1}','${C1}','${PROD}','p',10,10);
      insert into payments(center_id, profile_id, membership_id, sale_type, total_amount, pg_transaction_id, paid_at, status) values ('${C1}','${P1}','${m3}','new',320000,'tosskey_z3',now(),'paid');`);
    out.unlinkedKey = await ctxOf(db, m3);
    const na = await paidMembership(db, 'nicepay'); out.nicepay = await ctxOf(db, na.mid);
    out.notMine = (await q1(db, `select pg_refund_context('${m3}','${id(3, 77)}') c`)).c;
    return out;
  };
  const before = await world({ serverFixApplied: false }), after = await world();
  try {
    const b = await snapshotOf(before), a = await snapshotOf(after);
    const pick = c => c && ({ provider: c.provider, paymentKey: c.provider === 'mock' ? '(mock)' : c.paymentKey, amount: c.amount, hasOrder: c.orderId != null });
    // 변하면 안 되는 출력: 직접결제 / Mock / 정상 Toss / 타인 수강권(null)
    for (const k of ['direct', 'mock', 'tossPlain']) assert.deepEqual({ ...pick(a[k]), orderId: undefined }, { ...pick(b[k]), orderId: undefined }, k);
    assert.equal(a.notMine, null); assert.equal(b.notMine, null);
    assert.equal(a.direct.provider, null); assert.equal(a.mock.provider, 'mock'); assert.equal(a.tossPlain.provider, 'toss');
    // 보완된 출력
    assert.deepEqual(pick(b.tossLaterManual), { provider: null, paymentKey: null, amount: 1000, hasOrder: false }, '패치 전: 후속 수기 행 때문에 직접결제로 오판(결제키·금액도 수기 행 것)');
    assert.deepEqual(pick(a.tossLaterManual), { provider: 'toss', paymentKey: 'pk_z3', amount: 9000, hasOrder: true }, '패치 후: PG 원거래 기준');
    assert.deepEqual(pick(b.unlinkedKey), { provider: null, paymentKey: 'tosskey_z3', amount: 320000, hasOrder: false });
    assert.deepEqual(pick(a.unlinkedKey), { provider: 'unknown_pg', paymentKey: 'tosskey_z3', amount: 320000, hasOrder: false }, '출처 불명확 → unknown_pg (앱 서버는 금액>0 환불을 501로 거부)');
    assert.equal(b.nicepay.provider, 'nicepay'); assert.equal(a.nicepay.provider, 'nicepay');
  } finally { await before.close(); await after.close(); }
  // 연결 없고 키도 없지만 같은 회원·센터·상품의 고아 PG 주문만 있는 경우
  const db = await world();
  try {
    await mkOrder(db, 'toss', { amount: 55000, status: 'done' });
    const m = id(6, 9331);
    await db.exec(`insert into memberships(id, profile_id, center_id, product_id, product_name, total_count, remaining_count) values ('${m}','${P1}','${C1}','${PROD}','p',10,10);
      insert into payments(center_id, profile_id, membership_id, sale_type, total_amount, paid_at, status) values ('${C1}','${P1}','${m}','new',55000,now(),'paid');`);
    assert.equal((await ctxOf(db, m)).provider, 'unknown_pg');
  } finally { await db.close(); }
});

for (const opts of [{}, { crlf: true }]) {
  test(`Z4. 서버 경로/컨텍스트 패치 [${JSON.stringify(opts)}]: 멱등, 롤백은 원문 그대로 복원, 선행 패치가 없으면 중단, 구조가 다르면 중단, verify 전부 true`, async () => {
    const db = await world({ supportApplied: false, serverFixApplied: false, ...opts });
    try {
      const orig = { core: await defOf(db, SIGS.core), ctx: await defOf(db, 'public.pg_refund_context(uuid,uuid)') };
      await db.exec(serverFix); await db.exec(serverFix);
      const patched = { core: await defOf(db, SIGS.core), ctx: await defOf(db, 'public.pg_refund_context(uuid,uuid)') };
      assert.equal((patched.core.match(/-- pg_server_path_guard begin/g) ?? []).length, 1); assert.equal((patched.ctx.match(/-- pg_origin_context begin/g) ?? []).length, 1);
      const v = (await db.query(stripComments(read('verify_fix_refund_server_path_fail_closed_20261017.sql')))).rows[0];
      assert.ok(Object.values(v).every(x => x === true), JSON.stringify(v));
      await db.exec(serverRollback);
      assert.equal(await defOf(db, SIGS.core), orig.core, 'core 원문 복원'); assert.equal(await defOf(db, 'public.pg_refund_context(uuid,uuid)'), orig.ctx, 'context 원문 복원');
    } finally { await db.close(); }
  });
}

test('Z5. 서버 경로 패치 안전장치: 출처 가드 선행 없으면 중단, context 구조가 다르면 전체 중단(core도 안 바뀜)', async () => {
  const noPrereq = await world({ refundFixApplied: false, supportApplied: false, serverFixApplied: false });
  try {
    const before = await defOf(noPrereq, SIGS.core);
    await rejects(noPrereq.exec(serverFix), /먼저 적용하세요/); await noPrereq.exec('rollback');
    assert.equal(await defOf(noPrereq, SIGS.core), before);
  } finally { await noPrereq.close(); }
  const drift = await world({ supportApplied: false, serverFixApplied: false });
  try {
    const dctx = liveRefundContext.replace(/if v_pay\.order_id is not null then[\s\S]*?end if;/, '');
    await drift.exec(dctx.replace(/revoke all[\s\S]*$/, '').replace(/grant execute[\s\S]*$/, ''));
    const core0 = await defOf(drift, SIGS.core);
    await rejects(drift.exec(serverFix), /pg_refund_context 정의가 예상과 달라요/); await drift.exec('rollback');
    assert.equal(await defOf(drift, SIGS.core), core0, '트랜잭션 전체 롤백 — core도 그대로');
  } finally { await drift.close(); }
});

// ---------------------------------------------------------------- 환불 금액 정합성(Y) ----
const addRow = (db, mid, { oid = null, type = 'new', amount, at = '0 minute', key = null, provider = null }) =>
  db.exec(`insert into payments(center_id, profile_id, membership_id, order_id, sale_type, total_amount, pg_transaction_id, paid_at, status, payment_provider)
           values ('${C1}','${P1}','${mid}',${oid ? `'${oid}'` : 'null'},'${type}',${amount},${key ? `'${key}'` : 'null'},now() + interval '${at}','paid',${provider ? `'${provider}'` : 'null'})`);
const refundRows = async (db, mid) => (await db.query(`select total_amount a, order_id from payments where membership_id='${mid}' and sale_type='refund'`)).rows;

test('Y1. NICEPAY 원거래 뒤 후속 수기 결제가 있어도 내부 환불 금액 = PG 원거래 금액 = 취소 확인 금액 (패치 전에는 후속 행 금액으로 어긋난다)', async () => {
  for (const [fixed, expected] of [[false, 5000], [true, 30000]]) {
    const db = await world({ amountFixApplied: fixed });
    try {
      const n = await paidMembership(db, 'nicepay', { amount: 30000 });
      await addRow(db, n.mid, { amount: 5000, at: '1 minute' });          // 후속 수기 결제(order_id NULL, 최신 행)
      await recordCancel(db, n.oid, 30000, 'CXL-Y1-' + fixed);
      assert.equal((await serverRefund(db, n.mid)).rows[0].r.amount, expected, fixed ? '패치 후: PG 원거래 금액' : '패치 전: 후속 행 금액(어긋남 재현)');
      assert.deepEqual((await refundRows(db, n.mid)).map(r => r.a), [-expected]);
      if (fixed) { const c = await q1(db, `select cancel_amount from nicepay_pg_cancels where order_id='${n.oid}'`); assert.equal(-(await refundRows(db, n.mid))[0].a, c.cancel_amount, '환불 기록 = 취소 확인 기록'); }
    } finally { await db.close(); }
  }
});

test('Y2. 최신 행의 order_id 가 NULL/다른 주문이어도 쿠폰·포인트 복원은 PG 원거래 주문 기준, 수기 후속 행 여러 개·최신 행 순서 변화에도 동일', async () => {
  const db = await world();
  try {
    for (const p of ['toss', 'nicepay']) {
      const n = await paidMembership(db, p, { amount: 12000 });
      await addRow(db, n.mid, { amount: 700, at: '1 minute' });
      await addRow(db, n.mid, { amount: 300, at: '2 minute' });
      if (p === 'nicepay') await recordCancel(db, n.oid, 12000, 'CXL-Y2');
      else await db.query(`select pg_refund_begin('${n.mid}','${AUTH}')`);
      assert.equal((await serverRefund(db, n.mid)).rows[0].r.amount, 12000, p);
      assert.equal(await count(db, 'restored_points', `order_id='${n.oid}'`), 1, `${p}: 포인트 복원은 원거래 주문`);
      assert.equal(await count(db, 'restored_points', `order_id is null`), 0);
    }
  } finally { await db.close(); }
});

test('Y3. PG 원거래가 2개 이상이거나 이미 환불 행이 있는 PG 수강권은 환불 금액을 확정할 수 없어 거부 + 컨텍스트는 unknown_pg (직접결제·Mock 은 영향 없음)', async () => {
  const db = await world();
  try {
    for (const p of ['toss', 'nicepay']) {
      const two = await paidMembership(db, p, { amount: 10000 });
      const o2 = await mkOrder(db, p, { amount: 4000, status: 'done' });
      await addRow(db, two.mid, { oid: o2, amount: 4000, at: '1 minute', key: 'tid2-' + two.mid.slice(-5), provider: p === 'nicepay' ? 'nicepay' : null });
      assert.equal((await ctxOf(db, two.mid)).provider, 'unknown_pg', `${p}: 원거래 2개 → 앱이 PG 취소 호출 전에 거부`);
      if (p === 'toss') await db.query(`select pg_refund_begin('${two.mid}','${AUTH}')`);
      await rejects(serverRefund(db, two.mid), /여러 개인 수강권/);
      assert.equal((await q1(db, `select status from memberships where id='${two.mid}'`)).status, 'active');
      const prev = await paidMembership(db, p, { amount: 10000 });
      await addRow(db, prev.mid, { type: 'refund', amount: -3000, at: '1 minute' });
      assert.equal((await ctxOf(db, prev.mid)).provider, 'unknown_pg', `${p}: 이미 환불 행`);
      if (p === 'toss') await db.query(`select pg_refund_begin('${prev.mid}','${AUTH}')`);
      await rejects(serverRefund(db, prev.mid), /이미 환불 기록이 있는 PG/);
    }
    // 직접결제/Mock: 가장 최근 행 금액 계산 그대로 (패치 전과 동일), 복수 행도 허용
    for (const p of [null, 'mock']) {
      const m = await paidMembership(db, p, { amount: 8000 });
      await addRow(db, m.mid, { amount: 2000, at: '1 minute' });
      assert.equal((await serverRefund(db, m.mid)).rows[0].r.amount, 2000, `${p}: 기존 계산 유지`);
    }
  } finally { await db.close(); }
});

test('Y4. 정상 Toss/PortOne(원거래 1건)·회원 직접결제·Mock 환불은 패치 전후 동일 결과(금액·행·쿠폰 복원)', async () => {
  const run = async (fixed) => {
    const db = await world({ amountFixApplied: fixed });
    try {
      const out = {};
      for (const p of ['toss', 'portone']) {
        const o = await mkOrder(db, p, { amount: 9000 }); await db.query(`select confirm_real_payment('${o}', 'pk_${p}', 9000)`);
        const mid = await memOf(db, o);
        await db.query(`select pg_refund_begin('${mid}','${AUTH}')`);
        out[p] = [(await serverRefund(db, mid)).rows[0].r, (await refundRows(db, mid)).map(r => r.a), await count(db, 'restored_points', `order_id='${o}'`)];
      }
      for (const p of [null, 'mock']) { const m = await paidMembership(db, p, { amount: 6000 }); out[String(p)] = [(await asUser(db, () => db.query(`select refund_membership('${m.mid}') r`))).rows[0].r, (await refundRows(db, m.mid)).map(r => r.a)]; }
      return out;
    } finally { await db.close(); }
  };
  assert.deepEqual(await run(true), await run(false));
});

test('Y5. 금액 패치: 멱등, 롤백은 원문 그대로 복원, 선행 패치 없으면 중단, 구조 불일치면 전체 중단, verify true, 서버 경로 롤백만 해도 깨지지 않음', async () => {
  for (const opts of [{}, { crlf: true }]) {
    const db = await world({ amountFixApplied: false, ...opts });
    try {
      const orig = { core: await defOf(db, SIGS.core), ctx: await defOf(db, 'public.pg_refund_context(uuid,uuid)') };
      await db.exec(amountFix); await db.exec(amountFix);
      const patched = { core: await defOf(db, SIGS.core), ctx: await defOf(db, 'public.pg_refund_context(uuid,uuid)') };
      assert.equal((patched.core.match(/-- pg_refund_amount begin/g) ?? []).length, 1); assert.equal((patched.ctx.match(/-- pg_origin_ambiguity begin/g) ?? []).length, 1);
      const vs = stripComments(read('verify_fix_refund_amount_integrity_20261017.sql')).split(/;\s*\n\s*select m\.id/)[0];
      const v = (await db.query(vs)).rows[0];
      assert.ok(Object.values(v).every(x => x === true), JSON.stringify(v));
      await db.exec(amountRollback);
      assert.equal(await defOf(db, SIGS.core), orig.core, 'core 원문 복원'); assert.equal(await defOf(db, 'public.pg_refund_context(uuid,uuid)'), orig.ctx, 'context 원문 복원');
    } finally { await db.close(); }
  }
  const noPrereq = await world({ serverFixApplied: false, amountFixApplied: false });
  try {
    const before = await defOf(noPrereq, SIGS.core);
    await rejects(noPrereq.exec(amountFix), /먼저 적용하세요/); await noPrereq.exec('rollback');
    assert.equal(await defOf(noPrereq, SIGS.core), before);
  } finally { await noPrereq.close(); }
  const drift = await world({ amountFixApplied: false });
  try {
    const core0 = await defOf(drift, SIGS.core);
    await drift.exec(`create or replace function public.pg_refund_context(p_membership_id uuid, p_auth_uid uuid) returns json language plpgsql stable security definer set search_path = public as $$ begin return null; end $$;`);
    await rejects(drift.exec(amountFix), /fix_refund_server_path_fail_closed 패치가 없어요/); await drift.exec('rollback');
    assert.equal(await defOf(drift, SIGS.core), core0, '트랜잭션 전체 롤백 — core도 그대로');
  } finally { await drift.close(); }
});

// ---------------------------------------------------------------- orders_guard_pg_state 우회 경계(Y6) ----
test('Y6. orders_guard_pg_state: auth.uid() 가 NULL 이어도 anon/authenticated 롤은 서버 전용 상태를 못 바꾼다(RLS가 열려 있다고 가정해도). service_role·소유자 세션은 통과', async () => {
  const db = await world();
  try {
    const oid = await mkOrder(db, 'nicepay');
    await db.exec(`grant select, insert, update on orders to anon, authenticated, service_role;`);
    const attempts = [
      `update orders set pg_tid = 'HACK-1' where id = '${oid}'`,
      `update orders set pg_claim_id = gen_random_uuid() where id = '${oid}'`,
      `update orders set pg_review_reason = 'stale_claim', pg_review_at = now() where id = '${oid}'`,
      `update orders set payment_provider = 'toss' where id = '${oid}'`,
      `update orders set status = 'approving' where id = '${oid}'`,
    ];
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      try {
        for (const a of attempts) await rejects(db.exec(a), /서버에서만|바꿀 수 없어요|서버 승인 처리로만/);
        // INSERT 로 서버 전용 컬럼 심기: 값이 지워지고 approving 은 pending 으로
        const nid = id(5, 777000 + (role === 'anon' ? 1 : 2));
        await db.exec(`insert into orders(id, profile_id, center_id, product_id, product_name, amount, status, payment_provider, pg_tid, pg_claim_id, pg_review_reason)
                       values ('${nid}','${P1}','${C1}','${PROD}','p',100,'approving','toss','HACK-2',gen_random_uuid(),'stale_claim')`).catch(() => {});
      } finally { await db.exec('reset role'); }
      const planted = await db.query(`select pg_tid, pg_claim_id, pg_review_reason, status from orders where id = '${id(5, 777000 + (role === 'anon' ? 1 : 2))}'`);
      for (const r of planted.rows) { assert.equal(r.pg_tid, null); assert.equal(r.pg_claim_id, null); assert.equal(r.pg_review_reason, null); assert.notEqual(r.status, 'approving'); }
    }
    const o = await q1(db, `select pg_tid, pg_claim_id, pg_review_reason, payment_provider, status from orders where id='${oid}'`);
    assert.deepEqual(o, { pg_tid: null, pg_claim_id: null, pg_review_reason: null, payment_provider: 'nicepay', status: 'pending' }, '원본 주문 불변');
    // 서버 롤: service_role 및 롤 미설정 소유자 세션은 NICEPAY RPC 경로로 정상 동작(claim)
    await db.exec(`set role service_role`);
    try { assert.ok(await claim(db, oid), 'service_role: claim 성공'); } finally { await db.exec('reset role'); }
    assert.equal((await q1(db, `select status from orders where id='${oid}'`)).status, 'approving');
    // 로그인 사용자(auth.uid 있음)는 기존대로 차단
    await asUser(db, async () => { await db.exec('set role authenticated'); try { await rejects(db.exec(`update orders set pg_tid='x' where id='${oid}'`), /서버에서만/); } finally { await db.exec('reset role'); } });
  } finally { await db.close(); }
});

test('Y7. 실제 RLS 정책(주문 본인/매니저 정책과 같은 형태) 아래 anon 은 NICEPAY 주문 조회·수정·생성이 모두 막힌다', async () => {
  const db = await world();
  try {
    const oid = await mkOrder(db, 'nicepay');
    await db.exec(`alter table orders enable row level security;
      create policy own_sel on orders for select using (profile_id in (select my_profile_ids()));
      create policy own_ins on orders for insert with check (profile_id in (select my_profile_ids()));
      create policy mgr_upd on orders for update using (has_permission(center_id, 'pass.payment.create') or is_platform_admin());
      grant select, insert, update on orders to anon, authenticated;
      grant select on profiles, accounts, perms to anon, authenticated;`);
    await db.exec('set role anon');
    try {
      assert.equal((await db.query(`select 1 from orders where id='${oid}'`)).rows.length, 0, 'anon 은 조회 불가');
      const u = await db.query(`update orders set pg_tid='HACK' where id='${oid}' returning id`);
      assert.equal(u.rows.length, 0, 'anon UPDATE 는 RLS 로 0행');
      await rejects(db.exec(`insert into orders(profile_id, center_id, product_id, product_name, amount, status) values ('${P1}','${C1}','${PROD}','p',100,'done')`), /row-level security/);
    } finally { await db.exec('reset role'); }
    assert.equal((await q1(db, `select pg_tid from orders where id='${oid}'`)).pg_tid, null);
  } finally { await db.close(); }
});

// ---------------------------------------------------------------- orders INSERT 롤 경계(Y8~Y9) ----
test('Y8. orders INSERT 보정: 패치 전에는 anon(uid NULL)이 서버 전용 필드를 심을 수 있다(권한·RLS가 열려 있다고 가정) → 패치 후에는 anon/authenticated 모두 보정, service_role/소유자 세션은 그대로', async () => {
  for (const [applied, anonStatus] of [[false, 'done'], [true, 'pending']]) {
    const db = await world({ roleGuardApplied: applied });
    try {
      await db.exec(`grant select, insert, update on orders to anon, authenticated, service_role;`);
      const ins = (id, extra = '') => `insert into orders(id, profile_id, center_id, product_id, product_name, amount, status, verified, paid_at${extra}) values ('${id}','${P1}','${C1}','${PROD}','p',100,'done',true,now())`;
      await db.exec('set role anon'); try { await db.exec(ins(id(5, 880001))); } finally { await db.exec('reset role'); }
      const a = await q1(db, `select status, verified, paid_at from orders where id='${id(5, 880001)}'`);
      assert.equal(a.status, anonStatus, applied ? 'anon INSERT 보정됨' : '패치 전: anon이 status=done 을 심는다(재현)');
      if (applied) { assert.equal(a.verified, false); assert.equal(a.paid_at, null); }
      // authenticated(uid 있음/없음 모두)
      for (const [n, withUid] of [[2, true], [3, false]]) {
        const run = async () => { await db.exec('set role authenticated'); try { await db.exec(ins(id(5, 880000 + n))); } finally { await db.exec('reset role'); } };
        if (withUid) await asUser(db, run); else await run();
        const r = await q1(db, `select status, verified from orders where id='${id(5, 880000 + n)}'`);
        if (applied || withUid) { assert.equal(r.status, 'pending'); assert.equal(r.verified, false); }
      }
      // 서버 작업은 그대로: service_role / 롤 미설정 소유자
      await db.exec('set role service_role'); try { await db.exec(ins(id(5, 880010))); } finally { await db.exec('reset role'); }
      await db.exec(ins(id(5, 880011)));
      for (const n of [880010, 880011]) { const r = await q1(db, `select status, verified from orders where id='${id(5, n)}'`); assert.deepEqual([r.status, r.verified], ['done', true], `서버 경로 ${n} 불변`); }
    } finally { await db.close(); }
  }
});

for (const opts of [{}, { crlf: true }]) {
  test(`Y9. orders INSERT 롤 경계 패치 [${JSON.stringify(opts)}]: 멱등, 롤백은 원문 그대로 복원`, async () => {
    const db = await world({ roleGuardApplied: false, ...opts });
    try {
      if (opts.crlf) await db.exec(toCrlf(liveForceInsert));   // 운영 정의 형태(CRLF) 재현
      const sig = 'public.orders_force_server_fields_on_insert()';
      const orig = await defOf(db, sig);
      await db.exec(roleGuardFix); await db.exec(roleGuardFix);
      const patched = await defOf(db, sig);
      assert.equal((patched.match(/insert_role_guard/g) ?? []).length, 1);
      await db.exec(roleGuardRollback);
      assert.equal(await defOf(db, sig), orig, '원문 복원(CRLF 포함)');
    } finally { await db.close(); }
  });
}

test('Y9b. orders INSERT 롤 경계 패치: RLS를 켠 월드에서 verify 전부 true, 롤백 원문 복원, 구조 불일치 시 중단', async () => {
  const db = await world({ roleGuardApplied: false });
  try {
    await db.exec('alter table orders enable row level security;');
    const sig = 'public.orders_force_server_fields_on_insert()';
    const orig = await defOf(db, sig);
    await db.exec(roleGuardFix);
    const v = (await db.query(stripComments(read('verify_fix_orders_insert_role_guard_20261017.sql')))).rows[0];
    assert.ok(Object.values(v).every(x => x === true), JSON.stringify(v));
    await db.exec(roleGuardRollback);
    assert.equal(await defOf(db, sig), orig, '원문 복원');
    await db.exec(`create or replace function public.orders_force_server_fields_on_insert() returns trigger language plpgsql security definer set search_path = public as $$ begin return new; end $$;`);
    const before = await defOf(db, sig);
    await rejects(db.exec(roleGuardFix), /예상과 달라요/); await db.exec('rollback');
    assert.equal(await defOf(db, sig), before, '중단 시 변경 없음');
  } finally { await db.close(); }
});

// ---------------------------------------------------------------- 주문 생성 DB 게이트(GT) ----
const insertNicepayAs = async (db, role, uid, id_ = id(5, Math.floor(Math.random() * 1e9))) => {
  await db.exec(`select set_config('app.uid','${uid}',false)`);
  if (role) await db.exec(`set role ${role}`);
  try {
    await db.exec(`insert into orders(id, profile_id, center_id, product_id, product_name, amount, status, verified, payment_provider) values ('${id_}','${P1}','${C1}','${PROD}','p',1000,'done',true,'nicepay')`);
  } finally { if (role) await db.exec('reset role'); await db.exec(`select set_config('app.uid','',false)`); }
  return id_;
};
const GATE_MSG = /NICEPAY 결제는 아직 사용할 수 없어요/;

test('GT1. 게이트가 꺼져 있으면(기본) 클라이언트는 NICEPAY 주문을 어떤 경로로도 못 만든다(로그인 사용자/anon/authenticated). 다른 provider·서버 생성은 그대로', async () => {
  const db = await world();
  try {
    assert.equal((await q1(db, 'select mode from nicepay_checkout_gate')).mode, 'off');
    await db.exec('grant select, insert on orders to anon, authenticated, service_role;');
    await rejects(insertNicepayAs(db, null, AUTH), GATE_MSG);             // 로그인 사용자(auth.uid 있음)
    await rejects(insertNicepayAs(db, 'authenticated', AUTH), GATE_MSG);  // PostgREST authenticated 롤
    await rejects(insertNicepayAs(db, 'authenticated', ''), GATE_MSG);    // sub 없는 authenticated
    await rejects(insertNicepayAs(db, 'anon', ''), GATE_MSG);             // anon
    assert.equal(await count(db, 'orders', "payment_provider = 'nicepay'"), 0);
    // 서버(service_role / 롤 미설정 소유자)의 생성은 막지 않는다 — 서버는 앱의 4중 잠금이 담당
    await insertNicepayAs(db, 'service_role', '');
    await insertNicepayAs(db, null, '');
    assert.equal(await count(db, 'orders', "payment_provider = 'nicepay'"), 2);
    // 기존 provider(mock/toss/portone/직접결제 NULL) 클라이언트 생성은 영향 없음
    for (const p of ['mock', 'toss', 'portone', null]) {
      await db.exec(`select set_config('app.uid','${AUTH}',false)`); await db.exec('set role authenticated');
      try { await db.exec(`insert into orders(profile_id, center_id, product_id, product_name, amount, payment_provider) values ('${P1}','${C1}','${PROD}','p',1000,${p ? `'${p}'` : 'null'})`); }
      finally { await db.exec('reset role'); await db.exec(`select set_config('app.uid','',false)`); }
    }
    assert.equal(await count(db, 'orders', "payment_provider is distinct from 'nicepay'"), 4);
  } finally { await db.close(); }
});

test('GT2. 게이트를 켜면 클라이언트 NICEPAY 주문 생성은 허용(서버 필드는 pending/verified=false로 고정), 다시 끄면 즉시 차단, 변경은 감사 기록에 남는다', async () => {
  const db = await world();
  try {
    await db.exec('grant select, insert on orders to authenticated;');
    await db.exec("update nicepay_checkout_gate set mode = 'public', updated_at = now() where id");
    const oid = await insertNicepayAs(db, 'authenticated', AUTH);
    assert.deepEqual(await q1(db, `select status, verified, payment_provider from orders where id='${oid}'`), { status: 'pending', verified: false, payment_provider: 'nicepay' });
    await db.exec("update nicepay_checkout_gate set mode = 'off' where id");
    await rejects(insertNicepayAs(db, 'authenticated', AUTH), GATE_MSG);
    assert.deepEqual((await db.query('select mode from nicepay_checkout_gate_audit order by id')).rows.map(r => r.mode), ['off', 'public', 'off']);   // 시드, 켜짐, 꺼짐
    // 이미 만들어진 주문은 게이트와 무관하게 남는다(삭제/변경 없음)
    assert.equal(await count(db, 'orders', `id='${oid}'`), 1);
  } finally { await db.close(); }
});

test('GT3. create_order_secure 류 RPC(SECURITY DEFINER): 게이트가 꺼지면 포인트 차감·쿠폰 처리까지 같은 트랜잭션으로 전부 롤백된다(NICEPAY만), 다른 provider는 정상', async () => {
  const db = await world();
  try {
    await db.exec(`create table pts(bal int); insert into pts values (100);
      create function public.cos_stub(p_provider text) returns uuid language plpgsql security definer set search_path = public as $$
      declare v uuid; begin
        update pts set bal = bal - 10;                                    -- 포인트 차감(주문 INSERT 이전 부수효과)
        insert into orders(profile_id, center_id, product_id, product_name, amount, payment_provider) values ('${P1}','${C1}','${PROD}','p',1000,p_provider) returning id into v;
        return v; end $$;
      grant execute on function public.cos_stub(text) to authenticated;
      grant usage on schema public to authenticated;`);
    const call = async (provider) => { await db.exec(`select set_config('app.uid','${AUTH}',false)`); await db.exec('set role authenticated'); try { return await db.query(`select cos_stub(${provider ? `'${provider}'` : 'null'})`); } finally { await db.exec('reset role'); await db.exec(`select set_config('app.uid','',false)`); } };
    await rejects(call('nicepay'), GATE_MSG);
    assert.equal((await q1(db, 'select bal from pts')).bal, 100, '거부된 NICEPAY 주문은 포인트 차감도 남기지 않는다');
    assert.equal(await count(db, 'orders', "payment_provider = 'nicepay'"), 0);
    await call('mock'); await call('toss'); await call(null);
    assert.equal((await q1(db, 'select bal from pts')).bal, 70);
    await db.exec("update nicepay_checkout_gate set mode = 'public' where id");
    await call('nicepay');
    assert.equal((await q1(db, 'select bal from pts')).bal, 60);
  } finally { await db.close(); }
});

test('GT4. 게이트 테이블/함수 보호: anon·authenticated는 읽기/쓰기 불가, service_role은 읽기만, 행 삭제·감사 기록 수정/삭제 불가, 재적용은 값을 보존(멱등)', async () => {
  const db = await world();
  try {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      try {
        await rejects(db.query('select * from nicepay_checkout_gate'), /permission denied/);
        await rejects(db.exec("update nicepay_checkout_gate set mode = 'public'"), /permission denied/);
        await rejects(db.query('select * from nicepay_checkout_gate_audit'), /permission denied/);
        await rejects(db.query('select nicepay_checkout_mode()'), /permission denied/);
      } finally { await db.exec('reset role'); }
    }
    await db.exec('set role service_role');
    try { assert.equal((await q1(db, 'select mode from nicepay_checkout_gate')).mode, 'off'); await rejects(db.exec("update nicepay_checkout_gate set mode = 'public'"), /permission denied/); }
    finally { await db.exec('reset role'); }
    await rejects(db.exec('delete from nicepay_checkout_gate'), /삭제/);
    await rejects(db.exec("update nicepay_checkout_gate_audit set mode = 'public'"), /수정|삭제/);
    await rejects(db.exec('delete from nicepay_checkout_gate_audit'), /수정|삭제/);
    await db.exec("update nicepay_checkout_gate set mode = 'public' where id");
    await db.exec(gateFix); await db.exec(gateFix);
    assert.equal((await q1(db, 'select mode from nicepay_checkout_gate')).mode, 'public', '재적용이 켜진 게이트를 끄지 않는다');
    const v = (await db.query(stripComments(gateVerify))).rows[0];
    for (const [k, val] of Object.entries(v)) if (k.endsWith('must_be_true')) assert.equal(val, true, k);
    assert.equal(v.info_gate_mode_off_before_activation, false);   // 이 시점엔 public으로 켜 둔 상태
  } finally { await db.close(); }
});

test('GT5. 순서 보호: 게이트 없이는 NICEPAY 지원/ create_order_secure 패치가 중단, 롤백은 지원 SQL이 남아 있으면·켜짐/감사 이력이 있으면 중단, 깨끗하면 완전 제거', async () => {
  const noGate = await world({ gateApplied: false, supportApplied: false });
  try {
    await rejects(noGate.exec(support), /주문 생성 게이트가 없어요/); await noGate.exec('rollback');
    assert.equal(await count(noGate, 'pg_proc', "proname = 'nicepay_claim_order'"), 0, '중단되면 아무것도 설치되지 않는다');
    const cos = noGate; await cos.exec(`create or replace function public.create_order_secure(uuid, text, text, integer, boolean, text) returns uuid language plpgsql security definer set search_path = public as $$ begin if $6 not in ('mock','toss','portone') then raise exception 'x'; end if; return gen_random_uuid(); end $$;`);
    await rejects(cos.exec(cosFix), /주문 생성 게이트가 없어요/); await cos.exec('rollback');
  } finally { await noGate.close(); }
  const db = await world({ supportApplied: false });
  try {
    await db.exec(support);
    await rejects(db.exec(gateRollback), /nicepay provider를 허용 중/); await db.exec('rollback');
    await db.exec(supportRollback);
    await db.exec("update nicepay_checkout_gate set mode = 'public' where id");
    await rejects(db.exec(gateRollback), /켜져 있거나\(mode ≠ off\) 감사 기록|켜져 있거나.*감사 기록/); await db.exec('rollback');
    await db.exec("update nicepay_checkout_gate set mode = 'off' where id");
    await rejects(db.exec(gateRollback), /켜져 있거나\(mode ≠ off\) 감사 기록|켜져 있거나.*감사 기록/); await db.exec('rollback');   // 변경 이력(시드 이상) 보존
  } finally { await db.close(); }
  const pristine = await world({ supportApplied: false });
  try {
    await pristine.exec(gateRollback);
    assert.equal(await count(pristine, 'pg_proc', "proname in ('nicepay_checkout_mode','orders_guard_nicepay_create')"), 0);
    assert.equal(await count(pristine, 'pg_trigger', "tgname = 'orders_guard_nicepay_create'"), 0);
    await pristine.exec(gateFix);   // 다시 적용 가능
    assert.equal(await count(pristine, 'pg_trigger', "tgname = 'orders_guard_nicepay_create'"), 1);
  } finally { await pristine.close(); }
});

test('GT6. reviewer 모드: 심사 계정(accounts.pg_checkout_override)의 프로필만 NICEPAY 주문 생성 가능, 일반 회원·anon·남의 프로필 불가, public으로 올리면 모두 허용(앱 노출 정책과 일치)', async () => {
  const db = await world();
  try {
    await db.exec('grant select, insert on orders to anon, authenticated; grant select on profiles, accounts to authenticated;');
    await db.exec("update nicepay_checkout_gate set mode = 'reviewer' where id");
    await rejects(insertNicepayAs(db, 'authenticated', AUTH), GATE_MSG);                     // 일반 회원(override=false)
    await db.exec(`update accounts set pg_checkout_override = true where id = '${ACC}'`);
    const oid = await insertNicepayAs(db, 'authenticated', AUTH);                            // 심사 계정
    assert.deepEqual(await q1(db, `select status, verified, payment_provider from orders where id='${oid}'`), { status: 'pending', verified: false, payment_provider: 'nicepay' });
  } finally { await db.close(); }
  const db2 = await world();
  try {
    await db2.exec('grant select, insert on orders to authenticated; grant select on profiles, accounts to authenticated;');
    await db2.exec("update nicepay_checkout_gate set mode = 'public' where id");
    await insertNicepayAs(db2, 'authenticated', AUTH);                                        // override 없이도 public이면 허용
    await db2.exec("update nicepay_checkout_gate set mode = 'off' where id");
    await db2.exec(`update accounts set pg_checkout_override = true where id = '${ACC}'`);
    await rejects(insertNicepayAs(db2, 'authenticated', AUTH), GATE_MSG);                     // off이면 심사 계정도 불가
  } finally { await db2.close(); }
});
