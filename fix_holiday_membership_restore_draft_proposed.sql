-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- P0-6: 휴무일 강제 지정 시 취소된 예약의 수강권 횟수가 복구되지 않는 버그 수정
--
-- 원인: add_holiday_safe()가 예약자가 있는 날을 강제로 휴무일 지정할 때
-- `delete from reservations where class_id = any(v_class_ids)`로 예약을 그대로
-- 지우기만 하고, cancel_reservation()/admin_cancel_reservation()/
-- manager_set_attendance()가 전부 하는 "수강권 횟수 복구"를 하지 않았다. 회원이
-- 실제로 사용한 적 없는 수강권 횟수를 영구히 잃는 실질적 금전/재화 손실 버그.
--
-- 수정 범위: add_holiday_safe() 함수 본문 CREATE OR REPLACE + admin_action_logs.reservation_id
-- FK를 nullable/ON DELETE SET NULL로 변경(아래 별도 발견 버그 참고). 다른 함수/트리거/테이블
-- 구조는 전혀 바꾸지 않는다. delete_class_safe()/delete_class_group_safe()는 애초에 확정·대기·
-- 출석 예약이 있으면 삭제 자체를 막아서(raise exception) 수강권 미복구 버그는 없다 —
-- add_holiday_safe()만 유일하게 강제(force) 경로로 이 방어를 우회한다. 다만 이 두 함수도
-- "취소/노쇼 예약은 함께 삭제"하므로 그 예약에 admin_action_logs 참조가 있으면 동일한 FK
-- 위반을 겪을 수 있다 — 이번 FK 수정으로 함께 해결되지만, 그 두 함수 자체는 이번 PR에서
-- 손대지 않는다(범위 밖, docs/TODO.md에 별도 기록).
--
-- 복구 조건(= 실제로 수강권을 차감했던 예약만 복구):
--   - status in ('confirmed', 'attended') — waitlisted는 애초에 차감된 적이 없어 제외
--     (cancel_reservation()도 status='confirmed'일 때만 환급). attended도 포함하는 이유는
--     manager_set_attendance()의 취소 처리가 이전 상태(attended 포함)와 무관하게
--     membership_id만 있으면 복구하는 것과 일관되게 맞춘 것 — 이 함수가 예약 자체를
--     지워 출석 기록도 함께 사라지므로, 이미 소진 처리된 횟수를 그대로 돌려주는 쪽이
--     안전하다고 판단했다(기존 admin_cancel_reservation의 "실제 차감된 경우에만" 원칙과
--     동일한 정신).
--   - membership_consumed = true — ADMIN_FREE(무료 추가배치)처럼 애초에 차감이 없었던
--     예약은 제외(admin_cancel_reservation과 동일한 가드).
--   - membership_id is not null — 수강권 없이 만들어진 예약은 대상 아님.
--   - memberships.remaining_count is not null — 무제한권(횟수 제한 없음)은 복구할
--     remaining_count 자체가 없어 자연히 제외됨(admin_cancel_reservation/
--     manager_set_attendance와 동일한 가드, 특별 분기 불필요).
-- 같은 수강권으로 같은 날짜에 여러 건(예: 복수 클래스)을 예약했을 수 있어, 건수만큼
-- 정확히 합산해서 복구한다(단순 +1이 아니라 GROUP BY로 건수를 센 뒤 그만큼 더함).
--
-- 동시성: 이 함수는 원래도 명시적 행 잠금이 없었고(기존 동작 유지), memberships UPDATE와
-- 뒤이은 reservations DELETE는 각각 Postgres의 기본 MVCC/행 잠금으로 보호된다. 복구 대상
-- 조건(status/membership_consumed)은 이 시점에 "새로" 조회하므로, 회원이 동시에 자기
-- 예약을 cancel_reservation()으로 먼저 취소했다면(그쪽에서 이미 복구함) 그 예약은 이미
-- status='cancelled'라 이 복구 대상에서 자동으로 제외되어 이중 복구가 나지 않는다.
--
-- [이번 회귀 테스트 작성 중 추가로 발견한 별도 버그, 같은 함수라 함께 수정]
-- admin_action_logs.reservation_id는 `not null references reservations(id)`인데 ON DELETE
-- 지정이 없어(기본 RESTRICT) 지금까지 add_holiday_safe()는 "관리자 직접배치/무료배치"로
-- 만들어진 예약이 하루라도 껴 있으면 `delete from reservations`에서 FK 위반으로 통째로
-- 실패했다(트랜잭션 전체 롤백 — 휴무일도 등록 안 되고 아무 것도 안 바뀐 채 매니저에게는
-- 원인불명의 SQL 에러만 노출됨). admin_action_logs는 이미 member_name_snapshot/
-- class_title_snapshot/class_start_snapshot 같은 스냅샷 컬럼을 갖고 있어(add_admin_assignment.sql)
-- 원본 reservations 행이 사라져도 로그 자체는 의미를 유지하도록 설계돼 있었다 — FK가 그
-- 설계 의도와 어긋나 있던 것으로 보인다. reservation_id를 nullable로 바꾸고
-- ON DELETE SET NULL로 교체해 감사 로그 행은 보존하면서 참조만 끊는다(로그 삭제 아님).
-- 영향: `AdminActionLog.reservationId`(lib/adminAssignment.ts) 타입을 `string | null`로
-- 맞췄다 — 현재 이 필드를 실제로 읽는 화면 코드가 없어(app/manager/admin-assignments/page.tsx
-- 확인, "되돌리기" 기능 미구현) 런타임 영향은 없다.
-- ============================================================

BEGIN;

-- [별도 발견 버그 수정] admin_action_logs.reservation_id를 nullable + ON DELETE SET NULL로.
alter table admin_action_logs
    alter column reservation_id drop not null;

alter table admin_action_logs
    drop constraint if exists admin_action_logs_reservation_id_fkey;

alter table admin_action_logs
    add constraint admin_action_logs_reservation_id_fkey
    foreign key (reservation_id) references reservations(id) on delete set null;

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
        -- [P0-6 수정] 삭제로 사라질 예약 중 실제로 수강권을 차감했던 것만 복구
        update memberships m
        set remaining_count = remaining_count + sub.cnt
        from (
            select r.membership_id, count(*) as cnt
            from reservations r
            where r.class_id = any(v_class_ids)
              and r.status in ('confirmed', 'attended')
              and r.membership_consumed
              and r.membership_id is not null
            group by r.membership_id
        ) sub
        where m.id = sub.membership_id
          and m.remaining_count is not null;

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

COMMIT;
