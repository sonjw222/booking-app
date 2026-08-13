-- ============================================================
-- SEC-118(P0): orders.amount 클라이언트 신뢰 문제 — 서버 검증 도입
--
-- [근본 원인] lib/orders.ts의 createOrder()가 클라이언트가 계산한 amount를
-- 그대로 orders.amount에 저장하고, fulfill_order()/confirm_test_payment()가
-- 이를 그대로 payments.total_amount로 기록한다. orders INSERT RLS(add_orders.sql)도
-- profile_id 소유권만 확인할 뿐 금액에는 아무 제약이 없다 — 회원이 Supabase SDK로
-- orders에 직접 insert하면 임의 금액으로 정상 상품(수강권)을 받을 수 있다.
-- 설계 문서: docs/25_SEC118_Orders_Amount_Design.md (D안: RPC화 + 이중 방어 채택).
--
-- [이 파일이 하는 일]
-- 1) orders.verified 컬럼 추가 — "서버가 금액을 직접 계산해 만든 주문"인지 표시.
-- 2) create_order_secure() 신규 RPC — products.price를 서버가 조회해 amount를 직접
--    계산(클라이언트는 amount를 아예 보내지 않음). 포인트 사용도 이 함수 안에서
--    use_points()를 직접 호출해 원자적으로 처리한다(클라이언트가 "포인트를 이만큼
--    썼다"고 주장하는 값을 그대로 믿지 않음 — 실제 차감과 금액 계산이 같은 트랜잭션).
-- 3) fulfill_order() / confirm_test_payment()에 방어적 재검증 추가 — verified=true인
--    주문(신규 RPC로 생성)은 그대로 신뢰하고, verified=false인 기존/레거시 경로 주문은
--    "생성 시점 스냅샷"이 없으므로 현재 products.price와 직접 대조해 불일치하면 거부한다.
--    이렇게 하면 이미 존재하는 정상 주문(가격이 바뀌지 않은)은 계속 처리되면서도,
--    조작된 금액은 막힌다.
--
-- [쿠폰(coupon_code/discount_amount)에 대해] 이 코드베이스의 쿠폰 기능은 checkout
-- 화면의 MY_COUPONS 하드코딩 배열(app/checkout/page.tsx 주석: "보유 쿠폰 (데모)")뿐이고
-- 서버 검증이 전혀 없다(SQL 전체 검색 결과 discount_amount/coupon_code를 읽는 함수가
-- 하나도 없음, 확인함) — 즉 "쿠폰 할인"은 지금까지 순수 클라이언트 주장이었다. 이 RPC는
-- 쿠폰 할인을 서버 금액 계산에 전혀 반영하지 않는다(반영하면 여전히 클라이언트가 임의
-- 할인율을 주장할 수 있어 이번 수정의 의미가 없어짐) — 실제 쿠폰 시스템을 만들 때
-- 서버 검증 로직과 함께 별도로 확장할 것(설계 문서 4번 항목 참고).
--
-- [영향받는 기존 데이터] orders.verified는 기존 행에 전부 false로 채워짐(안전한
-- 기본값) — 기존 pending/paid 주문은 fulfill_order/confirm_test_payment 처리 시
-- products.price와 대조하는 재검증을 거친다(가격이 그대로면 정상 처리, 바뀌었거나
-- 애초에 조작됐다면 거부).
-- [위험도] 낮음 — 새 컬럼/새 RPC 추가, 기존 함수는 조회 로직만 앞에 추가(발급 로직
-- 자체는 변경 없음).
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] orders.verified 컬럼 — 서버가 금액을 직접 계산해 만든 주문인지 표시
-- ------------------------------------------------------------
alter table orders add column if not exists verified boolean not null default false;
comment on column orders.verified is
    'create_order_secure() RPC로 생성돼 서버가 금액을 직접 계산했는지. false=레거시/직접 insert 경로(fulfill_order 등에서 products.price와 재대조 필요)';

-- ------------------------------------------------------------
-- [2] create_order_secure() — 신규 주문 생성 RPC (금액은 서버가 계산, 클라이언트가
--     amount를 아예 넘길 수 없음)
-- ------------------------------------------------------------
create or replace function create_order_secure(
    p_product_id uuid,
    p_pay_method text default null,
    p_selected_size text default null,
    p_point_used int default 0,
    p_auto_book boolean default false,
    p_provider text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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

    if p_provider is not null and p_provider not in ('mock', 'toss', 'portone') then
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
$$;

revoke all on function create_order_secure(uuid, text, text, int, boolean, text) from public;
revoke all on function create_order_secure(uuid, text, text, int, boolean, text) from anon;
grant execute on function create_order_secure(uuid, text, text, int, boolean, text) to authenticated;

-- ------------------------------------------------------------
-- [3] fulfill_order() — verified=false 주문은 products.price와 재대조하는 방어
--     한 줄만 앞에 추가. 그 외 발급/매출기록 로직은 reservation_functions.sql의
--     현재 정의와 완전히 동일(변경 없음).
-- ------------------------------------------------------------
create or replace function fulfill_order(p_order_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_order      record;
    v_product    record;
    v_membership_id uuid;
    v_count      int;
    v_kind       text;
    v_expires    date;
begin
    -- 주문 조회 + 잠금
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    -- 권한: 이 센터 매니저/오너만
    if not (v_order.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 주문을 처리할 권한이 없어요';
    end if;

    -- 이미 완료된 주문이면 중복 발급 방지
    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    -- [SEC-118] verified=false(레거시/직접 insert 경로)면 현재 products.price와
    -- 직접 대조한다 — 생성 시점 스냅샷이 없어 "그때 가격"을 알 수 없으므로, 지금
    -- 가격과 다르면(조작됐거나 그 사이 가격이 바뀌었거나) 매니저가 직접 확인하게 막는다.
    if not coalesce(v_order.verified, false) then
        if v_order.product_id is null or v_order.amount <> (select price from products where id = v_order.product_id) then
            raise exception '주문 금액을 확인할 수 없어요. 상품 가격과 다릅니다 — 센터에서 직접 확인해주세요.';
        end if;
    end if;

    -- 상품 정보 (횟수/종류)
    v_count := null; v_kind := 'pass';
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            v_count := v_product.total_count;
            v_kind := v_product.product_kind;
        end if;
    end if;

    -- 유효기간 기본 60일
    v_expires := (now() + interval '60 days')::date;

    -- 1) 수강권/상품 발급
    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, status
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, 'active'
    ) returning id into v_membership_id;

    -- 2) 매출 기록 (결제수단은 주문의 pay_method 기준으로 대략 분류)
    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, paid_at, status, memo
    ) values (
        v_order.center_id, v_order.profile_id, v_membership_id,
        'new', 'membership',
        case when v_order.pay_method in ('card','kakao','toss') then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'transfer' then v_order.amount else 0 end,
        0,
        v_order.amount, 0, now(), 'paid',
        '앱 주문 자동 발급'
    );

    -- 3) 센터 회원목록에 자동 등록 (없으면 추가, 만료회원이면 복귀)
    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    -- 3-1) 회원이 자동예약을 선택했고 요일반 수강권이면 자동 예약
    if coalesce(v_order.auto_book, false) then
        begin
            perform auto_book_membership(v_membership_id);
        exception when others then
            null;  -- 자동예약 실패해도 발급 자체는 성공 처리
        end;
    end if;

    -- 4) 주문 완료 처리
    update orders set status = 'done', paid_at = now() where id = p_order_id;

    return json_build_object(
        'already_done', false,
        'membership_id', v_membership_id,
        'amount', v_order.amount
    );
end;
$$;

-- ------------------------------------------------------------
-- [4] confirm_test_payment() — 회원 본인 Mock 결제 확정 경로에도 동일한
--     재검증 한 줄 추가. 그 외 로직은 add_payment_test_provider.sql의 현재
--     정의와 완전히 동일(변경 없음).
-- ------------------------------------------------------------
create or replace function confirm_test_payment(p_order_id uuid, p_provider_ref text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_order         record;
    v_product       record;
    v_membership_id uuid;
    v_count         int;
    v_expires       date;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if v_order.profile_id not in (select my_profile_ids()) then
        raise exception '본인 주문만 확정할 수 있어요';
    end if;

    if v_order.payment_provider is distinct from 'mock' then
        raise exception '테스트 결제 확정은 Mock 결제 주문에만 사용할 수 있어요';
    end if;

    -- 이미 완료된 주문이면 중복 발급 방지
    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    -- [SEC-118] fulfill_order()와 동일한 재검증
    if not coalesce(v_order.verified, false) then
        if v_order.product_id is null or v_order.amount <> (select price from products where id = v_order.product_id) then
            raise exception '주문 금액을 확인할 수 없어요. 상품 가격과 다릅니다 — 센터에서 직접 확인해주세요.';
        end if;
    end if;

    -- 상품 정보 (횟수)
    v_count := null;
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            v_count := v_product.total_count;
        end if;
    end if;

    -- 유효기간 기본 60일 (fulfill_order와 동일)
    v_expires := (now() + interval '60 days')::date;

    -- 1) 주문 결제 확정(paid) — "orders = paid" 단계를 명시적으로 거침
    update orders set status = 'paid', paid_at = now() where id = p_order_id;

    -- 2) 수강권 발급
    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, status
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, 'active'
    ) returning id into v_membership_id;

    -- 3) 매출 기록 ("payments = paid" 단계) — pg_transaction_id에 mock 결제 참조값 저장
    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo
    ) values (
        v_order.center_id, v_order.profile_id, v_membership_id,
        'new', 'membership',
        v_order.amount, 0, 0, 0,
        v_order.amount, 0, p_provider_ref, now(), 'paid',
        '테스트 결제(Mock Provider) 자동 발급'
    );

    -- 4) 주문 완료 처리
    update orders set status = 'done' where id = p_order_id;

    return json_build_object(
        'already_done', false,
        'membership_id', v_membership_id,
        'amount', v_order.amount
    );
end;
$$;

COMMIT;

-- ============================================================
-- 적용 후 확인(읽기 전용)
-- ============================================================
select column_name, data_type, column_default from information_schema.columns
where table_name = 'orders' and column_name = 'verified';

select routine_name, security_type from information_schema.routines
where routine_name in ('create_order_secure', 'fulfill_order', 'confirm_test_payment');

-- ⚠ 아래는 이 수정으로 영향받을 수 있는 기존 데이터 확인용 — status가 아직
-- done/cancelled이 아닌(=앞으로 fulfill_order/confirm_test_payment를 거칠) 주문 중
-- verified=false인 것이 몇 건인지, 그리고 그중 실제로 products.price와 금액이
-- 다른(=재검증에서 막힐) 것이 몇 건인지 확인 권장.
select count(*) as pending_unverified_orders
from orders
where status not in ('done', 'cancelled') and verified = false;

select o.id, o.product_name, o.amount, p.price as current_product_price
from orders o
join products p on p.id = o.product_id
where o.status not in ('done', 'cancelled')
  and o.verified = false
  and o.amount <> p.price;
