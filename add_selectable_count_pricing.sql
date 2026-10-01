-- ============================================================
-- 수강권(pass)/상품(goods) 공통 "구매자가 횟수 선택 + 회차별 개별 가격표" (2026-10-01)
--
-- 문제: 같은 수강권/상품을 1회·2회·…·12회로 12개 product row로 등록해야 했고 구매 목록도 12줄이 됐다.
-- 요구: 상품 하나 안에서 구매자가 횟수를 고르고, 센터가 회차별 가격을 독립적으로 정한다(예: 6회 34,000원처럼
--   unit×count가 아닌 패키지 가격).
--
-- [설계 — 전체 사용처 감사 후 결정]
--   products.purchase_count_selectable boolean default false  — true면 가격표를 쓰는 선택형 상품(pass/goods 공통).
--     false(기존 모든 상품)는 products.total_count / products.price 의미가 100% 그대로.
--   product_count_prices (신규 child 테이블)                   — 회차별 가격. unique(product_id, count), count>=1, price>0,
--     products 삭제 시 cascade. price_1..price_12 같은 컬럼 확장/JSON 방식은 쓰지 않는다(20회·30회 확장, 서버 조회/제약/
--     집계 가능). "가격이 등록된 회차만 구매 가능" — 1,2,4,8,12회만 파는 구성도 되고 1~12 연속도 된다(min/max 컬럼 없음).
--   products.price(선택형)                                    — 호환 값 = 가격표의 최저 가격(RPC가 자동 동기화). 목록 정렬/
--     "~원부터" 표시/기존 쿼리가 계속 동작한다. 선택형 주문의 authoritative 금액은 절대 이 값이 아니라 가격표다.
--   * 별도 쓰기 정책 없이 RPC set_product_count_prices()로만 가격표를 바꾼다(전체 교체 + 검증 + products 동기화를 한 트랜잭션).
--
-- [주문 snapshot / 서버 검증]
--   orders.selected_count          — 구매자가 고른 횟수. 가격표에 없는 값이면 서버(BEFORE INSERT 트리거)가 거부.
--   orders.product_amount_snapshot — 주문 생성 시점에 서버가 가격표(선택형) 또는 상품가(고정)에서 확정한 "상품 기본금액".
--     이후 센터가 가격표를 바꿔도 기존 주문의 검증/발급 금액이 변하지 않는다. 쿠폰/포인트는 이 금액에서 서버가 다시 계산
--     (fix_order_issuance_and_auto_booking.sql). 같은 금액을 여러 컬럼에 중복 저장하지 않는다.
--   cart_items.selected_count      — 장바구니 선택 보존(가격은 표시용, 주문 시 서버가 다시 확정).
--   로그인 사용자는 주문의 selected_count / product_amount_snapshot / product_id를 UPDATE로 바꿀 수 없다(가드 트리거).
--   products.max_quantity("판매 가능한 membership 개수")는 의미 불변 — selected_count와 무관(구매 1건 = membership 1개).
--
-- 기존 "스케줄링수강권 1회~12회", "피겨화 대여 1회~12회" 같은 상품은 자동 병합/삭제/수정하지 않는다
-- (예약조건·주문·membership이 연결돼 있을 수 있음). 후보 조회 SELECT만 하단 주석에 있다.
-- 여러 번 실행해도 안전. 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================

alter table products add column if not exists purchase_count_selectable boolean not null default false;

alter table products drop constraint if exists products_selectable_count_check;
alter table products add constraint products_selectable_count_check check (
    not purchase_count_selectable
    or (unlimited = false and unlimited_pass = false)
);

create table if not exists product_count_prices (
    id         uuid primary key default gen_random_uuid(),
    product_id uuid not null references products(id) on delete cascade,
    count      integer not null check (count >= 1),
    price      integer not null check (price > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (product_id, count)
);
create index if not exists idx_product_count_prices_product on product_count_prices (product_id);

alter table product_count_prices enable row level security;

-- 조회: 센터 관리자(관리 화면) 또는 그 상품을 실제로 구매할 수 있는 회원(공개범위 규칙 재사용).
-- 쓰기 정책은 없다 — set_product_count_prices() RPC만 변경한다.
drop policy if exists "횟수 가격표 조회" on product_count_prices;
create policy "횟수 가격표 조회"
    on product_count_prices for select
    using (
        is_platform_admin()
        or exists (
            select 1 from products p
            where p.id = product_count_prices.product_id
              and p.center_id in (select my_managed_center_ids())
        )
        or exists (
            select 1 from (select my_profile_ids() as pid) me
            where member_can_purchase_product(product_count_prices.product_id, me.pid)
        )
    );

revoke all on table product_count_prices from anon;
revoke insert, update, delete on table product_count_prices from authenticated;
grant select on table product_count_prices to authenticated;
grant all on table product_count_prices to service_role;

-- ------------------------------------------------------------
-- 가격표 전체 교체(= 선택형 설정/해제). p_tiers: [{"count":1,"price":6000}, ...]
--   · 빈 배열/NULL이면 고정 상품으로 되돌린다(가격표 삭제 + purchase_count_selectable=false, price/total_count는 그대로).
--   · 이미 판매된 주문/membership에는 영향이 없다(주문은 snapshot, membership은 발급 시점의 횟수).
-- ------------------------------------------------------------
create or replace function set_product_count_prices(p_product_id uuid, p_tiers jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_product products;
    v_n       int;
    v_min     int;
begin
    select * into v_product from products where id = p_product_id for update;
    if not found then
        raise exception '상품을 찾을 수 없어요';
    end if;
    if not (
        has_permission(v_product.center_id, 'pass.create') or has_permission(v_product.center_id, 'pass.update')
        or is_platform_admin()
    ) then
        raise exception '횟수별 가격을 설정할 권한이 없어요';
    end if;

    if p_tiers is null or jsonb_typeof(p_tiers) <> 'array' or jsonb_array_length(p_tiers) = 0 then
        delete from product_count_prices where product_id = p_product_id;
        update products set purchase_count_selectable = false where id = p_product_id;
        return json_build_object('selectable', false, 'tiers', 0);
    end if;

    if v_product.unlimited or v_product.unlimited_pass then
        raise exception '무제한 상품은 횟수 선택형으로 만들 수 없어요';
    end if;

    -- 형식/제약 검증(중복 count, count<1, price<=0 거부)
    select count(*), min((t->>'price')::int)
      into v_n, v_min
      from jsonb_array_elements(p_tiers) t
     where (t->>'count') ~ '^[0-9]+$' and (t->>'price') ~ '^[0-9]+$'
       and (t->>'count')::int >= 1 and (t->>'price')::int > 0;
    if v_n <> jsonb_array_length(p_tiers) then
        raise exception '횟수는 1 이상, 가격은 0원보다 커야 해요';
    end if;
    if (select count(distinct (t->>'count')::int) from jsonb_array_elements(p_tiers) t) <> v_n then
        raise exception '같은 횟수를 두 번 등록할 수 없어요';
    end if;

    delete from product_count_prices where product_id = p_product_id;
    insert into product_count_prices (product_id, count, price)
    select p_product_id, (t->>'count')::int, (t->>'price')::int
      from jsonb_array_elements(p_tiers) t;

    -- 호환 값: products.price = 최저 가격(정렬/"~원부터"/기존 쿼리용). 선택형은 총 횟수를 상품에 고정하지 않는다.
    update products
       set purchase_count_selectable = true,
           price = v_min,
           total_count = null
     where id = p_product_id;

    return json_build_object('selectable', true, 'tiers', v_n, 'min_price', v_min);
end;
$$;
revoke all on function set_product_count_prices(uuid, jsonb) from public, anon;
grant execute on function set_product_count_prices(uuid, jsonb) to authenticated, service_role;

alter table orders add column if not exists selected_count integer;
alter table orders add column if not exists product_amount_snapshot integer;
alter table cart_items add column if not exists selected_count integer;

-- 주문 생성 시 서버가 검증·확정(클라이언트의 amount/selected_count를 신뢰하지 않음)
create or replace function orders_snapshot_product_amount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_p     products;
    v_price int;
begin
    if new.product_id is null then
        new.selected_count := null;
        new.product_amount_snapshot := null;
        return new;
    end if;
    select * into v_p from products where id = new.product_id;
    if not found then
        return new;   -- FK가 처리
    end if;

    if coalesce(v_p.purchase_count_selectable, false) then
        if new.selected_count is null then
            raise exception '구매할 횟수를 선택해주세요';
        end if;
        select price into v_price from product_count_prices
         where product_id = v_p.id and count = new.selected_count;
        if v_price is null then
            raise exception '구매할 수 없는 횟수예요(%회)', new.selected_count;
        end if;
        new.product_amount_snapshot := v_price;
    else
        if new.selected_count is not null then
            raise exception '이 상품은 구매 횟수를 선택할 수 없어요';
        end if;
        new.product_amount_snapshot := v_p.price;
    end if;
    return new;
end;
$$;
revoke all on function orders_snapshot_product_amount() from public, anon, authenticated;

drop trigger if exists orders_snapshot_product_amount on orders;
create trigger orders_snapshot_product_amount
    before insert on orders
    for each row execute function orders_snapshot_product_amount();

-- 주문 이후 snapshot 변조 방지(로그인한 클라이언트 세션 = auth.uid() 있음). 서버 함수/service_role/cron은 영향 없음.
create or replace function orders_guard_snapshot_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is not null then
        raise exception '주문의 상품/횟수/금액 정보는 변경할 수 없어요';
    end if;
    return new;
end;
$$;
revoke all on function orders_guard_snapshot_update() from public, anon, authenticated;

drop trigger if exists orders_guard_snapshot_update on orders;
create trigger orders_guard_snapshot_update
    before update of selected_count, product_amount_snapshot, product_id on orders
    for each row
    when (
        old.selected_count is distinct from new.selected_count
        or old.product_amount_snapshot is distinct from new.product_amount_snapshot
        or old.product_id is distinct from new.product_id
    )
    execute function orders_guard_snapshot_update();

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select
    to_regclass('public.product_count_prices') is not null as table_ok,
    (select count(*) from information_schema.columns where table_name = 'orders' and column_name in ('selected_count', 'product_amount_snapshot')) as order_cols_must_be_2,
    (select count(*) from pg_trigger where tgname in ('orders_snapshot_product_amount', 'orders_guard_snapshot_update')) as triggers_must_be_2,
    has_function_privilege('anon', 'set_product_count_prices(uuid,jsonb)', 'execute') as anon_must_be_false;

-- (참고용, 실행하지 않음) 기존 "같은 이름 + N회" 반복 상품 후보 조회 — 자동 병합/삭제/수정은 하지 않는다.
-- 예약조건(membership_schedule_rules / class_allowed_products)이 상품마다 다르면 센터가 직접 판단해 새 통합 상품을 만들고
-- 기존 상품을 판매중지(is_on_sale=false)하세요.
-- select center_id, product_kind, regexp_replace(name, '\s*[0-9]+회\s*$', '') as base_name, count(*) as variants,
--        array_agg(name order by total_count) as names, array_agg(total_count order by total_count) as counts,
--        array_agg(price order by total_count) as prices
-- from products
-- where is_active and name ~ '[0-9]+회\s*$' and not purchase_count_selectable
-- group by 1, 2, 3 having count(*) >= 3 order by variants desc;
