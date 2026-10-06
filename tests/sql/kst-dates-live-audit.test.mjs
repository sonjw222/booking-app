// 격리 PostgreSQL(PGlite) — verify_reservation_membership_kst_dates_20261004.sql(라이브 current_date 진단) 동작 확인 + 저장소 최종 lineage 정적 감사.
// 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/kst-dates-live-audit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const root = new URL('../../', import.meta.url);
const verify = readFileSync(new URL('verify_reservation_membership_kst_dates_20261004.sql', root), 'utf8').replace(/^\s*--.*$/gm, '');

test('verify: 읽기 전용 단일 SELECT', () => {
  assert.doesNotMatch(verify, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i);
  assert.equal(verify.trim().split(';').filter(x => x.trim()).length, 1);
});

test('verify: 허용 목록 밖의 current_date/now()::date 함수는 REVIEW_NEEDED, KST 표현·허용 함수만 있으면 CLEAN', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create function reserve_ok() returns boolean language sql as $$ select (now() at time zone 'Asia/Seoul')::date >= current_setting('x', true)::date $$;
      create function evaluate_notification_rules() returns date language sql as $$ select current_date $$;`);
    let r = (await db.query(verify)).rows[0];
    assert.deepEqual(r.functions_using_utc_date, ['evaluate_notification_rules']); assert.deepEqual(r.unexpected_functions, []); assert.equal(r.verdict, 'CLEAN');
    await db.exec(`create function bad_expiry(d date) returns boolean language sql as $$ select d >= current_date $$;
                   create function bad_expiry2(d date) returns boolean language sql as $$ select d >= now()::date $$;
                   create function commented() returns int language plpgsql as $$ begin -- current_date in a comment only
                     return 1; end $$;`);
    r = (await db.query(verify)).rows[0];
    assert.deepEqual(r.unexpected_functions, ['bad_expiry', 'bad_expiry2']); assert.equal(r.verdict, 'REVIEW_NEEDED');
  } finally { await db.close(); }
});

test('정적 감사: 수강권 유효성 판정 함수들의 최종 정의 파일은 UTC 날짜(current_date, now()::date) 없이 KST 표현만 사용', () => {
  // 생성일 순서 대신 파일명 날짜 접미사/알려진 최종 migration을 직접 지정: 아래 함수들의 최종 정의 파일은 KST 표현을 포함해야 한다.
  const finals = {
    'fix_reservation_integrity_20261003.sql': ['reserve_with_membership', 'usable_memberships', 'usable_memberships_for_classes'],
    'fix_waitlist_membership_consumed_20261003.sql': ['reserve_class'],
    'fix_grant_schedule_and_kst_dates_20261003.sql': ['cancel_reservation', 'update_class_safe', 'manager_grant_product', 'reserve_with_goods'],
    'fix_pg_order_refund_kst_dates_20261004.sql': ['_issue_membership_and_record_payment', 'fulfill_order', '_refund_membership_core'],
  };
  for (const [file, fns] of Object.entries(finals)) {
    const sql = readFileSync(new URL(file, root), 'utf8').replace(/--[^\n]*/g, '');
    for (const fn of fns) {
      const m = new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+(public\\.)?${fn}\\s*\\(`, 'i').exec(sql);
      assert.ok(m, `${file} 에 ${fn} 정의 없음`);
      const rest = sql.slice(m.index + 1);
      const next = rest.search(/create\s+(or\s+replace\s+)?function/i);
      const body = next < 0 ? rest : rest.slice(0, next);
      assert.doesNotMatch(body, /current_date|now\(\)\s*::\s*date/i, `${file}:${fn} 에 UTC 날짜 의존`);
      assert.match(body, /asia\/seoul/i, `${file}:${fn} 에 KST 표현 없음`);
    }
  }
});
