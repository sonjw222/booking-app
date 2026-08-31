-- ============================================================
-- fix_cancel_reservation_refunded_membership_ghost_count.sql 롤백
-- remaining_count UPDATE의 status 조건만 제거해 이전 동작(무조건 +1)으로 되돌린다.
-- fix_class_cancel_deadline_override.sql이 적용한 부분(마감시간 우선순위 로직)은
-- 그대로 유지한다 — 이 롤백은 오늘 이 파일이 새로 추가한 조건 한 줄만 되돌린다.
-- ============================================================

BEGIN;

create or replace function cancel_reservation(p_reservation_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_res         record;
    v_class       record;
    v_next        record;
    v_next_mem    record;
    v_promoted    boolean := false;
    v_skip_refund boolean := false;
begin
    select * into v_res from reservations
    where id = p_reservation_id
      and profile_id in (select id from profiles where account_id = my_account_id())
    for update;

    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;
    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이에요';
    end if;

    select * into v_class from classes where id = v_res.class_id;
    if found then
        if now() >= v_class.start_time then
            raise exception '수업이 이미 시작되어 취소할 수 없어요';
        end if;

        declare
            v_cancel_deadline    timestamptz;
            v_deduct_late        boolean := false;
            v_is_late            boolean := false;
            v_grace_deadline     timestamptz;
            v_effective_deadline timestamptz;
        begin
            if v_class.cancel_deadline_min is not null then
                v_cancel_deadline := v_class.start_time - make_interval(mins => v_class.cancel_deadline_min);
            else
                v_cancel_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'cancel');
                if v_cancel_deadline is null then
                    v_cancel_deadline := v_class.start_time;
                end if;
            end if;

            v_grace_deadline := least(v_res.created_at + interval '10 minutes', v_class.start_time);
            v_effective_deadline := greatest(v_cancel_deadline, v_grace_deadline);

            v_is_late := now() > v_effective_deadline;

            select coalesce(deduct_on_late_cancel, false) into v_deduct_late
            from center_settings where center_id = v_class.center_id;

            if v_is_late and not v_deduct_late then
                raise exception '취소 마감시간이 지났어요';
            end if;
            v_skip_refund := v_is_late and v_deduct_late;
        end;
    end if;

    update reservations set status = 'cancelled', cancel_source = 'MEMBER' where id = p_reservation_id;

    if v_res.status = 'confirmed' then
        if not v_skip_refund then
            update memberships set remaining_count = remaining_count + 1
            where id = v_res.membership_id;
        end if;

        for v_next in
            select * from reservations
            where class_id = v_res.class_id and status = 'waitlisted'
            order by waitlist_order asc
            for update
        loop
            select * into v_next_mem from memberships
            where id = v_next.membership_id
              and remaining_count > 0
              and expires_at >= current_date
            for update;

            if found then
                update reservations
                set status = 'confirmed', waitlist_order = null
                where id = v_next.id;

                update memberships set remaining_count = remaining_count - 1
                where id = v_next_mem.id;

                v_promoted := true;
                exit;
            end if;
        end loop;
    end if;

    return json_build_object('cancelled', true, 'waitlist_promoted', v_promoted);
end;
$$;

COMMIT;
