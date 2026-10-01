-- ============================================================
-- 비로그인(anon) 공개 판매상품 조회 — 토스페이먼츠 전자결제 심사 대응(2026-10-01)
--
-- 문제: lib/center.ts fetchCenterProducts()가 쓰는 fetch_purchasable_products()는 일부러
-- anon execute를 revoke해 뒀다(회원 등급/지정 회원 전용 상품이 비로그인에게 새지 않게,
-- add_membership_visibility_and_coupons.sql). 그 결과 비로그인 사용자는 센터 페이지는 열어도
-- 상품 목록 조회가 실패해 센터 화면 전체가 "찾을 수 없어요"로 떨어졌고, 심사관이 판매상품
-- (상품명/가격/센터)을 로그인 없이 확인할 수 없었다.
--
-- 해결: 기존 fetch_purchasable_products()는 한 글자도 건드리지 않고(권한 포함), 공개 전용
-- 별도 RPC를 새로 만든다. 공개 조건은 아래 네 가지를 "모두" 만족해야 한다:
--   centers.status = 'approved'      — 승인 대기/반려 센터 상품은 절대 노출 안 함
--   products.is_active               — 비활성(삭제) 상품 제외
--   products.is_on_sale              — 판매중지 상품 제외
--   products.visibility_type = 'all' — 등급 전용('grades')/지정 회원('selected_members') 상품은
--                                       anon에게 절대 노출 안 함(회원별 판정이 필요한 상품이라
--                                       이 공개 경로에서는 아예 후보에서 제외)
-- 반환 컬럼은 화면에 필요한 비민감 필드로 최소화한다(회원/매출/판매자 계정 정보 없음).
-- 남은 수량(remaining)은 product_sale_counts 뷰(authenticated 전용)를 anon에게 열지 않고
-- 함수 안에서 같은 기준(환불 제외 발급 건수)으로 계산한다.
--
-- 로그인 회원은 기존 fetch_purchasable_products()를 그대로 쓴다(회원별 구매 가능 상품).
-- 구매(checkout)는 여전히 로그인이 필요하다 — 이 RPC는 "조회"만 공개한다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전(create or replace).
-- 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================

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
    remaining      integer
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
        end
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      and (p_center_id is null or p.center_id = p_center_id)
    order by c.name asc, p.product_kind asc, p.price asc
    limit 500;
$$;

comment on function fetch_public_storefront_products is
    '비로그인 포함 누구나 조회 가능한 공개 판매상품 목록. 승인된 센터의 활성/판매중/전체공개(visibility_type=all) '
    '상품만 최소 컬럼으로 반환한다. 등급 전용/지정 회원 전용 상품은 절대 포함하지 않는다. 회원별 구매 가능 상품은 '
    'fetch_purchasable_products()(authenticated 전용)가 담당.';

-- 권한을 명시적으로 관리: 기본 PUBLIC execute를 걷어내고 anon/authenticated에만 연다.
revoke all on function fetch_public_storefront_products(uuid) from public;
grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;

-- ============================================================
-- 확인 — 함수가 anon에게 열려 있고, 기존 회원용 RPC는 여전히 anon 차단인지(둘 다 false/true 아래 설명)
-- ============================================================
select
    has_function_privilege('anon', 'fetch_public_storefront_products(uuid)', 'execute') as public_rpc_anon_ok,      -- true 여야 함
    has_function_privilege('anon', 'fetch_purchasable_products(uuid)', 'execute')       as member_rpc_anon_blocked;  -- false 여야 함

-- 공개 대상 상품 수(승인 센터 + 활성 + 판매중 + 전체공개). 승인 대기 센터 상품은 포함되지 않아야 한다.
select count(*) as public_product_count from fetch_public_storefront_products();

-- ============================================================
-- 완료!
-- ============================================================
