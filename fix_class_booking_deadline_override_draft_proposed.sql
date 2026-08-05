-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- CLASS-001 (Track D-1): 개별 수업 예약마감 지정 기능
--
-- 조사 결과 요약(중요 — 실행 전 반드시 읽을 것):
--   classes.booking_deadline_min 컬럼은 이미 존재했지만(schema.sql), 지금까지 어떤 관리자
--   UI에서도 이 컬럼에 값을 쓴 적이 없다 — lib/classes.ts의 모든 insert/update가 이 컬럼을
--   아예 지정하지 않아 DB DEFAULT(0)만 계속 저장돼 왔다. 반면 calc_deadline()은
--   center_settings가 존재하면(사실상 모든 센터) 무조건 그 값을 쓰고, classes.booking_deadline_min은
--   center_settings 행 자체가 없는 극단적 예외 상황에서만 폴백으로 쓰였다 — 즉 지금까지
--   이 컬럼은 사실상 죽은 컬럼이었다(형제 컬럼 cancel_deadline_min은 UI에는 연결돼 있지만
--   동일한 이유로 실질적 효과가 없는 것으로 보이며, 이 별도 버그는 docs/TODO.md에 새로
--   기록하고 이번 배치에서는 고치지 않는다 — 아래 "범위에서 제외한 이유" 참고).
--
-- 이번 수정:
--   1) booking_deadline_min을 nullable로 바꾸고(NOT NULL 제거), 기존에 default 0으로만
--      채워져 있던 값(=한 번도 명시적으로 지정된 적 없음)을 NULL로 백필한다 — "지정 안 함"과
--      "명시적으로 0분(수업 시작 직전까지) 지정"을 구분할 수 있게 하기 위함이다. 이 컬럼은
--      지금까지 어떤 코드도 0이 아닌 값을 쓴 적이 없으므로(위 조사 결과), 전부 0인 기존 값을
--      전부 "지정 안 함"으로 간주해도 데이터 손실이 없다(신규 발견: 이 판단의 근거는 UI
--      부재 확인 — booking_deadline_min에 대한 쓰기 코드가 없었다는 grep 결과).
--   2) reserve_class()의 예약마감 확인 로직 우선순위를 바꾼다: 개별 수업에
--      booking_deadline_min이 명시적으로 지정돼(not null) 있으면 그 값을 최우선으로 쓰고,
--      없으면 기존처럼 calc_deadline()(운영설정) → 그래도 없으면 즉시 마감(0분)으로 폴백한다.
--      reserve_class() 나머지 로직(당일예약/일일한도/대기한도/오픈시각 등, P1-12에서 배선한
--      부분 포함)은 전혀 바꾸지 않는다.
--
-- 범위에서 제외한 이유(cancel_deadline_min의 동일 버그를 이번에 함께 고치지 않는 이유):
--   cancel_deadline_min은 booking_deadline_min과 달리 이미 UI에 연결돼 있어(app/manager/classes/page.tsx의
--   기존 "예약취소 가능 시간" 입력칸), 관리자가 실제로 "0분"을 의도적으로 저장했을 가능성이
--   이론적으로 있다(당장은 그 값도 저장 즉시 폴백되어 무의미했지만, 사용자가 실제로 0을
--   선택해 저장한 적이 있는지는 이 조사만으로 단정할 수 없음). booking_deadline_min은 UI
--   자체가 없었으므로 전부 미사용 확정이지만, cancel_deadline_min은 데이터 마이그레이션
--   전에 더 신중한 검토가 필요해 별도 사안으로 분리하고 docs/TODO.md에 기록했다.
--
-- 기존 클래스 데이터 영향: 전부 booking_deadline_min이 NULL이 되어 "운영설정 기본값 사용"으로
-- 자동 전환된다(요구사항 "기존 수업 데이터는 자동으로 기본값 사용"과 일치) — 실제 계산 결과는
-- 바뀌지 않는다(어차피 지금까지 0은 한 번도 실제로 쓰인 적이 없었으므로).
--
-- 예상 영향 행 수: classes 테이블 전체 행(현재 booking_deadline_min = 0인 모든 행) — UPDATE 1건.
-- 인덱스: 불필요(WHERE 절 없는 단순 컬럼 스캔, 일회성 마이그레이션).
-- RLS 영향: 없음(컬럼 nullable 변경 + 함수 CREATE OR REPLACE만, 정책 변경 없음).
-- ============================================================

BEGIN;

-- [1] 스키마: nullable로 변경 + 기존 0 값을 "미지정"으로 백필
alter table classes
    alter column booking_deadline_min drop not null,
    alter column booking_deadline_min drop default;

update classes set booking_deadline_min = null where booking_deadline_min = 0;

comment on column classes.booking_deadline_min is
    '개별 수업 예약마감 재지정(분, 수업 시작 기준). null이면 운영설정(center_settings) 기본값을 그대로 씀 — CLASS-001';

-- [2] reserve_class(): 개별 수업 지정값이 있으면 운영설정보다 우선 적용
create or replace function reserve_class(p_class_id uuid, p_profile_id uuid default null)
returns json
language plpgsql
security definer
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
    if p_profile_id is not null then
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

    select * into v_class from classes where id = p_class_id for update;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_local_date := (v_class.start_time at time zone 'Asia/Seoul')::date;
    v_local_time := (v_class.start_time at time zone 'Asia/Seoul')::time;
    v_day_of_week := extract(dow from (v_class.start_time at time zone 'Asia/Seoul'))::int;

    if v_class.status = 'cancelled' then
        raise exception '폐강된 수업이에요';
    end if;
    if v_class.status = 'closed' then
        raise exception '예약이 마감된 수업이에요';
    end if;

    if not exists (
        select 1 from centers where id = v_class.center_id and status = 'approved'
    ) then
        raise exception '아직 승인되지 않은 센터예요';
    end if;

    -- 예약 마감시간 확인
    --   [CLASS-001] 이 수업에 booking_deadline_min이 명시적으로 지정돼 있으면(not null)
    --   운영설정(calc_deadline)보다 그 값을 우선 적용한다. 지정이 없으면 기존과 동일하게
    --   운영설정 → (그마저 없으면) 즉시 마감(0분)으로 폴백한다.
    declare
        v_book_deadline timestamptz;
    begin
        if v_class.booking_deadline_min is not null then
            v_book_deadline := v_class.start_time - make_interval(mins => v_class.booking_deadline_min);
        else
            v_book_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'book');
            if v_book_deadline is null then
                v_book_deadline := v_class.start_time;
            end if;
        end if;
        if now() > v_book_deadline then
            raise exception '예약 마감시간이 지났어요';
        end if;
    end;

    -- [P1-12] 예약 오픈 시각 확인 — 설정이 없거나(폴백 null) 계산이 안 되면 기존처럼 제한 없음
    declare
        v_open_deadline timestamptz;
    begin
        v_open_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'open');
        if v_open_deadline is not null and now() < v_open_deadline then
            raise exception '아직 예약이 열리지 않았어요';
        end if;
    end;

    -- [P1-12] 당일 예약 허용 여부 — 오늘(KST) 수업인데 설정이 꺼져 있으면 차단
    if v_local_date = (now() at time zone 'Asia/Seoul')::date then
        declare
            v_allow_same_day boolean;
        begin
            select allow_same_day_booking into v_allow_same_day
            from center_settings where center_id = v_class.center_id;
            if coalesce(v_allow_same_day, true) = false then
                raise exception '당일 예약은 허용되지 않아요';
            end if;
        end;
    end if;

    -- [P1-12] 일일 예약 가능 횟수 제한 — 이 센터, 이 날짜(KST) 기준 확정+대기 합산
    declare
        v_daily_enabled boolean;
        v_daily_limit   int;
        v_daily_count   int;
    begin
        select daily_book_limit_enabled, daily_book_limit
          into v_daily_enabled, v_daily_limit
        from center_settings where center_id = v_class.center_id;

        if coalesce(v_daily_enabled, false) and v_daily_limit is not null then
            select count(*) into v_daily_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = v_profile_id
              and c.center_id = v_class.center_id
              and (c.start_time at time zone 'Asia/Seoul')::date = v_local_date
              and r.status in ('confirmed', 'waitlisted');

            if v_daily_count >= v_daily_limit then
                raise exception '하루 예약 가능 횟수(%회)를 초과했어요', v_daily_limit;
            end if;
        end if;
    end;

    if exists (
        select 1 from center_holidays
        where center_id = v_class.center_id
          and holiday_date = v_local_date
    ) then
        raise exception '센터 휴무일이라 예약할 수 없어요';
    end if;

    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = v_profile_id
          and status in ('confirmed', 'waitlisted')
    ) then
        raise exception '이미 예약(또는 대기)한 수업이에요';
    end if;

    select m.* into v_membership
    from memberships m
    where m.profile_id = v_profile_id
      and m.center_id = v_class.center_id
      and m.remaining_count > 0
      and m.expires_at >= current_date
      and (
            not exists (select 1 from class_allowed_products cap where cap.class_id = v_class.id)
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = v_class.id)
      )
      and (
            m.product_id is null
            or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
            or exists (
                select 1 from membership_schedule_rules r
                where r.product_id = m.product_id
                  and (r.day_of_week is null or r.day_of_week = v_day_of_week)
                  and (r.start_time is null or r.start_time = v_local_time)
                  and (r.class_title is null or v_class.title like '%' || r.class_title || '%')
            )
      )
    order by m.expires_at asc
    limit 1
    for update;

    if not found then
        raise exception '이 수업에 사용할 수 있는 수강권이 없어요 (잔여횟수/기간/예약조건을 확인해주세요)';
    end if;

    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status = 'confirmed';

    if v_confirmed < v_class.capacity then
        v_status := 'confirmed';
        update memberships set remaining_count = remaining_count - 1
        where id = v_membership.id;

        insert into reservations (class_id, profile_id, membership_id, status)
        values (p_class_id, v_profile_id, v_membership.id, 'confirmed')
        returning id into v_reservation_id;
    else
        -- [P1-12] 대기예약 진입 전: 이 센터가 대기 기능을 쓰는지(주간 한도>0), 이번 주
        -- 한도를 넘지 않았는지 확인. 기존 "대기 등록" 로직 자체(차감 없이 순번만 부여)는 그대로.
        declare
            v_weekly_limit int;
            v_week_start   date;
            v_week_count   int;
        begin
            select waitlist_weekly_limit into v_weekly_limit
            from center_settings where center_id = v_class.center_id;

            if coalesce(v_weekly_limit, 0) = 0 then
                raise exception '이 수업은 정원이 찼고, 이 센터는 대기예약을 사용하지 않아요';
            end if;

            v_week_start := date_trunc('week', v_local_date)::date;
            select count(*) into v_week_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = v_profile_id
              and c.center_id = v_class.center_id
              and r.status = 'waitlisted'
              and (c.start_time at time zone 'Asia/Seoul')::date >= v_week_start
              and (c.start_time at time zone 'Asia/Seoul')::date < v_week_start + 7;

            if v_week_count >= v_weekly_limit then
                raise exception '이번 주 대기예약 가능 횟수(%회)를 초과했어요', v_weekly_limit;
            end if;
        end;

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

COMMIT;
