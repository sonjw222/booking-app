-- ============================================================
-- cancel_reservation() 당일예약 취소마감 회귀 버그 수정
--
-- 배경: fix_same_day_cancel_and_waitlist_auto_deadline.sql에서 "당일 예약이면
-- 시작시각 - same_day_change_hours/minutes도 마감 후보로 추가"하는 로직을 넣었는데,
-- same_day_change_hours/minutes 기본값이 0/0이라 이 후보가 항상 "수업 시작 시각 그
-- 자체"가 된다. greatest()로 제일 늦은 후보를 채택하는 구조상, 당일 만들어진 예약은
-- 센터가 설정한 정상 취소마감(groupCancelDaysBefore=0 + 특정 시각 같은, 전혀 안 망가진
-- 정상 설정)까지도 전부 무시하고 수업 시작 직전까지 항상 취소 성공해버리는 회귀가
-- 발생했다 — tests/e2e/settings/cancel-deadline.spec.ts(취소기한 2시간 정책, CI에서
-- 실제로 잡음, 2026-09-09)가 이 회귀를 정확히 검출.
--
-- 원래 고치려던 문제는 "며칠 전 기준(groupCancelDaysBefore>=1)으로 계산하면 당일예약
-- 건은 마감 날짜가 항상 어제 이전으로 계산돼 취소가 원천 불가능"했던 경우인데, 조건을
-- "예약이 당일에 만들어졌는가"로만 걸어서 groupCancelDaysBefore=0(오늘 특정 시각 마감,
-- 정상적으로 유효한 설정)인 경우까지 덮어써버린 게 원인이다.
--
-- 수정: 당일예약 안전장치는 "정상 계산된 마감의 날짜(KST)가 오늘보다 이전인 경우"
-- (= 진짜 "어제 이전으로 계산되는" 문제 상황)에만 적용하도록 조건을 좁힌다. 이러면:
--   - groupCancelDaysBefore=0 등으로 마감이 "오늘" 날짜로 정상 계산되는 경우 → 안전장치
--     미적용, 기존(회귀 전) 동작 그대로 (오늘 특정 시각 마감이 이미 지났으면 정상적으로
--     취소 실패)
--   - groupCancelDaysBefore>=1 기본값 등으로 마감 날짜가 어제 이전으로 계산되는 경우 →
--     안전장치 적용, "시작 - same_day_change_hours/minutes"까지는 취소 가능(원래 의도한
--     동작)
--
-- 변경 범위: cancel_reservation() 함수 본문만 CREATE OR REPLACE. 다른 로직(환급,
-- deduct_on_late_cancel, 대기 자동승격 마감 등)은 전혀 안 바꾼다.
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

            -- [1] 당일예약 안전장치 — "정상 계산된 마감의 날짜(KST)가 오늘보다 이전"일
            -- 때만(= days_before 계산이 진짜로 "어제 이전"을 만든 문제 상황일 때만)
            -- "시작 - N시간M분"을 마감 후보로 추가한다. 오늘 날짜로 정상 계산된 마감
            -- (예: groupCancelDaysBefore=0 + 특정 시각)은 이미 지났어도 손대지 않는다
            -- — 그건 회귀가 아니라 센터가 의도한 정상 마감이다.
            if v_settings.center_id is not null
               and (v_cancel_deadline at time zone 'Asia/Seoul')::date < (now() at time zone 'Asia/Seoul')::date
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
select proname, pg_get_functiondef(oid) like '%::date < (now() at time zone ''Asia/Seoul'')::date%' as has_regression_fix
from pg_proc where proname = 'cancel_reservation';
