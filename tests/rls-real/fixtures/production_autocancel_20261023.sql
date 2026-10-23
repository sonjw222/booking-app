-- Local isolated test fixture; production definitions before dedupe patch, read 2026-10-23.
CREATE OR REPLACE FUNCTION public.run_autocancel_sweep()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_class    record;
    v_res      record;
    v_restored boolean;
    v_cancelled_classes int := 0;
    v_cancelled_reservations int := 0;
    v_center_name text;
begin
    for v_class in
        select c.*
        from classes c
        join center_settings cs on cs.center_id = c.center_id
        where c.status = 'open'
          and cs.autocancel_enabled = true
          and now() < c.start_time
          and now() >= c.start_time - make_interval(hours => cs.autocancel_hours, mins => cs.autocancel_minutes)
          and c.min_capacity > (
              select count(*) from reservations r
              where r.class_id = c.id and r.status in ('confirmed', 'attended')
          )
        for update of c
    loop
        update classes set status = 'cancelled' where id = v_class.id;
        v_cancelled_classes := v_cancelled_classes + 1;

        select name into v_center_name from centers where id = v_class.center_id;

        for v_res in
            select * from reservations
            where class_id = v_class.id and status in ('confirmed', 'waitlisted', 'attended')
            for update
        loop
            v_restored := false;
            if v_res.status = 'confirmed' then
                update memberships set remaining_count = remaining_count + 1
                where id = v_res.membership_id
                  and status not in ('refunded', 'transferred')
                  and remaining_count is not null;
                v_restored := true;
            end if;

            update reservations
            set status = 'cancelled', cancel_source = 'ADMIN', cancelled_at = now()
            where id = v_res.id;

            v_cancelled_reservations := v_cancelled_reservations + 1;

            perform push_notification(
                (select account_id from profiles where id = v_res.profile_id),
                'admin_cancelled',
                coalesce(v_center_name, '센터') || ' 수업이 폐강됐어요',
                v_class.title || ' (최소 인원 미달)' ||
                    case when v_restored then ' — 수강권 횟수가 복구됐어요' else '' end,
                v_class.center_id, '/my-reservations',
                jsonb_build_object('class_id', v_class.id)
            );
        end loop;
    end loop;

    return json_build_object(
        'classes_cancelled', v_cancelled_classes,
        'reservations_cancelled', v_cancelled_reservations
    );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.trg_notify_reservation_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_center      uuid;
    v_center_name text;
    v_title       text;
    v_start       timestamptz;
    v_account     uuid;
    v_who         text;
    v_restored    boolean;
    m record;
begin
    if new.status = old.status then
        return new;  -- 상태 안 바뀌면 무시
    end if;

    select c.center_id, c.title, c.start_time, ct.name
      into v_center, v_title, v_start, v_center_name
      from classes c
      left join centers ct on ct.id = c.center_id
      where c.id = new.class_id;
    select pr.account_id, coalesce(pr.nickname, pr.name, '회원')
      into v_account, v_who
      from profiles pr where pr.id = new.profile_id;

    -- 대기 → 확정
    if old.status = 'waitlisted' and new.status = 'confirmed' then
        if v_account is not null then
            perform push_notification(
                v_account, 'waitlist_promoted', '대기하던 수업이 확정됐어요',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        end if;

    -- 취소
    elsif new.status = 'cancelled' then
        if v_account is not null then
            if new.cancel_source = 'HOLIDAY' then
                -- [NOTIF-001 E-4] 휴무일 자동취소 전용 문구: 센터명·수업명·시간·취소사유·
                -- 수강권 복구 여부. 복구 여부는 add_holiday_safe와 동일한 조건으로 판정한다
                -- (old.status가 확정/출석이고 membership_consumed && membership_id가 있으면
                -- 그 함수가 복구했다는 뜻).
                v_restored := old.status in ('confirmed', 'attended')
                    and new.membership_consumed
                    and new.membership_id is not null;
                perform push_notification(
                    v_account, 'reservation_canceled', '센터 휴무일로 예약이 취소됐어요',
                    coalesce(v_center_name, '센터') || ' · ' || v_title || ' · ' ||
                        to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI') ||
                        coalesce(' · ' || new.cancel_reason, '') ||
                        case when v_restored then ' · 사용한 수강권 횟수는 복구됐어요' else '' end,
                    v_center, '/my-reservations',
                    jsonb_build_object('reservation_id', new.id, 'cancel_source', 'HOLIDAY')
                );
            else
                perform push_notification(
                    v_account, 'reservation_canceled', '예약이 취소됐어요',
                    v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                    v_center, '/my-reservations',
                    jsonb_build_object('reservation_id', new.id)
                );
            end if;
        end if;
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'reservation_canceled', '예약이 취소됐어요',
                v_who || '님 · ' || v_title || ' ' ||
                    to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;

    -- 노쇼
    elsif new.status = 'no_show' then
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'no_show', '노쇼가 발생했어요',
                v_who || '님이 ' || v_title || ' 수업에 오지 않았어요',
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;
    end if;

    return new;
end;
$function$
;
