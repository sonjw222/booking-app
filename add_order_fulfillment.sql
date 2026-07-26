-- ============================================================
-- 주문 발급 자동화 (수강권 자동 추가 + 매출 자동 연동)
--
-- 하는 일:
--   fulfill_order 함수 추가
--   → 매니저가 주문 "확정·발급" 시 (또는 나중에 결제 성공 시)
--     · 회원에게 수강권/상품 자동 발급 (memberships)
--     · 매출 자동 기록 (payments → 매출관리 반영)
--   중복 발급 방지 (이미 완료된 주문은 재발급 안 함)
--
-- ⚠ 먼저 add_orders.sql 을 실행해 orders 테이블이 있어야 해요.
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================


-- ============================================================
-- 주문 처리 완료 (수강권/상품 자동 발급 + 매출 자동 연동)
--   매니저가 주문관리에서 "처리 완료" 시, 또는 나중에 실제 결제 성공 시 호출.
--   하는 일:
--     1) order를 done 처리
--     2) 그 회원에게 수강권/상품(membership) 자동 발급
--     3) payments에 매출 기록 (매출관리에 자동 반영)
--   이미 done인 주문은 중복 발급 안 함.
-- ============================================================

create or replace function fulfill_order(p_order_id uuid)
returns json
language plpgsql
security definer
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

    -- 3) 주문 완료 처리
    update orders set status = 'done', paid_at = now() where id = p_order_id;

    return json_build_object(
        'already_done', false,
        'membership_id', v_membership_id,
        'amount', v_order.amount
    );
end;
$$;



-- ============================================================
-- 완료!
--   매니저: 주문 관리 → "확정 · 발급" → 회원 수강권 자동 추가 + 매출 반영
-- ============================================================
