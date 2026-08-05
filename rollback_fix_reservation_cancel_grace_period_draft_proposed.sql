-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless fix_reservation_cancel_grace_period_draft_proposed.sql was applied ⚠️
-- RES-001 (Track C-5) 롤백 — cancel_reservation()을 10분 예외/시작-후-취소금지 로직 추가
-- 이전 상태로 되돌린다. 대기자 승격 로직 등 나머지는 동일.
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
    v_skip_refund boolean := false;   -- 마감 후 취소 + 차감옵션 시 환급 건너뜀
begin
    -- 내 계정 소유 프로필의 예약인지 확인 + 잠금
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

    -- 취소 마감시간 확인
    --   센터 설정(N일 전 HH:MM)이 있으면 그걸 쓰고, 없으면 classes 고정값 폴백.
    --   설정 14번(deduct_on_late_cancel)이 켜져 있으면, 마감 후 취소라도
    --   차단하지 않고 "횟수 차감"으로 진행한다.
    select * into v_class from classes where id = v_res.class_id;
    if found then
        declare
            v_cancel_deadline timestamptz;
            v_deduct_late boolean := false;
            v_is_late boolean := false;
        begin
            v_cancel_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'cancel');
            if v_cancel_deadline is null then
                v_cancel_deadline := v_class.start_time - make_interval(mins => v_class.cancel_deadline_min);
            end if;
            v_is_late := now() > v_cancel_deadline;

            select coalesce(deduct_on_late_cancel, false) into v_deduct_late
            from center_settings where center_id = v_class.center_id;

            if v_is_late and not v_deduct_late then
                -- 마감 지났고, 차감 옵션도 꺼져 있으면 취소 불가
                raise exception '취소 마감시간이 지났어요';
            end if;
            -- 마감 지났지만 차감 옵션이 켜져 있으면: 취소는 허용하되 환급 안 함
            v_skip_refund := v_is_late and v_deduct_late;
        end;
    end if;

    -- 취소 처리
    update reservations set status = 'cancelled' where id = p_reservation_id;

    if v_res.status = 'confirmed' then
        -- 수강권 환급 (단, 마감 후 취소 + 차감옵션이면 환급하지 않음 = 횟수 차감)
        if not v_skip_refund then
            update memberships set remaining_count = remaining_count + 1
            where id = v_res.membership_id;
        end if;

        -- 대기자를 순번대로 확인하면서 '확정 가능한 첫 사람'을 승격시킨다.
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
