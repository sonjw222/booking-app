-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- RES-001 (Track C-5): 예약 후 10분 이내 무료 취소 예외
--
-- ⚠️ 실행 순서: fix_reservation_cancel_source_column_draft_proposed.sql을 먼저 실행해야 한다
-- (이 함수가 새 컬럼 reservations.cancel_source를 참조함).
--
-- 새 정책:
--   - 일반 취소 마감조건과 무관하게, 예약 생성(reservations.created_at) 후 10분 이내라면
--     취소를 허용한다. 단, 취소 시점은 반드시 수업 시작 전이어야 한다.
--   - 기존 센터별 취소 마감이 이 10분 예외보다 더 유리(더 늦은 시각)하면 기존 마감을 그대로
--     적용한다 — 즉 "기존 마감 또는 10분 예외" 중 더 유리한(더 늦은) 쪽을 쓰되, 수업 시작
--     시각을 절대 넘지 않는다.
--   - 예) 20:00 수업을 19:30에 예약 → 19:40까지 취소 가능(10분 그대로).
--         20:00 수업을 19:55에 예약 → 10분이 아니라 20:00 직전까지만 가능(시작 시각으로 clamp).
--         20:00 이후에는 회원 셀프 취소가 무조건 불가(관리자 취소는 admin_cancel_reservation/
--         manager_set_attendance로 기존대로 가능 — 이 함수는 회원 셀프 취소 경로만 수정).
--   - 10분 예외로 취소되는 경우는 "정시 취소"로 취급해 정상 환급한다(deduct_on_late_cancel의
--     "마감 후 차감" 대상이 아님 — 그 설정은 이 유예기간보다도 더 늦게 취소했을 때만 적용됨).
--
-- 변경 범위: cancel_reservation() 함수 본문만 CREATE OR REPLACE. 대기자 승격 로직 등 나머지는
-- 전혀 바꾸지 않는다(아래 diff의 대부분은 그대로 복사).
--
-- 서버 시간 기준: now()는 Postgres 서버의 UTC 절대시각이고, KST 표시는 계산에 필요한 지점
-- (v_class.start_time)에서만 `at time zone`으로 변환한다 — 여기서는 순수 timestamptz 비교만
-- 하므로 시간대 변환 자체가 필요 없다(타임존 혼동 없음).
-- ============================================================

BEGIN;

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
            v_cancel_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'cancel');
            if v_cancel_deadline is null then
                v_cancel_deadline := v_class.start_time - make_interval(mins => v_class.cancel_deadline_min);
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
                -- TODO(2차): 승격된 회원에게 푸시 알림 발송
                exit;  -- 한 자리만 났으므로 한 명만 승격
            end if;
            -- 수강권을 못 쓰는 대기자는 건너뛰고 다음 순번 확인
        end loop;
    end if;

    return json_build_object('cancelled', true, 'waitlist_promoted', v_promoted);
end;
$$;

COMMIT;
