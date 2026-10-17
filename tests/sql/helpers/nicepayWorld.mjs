// NICEPAY SQL 테스트 공용 "월드" — 저장소의 라이브 정의를 그대로 잘라 설치용 SQL 문자열로 만든다.
// PGlite 테스트(tests/sql/nicepay-provider-support.test.mjs)와 실제 PostgreSQL 2세션 테스트(tests/sql/real-pg/nicepay-real-pg.mjs)가 같은 SQL을 쓴다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
export const read = f => readFileSync(new URL('../../../' + f, import.meta.url), 'utf8');
export const slice = (src, start, endMarker) => { const a = src.search(start); assert.ok(a >= 0, `start not found: ${start}`); const b = src.indexOf(endMarker, a); assert.ok(b > a, `end not found: ${endMarker}`); return src.slice(a, b + endMarker.length); };
export const lifecycle = read('fix_pg_payment_lifecycle.sql');
export const kst = read('fix_pg_order_refund_kst_dates_20261004.sql');
export const issuance = read('fix_order_issuance_and_auto_booking.sql');
export const confirmReal = read('add_confirm_real_payment.sql');
export const pointLife = read('fix_order_point_lifecycle.sql');
export const settlementSrc = read('fix_admin_settlement_summary_use_payment_provider.sql');
export const refundFix = read('fix_refund_pg_origin_guard_20261017.sql');
export const serverFix = read('fix_refund_server_path_fail_closed_20261017.sql');
export const serverRollback = read('rollback_fix_refund_server_path_fail_closed_20261017.sql');
export const roleGuardFix = read('fix_orders_insert_role_guard_20261017.sql');
export const roleGuardRollback = read('rollback_fix_orders_insert_role_guard_20261017.sql');
export const amountFix = read('fix_refund_amount_integrity_20261017.sql');
export const amountRollback = read('rollback_fix_refund_amount_integrity_20261017.sql');
export const refundRollback = read('rollback_fix_refund_pg_origin_guard_20261017.sql');
export const cosFix = read('fix_create_order_secure_allow_nicepay_20261016.sql');
export const cosRollback = read('rollback_fix_create_order_secure_allow_nicepay_20261016.sql');
export const preflight = stripCommentsEarly(read('preflight_nicepay_patch_targets_20261016.sql'));
function stripCommentsEarly(x) { return x.replace(/^\s*--.*$/gm, ''); }
export const support = read('add_nicepay_provider_support_20261016.sql');
export const supportRollback = read('rollback_add_nicepay_provider_support_20261016.sql');
export const stripComments = s => s.replace(/^\s*--.*$/gm, '');

export const id = (k, n) => `${String(k).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
export const C1 = id(1, 1), CI = id(1, 2), P1 = id(2, 1), ACC = id(3, 1), AUTH = id(3, 9), MGR = id(3, 2), PROD = id(4, 1);

export const liveHelper = slice(kst, /CREATE OR REPLACE FUNCTION public\._issue_membership_and_record_payment/, '$function$;');
export const liveFulfill = slice(kst, /CREATE OR REPLACE FUNCTION public\.fulfill_order/, '$function$;');
export const liveCore = slice(kst, /CREATE OR REPLACE FUNCTION public\._refund_membership_core/, '$function$;');
export const liveForceInsert = slice(lifecycle, /create or replace function orders_force_server_fields_on_insert\(\)/, 'execute function orders_force_server_fields_on_insert();');
export const liveStatusGuard = slice(pointLife, /create or replace function orders_guard_status_transition\(\)/, 'execute function orders_guard_status_transition();');
export const liveRestoreTrigger = slice(pointLife, /create or replace function orders_restore_points_on_cancel\(\)/, 'execute function orders_restore_points_on_cancel();');
export const liveRefundWrappers = slice(lifecycle, /create or replace function refund_membership\(p_membership_id uuid\)/, 'grant execute on function refund_membership_server(uuid, uuid, boolean, boolean) to service_role;');
export const liveRefundContext = slice(lifecycle, /create or replace function pg_refund_context\(p_membership_id uuid, p_auth_uid uuid\)/, 'grant execute on function pg_refund_context(uuid, uuid) to service_role;');
export const liveRefundBegin = slice(lifecycle, /create or replace function pg_refund_begin\(p_membership_id uuid, p_auth_uid uuid\)/, 'grant execute on function pg_refund_begin(uuid, uuid) to service_role;');
export const liveAccountFor = slice(lifecycle, /create or replace function _account_id_for_auth/, 'revoke all on function _account_id_for_auth(uuid) from public, anon, authenticated;');
export const liveConfirmReal = slice(issuance, /create or replace function public\.confirm_real_payment/, '$function$;');
export const liveCancelReal = slice(confirmReal, /create or replace function cancel_real_payment/, '$$;');
export const liveConfirmTest = slice(lifecycle, /CREATE OR REPLACE FUNCTION public\.confirm_test_payment/, '$function$;');
export const liveSettlement = slice(settlementSrc, /create or replace function admin_center_settlement_summary/, '\n$$;');

// 운영 정의 형태 재현: CRLF 줄바꿈, '[NEW 2026-10-02]' 주석 없음(운영 fulfill_order). 저장소 정의를 변환해 설치한다.
export const toCrlf = t => t.replace(/\r?\n/g, '\r\n');
export const dropNewComment = t => t.replace(/^[ \t]*-- \[NEW 2026-10-02\][^\n]*\n/m, '');
export const shaper = ({ crlf = false, noComment = false } = {}) => t => { let x = t; if (noComment) x = dropNewComment(x); if (crlf) x = toCrlf(x); return x; };

/** 환불 core(라이브 정의) 설치 SQL — 월드 기본 설치 뒤에 실행. */
export const coreInstallSql = opts => shaper(opts)(liveCore) + `;\nrevoke all on function public._refund_membership_core(uuid, uuid, boolean, boolean) from public, anon, authenticated, service_role;`;

/** 월드 기본 스키마 + 라이브 함수/트리거 설치 SQL (PGlite·실제 PostgreSQL 공용). */
export function baseWorldSql(opts = {}) {
  const shape = shaper(opts);
  return `
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    create function my_account_id() returns uuid language sql stable as $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;
    create table perms(account_id uuid, center_id uuid, perm text);
    create function has_permission(c uuid, p text) returns boolean language sql stable as $$ select exists (select 1 from perms where account_id = my_account_id() and center_id = c and perm = p) $$;
    create function is_platform_admin() returns boolean language sql stable as $$ select coalesce(current_setting('app.platform_admin', true), '') = 'on' $$;
    create table accounts(id uuid primary key, auth_id uuid, merged_into uuid);
    create table account_auth_identities(account_id uuid, auth_id uuid);
    create table profiles(id uuid primary key, account_id uuid);
    create function my_profile_ids() returns setof uuid language sql stable as $$ select id from profiles where account_id = my_account_id() $$;
    create table centers(id uuid primary key, name text default 'c', is_internal boolean not null default false);
    create table center_settlement_accounts(center_id uuid, bank_name text, account_number text, account_holder_name text);
    create table products(id uuid primary key, center_id uuid, name text, purchase_count_selectable boolean default false, unlimited_pass boolean default false, total_count int default 10,
      expiry_mode text default 'none', expiry_date date, expiry_days int, rolling_month_cutoff_day int default 15, rolling_month_allow_early_use boolean default false);
    create table orders(id uuid primary key default gen_random_uuid(), profile_id uuid, center_id uuid, product_id uuid, product_name text, amount int default 10000, selected_count int,
      selected_day_of_week int, selected_start_time time, selected_size text, auto_book boolean, member_coupon_id uuid,
      status text default 'pending' constraint orders_status_check check (status in ('pending','paid','cancelled','done')),
      paid_at timestamptz, verified boolean default true, pay_method text default 'card',
      payment_provider text constraint orders_payment_provider_check check (payment_provider is null or payment_provider in ('mock','toss','portone')));
    create table memberships(id uuid primary key default gen_random_uuid(), profile_id uuid, center_id uuid, product_id uuid, product_name text, pass_type text, total_count int, remaining_count int,
      expires_at date, starts_at date, status text default 'active', bound_day_of_week int, bound_start_time time, selected_size text, auto_book_requested boolean, pg_refund_started_at timestamptz);
    create table payments(id uuid primary key default gen_random_uuid(), center_id uuid, profile_id uuid, membership_id uuid, order_id uuid, sale_type text, revenue_category text,
      card_amount int, cash_amount int, transfer_amount int, point_amount int, direct_amount int, total_amount int, unpaid_amount int, pg_transaction_id text, paid_at timestamptz, status text, memo text,
      payment_provider text constraint payments_payment_provider_check check (payment_provider is null or payment_provider in ('mock','toss','portone')));
    create table member_coupons(id uuid primary key, status text, used_at timestamptz, order_id uuid);
    create table center_members(center_id uuid, profile_id uuid, status text default 'active');
    create table restored_points(order_id uuid, reason text);
    create function _refund_block_reason(m memberships, b boolean default false) returns text language sql as $$ select null::text $$;
    create function _restore_order_points(o uuid, r text) returns void language sql as $$ insert into restored_points values (o, r) $$;
    create function ensure_center_member(uuid, uuid) returns void language sql as $$ select 1 $$;
    create function member_can_purchase_product(uuid, uuid) returns boolean language sql as $$ select true $$;
    create function _order_expected_amount(o orders, b boolean) returns int language sql as $$ select o.amount $$;
    create function _order_auto_book(uuid, boolean) returns jsonb language sql as $$ select '{}'::jsonb $$;
    insert into centers values ('${C1}', 'c1', false), ('${CI}', 'ci', true);
    insert into accounts values ('${ACC}', '${AUTH}', null);
    insert into profiles values ('${P1}', '${ACC}');
    insert into products(id, center_id, name) values ('${PROD}', '${C1}', 'p');
    insert into perms values ('${MGR}', '${C1}', 'pass.payment.create'), ('${MGR}', '${CI}', 'pass.payment.create');
    insert into center_settlement_accounts values ('${C1}', 'bank', '123', 'holder');
    ${liveAccountFor}
    ${liveForceInsert}
    ${liveStatusGuard}
    ${liveRestoreTrigger}
    ${shape(liveHelper)}
    ${shape(liveFulfill)}
    ${liveRefundWrappers}
    ${liveRefundContext}
    ${liveRefundBegin}
    ${liveConfirmReal}
    ${liveCancelReal}
    ${liveConfirmTest}
    ${shape(liveSettlement)}
    revoke all on function public._issue_membership_and_record_payment(orders, text, text) from public, anon, authenticated, service_role;
`;
}
