-- ============================================================
-- 운영자용 센터 구독 관리 액션 — 플랜 변경 / 구독 취소
--
-- 배경: /admin/subscriptions(센터별 구독 현황)가 지금까지 조회 전용이라 운영자가
-- 센터의 플랜을 바꾸거나 구독을 취소할 방법이 없었다(사용자 QA 피드백). center_subscriptions
-- 테이블은 일반 사용자에게 INSERT/UPDATE 정책이 아예 없어(add_center_platform_subscription.sql
-- 의도적 설계 — service_role 또는 security definer RPC만 쓰기 가능) 운영자 화면도 반드시
-- RPC를 거쳐야 한다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 센터의 플랜을 바꾼다. 상태(status)는 건드리지 않는다 — 단순 플랜 변경이고, 카드/청구
-- 상태는 이 작업과 무관하게 그대로 유지되는 게 자연스럽다(예: active 상태에서 다른
-- 플랜으로 바꿔도 다음 청구는 새 플랜 가격으로, 카드는 그대로 등록돼 있어야 함).
create or replace function admin_set_center_subscription_plan(p_center_id uuid, p_plan_id uuid)
returns void
language plpgsql
security definer
as $$
begin
    if not is_platform_admin() then
        raise exception '플랫폼 운영자만 센터의 구독 플랜을 바꿀 수 있어요';
    end if;

    if not exists (select 1 from subscription_plans where id = p_plan_id) then
        raise exception '존재하지 않는 플랜이에요';
    end if;

    update center_subscriptions set plan_id = p_plan_id, updated_at = now()
    where center_id = p_center_id;

    if not found then
        raise exception '이 센터의 구독 정보를 찾을 수 없어요';
    end if;
end;
$$;

-- GRANT/REVOKE를 따로 조정하지 않는다 — set_default_subscription_plan()과 동일한 패턴으로,
-- 함수 기본값(PUBLIC 실행 가능)을 그대로 두고 내부 is_platform_admin() 체크가 실질적 게이트다.

-- 구독을 취소한다(status='canceled'). 이미 취소된 구독을 다시 취소해도 안전(멱등).
create or replace function admin_cancel_center_subscription(p_center_id uuid)
returns void
language plpgsql
security definer
as $$
begin
    if not is_platform_admin() then
        raise exception '플랫폼 운영자만 센터의 구독을 취소할 수 있어요';
    end if;

    update center_subscriptions set status = 'canceled', updated_at = now()
    where center_id = p_center_id;

    if not found then
        raise exception '이 센터의 구독 정보를 찾을 수 없어요';
    end if;
end;
$$;
