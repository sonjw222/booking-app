-- ============================================================
-- P4(매출/통계 대시보드 배치): payments.payment_provider 컬럼 추가
--
-- 배경(코드 감사로 확인):
--   실제 매출과 테스트(Mock) 결제를 구분할 신뢰 가능한 컬럼이 payments 테이블에 없었다.
--   orders.payment_provider(add_payment_test_provider.sql)는 있지만 payments는 orders와
--   FK로 연결돼 있지 않고(order_id 컬럼 자체가 없음), confirm_test_payment()가 만드는
--   행을 구분할 유일한 단서는 pg_transaction_id가 "mock_"로 시작한다는 문자열 관례뿐이었다
--   (미문서화, 강제 안 됨). 매출 통계가 이 관례에 기대면 깨지기 쉽고, "Mock 결제를 절대
--   실제 매출로 혼동하지 않는다"는 요구사항을 코드로 보장할 수 없었다.
--
--   payments에 insert하는 곳은 8곳(add_auto_booking.sql, add_direct_payment.sql,
--   add_order_fulfillment.sql=fulfill_order, add_payment_test_provider.sql=
--   confirm_test_payment, add_refund_and_membership.sql 2곳, add_unplaced_passes.sql,
--   reservation_functions.sql 2곳)이지만, 이 중 실제로 "테스트 결제"인 것은
--   confirm_test_payment 하나뿐이다 — 나머지는 전부 매니저가 직접 입력하거나
--   신뢰된 서버 로직이 만드는 실제 매출 경로다(add_payment_test_provider.sql 자신의
--   주석: "fulfill_order = 매니저 신뢰 기반 / confirm_test_payment = 본인 소유 +
--   payment_provider='mock' 한정"). 그래서 이 마이그레이션은 confirm_test_payment
--   하나만 재정의하고, 나머지 7곳은 전혀 건드리지 않는다 — payment_provider가
--   NULL이면 "실제 매출"이라는 뜻이고, 이는 이미 orders.payment_provider의 기존 관례
--   (null=레거시/매니저 수동 확인 경로)와 정확히 같은 의미다.
--
-- 영향받는 기존 데이터: payments 테이블에 컬럼 하나 추가(전부 NULL로 시작), 그 다음
--   이미 존재하는 mock 결제 행만 백필(테이블 전체 UPDATE 아님 — WHERE로 좁혀짐).
-- 예상 행 수: 이 개발 DB에서 지금까지 쌓인 통합테스트 결제 건수만큼(정확한 수는
--   백필 직후 검증 SELECT로 확인).
-- 위험도: 낮음 — 컬럼 추가는 nullable(기존 insert 7곳 전혀 안 건드림), 백필은
--   기존에도 이미 "mock_"로 시작하는 pg_transaction_id를 가진 행만 대상.
-- ============================================================

BEGIN;

-- [1] 컬럼 추가 — orders.payment_provider와 동일한 값 집합, nullable.
alter table payments add column if not exists payment_provider text;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'payments_payment_provider_check') then
        alter table payments add constraint payments_payment_provider_check
            check (payment_provider is null or payment_provider in ('mock', 'toss', 'portone'));
    end if;
end $$;

comment on column payments.payment_provider is
    '이 매출 행이 Mock(테스트) 결제로 발급됐는지(mock) 실제 결제(toss/portone)인지. NULL=매니저
     직접 입력 등 실제 매출 경로(fulfill_order/직접결제/환불/미배치 발급 등) — 통계는 이 값이
     mock이 아닌 행만 실제 매출로 집계해야 한다.';

-- [2] confirm_test_payment() 재정의 — 자기 자신이 만드는 매출 행에 payment_provider='mock'
-- 을 명시적으로 채우는 것만 추가, 나머지 로직은 기존과 완전히 동일(add_payment_test_provider.sql).
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

    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    v_count := null;
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            v_count := v_product.total_count;
        end if;
    end if;

    v_expires := (now() + interval '60 days')::date;

    update orders set status = 'paid', paid_at = now() where id = p_order_id;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, status
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, 'active'
    ) returning id into v_membership_id;

    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo,
        payment_provider
    ) values (
        v_order.center_id, v_order.profile_id, v_membership_id,
        'new', 'membership',
        v_order.amount, 0, 0, 0,
        v_order.amount, 0, p_provider_ref, now(), 'paid',
        '테스트 결제(Mock Provider) 자동 발급',
        'mock'
    );

    update orders set status = 'done' where id = p_order_id;

    return json_build_object(
        'already_done', false,
        'membership_id', v_membership_id,
        'amount', v_order.amount
    );
end;
$$;

-- [3] 백필 — 이 컬럼이 생기기 전에 이미 confirm_test_payment로 만들어진 과거 행들.
-- pg_transaction_id가 "mock_"로 시작하는 행만 좁혀서 갱신(테이블 전체 UPDATE 아님).
update payments
   set payment_provider = 'mock'
 where payment_provider is null
   and pg_transaction_id like 'mock\_%' escape '\';

COMMIT;

-- ============================================================
-- 확인
-- ============================================================
select payment_provider, count(*) from payments group by payment_provider order by 1;
