-- ============================================================
-- 운영 설정 → 예약/취소 규칙 실제 연동
--
-- 하는 일:
--   center_settings 의 "N일 전 HH:MM" 규칙을 실제 예약/취소 마감에 반영
--   1) calc_deadline() : 설정 기반 마감시각 계산 (그룹/프라이빗 구분)
--   2) reserve_class() : 예약 마감을 설정값으로 판단 (없으면 기존값 폴백)
--   3) cancel_reservation() : 취소 마감 + 설정14(마감후취소 차감) 반영
--
-- create or replace 라서 함수만 교체됩니다. 데이터 영향 없음.
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================


create or replace function calc_deadline(
    p_center_id uuid,
    p_class_format text,
    p_start_time timestamptz,
    p_kind text
)
returns timestamptz
language plpgsql stable
as $$
declare
    v_settings record;
    v_days int;
    v_time time;
    v_class_date date;
    v_deadline_date date;
begin
    select * into v_settings from center_settings where center_id = p_center_id;
    if not found then
        return null;   -- 설정 없음 → 폴백
    end if;

    -- 형태 + 종류에 맞는 (일수, 시각) 선택
    if p_class_format = 'private' then
        if p_kind = 'book' then
            v_days := v_settings.private_book_days_before;
            v_time := v_settings.private_book_time;
        else
            v_days := v_settings.private_cancel_days_before;
            v_time := v_settings.private_cancel_time;
        end if;
    else
        if p_kind = 'book' then
            v_days := v_settings.group_book_days_before;
            v_time := v_settings.group_book_time;
        else
            v_days := v_settings.group_cancel_days_before;
            v_time := v_settings.group_cancel_time;
        end if;
    end if;

    -- 수업일(한국시간) 기준 N일 전 날짜의 HH:MM (한국시간) 을 마감으로
    v_class_date := (p_start_time at time zone 'Asia/Seoul')::date;
    v_deadline_date := v_class_date - make_interval(days => v_days);

    -- 한국시간의 (날짜 + 시각) 을 timestamptz 로
    return ((v_deadline_date::text || ' ' || v_time::text) || '+09')::timestamptz;
end;
$$;


create or replace function reserve_class(p_class_id uuid, p_profile_id uuid default null)
returns json
language plpgsql
security definer  -- RLS를 우회해서 함수 안에서 검증을 직접 수행
as $$
declare
    v_profile_id    uuid;
    v_class         record;
    v_membership    record;
    v_confirmed     int;
    v_status        text;
    v_wait_order    int;
    v_reservation_id uuid;
    v_day_of_week   int;
    v_local_date    date;
    v_local_time    time;
begin
    -- (1) 예약할 프로필 결정
    --     p_profile_id 를 넘기면 그 프로필, 안 넘기면 본인 대표 프로필
    if p_profile_id is not null then
        -- 내 계정 소유의 프로필인지 확인
        select id into v_profile_id from profiles
        where id = p_profile_id and account_id = my_account_id();
    else
        select id into v_profile_id from profiles
        where account_id = my_account_id() and is_primary = true
        limit 1;
    end if;
    if v_profile_id is null then
        raise exception '로그인이 필요하거나 프로필을 찾을 수 없어요';
    end if;

    -- (2) 수업 정보 확인 (행 잠금으로 동시 예약 경쟁 방지)
    select * into v_class from classes where id = p_class_id for update;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    -- 한국시간 기준 날짜/시간/요일 (서버는 UTC라서 변환 필수!)
    v_local_date := (v_class.start_time at time zone 'Asia/Seoul')::date;
    v_local_time := (v_class.start_time at time zone 'Asia/Seoul')::time;
    v_day_of_week := extract(dow from (v_class.start_time at time zone 'Asia/Seoul'))::int;

    -- (2-1) 폐강/마감된 수업인지 확인
    if v_class.status = 'cancelled' then
        raise exception '폐강된 수업이에요';
    end if;
    if v_class.status = 'closed' then
        raise exception '예약이 마감된 수업이에요';
    end if;

    -- (2-2) 승인된 센터인지 확인 (승인대기 센터는 예약 불가)
    if not exists (
        select 1 from centers where id = v_class.center_id and status = 'approved'
    ) then
        raise exception '아직 승인되지 않은 센터예요';
    end if;

    -- (2-3) 예약 마감시간 확인
    --   센터 설정(N일 전 HH:MM)이 있으면 그걸 쓰고,
    --   없으면 기존 classes.booking_deadline_min(분 단위)로 폴백
    declare
        v_book_deadline timestamptz;
    begin
        v_book_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'book');
        if v_book_deadline is null then
            v_book_deadline := v_class.start_time - make_interval(mins => v_class.booking_deadline_min);
        end if;
        if now() > v_book_deadline then
            raise exception '예약 마감시간이 지났어요';
        end if;
    end;

    -- (3) 센터 휴무일 확인
    if exists (
        select 1 from center_holidays
        where center_id = v_class.center_id
          and holiday_date = v_local_date
    ) then
        raise exception '센터 휴무일이라 예약할 수 없어요';
    end if;

    -- (4) 중복 예약 확인
    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = v_profile_id
          and status in ('confirmed', 'waitlisted')
    ) then
        raise exception '이미 예약(또는 대기)한 수업이에요';
    end if;

    -- (5) 사용 가능한 수강권 찾기
    --     조건: 해당 센터 + 잔여횟수 있음 + 기간 유효
    --     수강권에 요일/시간 조건(membership_schedule_rules)이 있으면 그 조건도 통과해야 함
    select m.* into v_membership
    from memberships m
    where m.profile_id = v_profile_id
      and m.center_id = v_class.center_id
      and m.remaining_count > 0
      and m.expires_at >= current_date
      and (
            -- 조건이 하나도 없으면 통과
            not exists (select 1 from membership_schedule_rules r where r.membership_id = m.id)
            -- 조건이 있으면 하나라도 매칭돼야 통과
            or exists (
                select 1 from membership_schedule_rules r
                where r.membership_id = m.id
                  and (r.day_of_week is null or r.day_of_week = v_day_of_week)
                  and (r.start_time is null or r.start_time = v_local_time)
                  and (r.class_title is null or v_class.title like '%' || r.class_title || '%')
            )
      )
    order by m.expires_at asc   -- 만료 임박한 수강권부터 사용
    limit 1
    for update;

    if not found then
        raise exception '이 수업에 사용할 수 있는 수강권이 없어요 (잔여횟수/기간/예약조건을 확인해주세요)';
    end if;

    -- (6) 정원 확인 → 확정 또는 대기
    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status = 'confirmed';

    if v_confirmed < v_class.capacity then
        -- 확정 예약: 수강권 1회 차감
        v_status := 'confirmed';
        update memberships set remaining_count = remaining_count - 1
        where id = v_membership.id;

        insert into reservations (class_id, profile_id, membership_id, status)
        values (p_class_id, v_profile_id, v_membership.id, 'confirmed')
        returning id into v_reservation_id;
    else
        -- 대기 등록: 차감하지 않고 순번만 부여 (확정 전환될 때 차감)
        v_status := 'waitlisted';
        select coalesce(max(waitlist_order), 0) + 1 into v_wait_order
        from reservations where class_id = p_class_id and status = 'waitlisted';

        insert into reservations (class_id, profile_id, membership_id, status, waitlist_order)
        values (p_class_id, v_profile_id, v_membership.id, 'waitlisted', v_wait_order)
        returning id into v_reservation_id;
    end if;

    return json_build_object('status', v_status, 'reservation_id', v_reservation_id);
end;
$$;


create or replace function cancel_reservation(p_reservation_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_res         record;
    v_class       record;
    v_next        record;
    v_next_mem    record;
    v_promoted    boolean := false;
    v_skip_refund boolean := false;   -- 마감 후 취소 + 차감옵션 시 환급 건너뜀
begin
    -- 내 계정 소유 프로필의 예약인지 확인 + 잠금
    select * into v_res from reservations
    where id = p_reservation_id
      and profile_id in (select id from profiles where account_id = my_account_id())
    for update;

    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;
    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이에요';
    end if;

    -- 취소 마감시간 확인
    --   센터 설정(N일 전 HH:MM)이 있으면 그걸 쓰고, 없으면 classes 고정값 폴백.
    --   설정 14번(deduct_on_late_cancel)이 켜져 있으면, 마감 후 취소라도
    --   차단하지 않고 "횟수 차감"으로 진행한다.
    select * into v_class from classes where id = v_res.class_id;
    if found then
        declare
            v_cancel_deadline timestamptz;
            v_deduct_late boolean := false;
            v_is_late boolean := false;
        begin
            v_cancel_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'cancel');
            if v_cancel_deadline is null then
                v_cancel_deadline := v_class.start_time - make_interval(mins => v_class.cancel_deadline_min);
            end if;
            v_is_late := now() > v_cancel_deadline;

            select coalesce(deduct_on_late_cancel, false) into v_deduct_late
            from center_settings where center_id = v_class.center_id;

            if v_is_late and not v_deduct_late then
                -- 마감 지났고, 차감 옵션도 꺼져 있으면 취소 불가
                raise exception '취소 마감시간이 지났어요';
            end if;
            -- 마감 지났지만 차감 옵션이 켜져 있으면: 취소는 허용하되 환급 안 함
            v_skip_refund := v_is_late and v_deduct_late;
        end;
    end if;

    -- 취소 처리
    update reservations set status = 'cancelled' where id = p_reservation_id;

    if v_res.status = 'confirmed' then
        -- 수강권 환급 (단, 마감 후 취소 + 차감옵션이면 환급하지 않음 = 횟수 차감)
        if not v_skip_refund then
            update memberships set remaining_count = remaining_count + 1
            where id = v_res.membership_id;
        end if;

        -- 대기자를 순번대로 확인하면서 '확정 가능한 첫 사람'을 승격시킨다.
        --   그냥 1순위를 무조건 승격시키면, 그 사람의 수강권이 그새 소진/만료된 경우
        --   remaining_count 가 음수가 되거나 만료 수강권으로 예약이 잡히는 문제가 생김.
        for v_next in
            select * from reservations
            where class_id = v_res.class_id and status = 'waitlisted'
            order by waitlist_order asc
            for update
        loop
            -- 이 대기자의 수강권이 아직 쓸 수 있는지 확인 (잔여횟수 + 유효기간)
            select * into v_next_mem from memberships
            where id = v_next.membership_id
              and remaining_count > 0
              and expires_at >= current_date
            for update;

            -- 주의: record 변수는 'is not null' 판정이 불안정합니다.
            --   (모든 필드가 null인지로 평가되어 의도와 다르게 동작)
            --   PL/pgSQL 표준인 FOUND 를 사용해야 합니다.
            if found then
                update reservations
                set status = 'confirmed', waitlist_order = null
                where id = v_next.id;

                update memberships set remaining_count = remaining_count - 1
                where id = v_next_mem.id;

                v_promoted := true;
                -- TODO(2차): 승격된 회원에게 푸시 알림 발송
                exit;  -- 한 자리만 났으므로 한 명만 승격
            end if;
            -- 수강권을 못 쓰는 대기자는 건너뛰고 다음 순번 확인
        end loop;
    end if;

    return json_build_object('cancelled', true, 'waitlist_promoted', v_promoted);
end;
$$;


-- ============================================================
-- 완료!
--   운영 설정에서 "그룹 취소 1일 전 22:00까지"로 바꾸면
--   실제로 그 시각 이후 취소가 막힙니다(또는 설정14가 켜져 있으면 차감).
--   설정 행이 없으면 기존 classes 고정값으로 동작(폴백)합니다.
-- ============================================================
