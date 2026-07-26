-- ============================================================
-- 추가 알림 트리거 (예약 관련)
--
-- 하는 일:
--   회원 알림:
--     - 예약 확정됨 (내가 방금 예약 성공)
--     - 대기자로 등록됨
--     - 대기 → 예약 확정 전환 (자리 나서 확정)
--     - 내 예약이 취소됨
--   매니저 알림:
--     - 새 예약 접수
--     - 예약 취소 발생
--     - 노쇼(무단 불참) 발생
--
-- ⚠ add_notifications.sql 을 먼저 실행하세요 (push_notification 함수 필요).
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- 예약 INSERT → 회원 확인 알림 + 매니저 알림
-- ------------------------------------------------------------
create or replace function trg_notify_reservation_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center uuid;
    v_title text;
    v_start timestamptz;
    v_account uuid;
    v_who text;
    m record;
begin
    select c.center_id, c.title, c.start_time into v_center, v_title, v_start
      from classes c where c.id = new.class_id;

    select pr.account_id, coalesce(pr.nickname, pr.name, '회원')
      into v_account, v_who
      from profiles pr where pr.id = new.profile_id;

    -- 회원 본인 확인 알림
    if v_account is not null then
        if new.status = 'confirmed' then
            perform push_notification(
                v_account, 'reservation_confirmed', '예약이 확정됐어요',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        elsif new.status = 'waitlisted' then
            perform push_notification(
                v_account, 'reservation_waitlisted', '대기자로 등록됐어요',
                v_title || ' · 자리가 나면 알려드릴게요',
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        end if;
    end if;

    -- 매니저 알림 (확정 예약만; 대기는 소음이라 제외)
    if new.status = 'confirmed' then
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'new_reservation', '새 예약이 있어요',
                v_who || '님 · ' || v_title || ' ' ||
                    to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;
    end if;

    return new;
end;
$$;

drop trigger if exists notify_reservation_insert on reservations;
create trigger notify_reservation_insert
    after insert on reservations
    for each row execute function trg_notify_reservation_insert();


-- ------------------------------------------------------------
-- 예약 UPDATE → 상태 전환별 알림
--   waitlisted → confirmed : 대기 확정 (회원)
--   * → cancelled           : 취소 (회원 + 매니저)
--   * → no_show             : 노쇼 (매니저)
-- ------------------------------------------------------------
create or replace function trg_notify_reservation_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center uuid;
    v_title text;
    v_start timestamptz;
    v_account uuid;
    v_who text;
    m record;
begin
    if new.status = old.status then
        return new;  -- 상태 안 바뀌면 무시
    end if;

    select c.center_id, c.title, c.start_time into v_center, v_title, v_start
      from classes c where c.id = new.class_id;
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
            perform push_notification(
                v_account, 'reservation_canceled', '예약이 취소됐어요',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
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

drop trigger if exists notify_reservation_update on reservations;
create trigger notify_reservation_update
    after update on reservations
    for each row execute function trg_notify_reservation_update();


-- ============================================================
-- 완료!
--   예약/취소/대기전환/노쇼 알림이 자동으로 발송됩니다.
-- ============================================================
