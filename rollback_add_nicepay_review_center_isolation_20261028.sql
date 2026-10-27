-- add_nicepay_review_center_isolation_20261028.sql 되돌리기: 정책·트리거·신규 함수 삭제, 함수 4개를 이전 정의로 복원. centers.is_nicepay_review 컬럼과 심사 센터 데이터는 남긴다(데이터 보존).
-- ⚠ 안전장치: 롤백하면 분리 규칙이 사라져 심사 센터·상품·수업이 일반 회원에게 보일 수 있다. 일반 공개 가능 상태(승인된 비내부 심사 센터)가 하나라도 있으면 이 스크립트는 아무것도 바꾸지 않고 중단한다.
--   먼저 심사 센터를 비공개로 돌린다. 센터 하나만 닫으면 그 센터의 상품·수업 직접 조회까지 같이 막힌다(기존 "상품 조회"/"승인된 센터 수업 조회" 정책이 승인된 비내부 센터만 허용).
--   방법 ① SQL Editor: update centers set is_internal = true where is_nicepay_review;   -- 심사 센터 행만. 기존 운영 센터 변경 없음(is_internal 은 별도 보호 트리거가 없다)
--   방법 ② 플랫폼 관리자 계정으로 센터 승인 상태를 되돌림(status 는 guard_center_status_change 트리거가 플랫폼 관리자만 변경 허용 — SQL Editor 의 postgres 로는 변경 불가).
--   그 뒤 이 스크립트를 실행한다. (심사 센터 데이터는 삭제하지 않는다.)
-- 복원 규칙(기간 RPC): 분리 SQL 이 그 함수를 새로 만들었다면(함수 주석 표식) 삭제, 분리 SQL 적용 전부터 있었다면 add_public_storefront_product_periods_20261027.sql 정의로 복원.
BEGIN;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_nicepay_review')
     and exists (select 1 from centers where is_nicepay_review and status = 'approved' and not is_internal) then
    raise exception '롤백 중단: 일반 사용자에게 공개될 수 있는 심사 센터가 있어요. 먼저 update centers set is_internal = true where is_nicepay_review; 를 실행하세요(또는 플랫폼 관리자가 센터 승인 상태를 되돌리세요).';
  end if;
end $$;
drop policy if exists "nicepay_review_isolation" on centers;
drop policy if exists "nicepay_review_isolation" on classes;
drop policy if exists "nicepay_own_reservation_class" on classes;
drop policy if exists "nicepay_review_isolation" on products;
do $$
declare t text;
begin
  foreach t in array array['orders','memberships','cart_items','purchase_requests','reservations'] loop
    execute format('drop trigger if exists %I on %I', format('trg_%s_nicepay_review_guard', t), t);
    execute format('drop trigger if exists %I on %I', format('trg_%s_nicepay_review_guard_upd', t), t);
  end loop;
end $$;
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

-- 기간 RPC: 분리 SQL 이 만든 것이면 삭제, 이전부터 있었으면 이전 정의로 복원
do $do$ begin
  if to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null then
    if coalesce(obj_description('fetch_public_storefront_product_periods(uuid)'::regprocedure, 'pg_proc'), '') like 'created_by:add_nicepay_review_center_isolation_20261028%' then
      drop function fetch_public_storefront_product_periods(uuid);
    else
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
  end if;
end $do$;
drop function if exists nicepay_class_has_my_reservation(uuid);
drop function if exists nicepay_review_guard_center();
drop function if exists enforce_center_nicepay_review_admin_only();
drop function if exists nicepay_review_center_allowed(uuid);
drop function if exists nicepay_is_reviewer();
COMMIT;
