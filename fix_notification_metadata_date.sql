-- ============================================================
-- 알림 metadata 보강: 관리자 배치/취소 알림에 date(KST, YYYY-MM-DD) 추가
--
-- 배경:
--   admin_assigned/admin_cancelled 알림의 data에는 reservation_id/class_id/action만 있었다.
--   향후 알림센터(공지/결제/회원권 만료 등도 같은 kind+data 구조를 쓸 예정)에서 날짜만으로도
--   목록을 그룹핑/표시할 수 있도록 date를 추가한다. route는 이미 notifications.link 컬럼이
--   그 역할을 하므로 data에 중복 저장하지 않는다. reservation_type/사유/관리자명 등 회원에게
--   노출하면 안 되는 내부 정보는 여전히 넣지 않는다(add_admin_assignment.sql의 원칙 그대로).
--
--   trg_notify_reservation_insert/_update 두 함수 전체를 create or replace 하며, admin 타입
--   분기의 data payload에만 'date' 키를 추가한다 — 그 외 로직(회원 확정/대기, 매니저 알림,
--   대기→확정, 취소, 노쇼 등 기존 흐름)은 add_admin_assignment.sql과 완전히 동일하게 유지.
--
-- 여러 번 실행해도 안전 (create or replace).
-- ============================================================

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

    if new.reservation_type in ('ADMIN_ASSIGNMENT', 'ADMIN_FREE') then
        -- 관리자 배치: 회원에게는 무료/사유/관리자명/정원초과 등 내부 정보 노출 안 함
        if v_account is not null and new.status = 'confirmed' then
            perform push_notification(
                v_account, 'admin_assigned', '관리자가 예약을 등록했습니다',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object(
                    'reservation_id', new.id, 'class_id', new.class_id, 'action', 'assigned',
                    'date', to_char(v_start at time zone 'Asia/Seoul', 'YYYY-MM-DD')
                )
            );
        end if;
        -- 관리자가 만든 예약이므로 다른 매니저에게 별도 "새 예약" 알림은 생략(소음 방지)
        return new;
    end if;

    -- 회원 본인 확인 알림 (기존과 동일)
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
        return new;
    end if;

    select c.center_id, c.title, c.start_time into v_center, v_title, v_start
      from classes c where c.id = new.class_id;
    select pr.account_id, coalesce(pr.nickname, pr.name, '회원')
      into v_account, v_who
      from profiles pr where pr.id = new.profile_id;

    if new.status = 'cancelled' and new.reservation_type in ('ADMIN_ASSIGNMENT', 'ADMIN_FREE') then
        if v_account is not null then
            perform push_notification(
                v_account, 'admin_cancelled', '관리자가 예약을 취소했습니다',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object(
                    'reservation_id', new.id, 'class_id', new.class_id, 'action', 'cancelled',
                    'date', to_char(v_start at time zone 'Asia/Seoul', 'YYYY-MM-DD')
                )
            );
        end if;
        return new;
    end if;

    -- 대기 → 확정 (기존과 동일, 타입 무관)
    if old.status = 'waitlisted' and new.status = 'confirmed' then
        if v_account is not null then
            perform push_notification(
                v_account, 'waitlist_promoted', '대기하던 수업이 확정됐어요',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        end if;

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

-- ============================================================
-- 끝. admin_assigned/admin_cancelled 알림의 data에 date(YYYY-MM-DD, KST)가 추가되었습니다.
-- 그 외 알림 kind(reservation_confirmed, new_reservation 등)의 payload는 변경하지 않았습니다.
-- ============================================================
