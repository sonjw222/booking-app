-- 읽기 전용 사전 점검 — add_expired_order_resolution_20261031.sql 적용 "전"에 SQL Editor 에서 실행(변경 없음).
select
  to_regprocedure('public.fixed_expiry_passed(text,date)') is not null                                                    as pr251_applied_must_be_true,       -- fix_expired_fixed_date_products_20261031.sql
  md5(pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure)) = 'b675acdd9c48bba4b4a80891cbba0a76'                                  as fulfill_order_is_pre_state_must_be_true,
  to_regclass('public.order_expiry_resolutions') is null                                                                   as table_not_yet_created_must_be_true,
  to_regprocedure('public.manager_resolve_expired_order(uuid,text,text,integer,date,text,date,date)') is null              as rpc_not_yet_created_must_be_true,
  to_regprocedure('public.has_permission(uuid,text)') is not null and to_regprocedure('public.my_account_id()') is not null as helpers_exist_must_be_true,
  (select count(*) from pg_trigger where tgrelid = 'public.orders'::regclass and tgname in ('orders_guard_status_transition','orders_restore_points_on_cancel') and not tgisinternal) as order_triggers_must_be_2,
  (select count(*) from pg_trigger where tgrelid = 'public.orders'::regclass and tgname = 'orders_guard_expired_resolution') = 0 as status_guard_not_yet_created_must_be_true;
-- 참고(대상 규모): 만료된 고정 만료일 상품의 pending 주문 — 이 기능으로 처리할 대상
select substr(o.id::text, 1, 8) as order_prefix, o.status, o.pay_method, o.payment_provider, o.amount, to_char(o.created_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') as created_kst,
       p.expiry_date, o.points_used, (o.member_coupon_id is not null) as has_coupon
  from orders o join products p on p.id = o.product_id
 where o.status = 'pending' and fixed_expiry_passed(p.expiry_mode, p.expiry_date) order by o.created_at;
