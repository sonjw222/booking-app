-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- SYNC-001: Mock 결제(confirm_test_payment)가 정식 결제(fulfill_order)와 달리
-- ensure_center_member()를 호출하지 않아, 테스트 결제로 수강권을 처음 받은 회원이
-- center_members에 등록되지 않는 문제.
--
-- 조사 결과(Track A 감사): "예약자 동기화"(syncMembersFromReservations, 매니저가
-- 수동으로 누르는 버튼)와 "구매 확정 시 자동 center_members 등록"(ensure_center_member,
-- fulfill_order에서만 호출)은 서로 다른 두 메커니즘이다. confirm_test_payment()는
-- fulfill_order()의 "수강권 발급 + 매출 기록 + 주문 완료" 3단계를 의도적으로 복제하면서
-- (add_payment_test_provider.sql 헤더 주석 참고) ensure_center_member 호출만 누락됐다.
--
-- 수정: confirm_test_payment()에 fulfill_order와 동일하게
-- `perform ensure_center_member(v_order.center_id, v_order.profile_id);`를
-- 수강권 발급 직후에 추가한다. 다른 로직은 전혀 바꾸지 않는다.
-- ensure_center_member()는 이미 idempotent(on conflict do update)라 여러 번
-- 호출돼도 안전하다.
-- ============================================================

BEGIN;

create or replace function confirm_test_payment(p_order_id uuid, p_provider_ref text)
returns json
language plpgsql
security definer
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

    -- [SYNC-001 수정] fulfill_order()와 동일하게 센터 회원 등록을 동기화한다.
    perform ensure_center_member(v_order.center_id, v_order.profile_id);

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
