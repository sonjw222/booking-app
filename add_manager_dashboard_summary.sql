-- ============================================================
-- 관리자 홈 대시보드 집계 RPC
--
-- 배경:
--   관리자 홈이 "오늘 수업 목록"뿐이라 통계가 전혀 없었다. 클라이언트가 reservations/classes/
--   memberships/admin_action_logs를 전부 내려받아 집계하면 N+1과 과도한 데이터 전송이 생기므로,
--   기간(p_from~p_to, KST 기준 날짜) 하나를 받아 필요한 숫자를 전부 서버에서 한 번에 계산해
--   단일 JSON으로 반환한다. 매출은 PG 미연동이라 이 함수에 포함하지 않는다(화면에서 "준비중"
--   고정 표시 — 가짜 데이터 금지).
--
-- 권한: 기존 admin_assign_reservation과 동일하게 can_manage_center_reservations()로 검증.
--   다른 센터 관리자·일반 회원이 호출하면 예외를 던진다(RLS 우회가 아니라 함수 자체 검증 —
--   기존 fulfill_order/manager_book_member 등과 같은 패턴).
--
-- 적용 전제: add_admin_assignment.sql 적용 후 실행. 여러 번 실행해도 안전.
-- ============================================================

create or replace function manager_dashboard_summary(
    p_center_id uuid,
    p_from      date,
    p_to        date
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_from_ts timestamptz;
    v_to_ts   timestamptz;
    v_class_count        int;
    v_confirmed_count    int;
    v_cancelled_count    int;
    v_member_count       int;
    v_active_member_count int;
    v_active_membership_count int;
    v_admin_assignment_count int;
    v_admin_free_count   int;
begin
    if not can_manage_center_reservations(p_center_id) then
        raise exception '관리자 권한이 없어요';
    end if;

    v_from_ts := (p_from::text || ' 00:00:00+09')::timestamptz;
    v_to_ts   := (p_to::text   || ' 23:59:59+09')::timestamptz;

    select count(*) into v_class_count
    from classes
    where center_id = p_center_id
      and start_time >= v_from_ts and start_time <= v_to_ts;

    select count(*) into v_confirmed_count
    from reservations r
    join classes c on c.id = r.class_id
    where c.center_id = p_center_id
      and r.status = 'confirmed'
      and c.start_time >= v_from_ts and c.start_time <= v_to_ts;

    select count(*) into v_cancelled_count
    from reservations r
    join classes c on c.id = r.class_id
    where c.center_id = p_center_id
      and r.status = 'cancelled'
      and r.cancelled_at is not null
      and r.cancelled_at >= v_from_ts and r.cancelled_at <= v_to_ts;

    select count(*) into v_member_count
    from center_members where center_id = p_center_id;

    select count(*) into v_active_member_count
    from center_members where center_id = p_center_id and status = 'active';

    -- 활성 수강권: refund_membership()의 "아직 쓸 수 있는 수강권" 판정과 동일 기준
    select count(*) into v_active_membership_count
    from memberships
    where center_id = p_center_id
      and status = 'active'
      and (remaining_count is null or remaining_count > 0)
      and (expires_at is null or expires_at >= current_date);

    select count(*) into v_admin_assignment_count
    from admin_action_logs
    where center_id = p_center_id
      and action_type = 'CREATE_ASSIGNMENT'
      and created_at >= v_from_ts and created_at <= v_to_ts;

    select count(*) into v_admin_free_count
    from admin_action_logs
    where center_id = p_center_id
      and action_type = 'CREATE_FREE'
      and created_at >= v_from_ts and created_at <= v_to_ts;

    return json_build_object(
        'class_count', v_class_count,
        'confirmed_count', v_confirmed_count,
        'cancelled_count', v_cancelled_count,
        'member_count', v_member_count,
        'active_member_count', v_active_member_count,
        'active_membership_count', v_active_membership_count,
        'admin_assignment_count', v_admin_assignment_count,
        'admin_free_count', v_admin_free_count
    );
end;
$$;

-- ============================================================
-- 끝. 프론트는 이 함수 한 번 호출로 대시보드 요약 카드를 전부 채운다(N+1 없음).
-- 매출 관련 필드는 의도적으로 포함하지 않았다 — 화면에서 "준비중"으로 고정 표시할 것.
-- ============================================================
