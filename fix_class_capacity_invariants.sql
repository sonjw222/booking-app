-- ============================================================
-- MWHABIT Business Logic Fix Batch(2026-09-18) — 정원 변경 invariant 수정
-- ============================================================
-- 발견 경위: Automated Business Scenario E2E Phase 3(SCN-P1-31/32-BUGFOUND)가 실제
-- 라이브 dev DB에 대해 재현·고정한 버그.
--
-- Root cause(실제 코드 감사 결과):
--   update_class_safe()는 권한 체크 후 classes.capacity를 그냥 덮어쓸 뿐, 확정
--   예약자 수와 비교하거나 대기자를 승격시키는 로직이 전혀 없었다
--   (fix_class_cancel_deadline_override.sql 실제 본문 확인).
--
-- 수정 1 — 정원 축소 invariant(요청 2번):
--   새 capacity가 현재 확정(confirmed) 예약자 수보다 작으면 UPDATE 자체를 거부한다
--   ("현재 확정 예약 인원(N명)보다 적게 정원을 줄일 수 없습니다."). 기존 예약을
--   자동 취소하지 않는다(요청 조건 그대로) — silent over-capacity를 만들지 않는
--   대신, 그 정원으로 줄이고 싶으면 관리자가 먼저 예약을 직접 정리(취소)하게 한다.
--   classes 행을 `for update`로 잠가서 이 체크와 실제 UPDATE 사이에 동시에 들어오는
--   예약/취소와 경쟁하지 않게 한다(요청 5번 "동시 capacity update / cancel race
--   안전성").
--
-- 수정 2 — 정원 확대 시 대기자 자동 승격(요청 3번):
--   새 capacity가 기존보다 크면, 늘어난 자리만큼 대기자를 waitlist_order 순서대로
--   순회하며 승격시킨다. 각 후보는 cancel_reservation()의 승격 루프와 완전히 동일한
--   조건(수강권 remaining_count>0 and expires_at>=current_date, `for update`로
--   후보 잠금)으로 검증하고, 유효하지 않으면 건너뛰고 다음 순번을 본다(중복 승격/
--   순서 역전 없음). 수강권은 승격 시에만 정확히 1회 차감한다. 반환값에
--   promoted_count를 담아 몇 명이 승격됐는지 호출자가 알 수 있게 한다(선택적 UI
--   피드백용, 기존 호출부는 반환값을 쓰지 않아도 하위호환됨).
--
--   ⚠ 알림 큐잉 정책 변경 없음(요청 검증 항목): 승격된 예약의 status를 'confirmed'로
--   바꾸는 UPDATE는 reservations 테이블의 기존 트리거(trg_notify_reservation_update,
--   add_admin_assignment.sql)를 그대로 통과하므로 waitlist_promoted 알림이 cancel_
--   reservation()에서와 동일하게 자동 생성된다 — 이 함수에서 별도로 알림 로직을
--   추가하지 않았다(트리거가 이미 담당).
--
-- 반환 타입 변경: void → json({ promoted_count: int }). 기존 유일한 프로덕션
-- 호출부(lib/classes.ts의 updateClass())는 지금까지 data를 쓰지 않고 error만
-- 확인했으므로 하위호환된다(lib/classes.ts도 이번 배치에서 promoted_count를
-- 선택적으로 노출하도록 같이 갱신함).
--
-- 범위 밖(알려진 한계, 최종 보고서에 명시): update_class_group_safe()(반복수업 그룹
-- 일괄 수정)는 이번 수정 대상이 아니다 — 별도 RPC라 동일한 정원 invariant 문제가
-- 있을 수 있으나, 이번 요청은 update_class_safe()로 범위가 명시돼 있어 손대지
-- 않았다.
--
-- 이 SQL은 Claude Code 세션에서 직접 실행되지 않았다 — 실행 여부는 반드시 사용자가
-- Supabase SQL Editor에서 직접 확인 후 실행해야 한다.
-- ============================================================

create or replace function update_class_safe(
    p_class_id uuid, p_title text, p_description text,
    p_start_time timestamptz, p_end_time timestamptz, p_capacity int,
    p_allow_goods boolean, p_room_id uuid, p_cancel_deadline_min int,
    p_booking_deadline_min int, p_class_format text, p_pass_selection_mode text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center_id uuid;
    v_format text;
    v_is_own boolean;
    v_key text;
    v_old_capacity int;
    v_confirmed_count int;
    v_promoted_count int := 0;
    v_next record;
    v_next_mem record;
begin
    -- 정원 축소/확대 invariant를 안전하게 검사하려면 이 수업 행을 잠가서, 같은
    -- 순간의 다른 예약/취소/정원변경과 경쟁하지 않게 해야 한다(요청 5번).
    select center_id, class_format, capacity into v_center_id, v_format, v_old_capacity
    from classes where id = p_class_id for update;
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

    select count(*) into v_confirmed_count
    from reservations where class_id = p_class_id and status = 'confirmed';

    -- 정원 축소 invariant(요청 2번) — 확정 인원보다 작게는 못 줄인다. 기존 예약을
    -- 자동 취소하지 않고, silent over-capacity 상태를 만들지 않도록 UPDATE 자체를
    -- 거부한다. server validation이 최종 권한이며, 매니저 UI(app/manager/classes/
    -- page.tsx)는 같은 조건을 미리 확인해 더 친절한 안내만 보여줄 뿐이다.
    if p_capacity is not null and p_capacity < v_confirmed_count then
        raise exception '현재 확정 예약 인원(%명)보다 적게 정원을 줄일 수 없습니다.', v_confirmed_count;
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

    -- 정원 확대 시 대기자 자동 승격(요청 3번) — cancel_reservation()의 승격 루프와
    -- 동일한 규칙(순번 순, 수강권 유효성 확인, for update 잠금, 무효 후보는 건너뜀).
    -- capacity가 null이거나 줄었거나 그대로면 이 블록은 자연히 아무 일도 하지 않는다.
    if p_capacity is not null and p_capacity > v_old_capacity then
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
$$;

-- ============================================================
-- 적용 후 확인(read-only)
-- ============================================================
-- select proname, pg_get_functiondef(oid) like '%현재 확정 예약 인원%' as has_fix
-- from pg_proc where proname = 'update_class_safe';
