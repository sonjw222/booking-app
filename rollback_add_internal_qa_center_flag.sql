-- ============================================================
-- add_internal_qa_center_flag.sql 롤백 — 정책/RPC를 적용 직전 라이브 정의로 복원하고 helper를 제거한다.
-- ⚠ 롤백하면 is_internal=true인 QA 센터가 다시 일반 사용자에게 보인다(승인 상태이므로). 먼저 QA 센터를 pending으로 돌리거나
--   is_internal 센터가 없는지 확인하세요: select id, name from centers where is_internal;
-- 컬럼 centers.is_internal은 데이터 보존을 위해 기본 유지(맨 아래 주석).
-- ============================================================
-- 정책 3개 + RPC 2개 + helper 제거를 한 트랜잭션으로 되돌린다(중간 실패 시 전부 롤백).
BEGIN;

drop policy if exists "승인된 센터 조회" on centers;
create policy "승인된 센터 조회"
    on centers for select using (
        status = 'approved'
        or id in (select my_managed_center_ids())
        or id in (select my_center_ids_any_status())
        or is_platform_admin()
    );

drop policy if exists "승인된 센터 수업 조회" on classes;
create policy "승인된 센터 수업 조회"
    on classes for select using (
        center_id in (select centers.id from centers where centers.status = 'approved')
        or center_id in (select my_managed_center_ids())
    );

drop policy if exists "상품 조회" on products;
create policy "상품 조회"
    on products for select using (
        center_id in (select centers.id from centers where centers.status = 'approved')
        or center_id in (select my_managed_center_ids())
    );

create or replace function fetch_public_storefront_products(p_center_id uuid default null)
returns table (
    id             uuid,
    center_id      uuid,
    center_name    text,
    name           text,
    price          integer,
    product_kind   text,
    description    text,
    total_count    integer,
    unlimited      boolean,
    unlimited_pass boolean,
    group_label    text,
    remaining      integer,
    purchase_count_selectable boolean,
    min_purchase_count        integer,
    max_purchase_count        integer,
    min_tier_price            integer,
    max_tier_price            integer
)
language sql
stable
security definer
set search_path = public
as $$
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
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      -- 횟수 선택형인데 가격표가 아직 없으면(설정 중) 공개하지 않는다
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and (p_center_id is null or p.center_id = p_center_id)
    order by c.name asc, p.product_kind asc, p.price asc
    limit 500;
$$;


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

drop function if exists my_member_center_ids();

COMMIT;

-- 데이터 보존을 위해 기본은 주석 처리 — 정말 지울 때만:
-- alter table centers drop column if exists is_internal;
