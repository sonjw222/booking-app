-- ============================================================
-- P3(출석/체크인 배치): manager_set_attendance() 통합 + 대기(waitlisted) 가드 추가
--
-- 배경(코드 감사로 확인, 추측 아님):
--   manager_set_attendance()가 이 저장소 안에 서로 다른 버전으로 4곳에 정의돼 있었다
--   (add_attendance.sql v1, reservation_functions.sql 안에 v1 중복 + v2, add_admin_assignment.sql
--   v4). 어느 버전이 실제로 운영 DB에 살아있는지 git 파일만으로는 알 수 없다는 것 자체가
--   이미 docs/TODO.md P0-3에 알려진 문제(migration ledger 갭)다. v1은 "이미 취소된 예약도
--   다시 출석/노쇼로 바꿀 수 있음"(취소가 최종 상태가 아님) — v2/v4는 "취소는 최종 상태,
--   더 이상 못 바꿈"으로 더 안전하다. 이 파일은 v4(가장 최근, cancelled_by/cancelled_at
--   audit 컬럼까지 채움)를 그대로 base로 삼아 유일한 정의로 통합하고, 감사에서 발견한 실제
--   버그 하나를 추가로 고친다:
--
--   버그: 대기(waitlisted) 상태인 예약도 출석/결석으로 표시할 수 있었다(RPC도 관리자 UI도
--   막지 않음). 대기는 아직 확정된 자리가 아니라(수강권도 차감 안 됨) "출석"이 성립할 수
--   없는 상태 — 확정(confirmed)으로 승격되기 전까지는 출결 자체를 매길 대상이 아니다.
--
-- 영향받는 기존 데이터: 없음(함수 재정의만, 테이블/데이터 변경 없음).
-- 예상 행 수: 0 (DDL만).
-- 위험도: 낮음 — 기존 정상 경로(confirmed→attended/no_show/cancelled, 권한 체크)는 v4와
--   동일하게 유지, 새 가드는 이전에 허용되지 말았어야 할 경로(waitlisted 출결)만 막는다.
-- ============================================================

BEGIN;

create or replace function manager_set_attendance(p_reservation_id uuid, p_status text)
returns json
language plpgsql
security definer
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
    if not (v_class.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 예약을 처리할 권한이 없어요';
    end if;

    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이라 출결 상태를 바꿀 수 없어요';
    end if;

    -- [신규] 대기 중인 예약은 출석/결석으로 표시할 수 없다 — 확정된 적이 없어 애초에
    -- "출석했다/안 했다"를 매길 대상이 아니다(수강권도 차감된 적 없음). 대기 취소는 허용한다
    -- (대기 자체를 철회하는 것은 기존에도 정상 동작이었고 계속 필요함).
    if v_res.status = 'waitlisted' and p_status in ('attended', 'no_show') then
        raise exception '대기 중인 예약은 출석/결석으로 표시할 수 없어요 — 먼저 확정돼야 해요';
    end if;

    v_admin_id := my_account_id();

    if p_status = 'cancelled' then
        if v_res.membership_id is not null then
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

COMMIT;

-- ============================================================
-- 확인
-- ============================================================
select pg_get_functiondef('manager_set_attendance(uuid, text)'::regprocedure);
