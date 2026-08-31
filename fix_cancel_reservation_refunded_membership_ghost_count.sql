-- ============================================================
-- cancel_reservation(): 환불/양도된 수강권에 취소 시 "유령 잔여횟수"가 되살아나는 버그 수정
--
-- [근본 원인, 실측 확인] cancel_reservation()이 status='confirmed'인 예약을 취소할 때
-- (환급 대상인 경우) 그 예약이 걸려 있던 memberships 행의 remaining_count를 조건 없이
-- +1 한다. 그런데 그 사이 그 수강권 자체가 환불(status='refunded', 이미 환불 처리 시
-- remaining_count가 0으로 맞춰짐) 또는 양도(status='transferred', 소유권이 다른 사람에게
-- 넘어감)됐을 수 있다 — 예: 회원이 수강권 전체를 환불받은 뒤, 환불 전에 잡혀 있던 예약을
-- (아직 취소 안 된 채로 남아있었다면) 나중에 취소하면 이미 정산 끝난 환불 수강권의
-- remaining_count가 다시 올라간다. 실제로 프로덕션에서 이런 식으로 remaining_count가
-- 다시 채워진 환불 수강권 사례가 발견됐다(오늘 branch security/p0-batch-consolidation
-- 조사 중 SQL 주석에 남은 특정 membership id로 확인).
--
-- [수정] memberships.remaining_count 를 되돌리는 UPDATE에 상태 조건을 추가한다 —
-- 'refunded'(환불 완료, 돈이 이미 돌아갔음)나 'transferred'(소유권이 이미 다른 사람에게
-- 넘어갔음)인 수강권은 더 이상 이 회원이 되돌려받을 대상이 아니므로 조용히 건너뛴다.
-- 'active'/'paused'/'expired'는 기존과 동일하게 그대로 환급한다 — 특히 'paused'는
-- 재개 후 정상적으로 쓸 수 있어야 하는 정당한 케이스라 범위에서 제외했고, 'expired'는
-- reserve_class() 등 다른 곳에서 어차피 유효기간을 다시 확인하므로 여기서 막지 않아도
-- 실질적 위험이 없다(이번 배치는 "돈이 이미 정산됐거나 남의 것이 된 수강권" 두 상태만
-- 좁혀서 막는다 — 범위를 넓히면 이번에 확인 안 된 케이스에서 부작용이 생길 수 있어
-- 조사된 사례에 맞춰 최소로 고침).
--
-- cancel_reservation() 나머지 로직(마감시간 계산, 10분 유예, 대기자 승격 등)은 오늘
-- fix_class_cancel_deadline_override.sql에서 이미 적용한 그대로 전혀 바꾸지 않는다 —
-- remaining_count UPDATE 문 한 줄에 WHERE 조건만 추가한다.
--
-- 기존 데이터 영향: 없음(함수 CREATE OR REPLACE만, 기존 행 값은 건드리지 않음 — 이미
-- 잘못 채워진 remaining_count가 있다면 이 마이그레이션은 그 값을 소급 정정하지 않는다.
-- 필요하면 별도로 확인 후 수동 보정해야 함).
-- RLS 영향: 없음.
--
-- 짝 파일: rollback_fix_cancel_reservation_refunded_membership_ghost_count.sql
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
        -- [유령 잔여횟수 방지] 이미 환불(refunded)됐거나 양도(transferred)된 수강권은
        -- 더 이상 이 회원이 되돌려받을 대상이 아니므로 조용히 건너뛴다.
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

    return json_build_object('cancelled', true, 'waitlist_promoted', v_promoted);
end;
$$;

COMMIT;

-- 적용 후 확인 (read-only)
-- select pg_get_functiondef('cancel_reservation(uuid)'::regprocedure);
