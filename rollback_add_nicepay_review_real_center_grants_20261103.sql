-- add_nicepay_review_real_center_grants_20261103.sql 되돌리기: 함수 3개를 P2(add_nicepay_review_center_isolation_20261028.sql) 정의로 복원하고, 이 파일이 만든 객체를 삭제한다.
-- ⚠ 허용 목록 테이블(nicepay_review_center_grants)은 지정 이력이 들어 있을 수 있어 행이 있으면 기본적으로 중단한다(데이터 보존). 지워도 좋다고 판단하면 먼저
--   delete from nicepay_review_center_grants;  를 사용자가 직접 실행한 뒤 이 스크립트를 다시 실행한다. (기존 센터·상품·주문 데이터는 이 롤백이 건드리지 않는다.)
-- 롤백 순서: 이 파일 → (필요하면) rollback_add_nicepay_review_center_isolation_20261028.sql. 반대로 P2 를 먼저 롤백하면 이 파일의 함수가 의존 대상을 잃는다.
BEGIN;
do $$
begin
  if to_regclass('public.nicepay_review_center_grants') is not null and exists (select 1 from nicepay_review_center_grants) then
    raise exception '롤백 중단: 허용 목록에 행이 있어요(% 건). 내용을 확인하고 필요 없으면 delete from nicepay_review_center_grants; 를 먼저 실행하세요.', (select count(*) from nicepay_review_center_grants);
  end if;
end $$;

-- P2 정의 복원 (가드 트리거 함수가 purchase_allowed 를 더 이상 참조하지 않도록 먼저 복원)
create or replace function nicepay_review_guard_center()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_a uuid; v_b uuid; v_row jsonb := to_jsonb(new);
begin
  if not nicepay_is_client_request() then return new; end if;
  if tg_table_name = 'reservations' then
    select c.center_id into v_a from classes c where c.id = (v_row->>'class_id')::uuid;           -- 수업의 센터
    select m.center_id into v_b from memberships m where m.id = (v_row->>'membership_id')::uuid;  -- 수강권의 센터
    if v_a is not null and v_b is not null and v_a <> v_b then raise exception '수업과 수강권의 센터가 일치하지 않아요'; end if;
  else
    v_a := nullif(v_row->>'center_id', '')::uuid;                                                  -- 행이 주장하는 센터
    select p.center_id into v_b from products p where p.id = (v_row->>'product_id')::uuid;        -- 상품의 실제 센터
    if v_a is not null and v_b is not null and v_a <> v_b then raise exception '센터와 상품이 일치하지 않아요'; end if;
  end if;
  if v_a is not null and not nicepay_review_center_member_allowed(v_a) then raise exception '이 센터의 상품·수업은 이용할 수 없어요'; end if;
  if v_b is not null and not nicepay_review_center_member_allowed(v_b) then raise exception '이 센터의 상품·수업은 이용할 수 없어요'; end if;
  return new;
end $$;
do $$
declare t text; ins text := 'trg_%s_nicepay_review_guard'; upd text := 'trg_%s_nicepay_review_guard_upd';
begin
  foreach t in array array['orders','memberships','cart_items','purchase_requests'] loop
    execute format('drop trigger if exists %I on %I', format(ins, t), t);
    execute format('create trigger %I before insert on %I for each row execute function nicepay_review_guard_center()', format(ins, t), t);
    execute format('drop trigger if exists %I on %I', format(upd, t), t);
    execute format('create trigger %I before update of center_id, product_id on %I for each row when (old.center_id is distinct from new.center_id or old.product_id is distinct from new.product_id) execute function nicepay_review_guard_center()', format(upd, t), t);
  end loop;
  execute 'drop trigger if exists trg_reservations_nicepay_review_guard on reservations';
  execute 'create trigger trg_reservations_nicepay_review_guard before insert on reservations for each row execute function nicepay_review_guard_center()';
  execute 'drop trigger if exists trg_reservations_nicepay_review_guard_upd on reservations';
  execute 'create trigger trg_reservations_nicepay_review_guard_upd before update of class_id, membership_id on reservations for each row when (old.class_id is distinct from new.class_id or old.membership_id is distinct from new.membership_id) execute function nicepay_review_guard_center()';
end $$;

-- 목록 RPC 3개(SECURITY DEFINER — RLS 우회). 현재 정의 + nicepay_review_center_allowed 조건만 추가.
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
      and nicepay_review_center_member_allowed(c.id)   -- [NICEPAY 심사 분리] 심사 센터는 심사관에게만, 심사관에게는 심사 센터만
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
      and nicepay_review_center_member_allowed(p.center_id)   -- [NICEPAY 심사 분리]
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
      and nicepay_review_center_member_allowed(c.id)   -- [NICEPAY 심사 분리]
      and (p_center_id is null or p.center_id = p_center_id)
    limit 500;
$$;

create or replace function nicepay_review_center_member_allowed(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select case
        when p_center_id is null then true
        when is_platform_admin() then true
        when nicepay_is_reviewer() then exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review)
        else nicepay_review_center_allowed(p_center_id)
    end;
$$;

create or replace function nicepay_review_center_allowed(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select case
        when p_center_id is null then true
        when is_platform_admin() or p_center_id in (select my_managed_center_ids()) then true
        when exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review) then nicepay_is_reviewer()
        else not nicepay_is_reviewer()
    end;
$$;

drop function if exists nicepay_my_review_center_ids();
drop function if exists nicepay_review_center_purchase_allowed(uuid);
drop function if exists nicepay_review_center_purchase_granted(uuid);
drop function if exists nicepay_review_center_granted(uuid);
drop trigger if exists trg_nicepay_review_center_grant_valid on nicepay_review_center_grants;
drop function if exists enforce_nicepay_review_center_grant_valid();
drop table if exists nicepay_review_center_grants;
COMMIT;
