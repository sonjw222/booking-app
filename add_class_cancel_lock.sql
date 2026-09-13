-- ============================================================
-- 수업별 "예약 취소 불가" 설정 (특강 등 노쇼 방지용)
--
-- 배경(사용자 요청, 2026-09-13): 특강처럼 한 번 예약하면 취소할 수 없게 만들고 싶은
-- 수업이 있음 — 정원이 제한된 일회성 특강에서 예약 취소가 자유로우면 마감 직전
-- 대량 취소로 자리가 비는데도 새로 못 받는 문제가 생김. 회원이 예약 전에
-- "이 수업은 예약 취소가 불가능해요"라는 안내를 보고 동의한 뒤 예약하게 한다.
--
-- 설계:
--   1) classes.allow_cancel(기본 true) — false면 이 수업의 예약은 회원이 스스로
--      취소할 수 없음. 기존 수업은 전부 true로 유지되어 동작 변화 없음.
--   2) cancel_reservation() — 회원 셀프취소 RPC에만 이 체크를 추가한다. 매니저가
--      쓰는 admin_cancel_reservation()/manager_set_attendance()는 건드리지 않음 —
--      폐강·노쇼 처리 등 운영 목적의 취소는 계속 허용해야 하므로(사용자 요청은
--      "회원이 취소 못 하게"이지 "센터가 관리 못 하게"가 아님).
--   3) create_class_safe()/update_class_safe() — p_allow_cancel 파라미터 추가
--      (기본 true, 기존 호출부는 그대로 동작). 이 두 함수의 본문은 live DB에서
--      pg_get_functiondef()로 직접 확인한 현재 버전을 그대로 가져와 이 파라미터
--      하나만 추가했다 — 최근 권한 세분화(own/other, past_create/update 등) 로직은
--      전혀 건드리지 않음.
--   4) cancel_reservation()도 마찬가지로 live 버전을 그대로 가져와 취소마감/당일예약/
--      대기승격 등 기존 로직(여러 차례 회귀 이력이 있었던 부분, fix_same_day_cancel_*,
--      fix_cancel_reservation_* 등)은 전혀 건드리지 않고, "수업이 이미 시작됐는지"
--      확인하는 지점 바로 다음에 allow_cancel 체크만 추가했다.
--
-- [영향받는 기존 데이터] 없음 — 컬럼 기본값 true로 기존 수업은 전부 지금처럼 취소 가능.
-- [위험도] 낮음 — 컬럼 추가 + 함수 재정의(본문 대부분 동일), 새 파라미터는 전부 기본값 있음.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table classes add column if not exists allow_cancel boolean not null default true;

comment on column classes.allow_cancel is 'false면 이 수업 예약은 회원이 스스로 취소할 수 없음(특강 등). 매니저의 관리자 취소/노쇼 처리에는 영향 없음.';

-- ⚠ 2026-09-13 이 파일을 처음 실행한 뒤 발견: create/update_class_safe에 trailing
-- 파라미터(p_allow_cancel)를 추가한 CREATE OR REPLACE는 "같은 함수를 교체"가 아니라
-- "인자 개수가 다른 새 오버로드를 추가"로 처리됐다(pg_proc에 pronargs=12 옛 버전과
-- pronargs=13 새 버전이 함께 남음 — 라이브 확인함). 새 13-arg 버전의 EXECUTE 권한은
-- anon/authenticated/service_role 모두 정상 부여되어 기능 자체는 문제없지만, allow_cancel을
-- 전혀 모르는 12-arg 옛 버전이 죽지 않고 남아있는 건 이 저장소가 이미 여러 번 겪은
-- "여러 SQL 파일에서 재정의됨, 최종 본문 확인 필요" 문제를 새로 하나 더 만드는 것이라
-- 아래에서 명시적으로 제거한다. 여러 번 실행해도 안전(이미 없으면 조용히 넘어감).
drop function if exists public.create_class_safe(
    uuid, text, text, timestamp with time zone, timestamp with time zone,
    integer, boolean, uuid, integer, integer, text, text
);
drop function if exists public.update_class_safe(
    uuid, text, text, timestamp with time zone, timestamp with time zone,
    integer, boolean, uuid, integer, integer, text, text
);

-- ------------------------------------------------------------
-- create_class_safe: p_allow_cancel 파라미터 추가
-- ------------------------------------------------------------
create or replace function public.create_class_safe(
    p_center_id uuid, p_title text, p_description text,
    p_start_time timestamp with time zone, p_end_time timestamp with time zone,
    p_capacity integer, p_allow_goods boolean, p_room_id uuid,
    p_cancel_deadline_min integer, p_booking_deadline_min integer,
    p_class_format text, p_pass_selection_mode text,
    p_allow_cancel boolean default true
)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_id uuid;
    v_key text;
    v_verb text;
begin
    v_verb := case when p_start_time < now() then 'past_create' else 'create' end;
    v_key := 'schedule.own.' || (case when p_class_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
    if not (has_permission(p_center_id, v_key) or is_platform_admin()) then
        raise exception '이 센터에 수업을 등록할 권한이 없어요';
    end if;

    insert into classes (
        center_id, title, description, start_time, end_time, capacity,
        allow_goods, room_id, cancel_deadline_min, booking_deadline_min,
        class_format, pass_selection_mode, allow_cancel
    ) values (
        p_center_id, p_title, p_description, p_start_time, p_end_time, p_capacity,
        coalesce(p_allow_goods, true), p_room_id, coalesce(p_cancel_deadline_min, 0), p_booking_deadline_min,
        coalesce(p_class_format, 'group'), coalesce(p_pass_selection_mode, 'all'), coalesce(p_allow_cancel, true)
    ) returning id into v_id;

    return v_id;
end;
$function$;

-- ------------------------------------------------------------
-- update_class_safe: p_allow_cancel 파라미터 추가
-- ------------------------------------------------------------
create or replace function public.update_class_safe(
    p_class_id uuid, p_title text, p_description text,
    p_start_time timestamp with time zone, p_end_time timestamp with time zone,
    p_capacity integer, p_allow_goods boolean, p_room_id uuid,
    p_cancel_deadline_min integer, p_booking_deadline_min integer,
    p_class_format text, p_pass_selection_mode text,
    p_allow_cancel boolean default true
)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_center_id uuid;
    v_format text;
    v_orig_start timestamptz;
    v_is_own boolean;
    v_key text;
    v_verb text;
begin
    select center_id, class_format, start_time into v_center_id, v_format, v_orig_start from classes where id = p_class_id;
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
             or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    v_verb := case when v_orig_start < now() then 'past_update' else 'update' end;
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
    if not (has_permission(v_center_id, v_key) or is_platform_admin()) then
        raise exception '이 수업을 수정할 권한이 없어요';
    end if;

    update classes set
        title = p_title,
        description = p_description,
        start_time = p_start_time,
        end_time = p_end_time,
        capacity = p_capacity,
        allow_goods = coalesce(p_allow_goods, true),
        room_id = p_room_id,
        cancel_deadline_min = coalesce(p_cancel_deadline_min, 0),
        booking_deadline_min = p_booking_deadline_min,
        class_format = coalesce(p_class_format, 'group'),
        pass_selection_mode = coalesce(p_pass_selection_mode, 'all'),
        allow_cancel = coalesce(p_allow_cancel, true)
    where id = p_class_id;
end;
$function$;

-- ------------------------------------------------------------
-- cancel_reservation: allow_cancel = false면 회원 셀프취소 거부
-- (live 버전 그대로 + "수업이 이미 시작됐는지" 확인 바로 다음에 체크 한 줄 추가)
-- ------------------------------------------------------------
create or replace function public.cancel_reservation(p_reservation_id uuid)
 returns json
 language plpgsql
 security definer
as $function$
declare
    v_res         record;
    v_class       record;
    v_next        record;
    v_next_mem    record;
    v_promoted    boolean := false;
    v_skip_refund boolean := false;
    v_can_promote boolean := true;
begin
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

    select * into v_class from classes where id = v_res.class_id;
    if found then
        if now() >= v_class.start_time then
            raise exception '수업이 이미 시작되어 취소할 수 없어요';
        end if;

        declare
            v_cancel_deadline    timestamptz;
            v_deduct_late        boolean := false;
            v_is_late            boolean := false;
            v_grace_deadline     timestamptz;
            v_same_day_deadline  timestamptz;
            v_effective_deadline timestamptz;
            v_settings           record;
        begin
            if v_class.cancel_deadline_min is not null then
                v_cancel_deadline := v_class.start_time - make_interval(mins => v_class.cancel_deadline_min);
            else
                v_cancel_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'cancel');
                if v_cancel_deadline is null then
                    v_cancel_deadline := v_class.start_time;
                end if;
            end if;

            v_grace_deadline := least(v_res.created_at + interval '10 minutes', v_class.start_time);

            -- 취소 완전 불가(allow_cancel=false) 수업이어도 예약 직후 10분 유예(오조작
            -- 방지 안전장치, v_grace_deadline)는 그대로 유지한다 — 그 유예시간을 지난
            -- 뒤에만 완전히 차단한다(사용자 요청, 2026-09-13: "10분 이내엔 취소 가능한
            -- 건 유지해줘"). 유예시간 안이면 아래 마감시간 로직과 무관하게 항상 취소 가능.
            if v_class.allow_cancel is false and now() > v_grace_deadline then
                raise exception '이 수업은 예약 취소가 불가능해요';
            end if;

            select * into v_settings from center_settings where center_id = v_class.center_id;

            -- [1] 당일예약 안전장치 — 예약이 수업과 같은 KST 날짜에 만들어졌고(원래 조건,
            -- 유지) *동시에* 정상 계산된 마감의 날짜(KST)가 오늘보다 이전인 경우(=
            -- days_before 계산이 진짜로 "어제 이전"을 만든 문제 상황)에만 "시작 -
            -- N시간M분"을 마감 후보로 추가한다.
            --
            -- ⚠ 2026-09-10 재발 방지: 처음 이 조건을 "마감 날짜 < 오늘"만으로 좁혔다가
            -- (fix_same_day_cancel_deadline_regression.sql 최초 버전), classes.cancel_
            -- deadline_min(개별 수업 취소마감 재지정, fix_class_cancel_deadline_override.sql)
            -- 처럼 당일예약과 무관하게 "의도적으로 과거로 계산된 마감"까지 이 안전장치를
            -- 잘못 발동시켜 정상 마감 판정을 덮어써버리는 회귀를 새로 만들었다(통합테스트
            -- class-cancel-deadline-override.test.ts가 검출). "같은 날 예약" 조건을 다시
            -- 추가해 두 조건을 모두 만족할 때만 발동하도록 좁힌다 — 오늘 날짜로 정상
            -- 계산된 마감(예: groupCancelDaysBefore=0 + 특정 시각)이나, 당일예약이 아닌
            -- 개별 마감 재지정은 그대로 손대지 않는다.
            if v_settings.center_id is not null
               and (v_res.created_at at time zone 'Asia/Seoul')::date = (v_class.start_time at time zone 'Asia/Seoul')::date
               and (v_cancel_deadline at time zone 'Asia/Seoul')::date < (now() at time zone 'Asia/Seoul')::date
            then
                v_same_day_deadline := v_class.start_time
                    - make_interval(hours => coalesce(v_settings.same_day_change_hours, 0),
                                     mins  => coalesce(v_settings.same_day_change_minutes, 0));
                v_effective_deadline := greatest(v_cancel_deadline, v_grace_deadline, v_same_day_deadline);
            else
                v_effective_deadline := greatest(v_cancel_deadline, v_grace_deadline);
            end if;

            v_is_late := now() > v_effective_deadline;

            v_deduct_late := coalesce(v_settings.deduct_on_late_cancel, false);

            if v_is_late and not v_deduct_late then
                raise exception '취소 마감시간이 지났어요';
            end if;
            v_skip_refund := v_is_late and v_deduct_late;

            -- [2] 대기 자동승격 마감 — 0/0(기본값)이면 조건 없이 항상 승격(기존 동작 유지).
            if coalesce(v_settings.waitlist_auto_hours, 0) = 0 and coalesce(v_settings.waitlist_auto_minutes, 0) = 0 then
                v_can_promote := true;
            else
                v_can_promote := now() < v_class.start_time
                    - make_interval(hours => v_settings.waitlist_auto_hours, mins => v_settings.waitlist_auto_minutes);
            end if;
        end;
    end if;

    update reservations set status = 'cancelled', cancel_source = 'MEMBER' where id = p_reservation_id;

    if v_res.status = 'confirmed' then
        -- [유령 잔여횟수 방지] 환불/양도된 수강권은 되돌려받을 대상이 아니므로 건너뜀
        if not v_skip_refund then
            update memberships set remaining_count = remaining_count + 1
            where id = v_res.membership_id
              and status not in ('refunded', 'transferred');
        end if;

        if v_can_promote then
            for v_next in
                select * from reservations
                where class_id = v_res.class_id and status = 'waitlisted'
                order by waitlist_order asc
                for update
            loop
                select * into v_next_mem from memberships
                where id = v_next.membership_id
                  and remaining_count > 0
                  and expires_at >= current_date
                for update;

                if found then
                    update reservations
                    set status = 'confirmed', waitlist_order = null
                    where id = v_next.id;

                    update memberships set remaining_count = remaining_count - 1
                    where id = v_next_mem.id;

                    v_promoted := true;
                    exit;
                end if;
            end loop;
        end if;
    end if;

    return json_build_object('cancelled', true, 'waitlist_promoted', v_promoted, 'deducted', v_skip_refund);
end;
$function$;

-- ------------------------------------------------------------
-- 확인(읽기 전용) — proname당 정확히 한 줄(pronargs=13)만 나와야 정상.
-- 두 줄(12와 13이 함께) 나오면 위 drop function이 실행되지 않은 것.
-- ------------------------------------------------------------
select column_name, column_default from information_schema.columns where table_name = 'classes' and column_name = 'allow_cancel';
select proname, pronargs from pg_proc where proname in ('create_class_safe', 'update_class_safe', 'cancel_reservation') order by proname;
