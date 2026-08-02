-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- NOTIF-001 (E-4/E-5): 휴무일 강제취소 이력 보존 + 회원 알림 강화
--
-- ⚠️ 실행 순서: fix_reservation_cancel_source_column_draft_proposed.sql을 먼저 실행해야 한다
-- (이 파일이 새 컬럼 reservations.cancel_source를 참조함).
--
-- ⚠️ 이 파일은 최근 승인·실행된 P0-6 SQL(fix_holiday_membership_restore_draft_proposed.sql,
-- PR #32 — 수강권 복구 로직 추가)이 만든 add_holiday_safe()를 다시 CREATE OR REPLACE로
-- 덮어씁니다. P0-6에서 이미 추가한 "수강권 복구" 로직은 그대로 유지하면서, 삭제(DELETE)
-- 기반 구조를 취소(UPDATE status='cancelled') 기반으로 바꾸는 것이 이번 변경의 핵심입니다.
-- 아래 rollback 파일은 "P0-6 적용 직후 상태"(이 배치 이전, DELETE 기반 + 수강권 복구 포함)로
-- 정확히 되돌립니다 — P0-6 이전(수강권 미복구 버그가 있던) 상태로 되돌리는 게 아닙니다.
--
-- 조사 결과(중요):
--   - classes.status는 이미 'cancelled'를 지원합니다(schema.sql, "cancelled = 폐강" —
--     delete_class_safe류가 사용하는 것과 동일한 개념). 새 컬럼/제약 없이 이력을 보존할 수
--     있는 이유입니다.
--   - reservations.class_id → classes(id) FK에는 ON DELETE CASCADE가 없어서, 지금까지
--     add_holiday_safe()는 예약을 먼저 DELETE한 뒤에야 classes를 DELETE할 수 있었습니다
--     (그래서 이력이 통째로 사라졌음). UPDATE 방식으로 바꾸면 이 FK 문제 자체가 사라집니다
--     (아무 것도 삭제하지 않으므로).
--   - trg_notify_reservation_update(add_notification_triggers.sql)는 이미 `after update on
--     reservations`에서 status가 'cancelled'로 바뀌면 회원에게 "예약이 취소됐어요" 알림을
--     자동으로 만듭니다(회원+매니저 양쪽). DELETE는 이 트리거를 아예 발동시키지 않았지만
--     UPDATE는 발동시킵니다 — 즉 이 리팩터링만으로 E-4(회원 알림 생성)가 대부분 저절로
--     해결됩니다. 이번 수정은 그 알림 문구에 취소사유/수강권 복구 여부를 추가하는 것만
--     새로 합니다. 중복 알림 걱정 없음: 이 함수의 UPDATE는 한 번만 실행되고, 트리거는
--     "행 하나당 한 번"만 발동하므로 예약당 정확히 1건의 알림만 생성됩니다.
--
-- 수정 범위:
--   1) add_holiday_safe(): DELETE → UPDATE(status='cancelled', cancel_reason, cancelled_by,
--      cancelled_at, cancel_source='HOLIDAY') 방식으로 전환. 수강권 복구 로직(P0-6)은 그대로
--      유지. classes도 DELETE 대신 status='cancelled'로 전환.
--   2) trg_notify_reservation_update(): cancel_source='HOLIDAY'인 취소에 한해 알림 문구에
--      센터명·수업명·수업시간·취소사유·수강권 복구 여부를 포함하도록 확장. 그 외(일반
--      회원 셀프취소, 관리자 취소 등 cancel_source가 'HOLIDAY'가 아니거나 null인 경우)의
--      기존 알림 문구는 전혀 바꾸지 않는다.
--
-- 대량 예약 시 성능: 이 함수는 원래도 클래스/예약 건수에 비례하는 집합 UPDATE 1~2건이었고
-- (DELETE 2건 → UPDATE 2건으로 성격만 바뀜), 알림 생성은 트리거가 행 단위로 처리하므로
-- 예약 건수만큼 트리거가 실행된다 — 기존에도 이미 그랬던 방식과 동일한 처리량이라 별도의
-- 배치 최적화가 필요한 변경은 아니다(대량이라 해도 보통 수십~수백 건 수준).
--
-- 기존 API 유지: add_holiday_safe()의 반환 JSON 필드명(needs_confirm/class_count/
-- reservation_count/deleted_classes/cancelled_reservations)은 전혀 바꾸지 않는다
-- (lib/holidays.ts가 그대로 이 필드명을 읽음) — deleted_classes는 이제 "삭제된"이 아니라
-- "취소(폐강) 처리된" 클래스 수를 의미하지만, API 계약을 유지하기 위해 필드명은 유지한다.
-- ============================================================

BEGIN;

-- [1] add_holiday_safe(): DELETE → UPDATE(cancelled) 전환, 수강권 복구 로직은 그대로 유지
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
    v_admin_id   uuid;
begin
    -- 권한 확인 (센터 관리자/오너)
    if not has_permission(p_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '휴무일을 지정할 권한이 없어요';
    end if;

    v_admin_id := my_account_id();

    -- 그날 그 센터의 수업 id 모음 (KST 기준 날짜). 이미 폐강 처리된 수업은 다시 대상으로
    -- 잡지 않는다(재호출 시 멱등성 유지 — 기존에도 DELETE 후 재호출하면 대상이 없어 동일했음).
    select array_agg(id) into v_class_ids
    from classes
    where center_id = p_center_id
      and (start_time at time zone 'Asia/Seoul')::date = p_date
      and status <> 'cancelled';

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

    if v_class_ids is not null then
        -- [P0-6] 취소로 사라질 예약 중 실제로 수강권을 차감했던 것만 복구
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

        -- [E-4/E-5 재설계] 예약을 삭제하지 않고 취소 처리로 남겨 이력을 보존한다.
        -- trg_notify_reservation_update가 이 UPDATE로 자동 발동해 회원에게 알림을 생성한다.
        update reservations
        set status = 'cancelled',
            cancel_reason = coalesce(p_reason, '센터 휴무일 지정으로 자동 취소'),
            cancel_source = 'HOLIDAY',
            cancelled_by = v_admin_id,
            cancelled_at = now()
        where class_id = any(v_class_ids)
          and status in ('confirmed', 'waitlisted', 'attended');

        -- 수업도 삭제 대신 폐강(cancelled) 처리 — 이력·스냅샷 보존, FK 문제 없음
        update classes set status = 'cancelled' where id = any(v_class_ids);
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


-- [2] trg_notify_reservation_update(): HOLIDAY 취소에 한해 알림 문구 강화
create or replace function trg_notify_reservation_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center      uuid;
    v_center_name text;
    v_title       text;
    v_start       timestamptz;
    v_account     uuid;
    v_who         text;
    v_restored    boolean;
    m record;
begin
    if new.status = old.status then
        return new;  -- 상태 안 바뀌면 무시
    end if;

    select c.center_id, c.title, c.start_time, ct.name
      into v_center, v_title, v_start, v_center_name
      from classes c
      left join centers ct on ct.id = c.center_id
      where c.id = new.class_id;
    select pr.account_id, coalesce(pr.nickname, pr.name, '회원')
      into v_account, v_who
      from profiles pr where pr.id = new.profile_id;

    -- 대기 → 확정
    if old.status = 'waitlisted' and new.status = 'confirmed' then
        if v_account is not null then
            perform push_notification(
                v_account, 'waitlist_promoted', '대기하던 수업이 확정됐어요',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        end if;

    -- 취소
    elsif new.status = 'cancelled' then
        if v_account is not null then
            if new.cancel_source = 'HOLIDAY' then
                -- [NOTIF-001 E-4] 휴무일 자동취소 전용 문구: 센터명·수업명·시간·취소사유·
                -- 수강권 복구 여부. 복구 여부는 add_holiday_safe와 동일한 조건으로 판정한다
                -- (old.status가 확정/출석이고 membership_consumed && membership_id가 있으면
                -- 그 함수가 복구했다는 뜻).
                v_restored := old.status in ('confirmed', 'attended')
                    and new.membership_consumed
                    and new.membership_id is not null;
                perform push_notification(
                    v_account, 'reservation_canceled', '센터 휴무일로 예약이 취소됐어요',
                    coalesce(v_center_name, '센터') || ' · ' || v_title || ' · ' ||
                        to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI') ||
                        coalesce(' · ' || new.cancel_reason, '') ||
                        case when v_restored then ' · 사용한 수강권 횟수는 복구됐어요' else '' end,
                    v_center, '/my-reservations',
                    jsonb_build_object('reservation_id', new.id, 'cancel_source', 'HOLIDAY')
                );
            else
                perform push_notification(
                    v_account, 'reservation_canceled', '예약이 취소됐어요',
                    v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                    v_center, '/my-reservations',
                    jsonb_build_object('reservation_id', new.id)
                );
            end if;
        end if;
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'reservation_canceled', '예약이 취소됐어요',
                v_who || '님 · ' || v_title || ' ' ||
                    to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;

    -- 노쇼
    elsif new.status = 'no_show' then
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'no_show', '노쇼가 발생했어요',
                v_who || '님이 ' || v_title || ' 수업에 오지 않았어요',
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;
    end if;

    return new;
end;
$$;

COMMIT;
