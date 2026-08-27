-- ============================================================
-- P0-1 후속: 실제 PG(토스페이먼츠) 결제 확정 RPC
--
-- 배경: add_payment_test_provider.sql이 미리 계획해둔 대로("향후 실제 PG 웹훅을 붙일 때
-- 위 공통화를 함께 진행합니다"), confirm_test_payment()와 거의 동일한 "수강권 발급 + 매출
-- 기록 + 주문 완료 처리" 로직을 내부 헬퍼(_issue_membership_and_record_payment, 권한 체크
-- 없음)로 뽑아내고, confirm_test_payment/confirm_real_payment가 각자 자기 신뢰 모델에 맞는
-- 권한 체크를 마친 뒤 이 헬퍼를 호출하도록 리팩터링합니다.
--
-- fulfill_order()(add_order_fulfillment.sql)는 이 배치에서 전혀 건드리지 않습니다 —
-- 매니저 신뢰 모델이 서로 달라 그대로 별개로 둡니다(기존 관례 유지).
--
-- confirm_real_payment()의 신뢰 모델: 이 함수는 app/api/payments/confirm/route.ts
-- (서버 전용 Next.js API 라우트, service_role 키 사용)에서만 호출됩니다. 그 라우트는
-- 호출 전에 토스 결제 승인 API(시크릿 키로 서버 간 통신)로 실제 결제가 성공했음을 이미
-- 확인했으므로, 이 함수 자체는 auth.uid() 기반 "본인 소유" 체크를 하지 않습니다(호출자가
-- 이미 신뢰된 서버이기 때문 — confirm_test_payment의 "본인 소유" 체크와는 다른 이유로
-- 필요 없음). 대신 이 함수의 실행 권한 자체를 service_role로만 좁혀서, 일반 로그인
-- 사용자가 이 RPC를 직접 호출해 임의 주문을 결제완료 처리하는 것을 막습니다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- [1] 공통 헬퍼: 권한 체크 없는 순수 로직만 (fulfill_order/confirm_test_payment와
--     동일한 3단계 — 주문 paid 처리 → 수강권 발급 → 매출 기록 → 주문 done 처리)
--     public 스키마에 두되 실행 권한은 아래에서 정의자(functions 소유자)로 제한.
-- ------------------------------------------------------------
create or replace function _issue_membership_and_record_payment(p_order orders, p_provider_ref text, p_memo text)
returns json
language plpgsql
security definer
as $$
declare
    v_product       record;
    v_membership_id uuid;
    v_count         int;
    v_expires       date;
begin
    v_count := null;
    if p_order.product_id is not null then
        select * into v_product from products where id = p_order.product_id;
        if found then
            v_count := v_product.total_count;
        end if;
    end if;

    v_expires := (now() + interval '60 days')::date;

    update orders set status = 'paid', paid_at = now() where id = p_order.id;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, status
    ) values (
        p_order.profile_id, p_order.center_id, p_order.product_id, p_order.product_name,
        'count', v_count, v_count, v_expires, 'active'
    ) returning id into v_membership_id;

    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo
    ) values (
        p_order.center_id, p_order.profile_id, v_membership_id,
        'new', 'membership',
        p_order.amount, 0, 0, 0,
        p_order.amount, 0, p_provider_ref, now(), 'paid',
        p_memo
    );

    update orders set status = 'done' where id = p_order.id;

    return json_build_object('membership_id', v_membership_id, 'amount', p_order.amount);
end;
$$;

-- 일반 사용자가 권한 체크 없는 이 헬퍼를 직접 호출하지 못하도록 실행 권한을 제거.
-- confirm_test_payment/confirm_real_payment(둘 다 security definer)만 내부적으로 호출.
revoke execute on function _issue_membership_and_record_payment(orders, text, text) from public, authenticated, anon;


-- ------------------------------------------------------------
-- [2] confirm_test_payment 리팩터링 — 동작은 기존과 완전히 동일, 내부 로직만
--     공통 헬퍼 호출로 교체(중복 제거). 권한 체크(본인 소유 + payment_provider='mock')는
--     그대로 유지.
-- ------------------------------------------------------------
create or replace function confirm_test_payment(p_order_id uuid, p_provider_ref text)
returns json
language plpgsql
security definer
as $$
declare
    v_order  orders;
    v_result json;
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

    v_result := _issue_membership_and_record_payment(v_order, p_provider_ref, '테스트 결제(Mock Provider) 자동 발급');

    return json_build_object(
        'already_done', false,
        'membership_id', v_result->>'membership_id',
        'amount', (v_result->>'amount')::int
    );
end;
$$;


-- ------------------------------------------------------------
-- [3] confirm_real_payment — 실제 PG(토스) 결제 확정. service_role 전용(아래 GRANT 참고).
--     p_amount: 서버 라우트가 토스 승인 응답의 금액과 우리 orders.amount가 일치하는지
--     한 번 더 검증(이중 방어 — 라우트에서도 검증하지만 RPC 레벨에서도 재확인).
-- ------------------------------------------------------------
create or replace function confirm_real_payment(p_order_id uuid, p_payment_key text, p_amount int)
returns json
language plpgsql
security definer
as $$
declare
    v_order  orders;
    v_result json;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if v_order.payment_provider is distinct from 'toss' and v_order.payment_provider is distinct from 'portone' then
        raise exception '실 결제 확정은 실제 PG 주문에만 사용할 수 있어요';
    end if;

    if v_order.amount is distinct from p_amount then
        raise exception '결제 금액이 주문 금액과 일치하지 않아요';
    end if;

    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    v_result := _issue_membership_and_record_payment(v_order, p_payment_key, '실 결제(' || v_order.payment_provider || ') 자동 발급');

    return json_build_object(
        'already_done', false,
        'membership_id', v_result->>'membership_id',
        'amount', (v_result->>'amount')::int
    );
end;
$$;

-- 일반 로그인 사용자가 이 RPC를 직접 호출해 임의 주문을 결제완료 처리할 수 없도록,
-- 실행 권한을 service_role로만 좁힌다(app/api/payments/confirm/route.ts 전용).
revoke execute on function confirm_real_payment(uuid, text, int) from public, authenticated, anon;
grant execute on function confirm_real_payment(uuid, text, int) to service_role;


-- ------------------------------------------------------------
-- [4] cancel_real_payment — 실제 PG 결제 취소(webhook/취소 라우트 전용). service_role 전용.
-- ------------------------------------------------------------
create or replace function cancel_real_payment(p_order_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_order orders;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if v_order.payment_provider is distinct from 'toss' and v_order.payment_provider is distinct from 'portone' then
        raise exception '실 결제 취소는 실제 PG 주문에만 사용할 수 있어요';
    end if;

    if v_order.status = 'done' then
        raise exception '이미 발급된 주문은 취소할 수 없어요';
    end if;

    update orders set status = 'cancelled' where id = p_order_id;

    return json_build_object('cancelled', true);
end;
$$;

revoke execute on function cancel_real_payment(uuid) from public, authenticated, anon;
grant execute on function cancel_real_payment(uuid) to service_role;

-- ============================================================
-- 완료! confirm_real_payment/cancel_real_payment는 service_role만 실행 가능하므로
-- 일반 사용자 세션(anon/authenticated)에서는 호출 자체가 거부됩니다(RPC 권한 오류) —
-- 반드시 app/api/payments/* 서버 라우트(TOSS_SECRET_KEY로 이미 결제 검증 완료)를 거쳐야
-- 합니다.
-- ============================================================
