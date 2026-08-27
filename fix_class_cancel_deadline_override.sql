-- ============================================================
-- 개별 수업 취소마감 재지정(classes.cancel_deadline_min) 실질 무효 버그 수정
--
-- 배경(TODO.md P2-16/booking_deadline_min과 동일 계열 버그):
--   classes.cancel_deadline_min은 NOT NULL DEFAULT 0이고, 매니저 화면(app/manager/classes/
--   page.tsx "예약취소 가능 시간" 일/시간/분 입력칸)에 이미 연결돼 있다. 그런데
--   cancel_reservation()은 calc_deadline(center_id, class_format, start_time, 'cancel')을
--   먼저 호출하고, 이 함수는 center_settings 행이 있으면(사실상 항상) 무조건 그 값(운영설정
--   "예약취소 가능 시간")을 반환한다 — classes.cancel_deadline_min은 center_settings 행 자체가
--   없는 극단적 예외 상황에서만 폴백으로 쓰였다. 즉 매니저가 이 칸에 값을 저장해도 실제 취소
--   로직에는 전혀 반영되지 않았다(reserve_class()가 이미 겪었던 것과 동일한 버그,
--   fix_class_booking_deadline_override_draft_proposed.sql 참고).
--
--   booking_deadline_min과 달리 이번엔 곧바로 고치지 않고 먼저 실사용 여부를 확인했다 —
--   cancel_deadline_min은 UI가 이미 있어 매니저가 실제로 0이 아닌 값을 저장했을 가능성이
--   있었기 때문. 2026-08-27 라이브 조회 결과: classes 1535행 중 단 3행만 0이 아니었고
--   (어텐션 피겨팀 센터의 실제 수업 3개: 60분/7200분/1분 전), 나머지 1532행은 전부 0 —
--   dhmToMinutes()(lib/deadlineInput.ts)가 "세 칸 모두 비어있으면 null(=운영설정 사용)"을
--   반환하도록 이미 설계돼 있었는데도, classes.cancel_deadline_min이 NOT NULL DEFAULT 0이라
--   그 null이 클라이언트(lib/classes.ts)에서 다시 0으로 강제 변환돼 저장되던 것이 원인.
--   즉 이 3건은 매니저가 실제로 값을 입력한 것이 거의 확실하고, 나머지는 한 번도 손대지
--   않은 값이다.
--
-- 이번 수정(booking_deadline_min 때와 완전히 동일한 패턴):
--   1) cancel_deadline_min을 nullable로 바꾸고(NOT NULL 제거), 기존 0 값(=한 번도 명시적으로
--      지정된 적 없음)을 NULL로 백필한다. 0이 아닌 3건은 그대로 보존된다.
--   2) cancel_reservation()의 취소마감 확인 로직 우선순위를 바꾼다: 개별 수업에
--      cancel_deadline_min이 명시적으로 지정돼(not null) 있으면 그 값을 최우선으로 쓰고,
--      없으면 기존처럼 calc_deadline()(운영설정) → 그래도 없으면 즉시 마감(0분, reserve_class의
--      동일 폴백과 일치)으로 폴백한다. 나머지 로직(10분 유예, 대기자 승격 등)은 전혀 바꾸지 않는다.
--   3) create_class_safe/create_recurring_classes_safe/update_class_safe도 booking_deadline_min과
--      동일하게 coalesce(..., 0)을 제거해 null을 있는 그대로 저장하도록 한다(안 그러면 이번
--      수정 이후에도 새로 등록/수정하는 수업마다 다시 0으로 저장돼 버그가 재발함).
--
-- 기존 데이터 영향: classes.cancel_deadline_min = 0인 1532행이 NULL로 바뀐다(=운영설정 기본값
-- 사용으로 자동 전환, 실제 계산 결과는 바뀌지 않음 — 지금까지 0은 어차피 무시되고 운영설정이
-- 쓰였으므로). 0이 아닌 3행(어텐션 피겨팀)은 그대로 유지되고, 이번 수정 이후 실제로 처음
-- 반영되기 시작한다(그동안 무시되던 값이 정상 동작하게 됨 — 매니저가 놀라지 않도록 안내 필요할 수 있음).
--
-- 예상 영향 행 수: classes 테이블 UPDATE 1건(1532행 대상).
-- RLS 영향: 없음(컬럼 nullable 변경 + 함수 CREATE OR REPLACE만, 정책 변경 없음).
--
-- 짝 파일: rollback_fix_class_cancel_deadline_override.sql
-- ============================================================

BEGIN;

-- [1] 스키마: nullable로 변경 + 기존 0 값을 "미지정"으로 백필
alter table classes
    alter column cancel_deadline_min drop not null,
    alter column cancel_deadline_min drop default;

update classes set cancel_deadline_min = null where cancel_deadline_min = 0;

comment on column classes.cancel_deadline_min is
    '개별 수업 취소마감 재지정(분, 수업 시작 기준). null이면 운영설정(center_settings) 기본값을 그대로 씀';

-- [2] cancel_reservation(): 개별 수업 지정값이 있으면 운영설정보다 우선 적용
--     (reserve_class()의 booking_deadline_min 우선순위 패턴과 동일)
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
        -- [RES-001 C-5] 수업이 이미 시작됐으면 회원 셀프 취소는 예외 없이 절대 불가.
        if now() >= v_class.start_time then
            raise exception '수업이 이미 시작되어 취소할 수 없어요';
        end if;

        declare
            v_cancel_deadline    timestamptz;
            v_deduct_late        boolean := false;
            v_is_late            boolean := false;
            v_grace_deadline     timestamptz;
            v_effective_deadline timestamptz;
        begin
            -- [CLASS-001 계열] 이 수업에 cancel_deadline_min이 명시적으로 지정돼 있으면
            -- (not null) 운영설정(calc_deadline)보다 그 값을 우선 적용한다. 지정이 없으면
            -- 기존과 동일하게 운영설정 → (그마저 없으면) 즉시 마감(0분)으로 폴백한다.
            if v_class.cancel_deadline_min is not null then
                v_cancel_deadline := v_class.start_time - make_interval(mins => v_class.cancel_deadline_min);
            else
                v_cancel_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'cancel');
                if v_cancel_deadline is null then
                    v_cancel_deadline := v_class.start_time;
                end if;
            end if;

            -- [RES-001 C-5] 예약 생성 후 10분 이내 무료 취소 예외(수업 시작 시각을 넘지 않음).
            -- 기존 마감이 이보다 더 유리(더 늦음)하면 기존 마감을 그대로 쓴다.
            v_grace_deadline := least(v_res.created_at + interval '10 minutes', v_class.start_time);
            v_effective_deadline := greatest(v_cancel_deadline, v_grace_deadline);

            v_is_late := now() > v_effective_deadline;

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
    -- [NOTIF-001 E-4] cancel_source='MEMBER'로 표시 — trg_notify_reservation_update가 취소
    -- 출처별로 알림 문구를 다르게 만드는 데 쓴다(add_holiday_safe의 'HOLIDAY'와 구분).
    update reservations set status = 'cancelled', cancel_source = 'MEMBER' where id = p_reservation_id;

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
                exit;  -- 한 자리만 났으므로 한 명만 승격
            end if;
            -- 수강권을 못 쓰는 대기자는 건너뛰고 다음 순번 확인
        end loop;
    end if;

    return json_build_object('cancelled', true, 'waitlist_promoted', v_promoted);
end;
$$;

-- [3] 수업 생성/수정 RPC: coalesce(..., 0) 제거 — null을 있는 그대로 저장(재발 방지)

create or replace function create_class_safe(
    p_center_id uuid, p_title text, p_description text,
    p_start_time timestamptz, p_end_time timestamptz, p_capacity int,
    p_allow_goods boolean, p_room_id uuid, p_cancel_deadline_min int,
    p_booking_deadline_min int, p_class_format text, p_pass_selection_mode text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
    v_key text;
begin
    v_key := 'schedule.own.' || (case when p_class_format = 'private' then 'private' else 'group' end) || '.create';
    if not (has_permission(p_center_id, v_key) or is_platform_admin()) then
        raise exception '이 센터에 수업을 등록할 권한이 없어요';
    end if;

    insert into classes (
        center_id, title, description, start_time, end_time, capacity,
        allow_goods, room_id, cancel_deadline_min, booking_deadline_min,
        class_format, pass_selection_mode
    ) values (
        p_center_id, p_title, p_description, p_start_time, p_end_time, p_capacity,
        coalesce(p_allow_goods, true), p_room_id, p_cancel_deadline_min, p_booking_deadline_min,
        coalesce(p_class_format, 'group'), coalesce(p_pass_selection_mode, 'all')
    ) returning id into v_id;

    return v_id;
end;
$$;

create or replace function create_recurring_classes_safe(p_center_id uuid, p_rows jsonb)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
    v_ids uuid[];
begin
    if not (has_permission(p_center_id, 'schedule.own.group.create') or is_platform_admin()) then
        raise exception '이 센터에 수업을 등록할 권한이 없어요';
    end if;

    with inserted as (
        insert into classes (
            center_id, title, start_time, end_time, capacity, room_id,
            cancel_deadline_min, booking_deadline_min, recurring_group_id,
            pass_selection_mode, allow_goods, status
        )
        select
            p_center_id,
            r->>'title',
            (r->>'start_time')::timestamptz,
            (r->>'end_time')::timestamptz,
            (r->>'capacity')::int,
            nullif(r->>'room_id', '')::uuid,
            nullif(r->>'cancel_deadline_min', '')::int,
            nullif(r->>'booking_deadline_min', '')::int,
            nullif(r->>'recurring_group_id', '')::uuid,
            coalesce(r->>'pass_selection_mode', 'all'),
            coalesce((r->>'allow_goods')::boolean, true),
            'open'
        from jsonb_array_elements(p_rows) as r
        returning id
    )
    select array_agg(id) into v_ids from inserted;

    return coalesce(v_ids, array[]::uuid[]);
end;
$$;

create or replace function update_class_safe(
    p_class_id uuid, p_title text, p_description text,
    p_start_time timestamptz, p_end_time timestamptz, p_capacity int,
    p_allow_goods boolean, p_room_id uuid, p_cancel_deadline_min int,
    p_booking_deadline_min int, p_class_format text, p_pass_selection_mode text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center_id uuid;
    v_format text;
    v_is_own boolean;
    v_key text;
begin
    select center_id, class_format into v_center_id, v_format from classes where id = p_class_id;
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
             or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.update';
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
        cancel_deadline_min = p_cancel_deadline_min,
        booking_deadline_min = p_booking_deadline_min,
        class_format = coalesce(p_class_format, 'group'),
        pass_selection_mode = coalesce(p_pass_selection_mode, 'all')
    where id = p_class_id;
end;
$$;

COMMIT;

-- 적용 후 확인 (read-only)
-- select count(*) filter (where cancel_deadline_min is null) as null_count,
--        count(*) filter (where cancel_deadline_min is not null) as explicit_count
-- from classes;
-- (기대값: null_count=1532, explicit_count=3)
