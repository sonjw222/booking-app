-- cancel_reservation()이 "마감 후 취소 + 차감옵션"으로 환급 없이 처리했는지를 화면에
-- 알려주기 위한 수정 (2026-09-06 UX 감사).
--
-- 배경: fix_class_cancel_deadline_override.sql에서 센터 설정(deduct_on_late_cancel)이
-- 켜져 있으면 마감 후 취소도 막지 않고 "횟수 차감"으로 넘어가도록 만들었다. 이때
-- v_skip_refund가 true면 실제로 환급을 건너뛰어(수강권 1회가 그대로 소진됨) 처리하지만,
-- RPC 반환값(json)에는 이 사실이 전혀 담기지 않아 회원 화면(app/reservation/page.tsx)은
-- 항상 "예약이 취소됐어요"로만 안내했다 — 회원은 나중에 잔여횟수가 줄어든 걸 보고서야
-- 이상함을 느끼게 됨. 반환값에 deducted 필드만 추가하고 로직은 전혀 바꾸지 않는다.
--
-- ⚠ 2026-09-06 수정: 최초 작성 시 fix_class_cancel_deadline_override.sql(8/27)을 베이스로
-- 삼는 바람에, 그 이후 fix_cancel_reservation_refunded_membership_ghost_count.sql(8/31)이
-- 추가한 "환불(refunded)/양도(transferred)된 수강권은 remaining_count를 되돌리지 않는다"
-- 보호 로직을 실수로 되돌릴 뻔했다 — CI 통합테스트(cancel-reservation-refunded-membership.test.ts)
-- 가 바로 이 회귀를 잡아냈다. 8/31 수정을 다시 포함해 작성한다.
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
        -- [유령 잔여횟수 방지, fix_cancel_reservation_refunded_membership_ghost_count.sql]
        -- 이미 환불(refunded)됐거나 양도(transferred)된 수강권은 더 이상 이 회원이
        -- 되돌려받을 대상이 아니므로 조용히 건너뛴다.
        if not v_skip_refund then
            update memberships set remaining_count = remaining_count + 1
            where id = v_res.membership_id
              and status not in ('refunded', 'transferred');
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

    return json_build_object('cancelled', true, 'waitlist_promoted', v_promoted, 'deducted', v_skip_refund);
end;
$$;
