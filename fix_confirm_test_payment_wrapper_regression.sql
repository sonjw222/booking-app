-- ============================================================
-- confirm_test_payment() 잘못된 복구 수정 — SEC-118 검증 경로 복원
--
-- 배경: 라이브 DB의 confirm_test_payment()가 ensure_center_member()를 호출하지 않는
-- 드리프트가 있어(SYNC-001 회귀) fix_sync_test_payment_center_member_draft_proposed.sql의
-- "예전 독립형(standalone)" 버전을 재적용해 고쳤는데, 그 버전은 add_confirm_real_payment.sql
-- 이후에 도입된 "공통 헬퍼(_issue_membership_and_record_payment) 호출 + SEC-118 금액검증"
-- 리팩터보다 더 오래된 세대였다 — 재적용하면서 그 사이의 SEC-118 리팩터를 실수로 되돌려버림
-- (PR #129 통합테스트 order-amount-verification.test.ts 4건이 검출: 조작된 금액/쿠폰/포인트
-- 주장이 더는 거부되지 않고 통과함).
--
-- 이 파일은 add_confirm_real_payment.sql의 최신(공통 헬퍼 호출) 형태를 기준으로,
-- ensure_center_member() 호출만 추가한다 — SEC-118 검증 경로(_issue_membership_and_
-- record_payment 내부)는 전혀 안 건드리고 그대로 재사용.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

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

    -- [SYNC-001] fulfill_order()와 동일하게 센터 회원 등록을 동기화한다.
    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    return json_build_object(
        'already_done', false,
        'membership_id', v_result->>'membership_id',
        'amount', (v_result->>'amount')::int
    );
end;
$$;

-- ============================================================
-- 확인 — 둘 다 true여야 정상
-- ============================================================
select pg_get_functiondef(oid) like '%_issue_membership_and_record_payment%' as calls_sec118_helper,
       pg_get_functiondef(oid) like '%ensure_center_member%' as has_sync001_fix
from pg_proc where proname = 'confirm_test_payment';
