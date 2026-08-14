-- ============================================================
-- fix_manager_set_attendance_membership_integrity_draft_proposed.sql 롤백
--
-- SEC-115 수정 이전(fix_attendance_consolidate_and_guard_draft_proposed.sql 기준)
-- 상태로 manager_set_attendance()와 그 EXECUTE 권한을 되돌린다.
-- ⚠ 이 롤백은 대기(waitlisted) 예약 취소 시 remaining_count가 잘못 +1되는
-- 버그와 waitlisted→confirmed 직접 전환(무차감 확정) 문제를 그대로 복원한다.
--
-- 여러 번 실행해도 안전.
-- ============================================================

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

    if v_res.status = 'waitlisted' and p_status in ('attended', 'no_show') then
        raise exception '대기 중인 예약은 출석/결석으로 표시할 수 없어요 — 먼저 확정돼야 해요';
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

grant execute on function manager_set_attendance(uuid, text) to public;

COMMIT;

-- ============================================================
-- 완료. fix_attendance_consolidate_and_guard_draft_proposed.sql 정의 +
-- PUBLIC EXECUTE로 정확히 복원됨.
-- ============================================================
