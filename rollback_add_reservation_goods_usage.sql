-- ============================================================
-- add_reservation_goods_usage.sql 롤백 — 트리거/새 함수 제거, reserve_class_with_goods를 적용 전
-- (라이브, 2026-10-01 조회) 정의로 복원. 사용 기록 테이블은 데이터 보존을 위해 기본 유지(주석 참고).
-- 주의: 롤백 후에는 예약 취소 시 대여상품 횟수가 복원되지 않고(옛 동작), 이미 'deducted'로 기록된
--   건의 복원 책임은 운영자가 직접 져야 한다. 필요하면 먼저 아래 점검 쿼리로 대상을 확인하세요.
--   select * from reservation_goods_usages where status = 'deducted';
-- ============================================================
drop trigger if exists reservation_goods_sync on reservations;
drop trigger if exists reservation_goods_restore_on_delete on reservations;
drop function if exists trg_reservation_goods_sync();
drop function if exists trg_reservation_goods_restore_on_delete();

CREATE OR REPLACE FUNCTION public.reserve_class_with_goods(p_class_id uuid, p_profile_id uuid DEFAULT NULL::uuid, p_goods_membership_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
    v_result json;
    v_profile_id uuid;
    v_allow_goods boolean;
    v_goods record;
begin
    -- 1) 기존 예약 로직 그대로 수행 (수강권 차감 + 예약 생성)
    v_result := reserve_class(p_class_id, p_profile_id);

    -- 2) 상품을 함께 선택했으면 차감 처리
    if p_goods_membership_id is not null then
        -- 예약에 쓰인 프로필 확인
        if p_profile_id is not null then
            select id into v_profile_id from profiles
            where id = p_profile_id and account_id = my_account_id();
        else
            select id into v_profile_id from profiles
            where account_id = my_account_id() and is_primary = true limit 1;
        end if;

        -- 수업이 상품 사용을 허용하는지
        select allow_goods into v_allow_goods from classes where id = p_class_id;

        if v_allow_goods then
            -- 본인 상품이고 잔여 있는지 확인 후 차감
            select * into v_goods from memberships
            where id = p_goods_membership_id
              and profile_id = v_profile_id
            for update;

            if found then
                -- 무제한(null)이 아니고 잔여가 있으면 1 차감
                if v_goods.remaining_count is not null and v_goods.remaining_count > 0 then
                    update memberships set remaining_count = remaining_count - 1
                    where id = p_goods_membership_id;
                end if;
            end if;
        end if;
    end if;

    return v_result;
end;
$function$;

drop function if exists reserve_with_goods(uuid, uuid, uuid, uuid);

-- 데이터 보존을 위해 기본은 주석 처리 — 정말 지울 때만:
-- drop table if exists reservation_goods_usages;
-- alter table memberships drop column if exists selected_size;
