-- ============================================================
-- MWHABIT Membership Visibility + Member Coupon Batch(2026-09-18)
-- ============================================================
-- 감사 결과(실제 코드 기준, 추측 아님):
--   - 상품/수강권 카탈로그: products(reservation_functions.sql:676 RLS, lib/passes.ts CRUD)
--   - 회원 구매 목록: lib/center.ts의 fetchCenterProducts() — 지금은 visibility 필터가
--     전혀 없다(센터의 활성+판매중 상품 전부 노출).
--   - 주문 생성: lib/orders.ts createOrder() — 평범한 client insert, RLS
--     "주문 본인 생성"(add_orders.sql)이 profile_id 소유만 확인하고 상품 자격은
--     전혀 안 봄.
--   - 결제 확정(진짜 서버 검증 지점): _issue_membership_and_record_payment()
--     (최종본 fix_rolling_month_starts_at_not_null_regression.sql) — 가격은 이미
--     재검증하지만 쿠폰은 'WELCOME'/'FIGURE10' 하드코딩 두 개뿐이고 구매자격 검증
--     자체가 없다.
--   - 셀프 환불: refund_membership()(최종본 reservation_functions.sql) — 24시간 이내
--     미사용 수강권만 허용.
--   - 회원/등급: center_members(center_id,profile_id,grade_id,status),
--     member_grades(center_id,name) — 둘 다 센터별로 독립.
--   - 회원 검색 재사용 대상: lib/members.ts의 fetchMembers()/fetchGrades() —
--     CenterMember 타입에 id/profileId/name/phone/gradeId/gradeName이 이미 있어
--     "지정 회원만" 멀티선택 UI에 그대로 쓸 수 있다.
--
-- 설계 원칙:
--   1) UI에서 숨기는 것과 서버 강제는 완전히 분리한다. 회원용 상품 목록은 새
--      SECURITY DEFINER RPC(fetch_purchasable_products)가 서버에서 계산해서
--      돌려준다(products 테이블 SELECT RLS 자체는 건드리지 않음 — 매니저의 "내
--      상품 전체 관리" 화면이 깨지면 안 되고, 상품 메타데이터 자체를 감추는 게
--      아니라 "구매 가능 여부"를 감추는 것이 목적이라 기존 class_allowed_products
--      와 동일한 패턴을 따른다).
--   2) 구매 자격의 최종 강제는 두 지점에 중복으로 건다(defense in depth):
--      (a) orders INSERT RLS(member_can_purchase_product()) — pending 주문 생성
--          자체를 막는다(가장 이른 시점).
--      (b) _issue_membership_and_record_payment() 안에서 다시 한번 재확인 —
--          주문 생성과 결제 확정 사이에 공개범위가 바뀌었을 수도 있으므로.
--   3) 등급/지정회원 매핑은 JSON 배열이 아니라 정규화된 FK 테이블
--      (membership_product_grades/membership_product_members)로 만든다 — 요청
--      원문의 명시적 지침.
--   4) 쿠폰은 "정의(coupons)"와 "회원에게 실제 지급된 인스턴스(member_coupons)"를
--      분리한다. 기존 orders.coupon_code(WELCOME/FIGURE10 하드코딩)는 건드리지
--      않고 그대로 둔다 — 이번 배치는 새 member_coupon_id 경로를 추가할 뿐, 기존
--      공개 프로모션 코드 경로를 없애거나 바꾸지 않는다(무관한 변경 금지 원칙).
--
-- 이 SQL은 이 세션에서 Supabase에 직접 실행되지 않았다 — 실행은 사용자가 Supabase
-- SQL Editor에서 직접 해야 한다(CLAUDE.md 규칙 3/4, 최종 보고서 SQL 섹션 참고).
-- ============================================================

-- ============================================================
-- [1] products: 공개범위 컬럼 + 매핑 테이블
-- ============================================================

alter table products
    add column if not exists visibility_type text not null default 'all'
    check (visibility_type in ('all', 'grades', 'selected_members'));

comment on column products.visibility_type is
    '수강권 공개범위: all(전체 회원)/grades(특정 등급)/selected_members(지정 회원). '
    '기본값 all — 기존 상품은 마이그레이션 후 자동으로 전체 공개 유지(요청 원문 3번).';

create table if not exists membership_product_grades (
    id          uuid primary key default gen_random_uuid(),
    product_id  uuid not null references products(id) on delete cascade,
    grade_id    uuid not null references member_grades(id) on delete cascade,
    created_at  timestamptz not null default now(),
    unique (product_id, grade_id)
);
comment on table membership_product_grades is
    '수강권(products)이 visibility_type=grades일 때 공개 대상 등급. product/grade 둘 다 '
    '같은 센터 소속이어야 의미가 있다 — RLS와 애플리케이션 레벨(관리자 UI가 같은 센터의 '
    'member_grades만 보여줌) 둘 다에서 강제한다.';

create table if not exists membership_product_members (
    id                uuid primary key default gen_random_uuid(),
    product_id        uuid not null references products(id) on delete cascade,
    center_member_id  uuid not null references center_members(id) on delete cascade,
    created_at        timestamptz not null default now(),
    unique (product_id, center_member_id)
);
comment on table membership_product_members is
    '수강권이 visibility_type=selected_members일 때 공개 대상 회원(center_members 기준 —'
    ' 이미 center_id를 담고 있어 다른 센터 회원 매핑을 구조적으로 막기 쉽다).';

create index if not exists idx_mp_grades_product on membership_product_grades(product_id);
create index if not exists idx_mp_members_product on membership_product_members(product_id);
create index if not exists idx_mp_members_center_member on membership_product_members(center_member_id);

alter table membership_product_grades enable row level security;
alter table membership_product_members enable row level security;

-- 두 매핑 테이블 다 "그 상품을 관리할 수 있는 매니저만" 전체 권한 — 회원 세션은
-- 이 테이블에 직접 접근할 필요가 없다(구매 가능 상품 목록은 아래 RPC가 서버에서
-- 계산해서 돌려주므로, 회원이 "누가 지정됐는지" 원본 매핑을 볼 이유가 없다 — 오히려
-- 그걸 노출하면 "이 상품은 김OO/박OO 전용이다" 같은 타 회원 정보 유출이 된다).
drop policy if exists "매니저 상품등급공개범위 관리" on membership_product_grades;
create policy "매니저 상품등급공개범위 관리"
    on membership_product_grades for all
    using (product_id in (select id from products where center_id in (select my_managed_center_ids())))
    with check (
        product_id in (select id from products where center_id in (select my_managed_center_ids()))
        and grade_id in (
            select mg.id from member_grades mg
            join products p on p.center_id = mg.center_id
            where p.id = membership_product_grades.product_id
        )
    );

drop policy if exists "매니저 상품지정회원공개범위 관리" on membership_product_members;
create policy "매니저 상품지정회원공개범위 관리"
    on membership_product_members for all
    using (product_id in (select id from products where center_id in (select my_managed_center_ids())))
    with check (
        product_id in (select id from products where center_id in (select my_managed_center_ids()))
        and center_member_id in (
            select cm.id from center_members cm
            join products p on p.center_id = cm.center_id
            where p.id = membership_product_members.product_id
        )
    );

-- ============================================================
-- [2] 구매 자격 판정 헬퍼(회원 목록 RPC + orders INSERT RLS 양쪽에서 재사용)
-- ============================================================
create or replace function member_can_purchase_product(p_product_id uuid, p_profile_id uuid)
returns boolean
language sql
stable
as $$
    select coalesce((
        select
            case p.visibility_type
                when 'all' then true
                when 'grades' then exists (
                    select 1 from membership_product_grades mpg
                    join center_members cm
                      on cm.center_id = p.center_id
                     and cm.profile_id = p_profile_id
                     and cm.grade_id = mpg.grade_id
                    where mpg.product_id = p.id
                )
                when 'selected_members' then exists (
                    select 1 from membership_product_members mpm
                    join center_members cm
                      on cm.center_id = p.center_id
                     and cm.profile_id = p_profile_id
                     and cm.id = mpm.center_member_id
                    where mpm.product_id = p.id
                )
                else false
            end
        from products p
        where p.id = p_product_id
          and p.is_active
          and p.is_on_sale
    ), false);
$$;
comment on function member_can_purchase_product is
    '특정 회원(profile_id)이 특정 상품을 구매할 자격이 있는지 서버에서 판정한다. '
    'orders INSERT RLS와 _issue_membership_and_record_payment() 양쪽에서 재사용(요청 5번 '
    '"UI 숨김만으로 끝내지 말 것" — 두 지점 모두에서 독립적으로 강제).';

-- ============================================================
-- [3] 회원용 "구매 가능한 상품" 목록 RPC — lib/center.ts fetchCenterProducts()가
--     기존 raw select 대신 이걸 호출하도록 교체한다(요청 4번: 비대상 상품은 목록
--     자체에서 숨김).
-- ============================================================
create or replace function fetch_purchasable_products(p_center_id uuid)
returns setof products
language sql
stable
security definer
set search_path = public
as $$
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
$$;
comment on function fetch_purchasable_products is
    '로그인한 회원(my_profile_ids())이 실제로 구매 가능한 상품만 서버에서 필터링해 반환.'
    ' products SELECT RLS 자체는 안 건드림(매니저 전체 관리 화면은 그대로 전체를 봄) — '
    '이 RPC만 회원용 "내가 살 수 있는 것" 뷰를 제공.';

revoke execute on function fetch_purchasable_products(uuid) from anon;
grant execute on function fetch_purchasable_products(uuid) to authenticated;

-- ============================================================
-- [4] orders: 구매 자격을 INSERT 시점(가장 이른 시점)에도 강제
-- ============================================================
drop policy if exists "주문 본인 생성" on orders;
create policy "주문 본인 생성"
    on orders for insert
    with check (
        profile_id in (select my_profile_ids())
        and (product_id is null or member_can_purchase_product(product_id, profile_id))
    );
comment on policy "주문 본인 생성" on orders is
    'QA Fix Batch(2026-09-18): product_id가 있으면 member_can_purchase_product()로 구매 '
    '자격까지 확인 — product id를 직접 조작해 비공개 상품을 주문 생성 단계에서부터 막는다.';

-- ============================================================
-- [5] 쿠폰: 정의(coupons) + 적용 대상 수강권(coupon_products) + 실제 지급 인스턴스
--     (member_coupons)
-- ============================================================
create table if not exists coupons (
    id                    uuid primary key default gen_random_uuid(),
    center_id             uuid not null references centers(id) on delete cascade,
    name                  text not null,
    discount_type         text not null check (discount_type in ('fixed', 'percentage')),
    discount_value        int not null check (discount_value > 0),
    max_discount_amount   int check (max_discount_amount is null or max_discount_amount > 0),
    minimum_order_amount  int check (minimum_order_amount is null or minimum_order_amount >= 0),
    applies_to            text not null default 'all' check (applies_to in ('all', 'selected')),
    valid_from            timestamptz,
    valid_until           timestamptz,
    status                text not null default 'active' check (status in ('active', 'archived')),
    created_by            uuid references accounts(id),
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    check (discount_type <> 'percentage' or discount_value <= 100)
);
comment on table coupons is '센터 관리자가 만드는 쿠폰 정의(템플릿). 실제 회원에게 지급된 개별 쿠폰은 member_coupons.';

create table if not exists coupon_products (
    id          uuid primary key default gen_random_uuid(),
    coupon_id   uuid not null references coupons(id) on delete cascade,
    product_id  uuid not null references products(id) on delete cascade,
    created_at  timestamptz not null default now(),
    unique (coupon_id, product_id)
);
comment on table coupon_products is 'applies_to=selected인 쿠폰의 적용 대상 수강권 목록.';

create table if not exists member_coupons (
    id                uuid primary key default gen_random_uuid(),
    coupon_id         uuid not null references coupons(id) on delete cascade,
    center_member_id  uuid not null references center_members(id) on delete cascade,
    status            text not null default 'available'
                      check (status in ('available', 'used', 'expired', 'revoked')),
    issued_at         timestamptz not null default now(),
    used_at           timestamptz,
    order_id          uuid references orders(id) on delete set null,
    created_at        timestamptz not null default now()
);
comment on table member_coupons is '회원에게 실제 지급된 쿠폰 1장. status로 생애주기 관리(available→used/expired/revoked).';

-- "동일 coupon definition에 대해 동일 회원의 active coupon 중복 지급 방지"(요청 13번) —
-- 부분 unique index로 "이 쿠폰 정의를 이 회원이 available 상태로 동시에 2장 이상 갖지
-- 못하게" 강제한다. used/expired/revoked로 넘어간 뒤에는 다시 지급 가능(재발급 허용).
create unique index if not exists uniq_member_coupon_active
    on member_coupons(coupon_id, center_member_id)
    where status = 'available';

create index if not exists idx_coupons_center on coupons(center_id);
create index if not exists idx_coupon_products_coupon on coupon_products(coupon_id);
create index if not exists idx_member_coupons_center_member on member_coupons(center_member_id, status);
create index if not exists idx_member_coupons_coupon on member_coupons(coupon_id);
create index if not exists idx_member_coupons_order on member_coupons(order_id);

alter table coupons enable row level security;
alter table coupon_products enable row level security;
alter table member_coupons enable row level security;

drop policy if exists "매니저 쿠폰 관리" on coupons;
create policy "매니저 쿠폰 관리"
    on coupons for all
    using (center_id in (select my_managed_center_ids()) or is_platform_admin())
    with check (center_id in (select my_managed_center_ids()) or is_platform_admin());

drop policy if exists "매니저 쿠폰적용대상 관리" on coupon_products;
create policy "매니저 쿠폰적용대상 관리"
    on coupon_products for all
    using (coupon_id in (select id from coupons where center_id in (select my_managed_center_ids())))
    with check (
        coupon_id in (select id from coupons where center_id in (select my_managed_center_ids()))
        and product_id in (
            select p.id from products p
            join coupons c on c.center_id = p.center_id
            where c.id = coupon_products.coupon_id
        )
    );

-- member_coupons: 매니저는 자기 센터 회원의 쿠폰을 조회/지급/회수. 회원 본인은 자기
-- 것만 조회 가능(다른 회원 쿠폰 조회 금지 — 요청 14번). status/coupon_id/discount
-- 값 등은 오직 SECURITY DEFINER RPC를 통해서만 바뀌므로(아래 [6]), 회원이 직접
-- update할 수 있는 통로 자체가 없다(요청 22번 "coupon status를 회원이 직접 수정할
-- 수 없음").
drop policy if exists "매니저 회원쿠폰 관리" on member_coupons;
create policy "매니저 회원쿠폰 관리"
    on member_coupons for all
    using (
        coupon_id in (select id from coupons where center_id in (select my_managed_center_ids()))
        or is_platform_admin()
    )
    with check (
        coupon_id in (select id from coupons where center_id in (select my_managed_center_ids()))
        and center_member_id in (
            select cm.id from center_members cm
            join coupons c on c.center_id = cm.center_id
            where c.id = member_coupons.coupon_id
        )
    );

drop policy if exists "내 쿠폰 조회" on member_coupons;
create policy "내 쿠폰 조회"
    on member_coupons for select
    using (
        center_member_id in (
            select cm.id from center_members cm
            where cm.profile_id in (select my_profile_ids())
        )
    );

-- ============================================================
-- [6] 쿠폰 지급/회수 RPC — 일괄 지급 + 중복 방지 + 센터 격리를 한 곳에서 강제
-- ============================================================
create or replace function issue_coupon_to_members(p_coupon_id uuid, p_center_member_ids uuid[])
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_coupon        record;
    v_issued_count  int := 0;
    v_skipped_count int := 0;
    v_member_id     uuid;
begin
    select * into v_coupon from coupons where id = p_coupon_id;
    if not found then
        raise exception '쿠폰을 찾을 수 없어요';
    end if;
    if not (has_permission(v_coupon.center_id, 'customer.member.issue_pass') or is_platform_admin()) then
        raise exception '쿠폰을 지급할 권한이 없어요';
    end if;
    if v_coupon.status <> 'active' then
        raise exception '보관된(archived) 쿠폰은 지급할 수 없어요';
    end if;

    foreach v_member_id in array p_center_member_ids loop
        -- 다른 센터 회원에게는 지급 불가(요청 13/22번) — center_members가 실제로
        -- 이 쿠폰의 센터 소속인지 매번 확인.
        if not exists (
            select 1 from center_members cm
            where cm.id = v_member_id and cm.center_id = v_coupon.center_id
        ) then
            raise exception '다른 센터 회원에게는 쿠폰을 지급할 수 없어요';
        end if;

        -- 이미 같은 쿠폰을 available 상태로 갖고 있으면 건너뜀(중복 지급 방지,
        -- uniq_member_coupon_active와 동일 조건을 여기서 먼저 확인해 예외 대신
        -- "skipped"로 부드럽게 처리 — 일괄 지급 중 하나가 막혀 전체가 롤백되는
        -- 것을 방지).
        if exists (
            select 1 from member_coupons
            where coupon_id = p_coupon_id and center_member_id = v_member_id and status = 'available'
        ) then
            v_skipped_count := v_skipped_count + 1;
            continue;
        end if;

        insert into member_coupons (coupon_id, center_member_id, status)
        values (p_coupon_id, v_member_id, 'available');
        v_issued_count := v_issued_count + 1;
    end loop;

    return json_build_object('issued_count', v_issued_count, 'skipped_count', v_skipped_count);
end;
$$;
comment on function issue_coupon_to_members is
    '쿠폰 일괄 지급. has_permission(center_id, customer.member.issue_pass) 재사용(기존 '
    '수강권 발급 권한과 동일 — 새 권한 키를 만들지 않음). 이미 active 쿠폰을 가진 회원은 '
    '건너뛰고 나머지는 계속 진행(부분 성공 허용, 중복만 skip).';

create or replace function revoke_member_coupon(p_member_coupon_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_mc record;
    v_center_id uuid;
begin
    -- record 변수(v_mc)와 스칼라 변수(v_center_id)를 같은 INTO 리스트에 섞을 수 없어서
    -- (PL/pgSQL 제약, 실제 재현된 오류: "record variable cannot be part of
    -- multiple-item INTO list") 조회를 두 단계로 분리한다 — 잠금은 member_coupons
    -- 행 하나에만 걸면 충분하다(coupons는 여기서 상태를 바꾸지 않으므로 잠글 필요 없음).
    select * into v_mc from member_coupons where id = p_member_coupon_id for update;
    if not found then
        raise exception '쿠폰을 찾을 수 없어요';
    end if;

    select center_id into v_center_id from coupons where id = v_mc.coupon_id;
    if not (has_permission(v_center_id, 'customer.member.issue_pass') or is_platform_admin()) then
        raise exception '쿠폰을 회수할 권한이 없어요';
    end if;
    if v_mc.status = 'used' then
        raise exception '이미 사용한 쿠폰은 회수할 수 없어요';
    end if;
    if v_mc.status = 'revoked' then
        return json_build_object('revoked', true, 'already', true);
    end if;

    update member_coupons set status = 'revoked' where id = p_member_coupon_id;
    return json_build_object('revoked', true, 'already', false);
end;
$$;
comment on function revoke_member_coupon is
    '아직 사용하지 않은(available/expired) 쿠폰만 회수 가능(요청 21번 — used는 회수 금지).';

-- ============================================================
-- [7] payments.order_id — 환불 시 어느 주문에서 쓴 쿠폰이었는지 역추적하기 위해
--     필요(기존엔 payments→orders 연결이 없었음).
-- ============================================================
alter table payments add column if not exists order_id uuid references orders(id) on delete set null;
create index if not exists idx_payments_order on payments(order_id);

-- ============================================================
-- [8] orders: 쿠폰 인스턴스 참조 컬럼 추가(기존 coupon_code 텍스트 컬럼은 그대로
--     둠 — 별개의 두 경로가 공존, 요청 25번 "무관한 변경 금지"에 따라 기존 걸 안 건드림)
-- ============================================================
alter table orders add column if not exists member_coupon_id uuid references member_coupons(id) on delete set null;
create index if not exists idx_orders_member_coupon on orders(member_coupon_id);

-- ============================================================
-- [9] 결제 확정 함수 재정의 — 구매자격 재검증(defense in depth) + 실제 쿠폰 할인
--     계산 + 쿠폰 used 처리. 기존 로직(가격 검증/포인트 검증/수강권 발급/결제 기록)은
--     전혀 건드리지 않고 그 앞뒤에 새 블록만 추가한다.
-- ============================================================
create or replace function _issue_membership_and_record_payment(p_order orders, p_provider_ref text, p_memo text)
returns json
language plpgsql
security definer
as $$
declare
    v_product           record;
    v_membership_id     uuid;
    v_count             int;
    v_expires           date;
    v_starts            date;
    v_rm                record;
    v_verified_discount int;
    v_expected_amount   int;
    v_points_verified   boolean;
    v_coupon            record;
    v_member_coupon     record;
begin
    v_count := null;
    v_expires := null;
    v_starts := current_date;
    if p_order.product_id is not null then
        select * into v_product from products where id = p_order.product_id;
        if found then
            -- [FIX] 구매 자격 재검증(요청 5/17번) — 주문 생성 시점(orders INSERT RLS)에서
            -- 이미 확인했지만, 확정 시점 사이에 공개범위가 바뀌었을 수 있으므로 여기서
            -- 다시 한번 확인한다. UI 숨김이나 주문 생성 차단을 우회해 이 함수를 직접
            -- 호출할 방법은 없지만(confirm_test_payment/confirm_real_payment를 거쳐야
            -- 하고 둘 다 소유자 검증을 함), 그래도 이 함수 자체가 "최종 서버 검증
            -- 지점"이라는 원칙을 지키기 위해 독립적으로 재확인한다.
            if not member_can_purchase_product(p_order.product_id, p_order.profile_id) then
                raise exception '이 수강권을 구매할 수 있는 대상이 아닙니다.';
            end if;

            v_count := case when v_product.unlimited_pass then null else v_product.total_count end;
            if v_product.expiry_mode = 'rolling_month' then
                select * into v_rm from calc_rolling_month_dates(now(), v_product.rolling_month_cutoff_day);
                v_expires := v_rm.expires_at;
                if not coalesce(v_product.rolling_month_allow_early_use, false) then
                    v_starts := v_rm.starts_at;
                end if;
            else
                v_expires := case v_product.expiry_mode
                    when 'date' then v_product.expiry_date
                    when 'days' then (now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval)::date
                    else null
                end;
            end if;

            v_verified_discount := case p_order.coupon_code
                when 'WELCOME' then 5000
                when 'FIGURE10' then 10000
                else 0
            end;

            -- [FIX] 실제 member_coupon 기반 할인(요청 16번) — 클라이언트가 보낸 할인율/
            -- 할인금액/최종금액은 절대 신뢰하지 않고, member_coupon_id로부터 서버가
            -- 처음부터 다시 계산한다.
            if p_order.member_coupon_id is not null then
                select mc.*, c.discount_type, c.discount_value, c.max_discount_amount,
                       c.minimum_order_amount, c.applies_to, c.valid_from, c.valid_until,
                       c.status as coupon_status, c.center_id as coupon_center_id
                  into v_member_coupon
                  from member_coupons mc
                  join coupons c on c.id = mc.coupon_id
                 where mc.id = p_order.member_coupon_id
                 for update;

                if not found then
                    raise exception '쿠폰을 찾을 수 없어요';
                end if;
                -- 쿠폰 소유자 확인(다른 회원 쿠폰 도용 차단, 요청 24-12번)
                if not exists (
                    select 1 from center_members cm
                    where cm.id = v_member_coupon.center_member_id
                      and cm.profile_id = p_order.profile_id
                ) then
                    raise exception '본인에게 지급된 쿠폰만 사용할 수 있어요';
                end if;
                -- 센터 일치(다른 센터 쿠폰 차단, 요청 24-13번)
                if v_member_coupon.coupon_center_id is distinct from p_order.center_id then
                    raise exception '이 센터에서 사용할 수 없는 쿠폰이에요';
                end if;
                if v_member_coupon.status <> 'available' then
                    raise exception '사용할 수 없는 쿠폰이에요(이미 사용됐거나 만료/회수됨)';
                end if;
                if v_member_coupon.valid_from is not null and now() < v_member_coupon.valid_from then
                    raise exception '아직 사용할 수 없는 쿠폰이에요';
                end if;
                if v_member_coupon.valid_until is not null and now() > v_member_coupon.valid_until then
                    raise exception '유효기간이 지난 쿠폰이에요';
                end if;
                if v_member_coupon.applies_to = 'selected' and not exists (
                    select 1 from coupon_products where coupon_id = v_member_coupon.coupon_id and product_id = p_order.product_id
                ) then
                    raise exception '이 수강권에는 사용할 수 없는 쿠폰이에요';
                end if;
                if v_member_coupon.minimum_order_amount is not null and v_product.price < v_member_coupon.minimum_order_amount then
                    raise exception '최소 결제금액(%s원) 미만이라 쿠폰을 사용할 수 없어요', v_member_coupon.minimum_order_amount;
                end if;

                if v_member_coupon.discount_type = 'fixed' then
                    v_verified_discount := v_verified_discount + v_member_coupon.discount_value;
                else
                    v_verified_discount := v_verified_discount +
                        least(
                            (v_product.price * v_member_coupon.discount_value) / 100,
                            coalesce(v_member_coupon.max_discount_amount, v_product.price)
                        );
                end if;
            end if;

            if coalesce(p_order.points_used, 0) > 0 then
                select exists(
                    select 1 from point_transactions
                    where order_id = p_order.id
                      and profile_id = p_order.profile_id
                      and center_id = p_order.center_id
                      and amount = -p_order.points_used
                ) into v_points_verified;
                if not v_points_verified then
                    raise exception '포인트 사용 내역이 확인되지 않아 주문을 처리할 수 없어요(관리자 문의)';
                end if;
            end if;

            v_expected_amount := greatest(0, v_product.price - v_verified_discount - coalesce(p_order.points_used, 0));

            if p_order.amount is distinct from v_expected_amount then
                raise exception '주문 금액이 상품 가격과 일치하지 않아요(관리자 문의)';
            end if;
        end if;
    end if;

    update orders set status = 'paid', paid_at = now() where id = p_order.id;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, starts_at, status
    ) values (
        p_order.profile_id, p_order.center_id, p_order.product_id, p_order.product_name,
        'count', v_count, v_count, v_expires, v_starts, 'active'
    ) returning id into v_membership_id;

    insert into payments (
        center_id, profile_id, membership_id, order_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo
    ) values (
        p_order.center_id, p_order.profile_id, v_membership_id, p_order.id,
        'new', 'membership',
        p_order.amount, 0, 0, 0,
        p_order.amount, 0, p_provider_ref, now(), 'paid',
        p_memo
    );

    -- [FIX] 결제 성공 확정 시점에만 쿠폰을 used로 전환(요청 18번 — 선택 시점 X)
    if p_order.member_coupon_id is not null then
        update member_coupons
           set status = 'used', used_at = now(), order_id = p_order.id
         where id = p_order.member_coupon_id;
    end if;

    update orders set status = 'done' where id = p_order.id;

    return json_build_object('membership_id', v_membership_id, 'amount', p_order.amount);
end;
$$;

-- ============================================================
-- [10] 셀프 환불 시 쿠폰 복원(요청 18번 "전체 결제 취소가 정상 완료되면 available로
--      복원") — 현재 refund_membership()은 결제 후 24시간 이내 + 완전 미사용 수강권만
--      허용하는 "전체 취소"이지 부분취소가 아니므로(부분취소 경로 자체가 이 함수에
--      없음 확인됨), 안전하게 무조건 복원해도 된다(요청의 "부분취소가 존재한다면
--      임의 복원 금지" 조건에 해당하지 않음 — 이 함수는 애초에 전체취소만 다룸).
-- ============================================================
create or replace function refund_membership(p_membership_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_mem     record;
    v_unlimited boolean := false;
    v_hours   numeric;
    v_amount  int := 0;
    v_still_active int := 0;
    v_order_id uuid;
begin
    select * into v_mem from memberships
    where id = p_membership_id
      and profile_id in (select id from profiles where account_id = my_account_id())
    for update;

    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;
    if v_mem.status = 'refunded' then
        raise exception '이미 환불된 수강권이에요';
    end if;

    select coalesce(p.unlimited, false) into v_unlimited
    from products p where p.id = v_mem.product_id;
    v_unlimited := coalesce(v_unlimited, false);

    v_hours := extract(epoch from (now() - v_mem.created_at)) / 3600;
    if v_hours > 24 then
        raise exception '결제 후 24시간이 지나 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;

    if not v_unlimited and v_mem.total_count is not null
       and v_mem.remaining_count is distinct from v_mem.total_count then
        raise exception '이미 사용한 수강권은 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;

    select coalesce(total_amount, 0), order_id into v_amount, v_order_id
    from payments where membership_id = v_mem.id
    order by paid_at desc limit 1;
    v_amount := coalesce(v_amount, 0);

    update memberships
       set status = 'refunded', remaining_count = 0
     where id = v_mem.id;

    if v_amount > 0 then
        insert into payments (
            center_id, profile_id, membership_id,
            sale_type, revenue_category,
            card_amount, cash_amount, transfer_amount, point_amount,
            total_amount, unpaid_amount, paid_at, status, memo
        ) values (
            v_mem.center_id, v_mem.profile_id, v_mem.id,
            'refund', 'membership',
            0, 0, 0, 0,
            -v_amount, 0, now(), 'paid',
            '앱 셀프 환불'
        );
    end if;

    -- [FIX] 이 결제에 쓰인 쿠폰이 있으면 available로 복원(요청 18번)
    if v_order_id is not null then
        update member_coupons
           set status = 'available', used_at = null, order_id = null
         where order_id = v_order_id and status = 'used';
    end if;

    select count(*) into v_still_active
    from memberships m
    where m.profile_id = v_mem.profile_id
      and m.center_id = v_mem.center_id
      and m.status = 'active'
      and (m.remaining_count is null or m.remaining_count > 0)
      and (m.expires_at is null or m.expires_at >= current_date);

    if v_still_active = 0 then
        update center_members
           set status = 'expired'
         where profile_id = v_mem.profile_id
           and center_id = v_mem.center_id
           and status <> 'dormant';
    end if;

    return json_build_object('refunded', true, 'amount', v_amount);
end;
$$;

-- ============================================================
-- 확인(read-only) — Supabase SQL Editor에서 실행해 적용 여부 확인
-- ============================================================
-- select column_name from information_schema.columns
--  where table_name='products' and column_name='visibility_type';
-- select proname from pg_proc
--  where proname in ('member_can_purchase_product','fetch_purchasable_products',
--                     'issue_coupon_to_members','revoke_member_coupon');
-- select pg_get_functiondef(oid) like '%member_coupon_id%' as has_coupon_fix
--  from pg_proc where proname = '_issue_membership_and_record_payment';
-- select pg_get_functiondef(oid) like '%member_coupons%' as has_refund_fix
--  from pg_proc where proname = 'refund_membership';
