-- ============================================================
-- 대여상품(goods) 사용을 예약에 묶어 원자적으로 차감/복원 + 관리자 예약자 목록에 표시 (2026-10-01 QA)
--
-- 문제(QA 5/6):
--   (1) 예약 화면에서 수강권을 직접 고르면(passPick) reserve_with_membership()만 호출되고
--       고른 대여상품(selectedGoodsId)은 버려졌다 → 대여상품 횟수가 차감되지 않았다.
--   (2) 상품을 고른 경우에도 reserve_class_with_goods()는 reserve_class() 뒤에 별도로 차감만 했고
--       예약과의 연결 기록이 없어 취소해도 대여 횟수가 복원되지 않았다(대기예약이어도 차감).
--   (3) 관리자 예약자 목록에는 어떤 대여상품/사이즈를 쓰는지 알 방법이 없었다.
--
-- 해결:
--   - reservation_goods_usages: 예약 1건당 대여상품 사용 기록(상품명·사이즈 스냅샷, 차감/복원 상태).
--     unique(reservation_id, goods_membership_id)로 같은 예약에 중복 사용 불가.
--   - reserve_with_goods(): 수강권 지정(또는 자동선택) 예약 + 대여상품 검증/차감 + 사용 기록을 하나의
--     함수(=한 트랜잭션)에서 처리. 어느 단계든 실패하면 수강권/상품 모두 차감되지 않는다.
--     대기예약(waitlisted)은 수강권과 마찬가지로 이 시점에 차감하지 않고 'pending'으로만 기록하며,
--     대기→확정 승격 때 차감한다(아래 트리거).
--   - reservations 상태 트리거: 어떤 경로(회원 취소/관리자 취소/자동취소/휴무 처리 등)로 취소돼도
--     'deducted'인 사용 기록은 정확히 1회만 복원('restored')하고 재호출 시 중복 복원하지 않는다.
--   - 예약 취소 시 대여상품은 항상 복원한다(대여는 실제로 쓰지 않은 것이므로 수강권의
--     "마감 후 취소 시 차감" 정책과 분리).
--   - 사이즈 출처: ① 보유 대여상품(memberships.selected_size, 구매 시 선택) ② 프로필 shoe_size
--     ③ 둘 다 없으면 NULL(화면에는 "사이즈 미입력").
--
-- 기존 reserve_class_with_goods(uuid, uuid, uuid)는 시그니처를 유지한 채 새 함수로 위임한다
-- (오버로드를 새로 만들지 않아 기존 호출부가 그대로 동작).
-- 선행: fix_order_issuance_and_auto_booking.sql(memberships.selected_size 컬럼). 여러 번 실행해도 안전.
-- 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================

alter table memberships add column if not exists selected_size text;

create table if not exists reservation_goods_usages (
    id                    uuid primary key default gen_random_uuid(),
    reservation_id        uuid not null references reservations(id) on delete cascade,
    goods_membership_id   uuid not null references memberships(id) on delete cascade,
    center_id             uuid not null references centers(id) on delete cascade,
    profile_id            uuid not null references profiles(id) on delete cascade,
    product_name_snapshot text not null,
    size_snapshot         text,
    size_source           text not null default 'none' check (size_source in ('membership', 'profile', 'none')),
    unlimited             boolean not null default false,
    status                text not null default 'deducted' check (status in ('pending', 'deducted', 'restored', 'skipped')),
    deducted_at           timestamptz,
    restored_at           timestamptz,
    created_at            timestamptz not null default now(),
    unique (reservation_id, goods_membership_id)
);
create index if not exists idx_reservation_goods_usages_reservation on reservation_goods_usages (reservation_id);
create index if not exists idx_reservation_goods_usages_goods on reservation_goods_usages (goods_membership_id);

alter table reservation_goods_usages enable row level security;

drop policy if exists "예약 상품 사용 조회" on reservation_goods_usages;
create policy "예약 상품 사용 조회"
    on reservation_goods_usages for select
    using (
        profile_id in (select my_profile_ids())
        or center_id in (select my_managed_center_ids())
        or is_platform_admin()
    );
-- 쓰기 정책은 일부러 없다: 기록은 아래 SECURITY DEFINER 함수/트리거만 만든다.

revoke all on table reservation_goods_usages from anon;
revoke insert, update, delete on table reservation_goods_usages from authenticated;
grant select on table reservation_goods_usages to authenticated;
grant all on table reservation_goods_usages to service_role;

-- ------------------------------------------------------------
-- reserve_with_goods — 수강권 예약 + 대여상품 차감 + 사용 기록(원자적)
-- ------------------------------------------------------------
create or replace function reserve_with_goods(
    p_class_id uuid,
    p_profile_id uuid default null,
    p_membership_id uuid default null,
    p_goods_membership_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_profile_id  uuid;
    v_class       classes;
    v_goods       memberships;
    v_goods_prod  products;
    v_profile     profiles;
    v_result      json;
    v_res_id      uuid;
    v_res_status  text;
    v_size        text;
    v_size_source text := 'none';
    v_unlimited   boolean := false;
    v_usage_state text;
begin
    if p_profile_id is not null then
        select id into v_profile_id from profiles
         where id = p_profile_id and account_id = my_account_id();
    else
        select id into v_profile_id from profiles
         where account_id = my_account_id() and is_primary = true limit 1;
    end if;
    if v_profile_id is null then
        raise exception '본인 계정의 프로필만 예약할 수 있어요';
    end if;

    -- 상품을 쓰는 경우, 예약을 만들기 전에 먼저 검증하고 잠근다(실패하면 아무 것도 차감되지 않음).
    if p_goods_membership_id is not null then
        select * into v_class from classes where id = p_class_id;
        if not found then raise exception '수업을 찾을 수 없어요'; end if;
        if not coalesce(v_class.allow_goods, false) then
            raise exception '이 수업은 대여상품을 사용할 수 없어요';
        end if;

        select * into v_goods from memberships
         where id = p_goods_membership_id
         for update;
        if not found
           or v_goods.profile_id <> v_profile_id
           or v_goods.center_id <> v_class.center_id
           or v_goods.status <> 'active'
           or (v_goods.expires_at is not null and v_goods.expires_at < current_date)
           or (v_goods.starts_at is not null and v_goods.starts_at > current_date) then
            raise exception '사용할 수 없는 상품이에요';
        end if;
        select * into v_goods_prod from products where id = v_goods.product_id;
        if not found or v_goods_prod.product_kind <> 'goods' then
            raise exception '대여상품만 선택할 수 있어요';
        end if;
        v_unlimited := coalesce(v_goods_prod.unlimited, false);
        if not v_unlimited and coalesce(v_goods.remaining_count, 0) <= 0 then
            raise exception '남은 횟수가 없는 상품이에요';
        end if;

        -- 사이즈 출처: 보유 상품(구매 시 선택) → 프로필 신발 사이즈 → 없음
        if nullif(trim(coalesce(v_goods.selected_size, '')), '') is not null then
            v_size := trim(v_goods.selected_size); v_size_source := 'membership';
        else
            select * into v_profile from profiles where id = v_profile_id;
            if nullif(trim(coalesce(v_profile.shoe_size, '')), '') is not null then
                v_size := trim(v_profile.shoe_size); v_size_source := 'profile';
            end if;
        end if;
    end if;

    -- 기존 예약 함수에 그대로 위임(정원/마감/대기/수강권 검증은 한 글자도 바꾸지 않음)
    if p_membership_id is null then
        v_result := reserve_class(p_class_id, v_profile_id);
    else
        v_result := reserve_with_membership(p_class_id, v_profile_id, p_membership_id);
    end if;

    if p_goods_membership_id is null then
        return v_result;
    end if;

    v_res_id := (v_result->>'reservation_id')::uuid;
    v_res_status := v_result->>'status';

    if v_res_status = 'confirmed' then
        if not v_unlimited then
            update memberships set remaining_count = remaining_count - 1
             where id = p_goods_membership_id and remaining_count is not null;
        end if;
        v_usage_state := 'deducted';
    else
        v_usage_state := 'pending';   -- 대기예약: 승격 시점에 차감
    end if;

    insert into reservation_goods_usages (
        reservation_id, goods_membership_id, center_id, profile_id,
        product_name_snapshot, size_snapshot, size_source, unlimited,
        status, deducted_at
    ) values (
        v_res_id, p_goods_membership_id, v_goods.center_id, v_profile_id,
        v_goods.product_name, v_size, v_size_source, v_unlimited,
        v_usage_state, case when v_usage_state = 'deducted' then now() else null end
    );

    return (v_result::jsonb || jsonb_build_object('goods_status', v_usage_state))::json;
end;
$$;
revoke all on function reserve_with_goods(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function reserve_with_goods(uuid, uuid, uuid, uuid) to authenticated, service_role;

-- 기존 3-인자 함수는 시그니처 유지, 새 함수로 위임
create or replace function reserve_class_with_goods(
    p_class_id uuid, p_profile_id uuid default null, p_goods_membership_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
    return reserve_with_goods(p_class_id, p_profile_id, null, p_goods_membership_id);
end;
$$;

-- ------------------------------------------------------------
-- 상태 트리거 — 취소 시 복원(중복 방지), 대기 승격 시 차감
-- ------------------------------------------------------------
create or replace function trg_reservation_goods_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_u record;
begin
    if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
        for v_u in
            with upd as (
                update reservation_goods_usages
                   set status = case when status = 'deducted' then 'restored' else 'skipped' end,
                       restored_at = case when status = 'deducted' then now() else restored_at end
                 where reservation_id = new.id and status in ('deducted', 'pending')
             returning goods_membership_id, unlimited, status
            )
            select goods_membership_id, unlimited, status from upd
        loop
            if v_u.status = 'restored' and not v_u.unlimited then
                update memberships set remaining_count = remaining_count + 1
                 where id = v_u.goods_membership_id
                   and remaining_count is not null
                   and status not in ('refunded', 'transferred');
            end if;
        end loop;
    elsif old.status = 'waitlisted' and new.status = 'confirmed' then
        for v_u in
            select u.id, u.goods_membership_id, u.unlimited
              from reservation_goods_usages u
             where u.reservation_id = new.id and u.status = 'pending'
        loop
            if v_u.unlimited then
                update reservation_goods_usages set status = 'deducted', deducted_at = now() where id = v_u.id;
            else
                update memberships set remaining_count = remaining_count - 1
                 where id = v_u.goods_membership_id
                   and status = 'active'
                   and remaining_count > 0;
                if found then
                    update reservation_goods_usages set status = 'deducted', deducted_at = now() where id = v_u.id;
                else
                    update reservation_goods_usages set status = 'skipped' where id = v_u.id;  -- 잔여 없음: 차감 안 함
                end if;
            end if;
        end loop;
    end if;
    return new;
end;
$$;

drop trigger if exists reservation_goods_sync on reservations;
create trigger reservation_goods_sync
    after update of status on reservations
    for each row execute function trg_reservation_goods_sync();

-- 예약 행이 통째로 삭제되는 경로(수업 삭제 등)에서도 차감된 대여 횟수는 돌려준다.
create or replace function trg_reservation_goods_restore_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_u record;
begin
    for v_u in
        select id, goods_membership_id, unlimited
          from reservation_goods_usages
         where reservation_id = old.id and status = 'deducted'
    loop
        if not v_u.unlimited then
            update memberships set remaining_count = remaining_count + 1
             where id = v_u.goods_membership_id
               and remaining_count is not null
               and status not in ('refunded', 'transferred');
        end if;
    end loop;
    return old;
end;
$$;

drop trigger if exists reservation_goods_restore_on_delete on reservations;
create trigger reservation_goods_restore_on_delete
    before delete on reservations
    for each row execute function trg_reservation_goods_restore_on_delete();

revoke all on function trg_reservation_goods_sync() from public, anon, authenticated;
revoke all on function trg_reservation_goods_restore_on_delete() from public, anon, authenticated;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select
    to_regclass('public.reservation_goods_usages') is not null as table_ok,
    has_function_privilege('anon', 'reserve_with_goods(uuid,uuid,uuid,uuid)', 'execute') as anon_blocked_must_be_false,
    (select count(*) from pg_trigger where tgname in ('reservation_goods_sync', 'reservation_goods_restore_on_delete')) as triggers_must_be_2;
