-- ============================================================
-- 비로그인 구매 화면의 예약조건 표시(2026-10-03) — 공개 상품의 예약조건(membership_schedule_rules)만 읽는 전용 RPC.
-- 문제: membership_schedule_rules SELECT RLS가 auth.uid() is not null 이라 비로그인 사용자는 공개 센터/공개 수강권을 봐도 예약조건 accordion이 비었다.
-- 원칙: 원본 테이블의 anon 권한/정책은 늘리지 않는다(using(true), grant select to anon 금지). 대신 SECURITY DEFINER RPC가
--   fetch_public_storefront_products(p_center_id)의 공개 경계를 "그대로 재사용"(함수 자체를 join)해서 독자적인 공개 판단을 만들지 않는다 —
--   승인 센터 / is_internal 제외 / 활성 / 판매중 / visibility_type='all' / 횟수 선택형은 가격표 있는 것만 — 그리고 product_kind='pass'만, 요청 center_id의 상품만.
--   등급 전용·지정 회원 전용·판매중지·비활성·내부 QA·미승인 센터 상품은 결과에 나오지 않는다(다른 센터/비공개 product는 이 함수 안에서 걸러져 0행).
-- 반환은 최소(product_id, day_of_week, start_time, class_title). 센터 단위 1회 호출(상품마다 호출하지 않는다).
-- 이 세션에서는 production에 실행하지 않았습니다. rollback_add_public_product_schedule_rules_20261003.sql 로 되돌립니다.
-- ============================================================
begin;

create or replace function public.fetch_public_product_schedule_rules(p_center_id uuid)
returns table (
    product_id   uuid,
    day_of_week  integer,
    start_time   time,
    class_title  text
)
language sql
stable
security definer
set search_path = public
as $$
    select r.product_id, r.day_of_week, r.start_time, r.class_title
      from public.membership_schedule_rules r
      join public.fetch_public_storefront_products(p_center_id) s on s.id = r.product_id
     where p_center_id is not null
       and s.center_id = p_center_id
       and s.product_kind = 'pass'
     order by r.product_id, r.created_at, r.id
     limit 5000;
$$;

revoke all on function public.fetch_public_product_schedule_rules(uuid) from public;
grant execute on function public.fetch_public_product_schedule_rules(uuid) to anon, authenticated;

commit;

-- 적용 후 확인(읽기 전용)
select
    has_function_privilege('anon', 'public.fetch_public_product_schedule_rules(uuid)', 'execute') as anon_rpc_must_be_true,
    has_function_privilege('authenticated', 'public.fetch_public_product_schedule_rules(uuid)', 'execute') as auth_rpc_must_be_true,
    (select count(*) from public.fetch_public_product_schedule_rules(null)) as null_center_must_be_0;
