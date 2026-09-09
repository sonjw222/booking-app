-- ============================================================
-- 예약 취소(cancel_reservation) — 당일 예약 변경 유예시간 + 대기 자동승격 마감 연결
--
-- 배경: /manager/settings의 "당일 예약 변경 가능 시간"과 "예약대기 자동 예약 시간"은
-- center_settings 컬럼(same_day_change_hours/minutes, waitlist_auto_hours/minutes)까지는
-- 저장되고 있었지만, 실제 취소/승격 로직 어디서도 안 읽혀 "준비 중" 배지가 붙어있었다.
-- 다시 확인해보니 애초에 이 두 건은 정기 스케줄러가 필요한 게 아니라(예전 코드 주석의
-- 판단이 틀렸음), cancel_reservation() 안에서 이미 하고 있는 마감 계산에 조건 하나씩만
-- 추가하면 되는 문제였다.
--
-- [1] 당일 예약 변경 가능 시간
--   calc_deadline(..., 'cancel')은 "수업일 - group_cancel_days_before일, group_cancel_time시"로
--   마감을 계산한다. 오늘 열리는 수업을 당일에 예약했다면(days_before=1 기본값 기준) 이
--   마감은 항상 "어제"로 계산돼 이미 지나있다 — 당일 예약 건은 사실상 취소가 불가능했다는
--   뜻이다. 예약이 그 수업과 같은 날(KST) 만들어졌을 때만, "수업 시작 - same_day_change_hours
--   시간 - same_day_change_minutes분"이라는 별도 마감을 추가로 계산해 기존 v_effective_deadline
--   (greatest)에 포함시킨다. 이미 있던 v_grace_deadline(예약 후 10분 유예)과 같은 자리에
--   나란히 들어가는 "추가로 유리한 마감 후보"일 뿐이라, 당일 예약이 아닌 경우나 이 후보가
--   더 불리한 경우는 결과가 전혀 안 바뀐다 — 오직 넓혀주는 방향으로만 작동한다.
--
-- [2] 예약대기 자동 예약 시간
--   지금은 대기자 승격이 취소 발생 즉시, 시간 조건 없이 항상 일어난다. waitlist_auto_hours/
--   minutes가 둘 다 0(기본값, "0이면 취소시간 적용")이면 이 동작을 그대로 유지한다. 둘 중
--   하나라도 0이 아니면, "지금이 수업 시작 - N시간 - M분보다 이전"일 때만 승격을 시도하고,
--   그 시각을 넘었으면 이번 취소로는 아무도 승격시키지 않는다(대기자는 대기 상태 그대로 —
--   조건이 수업 단위라 한 명이 막히면 다른 대기자도 마찬가지라 반복 시도할 필요 없음).
--
-- 변경 범위: cancel_reservation() 함수 본문만 CREATE OR REPLACE(라이브 정의 기준, drift 없음
-- pg_get_functiondef로 직접 확인). 나머지 로직(취소 마감 판정, 환급, deduct_on_late_cancel 등)은
-- 전혀 안 바꾼다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

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
    v_can_promote boolean := true;
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
            v_same_day_deadline  timestamptz;
            v_effective_deadline timestamptz;
            v_settings           record;
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

            select * into v_settings from center_settings where center_id = v_class.center_id;

            -- [1] 당일 예약(같은 KST 날짜에 만들어진 예약)이면 "시작 - N시간M분"도
            -- 마감 후보로 추가 — 더 유리한(늦은) 쪽이 최종 채택된다.
            if v_settings.center_id is not null
               and (v_res.created_at at time zone 'Asia/Seoul')::date = (v_class.start_time at time zone 'Asia/Seoul')::date
            then
                v_same_day_deadline := v_class.start_time
                    - make_interval(hours => coalesce(v_settings.same_day_change_hours, 0),
                                     mins  => coalesce(v_settings.same_day_change_minutes, 0));
                v_effective_deadline := greatest(v_cancel_deadline, v_grace_deadline, v_same_day_deadline);
            else
                v_effective_deadline := greatest(v_cancel_deadline, v_grace_deadline);
            end if;

            v_is_late := now() > v_effective_deadline;

            v_deduct_late := coalesce(v_settings.deduct_on_late_cancel, false);

            if v_is_late and not v_deduct_late then
                raise exception '취소 마감시간이 지났어요';
            end if;
            v_skip_refund := v_is_late and v_deduct_late;

            -- [2] 대기 자동승격 마감 — 0/0(기본값)이면 조건 없이 항상 승격(기존 동작 유지).
            if coalesce(v_settings.waitlist_auto_hours, 0) = 0 and coalesce(v_settings.waitlist_auto_minutes, 0) = 0 then
                v_can_promote := true;
            else
                v_can_promote := now() < v_class.start_time
                    - make_interval(hours => v_settings.waitlist_auto_hours, mins => v_settings.waitlist_auto_minutes);
            end if;
        end;
    end if;

    update reservations set status = 'cancelled', cancel_source = 'MEMBER' where id = p_reservation_id;

    if v_res.status = 'confirmed' then
        -- [유령 잔여횟수 방지] 환불/양도된 수강권은 되돌려받을 대상이 아니므로 건너뜀
        if not v_skip_refund then
            update memberships set remaining_count = remaining_count + 1
            where id = v_res.membership_id
              and status not in ('refunded', 'transferred');
        end if;

        if v_can_promote then
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
    end if;

    return json_build_object('cancelled', true, 'waitlist_promoted', v_promoted, 'deducted', v_skip_refund);
end;
$$;

-- ============================================================
-- 확인
-- ============================================================
select proname, pg_get_functiondef(oid) like '%same_day_change_hours%' as has_same_day_fix,
       pg_get_functiondef(oid) like '%v_can_promote%' as has_waitlist_deadline_fix
from pg_proc where proname = 'cancel_reservation';
