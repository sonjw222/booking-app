// verify SQL 3종의 false-negative/false-positive 방지 — 함수 정의의 CRLF/들여쓰기/공백/public. 접두사/주석 유무가 달라도 APPLIED, 핵심 조건 하나가 빠지면 NOT_APPLIED.
// 실행: PGLITE_MODULE=<pglite 디렉터리> node --test tests/sql/verify-formatting-safe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE + '/dist/index.js').href : '@electric-sql/pglite');
const read = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const stripFullLineComments = s => s.replace(/^\s*--.*$/gm, '');
const V = {
  waitlist: stripFullLineComments(read('verify_waitlist_membership_consumed_20261003.sql')),
  grant: stripFullLineComments(read('verify_grant_schedule_and_kst_dates_20261003.sql')),
  member: stripFullLineComments(read('verify_member_candidate_search_20261003.sql')),
};
const SRC = { integrity: read('fix_reservation_integrity_20261003.sql'), wait: read('fix_waitlist_membership_consumed_20261003.sql'), grant: read('fix_grant_schedule_and_kst_dates_20261003.sql'), member: read('add_member_candidate_search_20261003.sql') };
const fnText = (sql, name) => { const a = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); const b = sql.indexOf('$function$;', sql.indexOf('AS $function$', a)); return sql.slice(a, b + '$function$;'.length); };

// ---- 정의를 "다르게 저장된 것처럼" 바꾸는 변환(의미는 동일) ----
const crlf = s => s.replace(/\r?\n/g, '\r\n');
const reindent = s => s.split('\n').map((l, i) => (i % 2 ? '\t\t  ' : '        ') + l.trim().replace(/[ \t]{2,}/g, ' ')).join('\n');     // 들여쓰기/공백이 전혀 다른 포맷
const noComments = s => s.split('\n').map(l => l.replace(/\s*--.*$/, '')).join('\n');                                                              // 주석 없이 저장
const qualify = s => s
  .replace(/\b(from|join|into|update) (?!public\.)(memberships|reservations|classes|products|profiles|accounts|center_members|membership_schedule_rules|class_allowed_products)\b/g, '$1 public.$2')
  .replace(/(?<![.\w])(is_membership_eligible_for_class|my_account_id|has_permission|is_platform_admin|kr_phone_digits|calc_deadline|validate_product_schedule_selection)\(/g, 'public.$1(');
const VARIANTS = { 원본: s => s, 'CRLF 줄바꿈': crlf, '들여쓰기·공백 변경': reindent, '주석 없음': noComments, 'public. 접두사': qualify, 'CRLF+들여쓰기+접두사+주석 없음': s => qualify(noComments(crlf(reindent(s)))) };

async function install(transform = s => s, mutate = s => s) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create table products(id uuid primary key, product_kind text); create table profiles(id uuid primary key, account_id uuid, shoe_size text); create table classes(id uuid primary key, pass_selection_mode text, start_time timestamptz, title text);
    create table memberships(id uuid primary key, product_id uuid, bound_day_of_week int, bound_start_time time);
    create table class_allowed_products(class_id uuid, product_id uuid); create table membership_schedule_rules(product_id uuid, day_of_week int, start_time time, class_title text);
    -- 이미 Production에 있는 전역 부분일치 RPC(member migration이 권한 회수)
    create function search_accounts_for_member(p_keyword text) returns table(profile_id uuid) language sql as $$ select null::uuid where false $$;
    grant execute on function search_accounts_for_member(text) to authenticated;
  `);
  const t = s => transform(mutate(s));
  await db.exec(t(fnText(SRC.integrity, 'is_membership_eligible_for_class')));
  await db.exec(t(fnText(SRC.integrity, 'reserve_with_membership')));
  await db.exec(t(fnText(SRC.integrity, 'reserve_class')));
  await db.exec(t(SRC.wait));
  await db.exec(t(SRC.grant));
  await db.exec(t(SRC.member));
  return db;
}
const verdicts = async db => Object.fromEntries(await Promise.all(Object.entries(V).map(async ([k, sql]) => [k, (await db.query(sql)).rows[0]])));
const failing = r => Object.keys(r).filter(k => k.endsWith('_ok') && r[k] !== true);

test('포맷이 달라도 APPLIED: 원본 / CRLF / 들여쓰기·공백 변경 / 주석 없음 / public. 접두사 / 전부 섞기 (3개 verify 모두)', async () => {
  for (const [label, tf] of Object.entries(VARIANTS)) {
    const db = await install(tf);
    try {
      const r = await verdicts(db);
      for (const k of Object.keys(r)) assert.equal(r[k].verdict, 'APPLIED', `${label} / ${k} / false: ${failing(r[k]).join(',')}`);
      assert.ok(Object.keys(r.waitlist).filter(x => x.endsWith('_ok')).length >= 7 && Object.keys(r.grant).filter(x => x.endsWith('_ok')).length >= 18 && Object.keys(r.member).filter(x => x.endsWith('_ok')).length >= 18);
    } finally { await db.close(); }
  }
});

// [이름, 변경(migration 텍스트), 반드시 NOT_APPLIED가 되어야 하는 verify들, 그중 false여야 하는 컬럼(의도한 조건이 실제로 잡혔는지)]
const MUTATIONS = [
  ['membership_consumed=true 제거(승격 두 경로)', s => s.replace(/, membership_consumed = true/g, ''), ['waitlist', 'grant'], { waitlist: ['cancel_reservation_promotion_consumed_ok', 'update_class_safe_promotion_consumed_ok'], grant: ['waitlist_promotion_consumed_ok'] }],
  ['reserve_class 대기 insert를 consumed=true로', s => s.replace("'waitlisted', v_wait_order, false", "'waitlisted', v_wait_order, true"), ['waitlist'], { waitlist: ['reserve_class_waitlisted_consumed_false_ok'] }],
  ['reserve_class 확정 insert에서 consumed 명시 제거', s => s.replace("'confirmed', true)   -- 확정", "'confirmed')   -- 확정").replace("status, membership_consumed)\n        values (p_class_id, v_profile_id, v_membership.id, 'confirmed'", "status)\n        values (p_class_id, v_profile_id, v_membership.id, 'confirmed'"), ['waitlist'], { waitlist: ['reserve_class_confirmed_consumed_true_ok'] }],
  ['승격 차감 조건(remaining_count is not null) 제거', s => s.replace(/ and remaining_count is not null;/g, ';'), ['waitlist', 'grant'], { waitlist: ['promotion_decrement_non_null_ok'], grant: ['promotion_decrement_non_null_ok'] }],
  ['승격 자격에서 status=active 제거', s => s.replace(/ {10,}and m\.status = 'active'\n/g, ''), ['grant'], { grant: ['waitlist_promotion_status_ok'] }],
  ['승격 자격에서 현재 수업 자격 제거', s => s.replace(/ {10,}and is_membership_eligible_for_class\(m\.id, [a-z_.]+\)[^\n]*\n/g, ''), ['grant'], { grant: ['waitlist_promotion_current_class_eligibility_ok'] }],
  ['승격 만료 조건에서 NULL 허용 제거', s => s.replace(/\(m\.expires_at is null or m\.expires_at >= (\(now\(\) at time zone 'Asia\/Seoul'\)::date)\)/g, 'm.expires_at >= $1'), ['grant'], { grant: ['waitlist_promotion_expiry_ok'] }],
  ['manager_grant_product 예약조건 검증 호출 제거', s => s.replace('perform public.validate_product_schedule_selection(v_product.id, v_bound_dow, v_bound_time);', ''), ['grant'], { grant: ['grant_validates_schedule_ok'] }],
  ['manager_grant_product 시작일을 current_date로', s => s.replace("v_starts      date := (now() at time zone 'Asia/Seoul')::date;", 'v_starts      date := current_date;'), ['grant'], { grant: ['grant_kst_dates_ok'] }],
  ['cancel_reservation search_path 제거', s => s.replace(" SECURITY DEFINER\n SET search_path TO 'public'\nAS $function$\ndeclare\n    v_res         record;", " SECURITY DEFINER\nAS $function$\ndeclare\n    v_res         record;"), ['grant'], { grant: ['cancel_reservation_search_path_ok'] }],
  ['회원 검색: customer.member.phone 권한 gate 제거', s => s.replace("v_can_phone := public.has_permission(p_center_id, 'customer.member.phone') or public.is_platform_admin();", 'v_can_phone := true;'), ['member'], { member: ['phone_permission_gate_ok'] }],
  ['회원 검색: 센터 회원 전화번호 반환 gate 제거', s => s.replace('case when v_can_phone then a.phone else null end as pphone', 'a.phone as pphone'), ['member'], { member: ['member_phone_gated_ok'] }],
  ['회원 검색: create 권한 검사 제거', s => s.replace("if p_center_id is null or not public.has_permission(p_center_id, 'customer.member.create') then", 'if p_center_id is null then'), ['member'], { member: ['body_create_permission_ok'] }],
  ['회원 검색: ILIKE 부분일치로 교체', s => s.replace("position(lower(v_kw) in lower(coalesce(p.name, ''))) > 0", "p.name ilike '%' || v_kw || '%'"), ['member'], { member: ['position_search_no_ilike_ok'] }],
  ['회원 검색: 저장 phone 정규화 제거', s => s.replace('and public.kr_phone_digits(a.phone) = v_exact', "and regexp_replace(coalesce(a.phone, ''), '[^0-9]', '', 'g') = v_exact"), ['member'], { member: ['phone_canonical_compare_ok'] }],
  ['회원 검색: 센터 밖 결과에 전체 번호 반환', s => s.replace("select e.pid, e.pname, left(v_exact, 3) || '-****-' || right(v_exact, 4), false from exact e", 'select e.pid, e.pname, e.pphone, false from exact e'), ['member'], { member: ['masked_exact_result_ok'] }],
  ['회원 검색: search_path 고정 제거', s => s.replace(/(returns table \(profile_id uuid, name text, phone text, already_member boolean\)\nlanguage plpgsql\nstable\nsecurity definer\n)set search_path = public\n/, '$1'), ['member'], { member: ['search_path_pinned_ok'] }],
];
test('핵심 조건 하나를 제거하면 NOT_APPLIED (의도한 *_ok가 정확히 false로 잡힌다)', async () => {
  for (const [label, mutate, mustFail, expectFalse] of MUTATIONS) {
    const db = await install(s => s, mutate);
    try {
      const r = await verdicts(db);
      for (const k of mustFail) {
        assert.equal(r[k].verdict, 'NOT_APPLIED', `${label} → ${k}`);
        for (const col of expectFalse[k] ?? []) assert.equal(r[k][col], false, `${label} → ${k}.${col}`);
      }
      for (const k of Object.keys(r).filter(k => !mustFail.includes(k))) assert.equal(r[k].verdict, 'APPLIED', `${label} 은 ${k}에는 영향이 없어야 한다(false: ${failing(r[k]).join(',')})`);
    } finally { await db.close(); }
  }
});

test('mutation도 포맷이 달라진 정의에서 똑같이 잡힌다(CRLF+들여쓰기+접두사+주석 없음 조합에서 NOT_APPLIED)', async () => {
  const all = VARIANTS['CRLF+들여쓰기+접두사+주석 없음'];
  for (const idx of [0, 1, 10, 12, 15]) {
    const [label, mutate, mustFail] = MUTATIONS[idx];
    const db = await install(all, mutate);
    try { const r = await verdicts(db); for (const k of mustFail) assert.equal(r[k].verdict, 'NOT_APPLIED', `${label} (섞인 포맷) → ${k}`); } finally { await db.close(); }
  }
});

test('권한이 잘못 열리면 NOT_APPLIED(helper/RPC execute), 원복하면 APPLIED', async () => {
  const db = await install();
  try {
    assert.equal((await verdicts(db)).member.verdict, 'APPLIED');
    const cases = [
      ['validate helper를 anon에게', 'grant execute on function validate_product_schedule_selection(uuid, integer, time) to anon', 'revoke execute on function validate_product_schedule_selection(uuid, integer, time) from anon', 'grant', 'helper_internal_only_ok'],
      ['validate helper를 authenticated에게', 'grant execute on function validate_product_schedule_selection(uuid, integer, time) to authenticated', 'revoke execute on function validate_product_schedule_selection(uuid, integer, time) from authenticated', 'grant', 'helper_internal_only_ok'],
      ['kr_phone_digits를 authenticated에게', 'grant execute on function kr_phone_digits(text) to authenticated', 'revoke execute on function kr_phone_digits(text) from authenticated', 'member', 'canonical_helper_internal_ok'],
      ['kr_phone_digits를 anon에게', 'grant execute on function kr_phone_digits(text) to anon', 'revoke execute on function kr_phone_digits(text) from anon', 'member', 'canonical_helper_internal_ok'],
      ['검색 RPC를 anon에게', 'grant execute on function search_member_candidates(uuid, text) to anon', 'revoke execute on function search_member_candidates(uuid, text) from anon', 'member', 'anon_denied_ok'],
      ['검색 RPC를 authenticated에서 회수', 'revoke execute on function search_member_candidates(uuid, text) from authenticated', 'grant execute on function search_member_candidates(uuid, text) to authenticated', 'member', 'authenticated_allowed_ok'],
      ['기존 전역 RPC를 authenticated에게 재부여', 'grant execute on function search_accounts_for_member(text) to authenticated', 'revoke execute on function search_accounts_for_member(text) from authenticated', 'member', 'old_global_search_revoked_ok'],
      ['기존 전역 RPC를 anon에게', 'grant execute on function search_accounts_for_member(text) to anon', 'revoke execute on function search_accounts_for_member(text) from anon', 'member', 'old_global_search_anon_denied_ok'],
    ];
    for (const [label, brk, fix, which, col] of cases) {
      await db.exec(brk);
      const r = (await db.query(V[which])).rows[0];
      assert.equal(r.verdict, 'NOT_APPLIED', label); assert.equal(r[col], false, `${label} → ${col}`);
      await db.exec(fix);
      assert.equal((await db.query(V[which])).rows[0].verdict, 'APPLIED', `${label} 원복`);
    }
  } finally { await db.close(); }
});

test('verify는 단일 읽기 전용 SELECT, 정규화 방식(소문자·주석 제거·공백 제거·public. 제거)을 쓰고 긴 정확 LIKE 문자열에 의존하지 않는다', () => {
  for (const [name, sql] of Object.entries(V)) {
    assert.doesNotMatch(sql, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i, name);
    assert.match(sql.trim(), /^with\b/i, name);
    assert.equal((sql.match(/;/g) || []).length >= 1, true);
    assert.ok(sql.includes("regexp_replace(regexp_replace(lower("), `${name}: 정규화 사용`);
    assert.ok(sql.includes("'\\s+'") && sql.includes("'public.'"), `${name}: 공백/public. 정규화`);
    assert.doesNotMatch(sql, /like '%[^']{60,}%'/, `${name}: 긴 정확 LIKE 금지`);
  }
});
