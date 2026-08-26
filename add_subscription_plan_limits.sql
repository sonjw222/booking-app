-- ============================================================
-- 구독 플랜 실제 제한 강제 (룸/스태프/회원/상품 종류 수)
--
-- 배경: add_center_platform_subscription.sql의 subscription_plans는 자유 텍스트
-- description만 있어서 실제로 아무것도 강제하지 못했다. 이 파일은:
--   1) subscription_plans에 숫자 제한 컬럼 4개 추가(null = 무제한)
--   2) "신규 센터 기본 플랜"을 트리거의 암묵적 "가장 먼저 만들어진 활성 플랜"이 아니라
--      명시적 is_default 플래그로 바꿈(플랜이 여러 개 생기면 암묵적 규칙은 헷갈림)
--   3) rooms/manager_centers/center_members/products 4개 테이블에 BEFORE INSERT
--      트리거를 달아 그 센터의 현재 플랜 제한을 실제로 강제한다 — 화면이 아니라 DB
--      레벨이라 API를 직접 호출해도 우회 불가능(이 프로젝트의 "RLS가 최종 방어선"
--      원칙과 동일한 이유로 트리거를 씀).
--
-- 안전성 확인(라이브 실측, 2026-08-26): 현재 센터당 최대 룸 1개/스태프 9명/회원
-- 27명/상품 종류 수 미확인이나 다들 소규모 — 기존 "기본 플랜"은 4개 전부 null(무제한)로
-- 유지해 기존 454개 센터 중 아무도 걸리지 않는다.
--
-- 카운트 기준(각 트리거 함수 주석 참고):
--   - 룸: rooms 테이블 전체 행(soft-delete 안 씀, 앱이 hard delete만 함)
--   - 스태프: manager_centers 중 오너 역할 제외 + status in ('pending','active')
--     (오너 본인은 "초대해서 채우는 슬롯"이 아니므로 제외)
--   - 회원: center_members 테이블 전체 행(status와 무관 — 지속되는 명단이라는 테이블
--     설계 의도 그대로, expired/dormant도 이미 등록된 고객 레코드로 취급)
--   - 상품: products 중 is_active=true(판매 정지/삭제된 상품은 슬롯에서 제외 —
--     lib/passes.ts의 "삭제"가 실제로는 is_active=false UPDATE임)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] subscription_plans에 제한 컬럼 + is_default 추가
-- ------------------------------------------------------------
alter table subscription_plans add column if not exists max_rooms int;
alter table subscription_plans add column if not exists max_staff int;
alter table subscription_plans add column if not exists max_members int;
alter table subscription_plans add column if not exists max_products int;
alter table subscription_plans add column if not exists is_default boolean not null default false;

comment on column subscription_plans.max_rooms is '이 플랜의 최대 룸 개수. null=무제한';
comment on column subscription_plans.max_staff is '이 플랜의 최대 스태프 수(오너 제외). null=무제한';
comment on column subscription_plans.max_members is '이 플랜의 최대 회원 수. null=무제한';
comment on column subscription_plans.max_products is '이 플랜의 최대 판매 중 상품 종류 수. null=무제한';
comment on column subscription_plans.is_default is '신규 센터 가입 시 자동 배정되는 기본 플랜(정확히 하나만 true)';

-- 정확히 하나의 플랜만 is_default=true일 수 있도록 강제(부분 유니크 인덱스 —
-- is_default=false인 행은 인덱스 대상이 아니라 여러 개 있어도 상관없음)
create unique index if not exists idx_subscription_plans_one_default
    on subscription_plans (is_default) where is_default;

-- 기존 "기본 플랜"을 명시적 기본값으로 지정(트리거가 이제부터 이 플래그를 봄)
update subscription_plans set is_default = true
where is_active
and not exists (select 1 from subscription_plans where is_default)
and id = (select id from subscription_plans where is_active order by created_at asc limit 1);


-- ------------------------------------------------------------
-- [2] 센터 생성 시 기본 플랜 배정 — "가장 먼저 만든 활성 플랜"이 아니라
--     명시적 is_default 플랜을 쓰도록 변경
-- ------------------------------------------------------------
create or replace function create_default_center_subscription()
returns trigger
language plpgsql
as $$
declare
    v_plan_id uuid;
begin
    select id into v_plan_id from subscription_plans where is_default limit 1;

    if v_plan_id is not null then
        insert into center_subscriptions (center_id, plan_id, status)
        values (new.id, v_plan_id, 'pending_billing_setup')
        on conflict (center_id) do nothing;
    end if;

    return new;
end;
$$;


-- ------------------------------------------------------------
-- [3] 플랜 제한 강제 트리거 4종
-- ------------------------------------------------------------

-- 3-1. 룸
create or replace function enforce_room_limit()
returns trigger
language plpgsql
as $$
declare
    v_max   int;
    v_count int;
begin
    select sp.max_rooms into v_max
    from center_subscriptions cs join subscription_plans sp on sp.id = cs.plan_id
    where cs.center_id = new.center_id;

    if v_max is null then
        return new; -- 플랜 없음(예외 상황) 또는 무제한
    end if;

    select count(*) into v_count from rooms where center_id = new.center_id;
    if v_count >= v_max then
        raise exception '현재 플랜은 룸을 최대 %개까지만 만들 수 있어요. 플랜을 업그레이드해주세요.', v_max;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_enforce_room_limit on rooms;
create trigger trg_enforce_room_limit
    before insert on rooms
    for each row execute function enforce_room_limit();


-- 3-2. 스태프 (오너 역할 제외, pending/active만 슬롯 소비)
create or replace function enforce_staff_limit()
returns trigger
language plpgsql
as $$
declare
    v_max     int;
    v_count   int;
    v_is_owner boolean;
begin
    select cr.is_owner into v_is_owner from center_roles cr where cr.id = new.role_id;
    if coalesce(v_is_owner, false) then
        return new; -- 오너 본인 행은 슬롯 소비 안 함(센터 생성 시 자동 생성되는 행 포함)
    end if;

    select sp.max_staff into v_max
    from center_subscriptions cs join subscription_plans sp on sp.id = cs.plan_id
    where cs.center_id = new.center_id;

    if v_max is null then
        return new;
    end if;

    select count(*) into v_count
    from manager_centers mc join center_roles cr on cr.id = mc.role_id
    where mc.center_id = new.center_id
      and mc.status in ('pending', 'active')
      and not cr.is_owner;

    if v_count >= v_max then
        raise exception '현재 플랜은 스태프를 최대 %명까지만 초대할 수 있어요. 플랜을 업그레이드해주세요.', v_max;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_enforce_staff_limit on manager_centers;
create trigger trg_enforce_staff_limit
    before insert on manager_centers
    for each row execute function enforce_staff_limit();


-- 3-3. 회원
create or replace function enforce_member_limit()
returns trigger
language plpgsql
as $$
declare
    v_max   int;
    v_count int;
begin
    select sp.max_members into v_max
    from center_subscriptions cs join subscription_plans sp on sp.id = cs.plan_id
    where cs.center_id = new.center_id;

    if v_max is null then
        return new;
    end if;

    select count(*) into v_count from center_members where center_id = new.center_id;
    if v_count >= v_max then
        raise exception '현재 플랜은 회원을 최대 %명까지만 등록할 수 있어요. 플랜을 업그레이드해주세요.', v_max;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_enforce_member_limit on center_members;
create trigger trg_enforce_member_limit
    before insert on center_members
    for each row execute function enforce_member_limit();


-- 3-4. 상품 종류(판매 중인 것만 카운트)
create or replace function enforce_product_limit()
returns trigger
language plpgsql
as $$
declare
    v_max   int;
    v_count int;
begin
    -- is_active=false로 등록되는 상품(있다면)은 애초에 슬롯을 안 쓰므로 검사 불필요
    if coalesce(new.is_active, true) = false then
        return new;
    end if;

    select sp.max_products into v_max
    from center_subscriptions cs join subscription_plans sp on sp.id = cs.plan_id
    where cs.center_id = new.center_id;

    if v_max is null then
        return new;
    end if;

    select count(*) into v_count from products where center_id = new.center_id and is_active;
    if v_count >= v_max then
        raise exception '현재 플랜은 상품을 최대 %종까지만 등록할 수 있어요. 플랜을 업그레이드해주세요.', v_max;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_enforce_product_limit on products;
create trigger trg_enforce_product_limit
    before insert on products
    for each row execute function enforce_product_limit();

-- ------------------------------------------------------------
-- [4] 기본 플랜 지정 RPC — "기존 기본 플랜 해제 + 새 플랜 지정"을 한 트랜잭션으로
--     원자적으로 처리(클라이언트에서 UPDATE 2번 따로 호출하면 그 사이 레이스 가능).
--     운영자 전용(is_platform_admin) — subscription_plans RLS의 "운영자 관리" 정책과
--     동일한 권한 기준을 함수 안에서도 명시적으로 재확인.
-- ------------------------------------------------------------
create or replace function set_default_subscription_plan(p_plan_id uuid)
returns void
language plpgsql
security definer
as $$
begin
    if not is_platform_admin() then
        raise exception '플랫폼 운영자만 기본 플랜을 지정할 수 있어요';
    end if;

    update subscription_plans set is_default = false where is_default;
    update subscription_plans set is_default = true where id = p_plan_id;
end;
$$;

COMMIT;

-- ============================================================
-- 완료! 확인:
--   select name, max_rooms, max_staff, max_members, max_products, is_default
--   from subscription_plans;
-- 기존 "기본 플랜"의 4개 컬럼이 전부 null(무제한)이고 is_default=true인지 확인하세요.
-- ============================================================
