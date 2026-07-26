-- ============================================================
-- 매니저 출결 처리 RPC
--
-- 하는 일:
--   manager_set_attendance(예약id, 상태) 함수 추가
--   상태: attended(출석) / no_show(노쇼) / confirmed(예약) / cancelled(취소)
--   예약취소 시 차감됐던 수강권 횟수 자동 복구
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================


-- ============================================================
-- 매니저 출결 처리 (출석/결석/노쇼/예약취소)
--   p_status: 'attended' | 'no_show' | 'confirmed' | 'cancelled'
--   - cancelled 로 바꾸면: 차감됐던 수강권 횟수 1 복구 (해당 membership)
--   - 다른 상태에서 cancelled 로 갈 때만 복구 (이미 취소된 건 재복구 안 함)
--   - 매니저(그 센터 관리 권한)만 실행
-- ============================================================

create or replace function manager_set_attendance(p_reservation_id uuid, p_status text)
returns json
language plpgsql
security definer
as $$
declare
    v_res     record;
    v_class   record;
    v_restored boolean := false;
begin
    if p_status not in ('attended', 'no_show', 'confirmed', 'cancelled') then
        raise exception '잘못된 상태예요';
    end if;

    select * into v_res from reservations where id = p_reservation_id for update;
    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;

    -- 권한: 그 수업이 속한 센터의 매니저인지
    select * into v_class from classes where id = v_res.class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;
    if not (v_class.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 예약을 처리할 권한이 없어요';
    end if;

    -- 예약취소로 변경 시, 아직 취소 상태가 아니었다면 횟수 복구
    if p_status = 'cancelled' and v_res.status <> 'cancelled' then
        if v_res.membership_id is not null then
            update memberships
               set remaining_count = remaining_count + 1
             where id = v_res.membership_id
               and remaining_count is not null;
            v_restored := true;
        end if;
    end if;

    -- 취소됐던 걸 다시 확정으로 되돌리면 재차감 (선택)
    if v_res.status = 'cancelled' and p_status = 'confirmed' then
        if v_res.membership_id is not null then
            update memberships
               set remaining_count = remaining_count - 1
             where id = v_res.membership_id
               and remaining_count is not null
               and remaining_count > 0;
        end if;
    end if;

    update reservations set status = p_status where id = p_reservation_id;

    return json_build_object('status', p_status, 'restored', v_restored);
end;
$$;



-- ============================================================
-- 완료!
--   오늘 수업/수업관리 → 예약자 명단 → 출석/결석/노쇼/취소
-- ============================================================
