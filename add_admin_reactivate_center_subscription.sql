-- ============================================================
-- 운영자용 — 취소된 센터 구독 재개
--
-- 배경: admin_cancel_center_subscription()으로 status를 'canceled'로 바꾸는 액션은
-- 있는데, 그걸 되돌릴 방법이 전혀 없었다. 실제로 QA 도중 실제 센터("어텐션 피겨팀")의
-- 구독을 관리자 화면에서 취소해봤다가 그대로 영구히 취소 상태로 남는 문제를 실제로
-- 겪었다(2026-08-26) — 아직 실제 청구(billing)가 없는 단계라 "취소"가 되돌릴 수 없는
-- 막다른 길이 되는 건 정상적인 운영 흐름이 아니다.
--
-- 재개 시 상태 결정: 카드가 등록돼 있으면(card_last4 not null) 'active'로, 아니면
-- 신규 센터가 생성될 때와 동일한 'pending_billing_setup'으로 되돌린다
-- (add_center_platform_subscription.sql의 create_default_center_subscription()과
-- 동일한 기본값 — 지금은 실제로 billing이 꺼져 있어 카드가 등록된 경우가 없으므로
-- 대부분 pending_billing_setup으로 돌아간다).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create or replace function admin_reactivate_center_subscription(p_center_id uuid)
returns void
language plpgsql
security definer
as $$
declare
    v_card_last4 text;
begin
    if not is_platform_admin() then
        raise exception '플랫폼 운영자만 센터의 구독을 재개할 수 있어요';
    end if;

    select card_last4 into v_card_last4 from center_subscriptions where center_id = p_center_id;
    if not found then
        raise exception '이 센터의 구독 정보를 찾을 수 없어요';
    end if;

    update center_subscriptions
    set status = case when v_card_last4 is not null then 'active' else 'pending_billing_setup' end,
        updated_at = now()
    where center_id = p_center_id;
end;
$$;

-- GRANT/REVOKE를 따로 조정하지 않는다 — admin_cancel_center_subscription()과 동일한
-- 패턴으로, 함수 기본값(PUBLIC 실행 가능)을 그대로 두고 내부 is_platform_admin() 체크가
-- 실질적 게이트다.
