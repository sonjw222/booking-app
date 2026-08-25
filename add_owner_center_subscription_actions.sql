-- ============================================================
-- 오너 셀프서비스 — 본인 센터의 구독 플랜 변경 / 구독 취소
--
-- 배경: 운영자는 add_admin_center_subscription_actions.sql로 아무 센터나 플랜 변경/
-- 취소가 가능한데, 정작 센터 오너 본인은 자기 구독을 스스로 바꾸거나 취소할 방법이
-- 없었다(사용자 QA 피드백). center_subscriptions는 일반 사용자에게 쓰기 정책이 아예
-- 없어(add_center_platform_subscription.sql 의도적 설계) 오너용 셀프서비스도 RPC를
-- 거쳐야 한다.
--
-- 사용자 결정(2026-08-26):
--   - 구독 취소: 상태만 'canceled'로 바뀔 뿐 앱 사용(기능 접근)은 그대로 유지 — 실제
--     결제가 아직 없는 단계라 "취소"에 별다른 제재를 걸 이유가 없음.
--   - 플랜 변경: 새 플랜의 제한(룸/스태프/회원/상품)을 현재 사용량이 이미 초과했으면
--     변경 자체를 막는다(다운그레이드했다가 신규 추가만 막히는 어정쩡한 상태 대신,
--     아예 못 바꾸게 해서 오너가 먼저 정리하도록 유도).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 호출자가 이 센터의 오너인지 확인하는 내부 헬퍼(두 함수에서 공용).
create or replace function _is_owner_of_center(p_center_id uuid)
returns boolean
language sql
stable
as $$
    select exists (
        select 1
        from manager_centers mc
        join center_roles cr on cr.id = mc.role_id
        join accounts a on a.id = mc.account_id
        where mc.center_id = p_center_id
          and a.auth_id = auth.uid()
          and cr.is_owner
          and mc.status = 'active'
    );
$$;

-- 오너 본인의 구독 플랜 변경. 현재 사용량이 새 플랜 제한을 이미 초과하면 거부한다.
create or replace function center_change_own_subscription_plan(p_center_id uuid, p_plan_id uuid)
returns void
language plpgsql
security definer
as $$
declare
    v_plan       subscription_plans;
    v_room_count int;
    v_staff_count int;
    v_member_count int;
    v_product_count int;
begin
    if not _is_owner_of_center(p_center_id) then
        raise exception '이 센터의 오너만 구독 플랜을 바꿀 수 있어요';
    end if;

    select * into v_plan from subscription_plans where id = p_plan_id;
    if not found then
        raise exception '존재하지 않는 플랜이에요';
    end if;

    if v_plan.max_rooms is not null then
        select count(*) into v_room_count from rooms where center_id = p_center_id;
        if v_room_count > v_plan.max_rooms then
            raise exception '현재 룸이 %개라 이 플랜(최대 %개)으로 바꿀 수 없어요. 먼저 룸을 정리해주세요.', v_room_count, v_plan.max_rooms;
        end if;
    end if;

    if v_plan.max_staff is not null then
        select count(*) into v_staff_count
        from manager_centers mc join center_roles cr on cr.id = mc.role_id
        where mc.center_id = p_center_id and mc.status in ('pending', 'active') and not cr.is_owner;
        if v_staff_count > v_plan.max_staff then
            raise exception '현재 스태프가 %명이라 이 플랜(최대 %명)으로 바꿀 수 없어요. 먼저 스태프를 정리해주세요.', v_staff_count, v_plan.max_staff;
        end if;
    end if;

    if v_plan.max_members is not null then
        select count(*) into v_member_count from center_members where center_id = p_center_id;
        if v_member_count > v_plan.max_members then
            raise exception '현재 회원이 %명이라 이 플랜(최대 %명)으로 바꿀 수 없어요. 먼저 회원을 정리해주세요.', v_member_count, v_plan.max_members;
        end if;
    end if;

    if v_plan.max_products is not null then
        select count(*) into v_product_count from products where center_id = p_center_id and is_active;
        if v_product_count > v_plan.max_products then
            raise exception '현재 판매 중 상품이 %종이라 이 플랜(최대 %종)으로 바꿀 수 없어요. 먼저 상품을 정리해주세요.', v_product_count, v_plan.max_products;
        end if;
    end if;

    update center_subscriptions set plan_id = p_plan_id, updated_at = now() where center_id = p_center_id;
end;
$$;

-- 오너 본인의 구독 취소 — 상태만 바뀌고 기능 제한은 없음(사용자 결정).
create or replace function center_cancel_own_subscription(p_center_id uuid)
returns void
language plpgsql
security definer
as $$
begin
    if not _is_owner_of_center(p_center_id) then
        raise exception '이 센터의 오너만 구독을 취소할 수 있어요';
    end if;

    update center_subscriptions set status = 'canceled', updated_at = now() where center_id = p_center_id;
end;
$$;
