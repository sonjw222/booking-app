-- ============================================================
-- P0-1: 테스트 결제(Mock Payment Provider) 지원
--
-- 배경:
--   fulfill_order()(add_order_fulfillment.sql)는 매니저/운영자 전용입니다
--   (security definer, my_managed_center_ids()/is_platform_admin() 체크).
--   회원이 스스로 "테스트 결제"를 완료했을 때 수강권을 즉시 받을 방법이
--   없었으므로, 이 파일은 회원 본인 전용 RPC 2개를 새로 추가합니다.
--
--   ⚠ 의도적 로직 중복 (fulfill_order 절대 수정하지 않음):
--   confirm_test_payment()는 fulfill_order()와 "수강권 발급 + 매출 기록 +
--   주문 완료 처리" 3단계가 거의 동일합니다. 공통 함수로 추출하는 것도
--   검토했지만, 두 함수의 권한 모델이 근본적으로 다릅니다
--   (fulfill_order = 매니저 신뢰 기반 / 이 함수 = 본인 소유 + payment_provider
--   = 'mock' 한정). 공통화하려면 fulfill_order의 시그니처·본문을 최소한
--   리팩터링해야 하는데 이는 "기존 RPC 변경 금지" 요구사항과 충돌하므로,
--   이번 작업에서는 중복을 허용합니다.
--   → 향후 실제 PG(Toss/PortOne) 웹훅을 붙일 때, 권한 체크 없는 순수 로직만
--     내부 헬퍼(예: _issue_membership_and_record_payment)로 뽑아
--     fulfill_order/confirm_real_payment 양쪽이 각자 권한 체크 후 호출하는
--     구조로 리팩터링할 계획입니다(docs/TODO.md 참고).
--
-- schema.sql은 건드리지 않습니다 — orders에 컬럼 하나만 추가합니다.
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- [1] orders.payment_provider 컬럼 추가
--   - Payment Adapter가 이 주문을 처리한 provider 식별자 (mock/toss/portone)
--   - null이면 레거시 경로(매니저가 /manager/orders에서 수동 확인하는 주문)
--   - 기존 pay_method(카드/카카오페이 등 "결제 수단" 선택값)와는 별개 —
--     pay_method는 그대로 두고, 이 컬럼만으로 "테스트 결제 RPC를 써도 되는
--     주문인지"를 안전하게 구분합니다.
-- ------------------------------------------------------------
alter table orders add column if not exists payment_provider text;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'orders_payment_provider_check') then
        alter table orders add constraint orders_payment_provider_check
            check (payment_provider is null or payment_provider in ('mock', 'toss', 'portone'));
    end if;
end $$;

comment on column orders.payment_provider is
    'Payment Adapter가 이 주문을 처리한 provider(mock/toss/portone). null=레거시 매니저 수동 확인 경로';


-- ============================================================
-- [2] 테스트 결제 확정 (Mock Provider 전용)
--   - 본인 소유 + payment_provider = 'mock' 인 주문만 허용
--   - fulfill_order와 동일한 3단계 수행: 주문 paid 처리 → 수강권 발급 →
--     매출 기록 → 주문 done 처리 (하나의 트랜잭션으로 원자적 처리)
--   - 이미 done이면 중복 발급 방지(fulfill_order와 동일 패턴)
-- ============================================================
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


-- ============================================================
-- [3] 테스트 결제 취소 (Mock Provider 전용)
--   - 본인 소유 + payment_provider = 'mock' + 아직 done 아닌 주문만
--   - Mock 시나리오가 "cancelled"일 때, 또는 회원이 명시적으로 취소할 때 사용
-- ============================================================
create or replace function cancel_test_payment(p_order_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_order record;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if v_order.profile_id not in (select my_profile_ids()) then
        raise exception '본인 주문만 취소할 수 있어요';
    end if;

    if v_order.payment_provider is distinct from 'mock' then
        raise exception '테스트 결제 취소는 Mock 결제 주문에만 사용할 수 있어요';
    end if;

    if v_order.status = 'done' then
        raise exception '이미 발급된 주문은 취소할 수 없어요';
    end if;

    update orders set status = 'cancelled' where id = p_order_id;

    return json_build_object('cancelled', true);
end;
$$;


-- ============================================================
-- 완료!
--   confirm_test_payment / cancel_test_payment 모두 payment_provider='mock'
--   주문에만 동작하므로, 실제 Toss/PortOne이 붙어도 이 함수들이 실제 결제
--   주문을 건드릴 수 없습니다.
-- ============================================================
