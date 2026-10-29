-- ============================================================
-- 만료 상품 자동 노출 종료 및 신규 구매 차단 (2026-10-31, 검토용 제안 — 운영·공유 DEV 미실행)
--
-- 규칙: products.expiry_mode = 'date' 이고 products.expiry_date 가 한국 시간(Asia/Seoul) 기준 "오늘"보다 이전이면 구매 불가 상품으로 본다.
--       오늘·미래 만료일은 그대로 노출, expiry_mode='days'·'rolling_month'·'none' 은 기존 동작 그대로. 데이터는 하나도 바꾸지 않는다(is_on_sale·is_active·expiry_date 불변, cron·UPDATE 없음 — 조회 시점에 날짜로 계산).
-- 바뀌는 것(전부 CREATE OR REPLACE / ALTER POLICY, 테이블 데이터 변경 없음):
--   신규 함수 2: fixed_expiry_passed(text,date)(순수 계산), product_fixed_expiry_passed(uuid)(주문 정책용 SECURITY DEFINER)
--   목록 함수 3(만료 상품 제외 조건 1줄씩 추가): fetch_public_storefront_products, fetch_public_storefront_product_periods, fetch_purchasable_products
--   주문 생성: create_order_secure(만료 상품이면 예외), orders INSERT 정책 "주문 본인 생성"(만료 상품이면 거부 — 클라이언트가 orders 에 직접 INSERT 해도 막힘)
-- 일부러 바꾸지 않는 것: member_can_purchase_product — 결제 확정·발급(_issue_membership_and_record_payment)이 이 함수로 "구매 자격"을 다시 확인한다.
--   만료일 뒤에 확정되는 기존 pending 주문의 발급이 막혀 결제만 되고 수강권이 안 생기는 사고를 막기 위해, "신규 주문"만 별도 함수·정책으로 막는다. 환불·취소·기존 수강권·예약·구매내역도 영향 없음.
--   관리자 상품 관리(products 직접 조회·수정), manager_grant_product(관리자 지급)도 그대로.
-- NICEPAY P2/P2b 호환: 목록 함수 3개는 P2 가 만든 현재 운영 정의(nicepay_review_center_member_allowed 조건 포함)에 만료 조건 한 줄만 추가한다 — 심사 센터 격리 조건 보존.
--   P2/P2b 를 다시 실행하지 않으며, 이 파일 이후에 P2 를 재실행하면 목록 함수 3개가 옛 정의로 되돌아가므로 하지 말 것(해시 가드가 이 파일 적용본 해시도 허용하지 않는 정의면 중단한다).
-- 안전장치: 대상 함수 4개의 "현재 정의 해시"와 정책 식이 (적용 전 운영 정의) 또는 (이 파일 적용본)과 정확히 같을 때만 진행한다. 다르면(운영에서 따로 바뀜) 덮어쓰지 않고 중단한다. 한 트랜잭션 — 중간 실패 시 전체 롤백.
-- 확인: verify_fix_expired_fixed_date_products_20261031.sql(읽기 전용). 되돌리기: rollback_fix_expired_fixed_date_products_20261031.sql.
-- ============================================================
begin;
do $$
declare r record; v_h text; v_pol text;
begin
    for r in select * from (values
            ('public.fetch_public_storefront_products(uuid)', 'b40c8da87ee36e7cfd6d3e2cb1880d4c', 'f8c385903d9385900f58dc02254ae616'),
            ('public.fetch_public_storefront_product_periods(uuid)', 'a75179807f56a6027b65a3b6ab1bef15', 'a1ad0e63c292f287fc8852d190602139'),
            ('public.fetch_purchasable_products(uuid)', '04286c619a7edb2e2becd98b70394f42', '060c642011bf72e4d14533db58bc552f'),
            ('public.create_order_secure(uuid,text,text,integer,boolean,text)', '65c18454f065b8cf19f0e6713dd58bee', '3012e68e4a87f40521d314e64d7e82e4')
        ) as t(sig, pre_md5, post_md5)
    loop
        if to_regprocedure(r.sig) is null then raise exception '% 가 없어요 — 선행 SQL 이 적용돼 있어야 해요', r.sig; end if;
        v_h := md5(pg_get_functiondef(to_regprocedure(r.sig)));
        if v_h <> r.pre_md5 and v_h <> r.post_md5 then
            raise exception '% 의 현재 정의가 예상(적용 전 운영 정의/이 파일 적용본)과 달라요(해시 %) — 덮어쓰지 않고 중단합니다', r.sig, v_h;
        end if;
    end loop;
    select pg_get_expr(polwithcheck, polrelid) into v_pol from pg_policy where polrelid = 'public.orders'::regclass and polname = '주문 본인 생성' and polcmd = 'a';
    if v_pol is null then raise exception 'orders 정책 "주문 본인 생성" 이 없어요 — 중단'; end if;
    if md5(v_pol) <> md5('((profile_id IN ( SELECT my_profile_ids() AS my_profile_ids)) AND ((product_id IS NULL) OR member_can_purchase_product(product_id, profile_id)))') and md5(v_pol) <> '35a7c89729127c9c246e01a4ed524f0d' then
        raise exception 'orders 정책 "주문 본인 생성" 의 현재 식이 예상과 달라요 — 덮어쓰지 않고 중단합니다'; end if;
end $$;

create or replace function public.fixed_expiry_passed(p_expiry_mode text, p_expiry_date date)
returns boolean language sql stable set search_path = public as $f$
    -- 고정 만료일(expiry_mode='date')이 한국 시간(Asia/Seoul) 기준 "오늘"보다 이전이면 true. 오늘·미래·다른 만료 방식(days/rolling_month/none)·정보 없음은 false.
    select coalesce(p_expiry_mode = 'date' and p_expiry_date is not null and p_expiry_date < (now() at time zone 'Asia/Seoul')::date, false);
$f$;
comment on function public.fixed_expiry_passed(text, date) is '2026-10-31 만료 상품 자동 노출 종료: 고정 만료일(KST)이 지났는지. 데이터를 바꾸지 않고 조회 시점에 계산한다.';
grant execute on function public.fixed_expiry_passed(text, date) to public, anon, authenticated, service_role;

create or replace function public.product_fixed_expiry_passed(p_product_id uuid)
returns boolean language sql stable security definer set search_path = public as $f$
    -- 주문 INSERT 정책(WITH CHECK)용: 호출자의 RLS 로 상품 행이 가려져도 만료 여부는 정확히 판정한다(SECURITY DEFINER). 상품이 없으면 false.
    select coalesce((select public.fixed_expiry_passed(p.expiry_mode, p.expiry_date) from products p where p.id = p_product_id), false);
$f$;
comment on function public.product_fixed_expiry_passed(uuid) is '2026-10-31 만료 상품: 상품 id 기준 만료 여부(주문 INSERT 정책용).';
revoke all on function public.product_fixed_expiry_passed(uuid) from public, anon;
grant execute on function public.product_fixed_expiry_passed(uuid) to authenticated, service_role;

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
      and not fixed_expiry_passed(p.expiry_mode, p.expiry_date)   -- [만료 상품] 고정 만료일(KST)이 오늘보다 이전이면 목록에서 제외
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
      and not fixed_expiry_passed(p.expiry_mode, p.expiry_date)   -- [만료 상품] 고정 만료일(KST)이 오늘보다 이전이면 목록에서 제외
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
      and not fixed_expiry_passed(p.expiry_mode, p.expiry_date)   -- [만료 상품] 고정 만료일(KST)이 오늘보다 이전이면 목록에서 제외
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
    -- [만료 상품] 고정 만료일(KST)이 지난 상품은 신규 주문을 만들 수 없다(이미 만든 pending 주문의 확정·발급은 이 함수와 무관하게 그대로 진행된다).
    if fixed_expiry_passed(v_product.expiry_mode, v_product.expiry_date) then
        raise exception '판매 기간이 지난 상품이라 구매할 수 없어요';
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
alter policy "주문 본인 생성" on public.orders with check (
    (profile_id in (select my_profile_ids() as my_profile_ids))
    and ((product_id is null) or (member_can_purchase_product(product_id, profile_id) and not product_fixed_expiry_passed(product_id)))
);

do $$
declare r record; v_pol text;
begin
    for r in select * from (values
            ('public.fetch_public_storefront_products(uuid)', 'b40c8da87ee36e7cfd6d3e2cb1880d4c', 'f8c385903d9385900f58dc02254ae616'),
            ('public.fetch_public_storefront_product_periods(uuid)', 'a75179807f56a6027b65a3b6ab1bef15', 'a1ad0e63c292f287fc8852d190602139'),
            ('public.fetch_purchasable_products(uuid)', '04286c619a7edb2e2becd98b70394f42', '060c642011bf72e4d14533db58bc552f'),
            ('public.create_order_secure(uuid,text,text,integer,boolean,text)', '65c18454f065b8cf19f0e6713dd58bee', '3012e68e4a87f40521d314e64d7e82e4')
        ) as t(sig, pre_md5, post_md5)
    loop
        if md5(pg_get_functiondef(to_regprocedure(r.sig))) <> r.post_md5 then
            raise exception '% 적용 결과 정의 해시가 기대값과 달라요 — 트랜잭션 전체를 롤백합니다', r.sig; end if;
    end loop;
    select pg_get_expr(polwithcheck, polrelid) into v_pol from pg_policy where polrelid = 'public.orders'::regclass and polname = '주문 본인 생성';
    if md5(v_pol) <> '35a7c89729127c9c246e01a4ed524f0d' then raise exception 'orders 정책 적용 결과가 기대와 달라요 — 롤백'; end if;
end $$;
commit;
