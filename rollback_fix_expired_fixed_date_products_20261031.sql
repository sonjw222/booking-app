-- fix_expired_fixed_date_products_20261031.sql 되돌리기 (2026-10-31, 검토용 — 운영 미실행): 목록 함수 3개·create_order_secure·orders 정책을 적용 전 운영 정의로 복원하고 신규 함수 2개를 삭제한다. 데이터 변경 없음.
-- 안전장치: 현재 정의가 (이 파일 적용본) 또는 (이미 적용 전 정의)가 아니면 덮어쓰지 않고 중단한다. 한 트랜잭션.
-- ⚠ 되돌리면 만료일이 지난 상품이 다시 공개 목록·구매 목록에 보이고 신규 주문도 가능해진다(기존 데이터는 그대로).
begin;
do $$
declare r record; v_h text;
begin
    for r in select * from (values
            ('public.fetch_public_storefront_products(uuid)', 'b40c8da87ee36e7cfd6d3e2cb1880d4c', 'f8c385903d9385900f58dc02254ae616'),
            ('public.fetch_public_storefront_product_periods(uuid)', 'a75179807f56a6027b65a3b6ab1bef15', 'a1ad0e63c292f287fc8852d190602139'),
            ('public.fetch_purchasable_products(uuid)', '04286c619a7edb2e2becd98b70394f42', '060c642011bf72e4d14533db58bc552f'),
            ('public.create_order_secure(uuid,text,text,integer,boolean,text)', '65c18454f065b8cf19f0e6713dd58bee', '3012e68e4a87f40521d314e64d7e82e4')
        ) as t(sig, pre_md5, post_md5)
    loop
        v_h := md5(pg_get_functiondef(to_regprocedure(r.sig)));
        if v_h <> r.pre_md5 and v_h <> r.post_md5 then
            raise exception '% 의 현재 정의가 예상과 달라요(해시 %) — 덮어쓰지 않고 중단합니다', r.sig, v_h;
        end if;
    end loop;
end $$;

alter policy "주문 본인 생성" on public.orders with check (
    (profile_id in (select my_profile_ids() as my_profile_ids)) and ((product_id is null) or member_can_purchase_product(product_id, profile_id))
);
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
CREATE OR REPLACE FUNCTION public.fetch_public_storefront_product_periods(p_center_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(product_id uuid, expiry_mode text, expiry_days integer, expiry_date date, rolling_month_cutoff_day integer, rolling_month_allow_early_use boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
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
CREATE OR REPLACE FUNCTION public.create_order_secure(p_product_id uuid, p_pay_method text DEFAULT NULL::text, p_selected_size text DEFAULT NULL::text, p_point_used integer DEFAULT 0, p_auto_book boolean DEFAULT false, p_provider text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_profile_id uuid;
    v_product    record;
    v_amount     int;
    v_order_id   uuid;
begin
    -- 대표 프로필 우선, 없으면 가장 먼저 만든 프로필 (기존 lib/orders.ts의 createOrder와
    -- 동일한 선택 규칙)
    select id into v_profile_id from profiles
    where account_id = my_account_id()
    order by is_primary desc, created_at asc
    limit 1;
    if v_profile_id is null then
        raise exception '프로필을 찾을 수 없어요. 프로필 관리에서 프로필을 만들어주세요.';
    end if;

    select * into v_product from products where id = p_product_id;
    if not found then
        raise exception '상품을 찾을 수 없어요';
    end if;
    if not v_product.is_active or not v_product.is_on_sale then
        raise exception '지금은 구매할 수 없는 상품이에요';
    end if;

    if p_provider is not null and p_provider not in ('mock', 'toss', 'portone', 'nicepay') then
        raise exception '잘못된 결제 provider예요';
    end if;

    -- 포인트는 여기서 직접 차감(use_points가 실제 잔액을 확인·차감·로그까지 원자적으로
    -- 처리) — 클라이언트가 미리 차감해두고 "이만큼 썼다"고 주장하는 값을 그대로 믿지
    -- 않는다. 잔액 부족이면 use_points가 예외를 던져 여기서 전체 롤백된다.
    if p_point_used > 0 then
        perform use_points(v_product.center_id, v_profile_id, p_point_used);
    end if;

    v_amount := v_product.price - greatest(p_point_used, 0);
    if v_amount < 0 then
        raise exception '포인트 사용액이 상품 가격을 초과할 수 없어요';
    end if;

    insert into orders (
        center_id, profile_id, product_id, product_name, amount,
        pay_method, selected_size, auto_book, payment_provider,
        status, verified
    ) values (
        v_product.center_id, v_profile_id, v_product.id, v_product.name, v_amount,
        p_pay_method, p_selected_size, coalesce(p_auto_book, false), p_provider,
        'pending', true
    ) returning id into v_order_id;

    return v_order_id;
end;
$function$;
drop function if exists public.product_fixed_expiry_passed(uuid);
drop function if exists public.fixed_expiry_passed(text, date);

do $$
declare r record;
begin
    for r in select * from (values
            ('public.fetch_public_storefront_products(uuid)', 'b40c8da87ee36e7cfd6d3e2cb1880d4c', 'f8c385903d9385900f58dc02254ae616'),
            ('public.fetch_public_storefront_product_periods(uuid)', 'a75179807f56a6027b65a3b6ab1bef15', 'a1ad0e63c292f287fc8852d190602139'),
            ('public.fetch_purchasable_products(uuid)', '04286c619a7edb2e2becd98b70394f42', '060c642011bf72e4d14533db58bc552f'),
            ('public.create_order_secure(uuid,text,text,integer,boolean,text)', '65c18454f065b8cf19f0e6713dd58bee', '3012e68e4a87f40521d314e64d7e82e4')
        ) as t(sig, pre_md5, post_md5)
    loop
        if md5(pg_get_functiondef(to_regprocedure(r.sig))) <> r.pre_md5 then
            raise exception '% 복원 결과가 적용 전 운영 정의와 달라요 — 트랜잭션 전체를 롤백합니다', r.sig; end if;
    end loop;
    if (select md5(pg_get_expr(polwithcheck, polrelid)) from pg_policy where polrelid = 'public.orders'::regclass and polname = '주문 본인 생성') <> md5('((profile_id IN ( SELECT my_profile_ids() AS my_profile_ids)) AND ((product_id IS NULL) OR member_can_purchase_product(product_id, profile_id)))') then
        raise exception 'orders 정책 복원 결과가 적용 전과 달라요 — 롤백'; end if;
end $$;
commit;
