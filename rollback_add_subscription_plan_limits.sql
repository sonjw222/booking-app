-- add_subscription_plan_limits.sql 롤백
--
-- 트리거/함수/컬럼을 전부 제거해 "플랜 제한 강제" 이전 상태로 되돌립니다.
-- add_center_platform_subscription.sql이 만든 3개 테이블 자체는 건드리지 않습니다.

BEGIN;

drop function if exists set_default_subscription_plan(uuid);

drop trigger if exists trg_enforce_product_limit on products;
drop function if exists enforce_product_limit();

drop trigger if exists trg_enforce_member_limit on center_members;
drop function if exists enforce_member_limit();

drop trigger if exists trg_enforce_staff_limit on manager_centers;
drop function if exists enforce_staff_limit();

drop trigger if exists trg_enforce_room_limit on rooms;
drop function if exists enforce_room_limit();

-- create_default_center_subscription()을 "가장 먼저 만든 활성 플랜" 방식으로 원복
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

drop index if exists idx_subscription_plans_one_default;

alter table subscription_plans drop column if exists max_rooms;
alter table subscription_plans drop column if exists max_staff;
alter table subscription_plans drop column if exists max_members;
alter table subscription_plans drop column if exists max_products;
alter table subscription_plans drop column if exists is_default;

COMMIT;
