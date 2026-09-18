-- ============================================================
-- MWHABIT Business Logic Fix Batch — 정원 invariant 수정 CORRECTIVE PATCH
-- ============================================================
-- 실측으로 발견한 문제: 앞서 적용한 fix_class_capacity_invariants.sql이
-- update_class_safe()를 12개 파라미터 시그니처로 재정의했는데, 실제 라이브 DB의
-- 최신 버전은 13개 파라미터(p_allow_cancel 포함, add_class_cancel_lock.sql
-- 2026-09-13 — 이 파일이 진짜 최신본이었는데 앞선 조사에서 놓쳤다: 그 파일의 함수
-- 정의가 "create or replace function public.update_class_safe("처럼 스키마를
-- 명시하고 파라미터가 다음 줄에 있어서, 이전 조사의 grep 패턴이 못 찾았다).
-- Postgres는 파라미터 개수가 다르면 "같은 함수 교체"가 아니라 "새 오버로드 추가"로
-- 처리한다 — 그 결과 PGRST203("Could not choose the best candidate function")
-- 에러로 실제 호출이 전부 막혔다(실측 재현).
--
-- 이 파일은 (1) 잘못 만들어진 12-arg 오버로드를 제거하고, (2) add_class_cancel_lock.sql
-- 의 실제 최신 본문(allow_cancel/own-other 권한/past_update 판정 포함)을 그대로
-- 가져와 그 위에 정원 invariant 로직만 추가한다 — 다른 로직은 전혀 건드리지 않는다.
--
-- 이 SQL은 이 세션에서 Supabase에 직접 실행되지 않았다 — 사용자가 Supabase SQL
-- Editor에서 직접 적용해야 한다.
-- ============================================================

-- 잘못 생성된 12-arg 오버로드(이전 fix_class_capacity_invariants.sql이 실수로 새로
-- 만든 것) 제거.
drop function if exists public.update_class_safe(
    uuid, text, text, timestamp with time zone, timestamp with time zone,
    integer, boolean, uuid, integer, integer, text, text
);

-- 진짜 최신 13-arg 버전(add_class_cancel_lock.sql, returns void)도 명시적으로 지운다 —
-- 이번에 returns void → returns json으로 반환 타입을 바꾸는데, Postgres는 CREATE OR
-- REPLACE로 기존 함수의 반환 타입을 바꾸는 것을 거부한다("cannot change return type of
-- existing function", 실제로 이 오류로 재현 확인됨) — DROP 후 새로 만들어야 한다.
drop function if exists public.update_class_safe(
    uuid, text, text, timestamp with time zone, timestamp with time zone,
    integer, boolean, uuid, integer, integer, text, text, boolean
);

create or replace function public.update_class_safe(
    p_class_id uuid, p_title text, p_description text,
    p_start_time timestamp with time zone, p_end_time timestamp with time zone,
    p_capacity integer, p_allow_goods boolean, p_room_id uuid,
    p_cancel_deadline_min integer, p_booking_deadline_min integer,
    p_class_format text, p_pass_selection_mode text,
    p_allow_cancel boolean default true
)
 returns json
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
    v_old_capacity int;
    v_confirmed_count int;
    v_promoted_count int := 0;
    v_next record;
    v_next_mem record;
begin
    -- 정원 축소/확대 invariant를 안전하게 검사하려면 이 수업 행을 잠가서, 같은 순간의
    -- 다른 예약/취소/정원변경과 경쟁하지 않게 해야 한다(요청 5번 동시성 안전성).
    select center_id, class_format, start_time, capacity
      into v_center_id, v_format, v_orig_start, v_old_capacity
      from classes where id = p_class_id for update;
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    -- ⚠ 아래 own/other + past_update 권한 판정은 add_class_cancel_lock.sql(2026-09-13,
    -- 실제 최신본)에서 그대로 가져온 것 — 정원 invariant 추가와 무관하게 손대지 않는다.
    v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
             or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    v_verb := case when v_orig_start < now() then 'past_update' else 'update' end;
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
    if not (has_permission(v_center_id, v_key) or is_platform_admin()) then
        raise exception '이 수업을 수정할 권한이 없어요';
    end if;

    -- [FIX] 정원 축소 invariant(요청 2번) — 확정 인원보다 작게는 못 줄인다. 기존
    -- 예약을 자동 취소하지 않고, silent over-capacity 상태를 만들지 않도록 UPDATE
    -- 자체를 거부한다.
    if p_capacity is not null and p_capacity < v_old_capacity then
        select count(*) into v_confirmed_count
        from reservations where class_id = p_class_id and status = 'confirmed';
        if p_capacity < v_confirmed_count then
            raise exception '현재 확정 예약 인원(%명)보다 적게 정원을 줄일 수 없습니다.', v_confirmed_count;
        end if;
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

    -- [FIX] 정원 확대 시 대기자 자동 승격(요청 3번) — cancel_reservation()의 승격
    -- 루프와 동일한 규칙(순번 순, 수강권 유효성 확인, for update 잠금, 무효 후보는
    -- 건너뜀).
    if p_capacity is not null and p_capacity > v_old_capacity then
        select count(*) into v_confirmed_count
        from reservations where class_id = p_class_id and status = 'confirmed';

        for v_next in
            select * from reservations
            where class_id = p_class_id and status = 'waitlisted'
            order by waitlist_order asc
            for update
        loop
            exit when v_confirmed_count >= p_capacity;

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

                v_confirmed_count := v_confirmed_count + 1;
                v_promoted_count := v_promoted_count + 1;
            end if;
        end loop;
    end if;

    return json_build_object('promoted_count', v_promoted_count);
end;
$function$;

-- ============================================================
-- 확인(read-only)
-- ============================================================
-- select proname, pronargs, pg_get_functiondef(oid) like '%현재 확정 예약 인원%' as has_fix
-- from pg_proc where proname = 'update_class_safe';
-- (pronargs가 13인 행 딱 하나만 나와야 한다 — 12짜리 잘못된 오버로드가 사라졌는지 확인)
