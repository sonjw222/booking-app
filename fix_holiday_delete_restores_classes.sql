-- ============================================================
-- P0-1: 휴무일 삭제 후에도 "폐강된 수업입니다"가 계속 남는 버그 수정
--
-- 근본 원인(코드로 확인): add_holiday_safe()(fix_holiday_history_and_notification_draft_proposed.sql)는
-- 휴무일을 추가할 때 그날 그 센터의 모든 수업을 classes.status='cancelled'로 UPDATE한다
-- (이력 보존을 위해 삭제 대신 상태만 바꾸는 방식으로 이번 세션에 재설계됨). 그런데
-- lib/holidays.ts의 deleteHoliday()는 center_holidays 행만 직접 DELETE할 뿐, 그때 함께
-- cancelled로 바뀐 classes.status를 되돌리는 코드가 어디에도 없다 — 캐시나 RPC 문제가
-- 아니라, "휴무일을 지울 때 되돌리는 로직 자체가 애초에 없었다"는 것이 정확한 원인이다.
--
-- 확인: 현재 코드베이스 전체에서 classes.status를 'cancelled'로 SET하는 곳은
-- add_holiday_safe() 하나뿐이다(delete_class_safe()는 행 자체를 DELETE하지 별도
-- status='cancelled' 처리를 하지 않음, grep으로 확인됨). 따라서 이 시점 기준으로는
-- "그날 그 센터의 cancelled 수업 = 전부 이 휴무일 때문에 cancelled됨"이 안전하게 성립한다.
--
-- 수정 범위: 휴무일 삭제 시 수업 상태(bookability)만 되돌린다. 이미 취소 처리되어 회원에게
-- 알림이 간 예약(reservations.status='cancelled', cancel_source='HOLIDAY')은 자동으로
-- 되살리지 않는다 — 회원이 이미 취소 알림을 받았고 수강권도 환급됐으므로, 그 예약을
-- 조용히 부활시키면 오히려 혼란을 준다. 다시 예약이 필요하면 환급된 수강권으로 새로
-- 예약하면 된다(요청 범위: "예약 가능 여부가 다시 정상 계산되어야 한다"에 한정).
-- ============================================================

create or replace function remove_holiday_safe(p_holiday_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_center_id uuid;
    v_date      date;
    v_restored  int;
begin
    select center_id, holiday_date into v_center_id, v_date
    from center_holidays where id = p_holiday_id;
    if not found then
        raise exception '휴무일을 찾을 수 없어요';
    end if;

    if not has_permission(v_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '휴무일을 삭제할 권한이 없어요';
    end if;

    delete from center_holidays where id = p_holiday_id;

    -- 이 휴무일 때문에 폐강 처리됐던 수업을 다시 예약 가능(open) 상태로 되돌린다.
    update classes
    set status = 'open'
    where center_id = v_center_id
      and (start_time at time zone 'Asia/Seoul')::date = v_date
      and status = 'cancelled';
    get diagnostics v_restored = row_count;

    return json_build_object('restored_classes', v_restored);
end;
$$;
