-- 읽기 전용 사전 점검 (DDL/DML 없음) — SQL 적용 전에 실행해 "치환 위치가 운영 정의와 맞는지"를 미리 확인한다.
-- *_ok 가 모두 true 여야 add_nicepay_provider_support_20261016.sql / fix_create_order_secure_allow_nicepay_20261016.sql 이 중단 없이 적용된다.
-- (이미 패치된 상태면 해당 항목은 'patched'로 true 처리) 값/키/데이터는 출력하지 않는다.
with
 h as (select pg_get_functiondef('public._issue_membership_and_record_payment(orders,text,text)'::regprocedure) d),
 f as (select pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure) d),
 c as (select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) d),
 t as (select pg_get_functiondef('public.orders_guard_status_transition()'::regprocedure) d),
 s as (select pg_get_functiondef(to_regprocedure('public.admin_center_settlement_summary(date,date)')) d),
 o as (select pg_get_functiondef(to_regprocedure('public.create_order_secure(uuid,text,text,integer,boolean,text)')) d)
select
  (select position(chr(13) in d) > 0 from h)                                                                                       as info_helper_has_crlf,
  (select position(chr(13) in d) > 0 from f)                                                                                       as info_fulfill_has_crlf,
  (select d ~ 'case when p_order\.payment_provider = ''nicepay''' or ((select count(*) from regexp_matches(d, '(pg_transaction_id,\s*paid_at,\s*status,\s*memo)(\s*\)\s*values\s*\()', 'g')) = 1
                                                                       and (select count(*) from regexp_matches(d, '(p_memo)(\s*\)\s*;)', 'g')) = 1) from h)                 as helper_patch_ok,
  (select d ~ '-- fulfill_nicepay_guard begin' or ((select count(*) from regexp_matches(d, 'status\s*=\s*''done''\s+then\s+return\s+json_build_object\(\s*''already_done''\s*,\s*true\s*\)\s*;\s*end\s+if;', 'g')) = 1
                                                   and (select count(*) from regexp_matches(d, 'if\s+v_order\.status\s*=\s*''cancelled''\s+then\s+raise\s+exception\s+''취소된 주문은 발급할 수 없어요''\s*;\s*end\s+if;', 'g')) = 1
                                                   and d ~ 'v_order\s+orders') from f)                                                                                        as fulfill_patch_ok,
  (select d ~ '-- pg_unknown_origin_guard begin' or ((select count(*) from regexp_matches(d, 'raise\s+exception\s+''카드/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요''\s*;\s*end\s+if;', 'g')) = 1
                                                      and ((select count(*) from regexp_matches(d, 'o\.payment_provider\s+in\s*\(\s*''toss''\s*,\s*''portone''\s*\)', 'g')) = 1 or d ~ 'o\.payment_provider is not null and o\.payment_provider <> ''mock''')
                                                      and d ~ 'v_mem' and d ~ 'p_allow_pg') from c)                                                                   as refund_origin_patch_ok,
  (select d ~ '-- nicepay_pg_cancel_guard begin' or ((select count(*) from regexp_matches(d, 'raise\s+exception\s+''카드/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요''\s*;\s*end\s+if;', 'g')) = 1
                                                      and d ~ 'v_order_id' and d ~ 'v_amount') from c)                                                                       as refund_core_patch_ok,
  (select d ~ '-- pg_server_path_guard begin' or ((select count(*) from regexp_matches(d, 'raise\s+exception\s+''카드/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요''\s*;\s*end\s+if;', 'g')) = 1 and d ~ '-- pg_unknown_origin_guard begin' and d ~ 'v_mem') from c) as refund_server_path_patch_ok,
  (to_regprocedure('public.nicepay_checkout_mode()') is not null) as info_checkout_gate_installed,
  (select d ~ '-- pg_refund_amount begin' or ((select count(*) from regexp_matches(d, 'v_amount\s*:=\s*coalesce\(\s*v_amount\s*,\s*0\s*\)\s*;', 'g')) = 1 and d ~ 'v_order_id' and d ~ '-- pg_server_path_guard begin') from c) as refund_amount_patch_ok,
  (select d ~ '/\*insert_role_guard\*/' or ((select count(*) from regexp_matches(d, 'if\s+auth\.uid\(\)\s+is\s+not\s+null\s+then', 'g')) = 1 and d ~ 'new\.verified\s*:=\s*false') from (select pg_get_functiondef('public.orders_force_server_fields_on_insert()'::regprocedure) d) x) as orders_insert_guard_patch_ok,
  (select d ~ '-- pg_origin_context begin' or ((select count(*) from regexp_matches(d, 'v_provider\s+text\s*;', 'g')) = 1 and (select count(*) from regexp_matches(d, 'if\s+v_pay\.order_id\s+is\s+not\s+null\s+then\s+select\s+payment_provider\s+into\s+v_provider\s+from\s+orders\s+where\s+id\s*=\s*v_pay\.order_id\s*;\s*end\s+if;', 'g')) = 1) from (select pg_get_functiondef('public.pg_refund_context(uuid,uuid)'::regprocedure) d) x) as refund_context_patch_ok,
  (select d ~ '허용되지 않는 주문 상태 변경이에요'
      and d ~ 'old\.status\s*=\s*''pending''\s+and\s+new\.status\s+in\s*\(\s*''paid''\s*,\s*''done''\s*,\s*''cancelled''\s*\)'
      and d ~ 'old\.status\s*=\s*''paid''\s+and\s+new\.status\s+in\s*\(\s*''done''\s*,\s*''cancelled''\s*\)' from t)                  as status_trigger_ok,
  (select d is null or d ~ '''portone''\s*,\s*''nicepay''' or (select count(*) from regexp_matches(d, 'p\.payment_provider\s+in\s*\(\s*''toss''\s*,\s*''portone''\s*\)', 'g')) = 1 from s) as settlement_patch_ok_or_absent,
  (select d is not null and (d ~ '''portone''\s*,\s*''nicepay''' or (select count(*) from regexp_matches(d, '''mock''\s*,\s*''toss''\s*,\s*''portone''', 'g')) = 1) from o) as create_order_secure_patch_ok;
