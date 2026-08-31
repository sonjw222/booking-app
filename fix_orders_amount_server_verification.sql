-- ============================================================
-- SEC-118(P0): orders.amount 클라이언트 신뢰 문제 — 서버 검증 도입
--
-- [근본 원인, 실측 확인] lib/orders.ts의 createOrder()가 클라이언트가 계산한 amount를
-- 그대로 orders.amount에 저장하고, orders INSERT RLS(add_orders.sql)는 profile_id 소유권만
-- 확인할 뿐 금액에는 아무 제약이 없다. confirm_test_payment()/confirm_real_payment()가
-- 공유하는 _issue_membership_and_record_payment() 헬퍼(add_confirm_real_payment.sql)는
-- p_order.amount를 그대로 payments.total_amount에 기록하고 즉시 수강권을 발급한다 — 사람이
-- 검토하는 단계가 전혀 없다. 로그인한 회원이 Supabase 클라이언트로 orders에 직접
-- (예: amount=1) insert한 뒤 confirm_test_payment RPC를 자기 소유 주문으로 호출하면(Mock은
-- 결제 자체를 검증하지 않음) 임의 금액으로 수강권을 즉시 받을 수 있다. confirm_real_payment도
-- "결제사가 실제로 받은 금액과 orders.amount가 같은지"만 검증해 orders.amount 자체가 이미
-- 조작돼 있으면 똑같이 뚫린다.
--
-- [기존 SEC-118 조치와의 관계] docs/TODO.md(P1-5 조사 기록)에 따르면 fulfill_order()
-- (매니저가 수동 승인하는 경로)는 라이브 DB에 이미 자체적인 가격 검증 로직이 들어가 있다
-- (정적 .sql 파일에는 반영 안 된 라이브 전용 변경 — 그 조사에서 "SEC-118"이라는 이름이
-- 처음 쓰였음, 이 배치와 같은 취약점 계열). 그런데 confirm_test_payment/confirm_real_payment
-- 가 공유하는 _issue_membership_and_record_payment()(사람 검토 없이 자동으로 승인되는
-- 경로 — Mock/PG 결제 확정)는 그 조치 대상이 아니었고, 지금 실측 확인해도 여전히 검증이
-- 없다. 이 배치는 그 남은 자동 승인 경로만 좁혀서 고친다(fulfill_order는 이미 자체 방어가
-- 있고 사람이 검토하는 방어선도 있어 건드리지 않음 — docs/25_SEC118_Orders_Amount_Design.md
-- D안 기반).
--
-- [최초 설계 초안의 구멍, 직접 발견해 수정함] 처음에는 orders.points_used를 클라이언트가
-- 주장하는 값 그대로 믿고 "가격 - 검증된 쿠폰 - points_used = amount"만 확인하려 했다.
-- 그런데 이러면 use_points()를 실제로 한 번도 호출하지 않고도 points_used만 큰 값으로
-- 주장해 금액을 임의로 낮출 수 있다 — 쿠폰과 달리 포인트는 "하드코딩된 값 목록"이 아니라
-- "회원마다 다른 실제 잔액"이라 그런 식으로는 검증이 안 된다. 그래서 point_transactions에
-- order_id 연결 고리를 새로 추가해, "이 주문 번호로 실제 차감된 point_transactions 행이
-- 있는지"를 직접 확인하는 방식으로 바꿨다(아래 [1][2] 참고) — points_used는 이제 클라이언트
-- 주장이 아니라 실제 원장 행의 존재로 검증된다.
--
-- 범위: _issue_membership_and_record_payment()만 수정한다(confirm_test_payment/
-- confirm_real_payment 공용 헬퍼라 한 곳만 고치면 두 경로 모두 보호됨).
--
-- [알려진 잔여 위험, 완전히 닫지 않음] use_points()가 주문 생성 "이전"에 orderId 없이
-- 먼저 호출되던 기존 순서를, 이번에 "주문을 먼저 만들고 그 orderId로 포인트를 사용"하도록
-- 바꿨다(app/checkout/page.tsx도 함께 수정). 이 순서 변경 자체가 새로운 레이스는 만들지
-- 않지만, use_points()가 실패(예: 그 사이 다른 주문에서 포인트를 다 씀)하면 주문은 이미
-- pending 상태로 남는다 — 기존에도 결제 흐름 중 어떤 단계든 실패하면 pending 주문이
-- 남는 것과 동일한 패턴이라 새로운 위험은 아니다(사람이 방치된 pending 주문을 신경쓸
-- 필요는 없음 — 매니저 화면에 그대로 노출되고, 재구매 시 새 주문을 또 만들 뿐).
--
-- 기존 데이터 영향: orders.points_used/point_transactions.order_id는 기존 행에 전부
-- NULL/0으로 채워짐(이미 완료된 주문은 이 함수를 다시 통과하지 않으므로 영향 없음).
-- RLS 영향: 없음(컬럼 추가 + 함수 CREATE OR REPLACE만).
--
-- 짝 파일: rollback_fix_orders_amount_server_verification.sql
-- ============================================================

BEGIN;

-- [1] 포인트 사용액을 주문에 남겨 승인 시점에 "가격 - 검증된 쿠폰 - 사용 포인트"와
--     대조할 수 있게 한다.
alter table orders add column if not exists points_used int not null default 0;

comment on column orders.points_used is
    'checkout에서 이 주문에 사용한 포인트(원 단위). use_points() 호출 시 이 주문번호로
     남긴 point_transactions 행이 실제로 있는지로 검증됨(클라이언트 주장을 그대로 믿지 않음)';

-- [2] point_transactions에 어느 주문에서 쓴 차감인지 연결 고리 추가.
--     기존 write_review() 적립이나 매니저 수동 적립/차감(reason 다양)은 주문과 무관하므로
--     order_id가 없어도(null) 정상 — 이 컬럼은 "결제 시 사용" 차감에만 채워진다.
alter table point_transactions add column if not exists order_id uuid references orders(id);

comment on column point_transactions.order_id is
    '결제 시 포인트를 사용한 경우, 그 포인트를 소비한 주문. SEC-118 금액 검증에서
     "실제로 차감된 포인트인지" 확인하는 데 쓰인다';

-- [3] use_points(): 어느 주문에서 쓴 차감인지 남기도록 p_order_id(선택) 추가.
--     인자 개수가 늘어나 CREATE OR REPLACE만으로는 기존 3-인자 함수를 "교체"하지 못하고
--     오버로드로 나란히 남는다 — 두 버전이 공존하면 어느 쪽이 호출될지에 따라 order_id
--     연결이 되거나 안 되거나가 갈려(누군가 실수로 3-인자 형태로 호출하면 SEC-118 검증이
--     못 찾는 point_transactions 행이 생김) 보안 검증의 전제가 흔들린다. 기존 3-인자
--     버전을 명시적으로 제거해 단일 진입점만 남긴다(p_order_id는 기본값 null이라 주문과
--     무관한 용도로 4번째 인자 없이 호출해도 그대로 동작함).
drop function if exists use_points(uuid, uuid, int);

create or replace function use_points(
    p_center_id uuid,
    p_profile_id uuid,
    p_amount int,
    p_order_id uuid default null
)
returns json
language plpgsql
security definer
as $$
declare
    v_balance int;
begin
    if p_profile_id not in (select my_profile_ids()) then
        raise exception '본인 포인트만 사용할 수 있어요';
    end if;
    if p_amount <= 0 then
        return json_build_object('used', 0);
    end if;

    perform 1 from profiles where id = p_profile_id for update;

    select coalesce(sum(amount), 0) into v_balance
    from point_transactions
    where center_id = p_center_id and profile_id = p_profile_id;

    if v_balance < p_amount then
        raise exception '포인트가 부족해요';
    end if;

    insert into point_transactions (profile_id, center_id, amount, reason, order_id)
    values (p_profile_id, p_center_id, -p_amount, '결제 시 사용', p_order_id);

    return json_build_object('used', p_amount);
end;
$$;

-- [4] 공통 헬퍼에 금액 검증 추가 — confirm_test_payment/confirm_real_payment 양쪽 모두
--     이 함수를 거치므로 한 곳만 고치면 두 경로가 전부 보호된다.
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
    v_verified_discount int;
    v_expected_amount   int;
    v_points_verified   boolean;
begin
    v_count := null;
    if p_order.product_id is not null then
        select * into v_product from products where id = p_order.product_id;
        if found then
            v_count := v_product.total_count;

            -- [SEC-118] 데모 쿠폰(app/checkout/page.tsx MY_COUPONS와 동일 값)만 서버가
            -- 신뢰하는 할인으로 인정 — 알려지지 않은 코드나 잘못된 금액을 주장하면 0으로 취급.
            v_verified_discount := case p_order.coupon_code
                when 'WELCOME' then 5000
                when 'FIGURE10' then 10000
                else 0
            end;

            -- [SEC-118] points_used는 클라이언트 주장을 그대로 믿지 않는다 — 이 주문번호로
            -- 실제 point_transactions 차감 행이 남아 있어야만(=use_points()가 진짜 호출됐어야만)
            -- 인정한다. 그렇지 않으면(예: points_used만 조작해서 보낸 경우) 통과시키지 않는다.
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
        -- product_id는 있는데 상품 자체가 이미 삭제된 경우(found=false)는 기존과 동일하게
        -- 검증을 건너뛴다 — 정상 체크아웃 흐름(동기 처리)에서는 사실상 발생하지 않는다.
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

COMMIT;

-- 적용 후 확인 (read-only)
-- select column_name from information_schema.columns where table_name = 'orders' and column_name = 'points_used';
-- select column_name from information_schema.columns where table_name = 'point_transactions' and column_name = 'order_id';
-- select pg_get_functiondef('_issue_membership_and_record_payment(orders, text, text)'::regprocedure);
-- select pg_get_functiondef('use_points(uuid, uuid, int, uuid)'::regprocedure);
