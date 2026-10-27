-- add_nicepay_review_center_isolation_20261028.sql 되돌리기: 정책·트리거·신규 함수 삭제, 함수 4개를 이전 정의로 복원. centers.is_nicepay_review 컬럼과 심사 센터 데이터는 남긴다(데이터 보존).
-- 주의: 되돌리면 심사 센터가 일반 회원에게도 보인다 — 심사 센터 데이터를 만든 상태라면 먼저 해당 센터를 비공개(status 변경 또는 삭제는 별도 승인)로 두고 실행.
BEGIN;
drop policy if exists "nicepay_review_isolation" on centers;
drop policy if exists "nicepay_review_isolation" on classes;
drop policy if exists "nicepay_review_isolation" on products;
drop trigger if exists trg_orders_nicepay_review_guard on orders;
drop trigger if exists trg_memberships_nicepay_review_guard on memberships;
drop trigger if exists trg_reservations_nicepay_review_guard on reservations;
drop trigger if exists trg_centers_nicepay_review_admin_only on centers;
create or replace function public.center_rows_visible(p_center_id uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $$
    select coalesce(
        p_center_id is null
        or not exists (select 1 from public.centers c where c.id = p_center_id and c.is_internal)
        or p_center_id in (select public.my_member_center_ids())
        or p_center_id in (select public.my_managed_center_ids())
        or public.is_platform_admin(),
        false);
$$;

CREATE OR REPLACE FUNCTION public.fetch_public_storefront_products(p_center_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, center_id uuid, center_name text, name text, price integer, product_kind text, description text, total_count integer, unlimited boolean, unlimited_pass boolean, group_label text, remaining integer, purchase_count_selectable boolean, min_purchase_count integer, max_purchase_count integer, min_tier_price integer, max_tier_price integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select
        p.id,
        p.center_id,
        c.name,
        p.name,
        p.price,
        p.product_kind,
        p.description,
        p.total_count,
        p.unlimited,
        p.unlimited_pass,
        p.group_label,
        case
            when p.max_quantity is null then null
            else greatest(
                0,
                p.max_quantity - (
                    select count(*)::int from memberships m
                    where m.product_id = p.id and m.status <> 'refunded'
                )
            )
        end,
        coalesce(p.purchase_count_selectable, false),
        (select min(t.count) from product_count_prices t where t.product_id = p.id),
        (select max(t.count) from product_count_prices t where t.product_id = p.id),
        (select min(t.price) from product_count_prices t where t.product_id = p.id),
        (select max(t.price) from product_count_prices t where t.product_id = p.id)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal   -- QA/내부 센터는 공개 목록에 절대 나오지 않는다
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      -- 횟수 선택형인데 가격표가 아직 없으면(설정 중) 공개하지 않는다
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and (p_center_id is null or p.center_id = p_center_id)
    order by c.name asc, p.product_kind asc, p.price asc
    limit 500;
$function$;
revoke all on function fetch_public_storefront_products(uuid) from public;
grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;

CREATE OR REPLACE FUNCTION public.fetch_purchasable_products(p_center_id uuid)
 RETURNS SETOF products
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select p.* from products p
    where p.center_id = p_center_id
      -- QA/내부 센터(centers.is_internal)는 그 센터의 회원/관리자만 상품을 조회할 수 있다(UUID를 알아도 일반 계정은 빈 목록)
      and (
        not exists (select 1 from centers c where c.id = p.center_id and c.is_internal)
        or p.center_id in (select my_member_center_ids())
        or p.center_id in (select my_managed_center_ids())
      )
      and p.is_active
      and p.is_on_sale
      and (
        p.visibility_type = 'all'
        or (
            p.visibility_type = 'grades' and exists (
                select 1 from membership_product_grades mpg
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.grade_id = mpg.grade_id
                where mpg.product_id = p.id
            )
        )
        or (
            p.visibility_type = 'selected_members' and exists (
                select 1 from membership_product_members mpm
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.id = mpm.center_member_id
                where mpm.product_id = p.id
            )
        )
      )
    order by p.product_kind asc, p.price asc;
$function$;
revoke all on function public.fetch_purchasable_products(uuid) from public, anon;
grant execute on function public.fetch_purchasable_products(uuid) to authenticated, service_role;

-- periods 함수는 add_public_storefront_product_periods_20261027.sql 의 정의로 복원(그 파일을 적용하지 않았다면 이 함수는 없던 것이므로 삭제)
do $do$ begin
  if to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null then
    execute $f$create or replace function fetch_public_storefront_product_periods(p_center_id uuid default null)
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
$$;$f$;
  end if;
end $do$;
drop function if exists nicepay_review_guard_center();
drop function if exists enforce_center_nicepay_review_admin_only();
drop function if exists nicepay_review_center_allowed(uuid);
drop function if exists nicepay_is_reviewer();
COMMIT;
