// 격리 PostgreSQL(PGlite) — F16 기간제 매출 분배의 합계 보존. 운영 두 함수 정의(2026-10-22 읽기 전용 확인본)를 그대로 설치한 뒤
// fix_period_revenue_remainder_20261022.sql(제자리 패치)을 적용해 전/후를 대조한다. 권한 helper 는 스텁이므로 RLS/인가 검증이 아니다.
// 실행: node --test tests/sql/period-revenue-remainder.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const defs = JSON.parse(readFileSync(new URL('./fixtures/production-revenue-definitions-1022.json', import.meta.url), 'utf8'));
const migration = readFileSync(new URL('../../fix_period_revenue_remainder_20261022.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../../rollback_fix_period_revenue_remainder_20261022.sql', import.meta.url), 'utf8');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C = id(1), PROD_PERIOD = id(2), PROF = id(4);

async function world({ patched }) {
  dayCursor = 2;
  const db = new PGlite();
  await db.exec(`
    create table center_settings(center_id uuid, unlimited_pass_revenue_mode text);
    create table products(id uuid, product_kind text, unlimited_pass boolean, name text);
    create table memberships(id uuid, center_id uuid, product_id uuid, pass_type text, total_count int);
    create table payments(membership_id uuid, center_id uuid, profile_id uuid, total_amount int, payment_provider text, sale_type text, paid_at timestamptz);
    create table classes(id uuid, status text, start_time timestamptz, title text, place text);
    create table reservations(id uuid default gen_random_uuid(), membership_id uuid, profile_id uuid, class_id uuid, status text);
    create table profiles(id uuid, name text);
    create table membership_session_amounts(membership_id uuid, session_index int, amount int);
    create function my_managed_center_ids() returns setof uuid language sql stable as $$select '${C}'::uuid$$;
    create function is_platform_admin() returns boolean language sql stable as $$select false$$;
    insert into center_settings values('${C}','usage_split');
    insert into products values('${PROD_PERIOD}','pass',true,'기간제');
    insert into profiles values('${PROF}','QA');
  `);
  for (const d of defs) await db.exec(d.definition);
  if (patched) await db.exec(migration);
  return db;
}
let seq = 100;
let dayCursor = 2;   // 회원권마다 겹치지 않는 날짜를 쓴다(상세 조회는 그 날의 모든 회원권 행을 돌려주므로)
async function period(db, { paid, uses, provider = null, extraRefund = 0 }) {
  const m = id(seq++);
  await db.exec(`insert into memberships values('${m}','${C}','${PROD_PERIOD}','period',null);
                 insert into payments values('${m}','${C}','${PROF}',${paid},${provider ? `'${provider}'` : 'null'},'new','2026-10-01 00:00+09');`);
  if (extraRefund) await db.exec(`insert into payments values('${m}','${C}','${PROF}',${-extraRefund},null,'refund','2026-10-20 00:00+09');`);
  const days = [];
  for (let i = 0; i < uses.length; i++) {
    const cid = id(seq++); const day = dayCursor++; days.push(`2026-10-${String(day).padStart(2, '0')}`);
    await db.exec(`insert into classes values('${cid}','${uses[i].classStatus ?? 'active'}','2026-10-${String(day).padStart(2, '0')} 10:00+09','수업 ${i}',null);
                   insert into reservations(membership_id,profile_id,class_id,status) values('${m}','${PROF}','${cid}','${uses[i].res ?? 'attended'}');`);
  }
  return { m, days };
}
const daily = async (db, from = '2026-10-01', to = '2026-10-31') => (await db.query(`select class_revenue_daily_summary('${C}','${from}','${to}') data`)).rows[0].data;
const detail = async (db, d) => (await db.query(`select class_revenue_for_date('${C}','${d}') data`)).rows[0].data;
const sumDaily = (rows) => rows.reduce((s, r) => s + r.total, 0);
const sumDetail = async (db, days) => { let s = 0; for (const d of days) for (const r of await detail(db, d)) s += r.amount; return s; };

test('수정 전(운영 정의 그대로): 1000원/3회가 999원 — 합계 누락 재현', async () => {
  const db = await world({ patched: false });
  const { days } = await period(db, { paid: 1000, uses: [{}, {}, {}] });
  assert.equal(sumDaily(await daily(db)), 999);
  assert.equal(await sumDetail(db, days), 999);
  await db.close();
});

test('수정 후: 1000/3 → 합계 1000(334·333·333), 20000/2 → 20000, 일별 요약 = 날짜별 상세', async () => {
  const db = await world({ patched: true });
  const a = await period(db, { paid: 1000, uses: [{}, {}, {}] });
  assert.equal(sumDaily(await daily(db)), 1000);
  assert.equal(await sumDetail(db, a.days), 1000);
  const amounts = []; for (const d of a.days) amounts.push(...(await detail(db, d)).map((r) => r.amount));
  assert.deepEqual(amounts, [334, 333, 333]);                                  // 나머지는 앞 회차부터 1원씩(횟수제와 같은 규칙)
  const b = await period(db, { paid: 20000, uses: [{}, {}] });
  assert.equal(sumDaily(await daily(db)), 21000);                               // 1000 + 20000
  assert.equal(await sumDetail(db, b.days), 20000);
  await db.close();
});

test('경계: 0원·이용 0회·1회·노쇼 포함·취소/폐강 제외·일부 날짜 조회·mock 제외·환불 별도', async () => {
  const db = await world({ patched: true });
  const zero = await period(db, { paid: 0, uses: [{}, {}] });                    // 0원 → 0원씩
  assert.equal(await sumDetail(db, zero.days), 0);
  await period(db, { paid: 5000, uses: [] });                                     // 이용 0회 → 매출 없음
  const one = await period(db, { paid: 7777, uses: [{}] });                       // 1회 → 전액
  assert.equal(await sumDetail(db, one.days), 7777);
  const mix = await period(db, { paid: 1000, uses: [{ res: 'no_show' }, { res: 'cancelled' }, { classStatus: 'cancelled' }, { res: 'confirmed' }] });
  // 취소 예약·폐강 수업은 분배 대상이 아니다 → 유효 이용 2회(노쇼·확정): 500+500
  assert.equal(await sumDetail(db, mix.days), 1000);
  const mock = await period(db, { paid: 3000, provider: 'mock', uses: [{}] });    // mock 결제 제외 → 0
  assert.equal(await sumDetail(db, mock.days), 0);
  // 일부 날짜만 조회해도 그 날의 몫은 전체 분배와 같다(회차 순서 기준이므로 조회 범위에 따라 달라지지 않는다)
  const part = await period(db, { paid: 1000, uses: [{}, {}, {}] });
  const one1 = await daily(db, part.days[0], part.days[0]);
  const two = await daily(db, part.days[1], part.days[1]);
  assert.equal(one1[0].periodPassRevenue, 334);                                   // 첫 회차가 나머지 1원을 받는다
  assert.equal(two[0].periodPassRevenue, 333);
  assert.equal((await detail(db, part.days[0]))[0].amount, 334);                  // 요약과 상세가 같은 값
  await db.close();
});

test('환불: 환불 행은 분배 금액에 섞이지 않고 refundAmount 로 따로 집계된다', async () => {
  const db = await world({ patched: true });
  await period(db, { paid: 1000, uses: [{}, {}, {}], extraRefund: 300 });
  const rows = await daily(db);
  assert.equal(rows.reduce((s, r) => s + r.refundAmount, 0), -300);
  assert.equal(rows.reduce((s, r) => s + r.periodPassRevenue, 0), 1000);          // 분배 합은 환불과 무관하게 결제액 보존
  await db.close();
});

test('purchase_date_full 모드는 그대로(구매일 전액) — 회귀 없음', async () => {
  const db = await world({ patched: true });
  await db.exec(`update center_settings set unlimited_pass_revenue_mode='purchase_date_full'`);
  const a = await period(db, { paid: 1000, uses: [{}, {}, {}] });
  assert.equal(sumDaily(await daily(db)), 1000);
  assert.equal((await detail(db, '2026-10-01'))[0].amount, 1000);
  assert.equal((await detail(db, a.days[0])).length, 0);
  await db.close();
});

test('멱등·중단 안전: 두 번 적용해도 같다 / 예상과 다른 정의면 아무것도 바꾸지 않고 중단한다 / 롤백은 원본 복원', async () => {
  const db = await world({ patched: true });
  await db.exec(migration);                                                         // 재적용 = 마커로 건너뜀
  const a = await period(db, { paid: 1000, uses: [{}, {}, {}] });
  assert.equal(await sumDetail(db, a.days), 1000);
  await db.exec(rollback);
  const b = await period(db, { paid: 1000, uses: [{}, {}, {}] });
  assert.equal(await sumDetail(db, b.days), 999);                                 // 원본 복원 후에는 결함이 다시 재현된다(롤백 확인)
  await db.close();
  // 예상과 다른 정의(치환 대상 없음) → 중단
  const odd = new PGlite();
  await odd.exec(`create function my_managed_center_ids() returns setof uuid language sql as $$select null::uuid$$; create function class_revenue_daily_summary(a uuid,b date,c date) returns json language sql as $$select '[]'::json$$; create function class_revenue_for_date(a uuid,b date) returns json language sql as $$select '[]'::json$$;`);
  await assert.rejects(odd.exec(migration), /F16 패치 중단/);
  await odd.close();
});

test('추가 이용: 이용 횟수가 늘면 분배가 다시 계산되고 매번 합계가 결제금액과 같다 / usage_split 에서는 정기권 전액 행이 없다', async () => {
  const db = await world({ patched: true });
  const m = id(seq++);
  await db.exec(`insert into memberships values('${m}','${C}','${PROD_PERIOD}','period',null);
                 insert into payments values('${m}','${C}','${PROF}',1000,null,'new','2026-10-01 00:00+09');`);
  const days = [];
  for (let n = 1; n <= 6; n++) {                                                 // 1회, 2회, … 6회 이용으로 늘려 가며 매번 합계 확인
    const cid = id(seq++); const day = dayCursor++; days.push(`2026-10-${String(day).padStart(2, '0')}`);
    await db.exec(`insert into classes values('${cid}','active','2026-10-${String(day).padStart(2, '0')} 10:00+09','수업 ${n}',null);
                   insert into reservations(membership_id,profile_id,class_id,status) values('${m}','${PROF}','${cid}','attended');`);
    assert.equal(await sumDetail(db, days), 1000, `${n}회 이용 시 합계`);
    assert.equal(sumDaily(await daily(db, days[0], days[days.length - 1])), 1000, `${n}회 이용 시 일별 요약 합계`);
  }
  for (const d of days) for (const r of await detail(db, d)) assert.equal(r.type, 'class');   // usage_split: 구매일 전액('period_pass') 행 없음
  await db.close();
});
