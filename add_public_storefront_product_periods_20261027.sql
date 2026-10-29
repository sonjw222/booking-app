-- ============================================================
-- 공개 판매상품의 이용기간 원본 조회 RPC (추가 전용, 검토용 — 실행하지 않음)
--
-- 배경: NICEPAY 카드사 심사 사전 보완 요청 — "서비스 제공기간(시작일~종료일)과 사전예약기간(결제일~서비스 시작일)을 고객이 확인할 수 있게 명시".
-- 로그인 회원용 상품 목록(fetch_purchasable_products = select p.*)은 이미 expiry_* 컬럼을 반환하므로 앱만 고치면 된다.
-- 비로그인 공개 목록(fetch_public_storefront_products)은 반환 컬럼이 고정돼 있고 RETURNS TABLE 시그니처는 create or replace 로 바꿀 수 없다(바꾸려면 DROP 필요).
-- 그래서 기존 함수는 건드리지 않고, 같은 노출 조건으로 "상품 id + 이용기간 원본 5개 컬럼"만 돌려주는 새 함수를 추가한다.
--
-- 안전:
--  · 새 함수만 추가한다. 테이블/컬럼/기존 함수/정책을 바꾸거나 지우지 않는다. 데이터 변경 없음.
--  · 노출 조건은 fetch_public_storefront_products 와 동일하다(승인된 센터, 내부 QA 센터 제외, 활성·판매중·전체공개, 횟수 선택형은 가격표가 있는 것만).
--  · 반환 컬럼은 이용기간 원본뿐이다(가격·설명·판매 수량 등 다른 정보를 추가로 공개하지 않는다).
--  · SECURITY DEFINER + search_path 고정, PUBLIC 권한 회수 후 anon/authenticated 에만 실행 허용.
--  · 앱은 이 함수가 없거나 실패하면 조용히 무시하고 "기간 공통 안내"만 보인다(앱이 먼저 배포돼도 안전).
-- 되돌리기: rollback_add_public_storefront_product_periods_20261027.sql
-- 확인(읽기 전용): verify_add_public_storefront_product_periods_20261027.sql
-- ============================================================

create or replace function fetch_public_storefront_product_periods(p_center_id uuid default null)
returns table (
    product_id uuid,
    expiry_mode text,
    expiry_days integer,
    expiry_date date,
    rolling_month_cutoff_day integer,
    rolling_month_allow_early_use boolean
)
language sql
stable
security definer
set search_path = public
as $$
    select
        p.id,
        p.expiry_mode,
        p.expiry_days,
        p.expiry_date,
        p.rolling_month_cutoff_day,
        coalesce(p.rolling_month_allow_early_use, false)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and (p_center_id is null or p.center_id = p_center_id)
    limit 500;
$$;

revoke all on function fetch_public_storefront_product_periods(uuid) from public;
grant execute on function fetch_public_storefront_product_periods(uuid) to anon, authenticated;

comment on function fetch_public_storefront_product_periods(uuid) is
  '비로그인 포함 누구나 호출 가능. fetch_public_storefront_products 와 같은 노출 조건의 상품에 대해 이용기간 원본(expiry_mode/days/date, rolling_month 컷오프/early-use)만 반환한다.';

-- 확인(읽기 전용)
select
    to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null as function_exists,
    has_function_privilege('anon', 'fetch_public_storefront_product_periods(uuid)', 'execute') as anon_can_execute,
    has_function_privilege('authenticated', 'fetch_public_storefront_product_periods(uuid)', 'execute') as authenticated_can_execute;
