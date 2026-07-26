-- ============================================================
-- 휴무일 연동 (수업 자동 삭제 + 예약자 처리)
--
-- 하는 일:
--   add_holiday_safe 함수 추가
--   → 휴무일 지정 시 그날 수업을 자동 삭제 (반복수업은 그 날짜만)
--   → 예약자가 있으면 확인 요청, 확인하면 예약 취소 후 삭제
--   → 회원 예약 화면에서는 휴무일 수업이 아예 안 보임 (코드에서 처리)
--   → 매니저는 휴무일에 수업 개설 불가 (코드에서 처리)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================


-- ============================================================
-- 휴무일 지정 (수업 자동 삭제 + 예약자 처리)
--   p_force = false: 그날 수업에 살아있는 예약이 있으면 삭제 안 하고
--                    needs_confirm=true 반환 (매니저 확인 필요)
--   p_force = true : 예약 취소 + 수업 삭제 후 휴무일 등록
--   반복수업이어도 "그 날짜"의 수업만 삭제됨 (날짜별로 행이 분리돼 있음)
-- ============================================================

create or replace function add_holiday_safe(
    p_center_id uuid,
    p_date date,
    p_reason text default null,
    p_force boolean default false
)
returns json
language plpgsql
security definer
as $$
declare
    v_class_ids  uuid[];
    v_active_cnt int;
begin
    -- 권한 확인 (센터 관리자/오너)
    if not has_permission(p_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '휴무일을 지정할 권한이 없어요';
    end if;

    -- 그날 그 센터의 수업 id 모음 (KST 기준 날짜)
    select array_agg(id) into v_class_ids
    from classes
    where center_id = p_center_id
      and (start_time at time zone 'Asia/Seoul')::date = p_date;

    -- 살아있는 예약 수 (확정/대기/출석)
    v_active_cnt := 0;
    if v_class_ids is not null then
        select count(*) into v_active_cnt
        from reservations
        where class_id = any(v_class_ids)
          and status in ('confirmed','waitlisted','attended');
    end if;

    -- 예약이 있는데 강제 아님 → 확인 요청
    if v_active_cnt > 0 and not p_force then
        return json_build_object(
            'needs_confirm', true,
            'class_count', coalesce(array_length(v_class_ids, 1), 0),
            'reservation_count', v_active_cnt
        );
    end if;

    -- 수업 삭제 (예약 기록 먼저 정리)
    if v_class_ids is not null then
        delete from reservations where class_id = any(v_class_ids);
        delete from classes where id = any(v_class_ids);
    end if;

    -- 휴무일 등록 (이미 있으면 무시)
    insert into center_holidays (center_id, holiday_date, reason)
    values (p_center_id, p_date, p_reason)
    on conflict do nothing;

    return json_build_object(
        'needs_confirm', false,
        'deleted_classes', coalesce(array_length(v_class_ids, 1), 0),
        'cancelled_reservations', v_active_cnt
    );
end;
$$;



-- ============================================================
-- 완료!
--   휴무일 관리 → 날짜 선택 → 추가
--   그날 예약자가 있으면 "예약 취소하고 지정" 확인창이 떠요
-- ============================================================
