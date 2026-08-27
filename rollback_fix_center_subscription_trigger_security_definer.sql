-- ============================================================
-- fix_center_subscription_trigger_security_definer.sql 롤백
-- security definer 추가 이전(add_center_platform_subscription.sql이 정의했던 원문
-- plpgsql invoker 함수) 그대로 되돌린다. 로직은 전혀 안 바뀜 — 실행 권한 컨텍스트만
-- 원래대로.
-- ============================================================

create or replace function create_default_center_subscription()
returns trigger
language plpgsql
as $$
declare
    v_plan_id uuid;
begin
    select id into v_plan_id
    from subscription_plans
    where is_active
    order by created_at asc
    limit 1;

    if v_plan_id is not null then
        insert into center_subscriptions (center_id, plan_id, status)
        values (new.id, v_plan_id, 'pending_billing_setup')
        on conflict (center_id) do nothing;
    end if;

    return new;
end;
$$;
