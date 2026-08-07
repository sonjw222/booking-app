-- fix_attendance_consolidate_and_guard_draft_proposed.sql 롤백
-- add_admin_assignment.sql의 v4(대기 가드 추가 이전) 본문으로 되돌린다.
-- 주의: 이 롤백은 "대기 중인 예약도 출석/결석으로 표시 가능"했던 이전 버그를 다시 되살린다
-- — 정말 되돌려야 하는 경우가 아니면 적용하지 마세요.

BEGIN;

create or replace function manager_set_attendance(p_reservation_id uuid, p_status text)
returns json
language plpgsql
security definer
as $$
declare
    v_res      record;
    v_class    record;
    v_restored boolean := false;
    v_admin_id uuid;
begin
    if p_status not in ('attended', 'no_show', 'confirmed', 'cancelled') then
        raise exception '잘못된 상태예요';
    end if;

    select * into v_res from reservations where id = p_reservation_id for update;
    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;

    select * into v_class from classes where id = v_res.class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;
    if not (v_class.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 예약을 처리할 권한이 없어요';
    end if;

    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이라 출결 상태를 바꿀 수 없어요';
    end if;

    v_admin_id := my_account_id();

    if p_status = 'cancelled' then
        if v_res.membership_id is not null then
            update memberships
               set remaining_count = remaining_count + 1
             where id = v_res.membership_id
               and remaining_count is not null;
            v_restored := true;
        end if;

        update reservations
           set status = p_status,
               cancelled_by = v_admin_id,
               cancelled_at = now(),
               updated_at = now()
         where id = p_reservation_id;
    else
        update reservations
           set status = p_status, updated_at = now()
         where id = p_reservation_id;
    end if;

    return json_build_object('status', p_status, 'restored', v_restored);
end;
$$;

COMMIT;
