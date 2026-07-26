-- ============================================================
-- 상품 상세설명 + 대여 사이즈 + 장바구니
--
-- 하는 일:
--   1) products.description (상세 설명), products.sizes (대여 사이즈 목록)
--   2) cart_items 테이블 (장바구니)
--   3) orders에 사이즈/쿠폰 정보 컬럼
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 1) 상품 설명/사이즈
alter table products add column if not exists description text;
alter table products add column if not exists sizes text[];

-- 2) 주문에 사이즈/쿠폰
alter table orders add column if not exists selected_size text;
alter table orders add column if not exists coupon_code text;
alter table orders add column if not exists discount_amount int not null default 0;

-- 3) 장바구니
create table if not exists cart_items (
    id           uuid primary key default gen_random_uuid(),
    profile_id   uuid not null references profiles(id) on delete cascade,
    center_id    uuid not null references centers(id) on delete cascade,
    product_id   uuid not null references products(id) on delete cascade,
    product_name text not null,
    price        int not null default 0,
    selected_size text,
    created_at   timestamptz not null default now()
);

alter table cart_items enable row level security;

drop policy if exists "장바구니 본인" on cart_items;
create policy "장바구니 본인"
    on cart_items for all
    using (profile_id in (select my_profile_ids()))
    with check (profile_id in (select my_profile_ids()));


-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns where table_name = 'products' and column_name in ('description','sizes');


-- ============================================================
-- 완료!
-- ============================================================
