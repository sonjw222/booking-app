-- ============================================================
-- 수업 삭제 안전 함수 (취소 예약 + 오너 권한 문제 최종 해결)
--
-- 문제:
--   1) 취소된 예약이 FK로 삭제를 막음
--   2) 오너인데도 my_managed_center_ids()에 안 잡혀 "권한 없음"
-- 해결:
--   서버 함수(security definer)로 삭제 처리 + 권한 체크를
--   has_permission(오너 자동 통과)으로 변경
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================


-- ============================================================
-- 수업 삭제 (매니저용, security definer)
--   - 권한: 그 수업 센터를 관리하는 매니저만
--   - 취소/노쇼 예약 기록을 먼저 지우고 수업 삭제
--   - 확정/대기/출석 예약이 있으면 막음 (안내)
--   - 삭제 후, 그 제목 수업이 더 없으면 예약조건도 정리
-- ============================================================

create or replace function delete_class_safe(p_class_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_center_id uuid;
    v_title     text;
    v_active    int;
begin
    select center_id, title into v_center_id, v_title
    from classes where id = p_class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    -- 권한 확인 (오너는 has_permission이 자동 통과)
    if not has_permission(v_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '이 수업을 삭제할 권한이 없어요';
    end if;

    -- 확정/대기/출석 예약이 있으면 삭제 불가
    select count(*) into v_active from reservations
    where class_id = p_class_id and status in ('confirmed','waitlisted','attended');
    if v_active > 0 then
        raise exception '확정·대기·출석 예약이 있어 삭제할 수 없어요 (%건). 먼저 처리해주세요', v_active;
    end if;

    -- 취소/노쇼 기록 정리 후 수업 삭제
    delete from reservations where class_id = p_class_id;
    delete from classes where id = p_class_id;

    -- 같은 제목 수업이 더 없으면 예약조건 정리
    if not exists (select 1 from classes where center_id = v_center_id and title = v_title) then
        delete from membership_schedule_rules
        where class_title = v_title
          and product_id in (select id from products where center_id = v_center_id);
    end if;

    return json_build_object('deleted', true);
end;
$$;

-- 반복수업 그룹 삭제 (security definer)
create or replace function delete_class_group_safe(p_group_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_center_id uuid;
    v_title     text;
    v_active    int;
begin
    select center_id, title into v_center_id, v_title
    from classes where recurring_group_id = p_group_id limit 1;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    if not has_permission(v_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '이 수업을 삭제할 권한이 없어요';
    end if;

    select count(*) into v_active from reservations
    where class_id in (select id from classes where recurring_group_id = p_group_id)
      and status in ('confirmed','waitlisted','attended');
    if v_active > 0 then
        raise exception '확정·대기·출석 예약이 있어 삭제할 수 없어요 (%건). 먼저 처리해주세요', v_active;
    end if;

    delete from reservations
    where class_id in (select id from classes where recurring_group_id = p_group_id);
    delete from classes where recurring_group_id = p_group_id;

    if not exists (select 1 from classes where center_id = v_center_id and title = v_title) then
        delete from membership_schedule_rules
        where class_title = v_title
          and product_id in (select id from products where center_id = v_center_id);
    end if;

    return json_build_object('deleted', true);
end;
$$;



-- ============================================================
-- 완료!  이제 오너/권한있는 매니저가 수업 삭제 시:
--   - 취소/노쇼 예약 자동 정리 후 삭제
--   - 확정/대기/출석 예약 있으면 건수와 함께 안내
--   - 같은 제목 수업이 다 없어지면 예약조건도 정리
-- ============================================================
