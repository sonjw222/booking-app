-- ============================================================
-- P1-5b (Bucket 2) — manager_set_attendance() 출결 처리 권한
--
-- 배경: 대시보드 로스터의 출석/결석/노쇼/예약취소 버튼이 부르는 manager_set_attendance()가
--   my_managed_center_ids()만 체크하고 있었다(pg_get_functiondef로 라이브 정의를 직접
--   확인해서 확정 — 정적 파일에 여러 버전이 있어 파일 추측 대신 실제 정의를 가져왔다).
--   schedule.attendance 키는 카탈로그에 있지만 지금까지 연결되지 않았다.
--
-- 이 파일은 권한 체크 한 줄만 추가하고 나머지 로직(대기 예약 상태 전환 제약, 취소 시
-- remaining_count 복구 등)은 라이브 정의와 완전히 동일하게 유지한다.
--
-- ⚠ 동작 변경 주의: schedule.attendance를 아직 역할에 안 준 기존 스태프는 더 이상
--   대시보드에서 출석/결석/노쇼/예약취소 처리를 못 하게 된다. 오너는 영향 없음.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create or replace function manager_set_attendance(p_reservation_id uuid, p_status text)
returns json
language plpgsql
security definer
set search_path = public
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
    if not (has_permission(v_class.center_id, 'schedule.attendance') or is_platform_admin()) then
        raise exception '이 예약을 처리할 권한이 없어요';
    end if;

    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이라 출결 상태를 바꿀 수 없어요';
    end if;

    if v_res.status = 'waitlisted' and p_status in ('attended', 'no_show') then
        raise exception '대기 중인 예약은 출석/결석으로 표시할 수 없어요 — 먼저 확정돼야 해요';
    end if;

    if v_res.status = 'waitlisted' and p_status = 'confirmed' then
        raise exception '대기 예약은 이 화면에서 바로 확정으로 바꿀 수 없어요 — 정원이 비면 자동으로 승격돼요';
    end if;

    v_admin_id := my_account_id();

    if p_status = 'cancelled' then
        if v_res.status in ('confirmed', 'attended', 'no_show') and v_res.membership_id is not null then
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

-- ============================================================
-- 확인
-- ============================================================
select proname, pg_get_functiondef(oid) like '%schedule.attendance%' as has_permission_check
from pg_proc where proname = 'manager_set_attendance';
