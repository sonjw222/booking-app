-- ============================================================
-- refund_membership() 환불 후 예약 잔존 문제 수정(P1, 데이터 무결성 — 보안 아님)
--
-- [근본 원인] membership 구매 → 그 membership으로 미래 confirmed/waitlisted 예약 생성 →
-- refund_membership()으로 self refund(status='refunded', remaining_count=0) → 그 예약은
-- 전혀 정리되지 않고 그대로 남는다 → 나중에 그 예약을 cancel_reservation()으로 취소하면
-- `update memberships set remaining_count = remaining_count + 1`이 membership 상태
-- (refunded인지)를 전혀 확인하지 않고 무조건 실행돼, 이미 환불되어 remaining_count=0이어야
-- 할 membership에 유령 잔여횟수가 생긴다.
--
-- [실측 확인, 2026-08-14] 사용자가 read-only 진단(diagnose_refund_membership_reservation_
-- orphan_readonly.sql)을 실행한 결과, Live에 이미 이 상태(membership c582ef56...는
-- status=refunded/remaining_count=0/total_count=3인데 미래 confirmed 예약 3건이 그대로
-- 남아있음)가 실재함을 확인함 — 설계 단계의 가설이 아니라 이미 발생한 문제.
--
-- [채택안] D(A+C, docs/TODO.md에서 결정) — A: 환불 자체를 막아 애초에 이 상태 진입을
-- 방지. C: 혹시 다른 경로로 이미 이 상태에 진입해도(위 실측 사례처럼) cancel_reservation()이
-- 유령 카운트를 만들지 않도록 안전망.
--
-- [함수 본문 출처] refund_membership()/cancel_reservation() 둘 다 이 저장소에 여러
-- 파일에 흩어져 재정의돼 있어(각각 2곳/4곳), 2026-08-14에 사용자가
-- pg_get_functiondef로 실제 Live 본문을 직접 조회해 확인함 — cancel_reservation()은
-- reservation_functions.sql 버전과 달리 RES-001(수업 시작 후 취소 불가, 10분 유예)/
-- NOTIF-001(cancel_source='MEMBER') 로직이 이미 추가돼 있었다. 아래는 그 실측 본문에
-- 각각 필요한 줄만 추가한 것이다(다른 로직 변경 없음, 문자 그대로 대조 확인).
--
-- [이 파일이 하는 일]
-- 1) refund_membership()에 "미래 확정/대기 예약이 있으면 환불 거부" 체크 추가(A).
-- 2) cancel_reservation()의 remaining_count 복구 UPDATE에 "그 membership이 refunded가
--    아닐 때만" 조건 추가(C) — 이미 존재하는 위 실측 사례 같은 orphan 데이터에 대해서도
--    앞으로 그 예약이 취소될 때 유령 카운트가 생기는 것을 막는 안전망.
--
-- [영향받는 기존 데이터] 없음(함수 재정의만) — 단, 위 실측으로 발견된 기존 orphan
-- 데이터(membership c582ef56...) 자체는 이 파일이 정리하지 않는다(별도 cleanup 필요
-- 여부는 사용자 판단 — 그 3건의 confirmed 예약을 그대로 둘지, 수동으로 취소 처리할지는
-- 회원/매출 이력에 영향을 주는 결정이라 자동으로 처리하지 않음).
-- [위험도] 낮음 — 정상 환불(예약 없는 상태)에는 전혀 영향 없음. 예약이 남은 상태에서
-- 환불을 시도하면 이제 명확한 안내와 함께 거부된다(의도된 동작 변경).
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

create or replace function refund_membership(p_membership_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_mem     record;
    v_unlimited boolean := false;
    v_hours   numeric;
    v_amount  int := 0;
    v_still_active int := 0;
begin
    -- 본인 소유 수강권인지 확인 + 잠금
    select * into v_mem from memberships
    where id = p_membership_id
      and profile_id in (select id from profiles where account_id = my_account_id())
    for update;

    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;
    if v_mem.status = 'refunded' then
        raise exception '이미 환불된 수강권이에요';
    end if;

    -- 무제한 여부
    select coalesce(p.unlimited, false) into v_unlimited
    from products p where p.id = v_mem.product_id;
    v_unlimited := coalesce(v_unlimited, false);

    -- 24시간 이내인지
    v_hours := extract(epoch from (now() - v_mem.created_at)) / 3600;
    if v_hours > 24 then
        raise exception '결제 후 24시간이 지나 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;

    -- 미사용인지 (횟수권만 확인)
    if not v_unlimited and v_mem.total_count is not null
       and v_mem.remaining_count is distinct from v_mem.total_count then
        raise exception '이미 사용한 수강권은 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;

    -- [신규] 이 수강권으로 예약된 미래 확정/대기 예약이 있으면 환불을 막는다 —
    -- 먼저 예약을 취소한 뒤 환불하도록 유도(안 그러면 예약이 정리되지 않고 그대로
    -- 남아 나중에 취소할 때 remaining_count가 잘못 복구되는 문제가 생김).
    if exists (
        select 1 from reservations r
        join classes c on c.id = r.class_id
        where r.membership_id = v_mem.id
          and r.status in ('confirmed', 'waitlisted')
          and c.start_time > now()
    ) then
        raise exception '이 수강권으로 예약된 수업이 있어요. 먼저 예약을 취소한 뒤 환불해주세요.';
    end if;

    -- 결제 금액 찾기 (매출 환불 기록용)
    select coalesce(total_amount, 0) into v_amount
    from payments where membership_id = v_mem.id
    order by paid_at desc limit 1;
    v_amount := coalesce(v_amount, 0);

    -- 1) 수강권 환불 처리
    update memberships
       set status = 'refunded', remaining_count = 0
     where id = v_mem.id;

    -- 2) 매출에 환불(음수) 기록 → 매출관리 자동 반영
    if v_amount > 0 then
        insert into payments (
            center_id, profile_id, membership_id,
            sale_type, revenue_category,
            card_amount, cash_amount, transfer_amount, point_amount,
            total_amount, unpaid_amount, paid_at, status, memo
        ) values (
            v_mem.center_id, v_mem.profile_id, v_mem.id,
            'refund', 'membership',
            0, 0, 0, 0,
            -v_amount, 0, now(), 'paid',
            '앱 셀프 환불'
        );
    end if;

    -- 3) 남은 사용가능 수강권이 없으면 만료회원으로
    select count(*) into v_still_active
    from memberships m
    where m.profile_id = v_mem.profile_id
      and m.center_id = v_mem.center_id
      and m.status = 'active'
      and (m.remaining_count is null or m.remaining_count > 0)
      and (m.expires_at is null or m.expires_at >= current_date);

    if v_still_active = 0 then
        update center_members
           set status = 'expired'
         where profile_id = v_mem.profile_id
           and center_id = v_mem.center_id
           and status <> 'dormant';
    end if;

    return json_build_object('refunded', true, 'amount', v_amount);
end;
$$;

create or replace function cancel_reservation(p_reservation_id uuid)
returns json
language plpgsql
security definer
set search_path = public
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
        -- [신규] status <> 'refunded' 추가 — refund_membership()의 새 체크(위)로 정상
        -- 흐름에서는 더 이상 발생할 수 없지만, 이미 존재하는 orphan 데이터나 놓친 경로가
        -- 있어도 이미 환불된 membership의 remaining_count를 유령으로 복구하지 않는 안전망.
        if not v_skip_refund then
            update memberships set remaining_count = remaining_count + 1
            where id = v_res.membership_id and status <> 'refunded';
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

-- ============================================================
-- 적용 후 확인(읽기 전용)
-- ============================================================
select routine_name, security_type
from information_schema.routines
where routine_name in ('refund_membership', 'cancel_reservation');

-- 기존 orphan 사례(diagnose 파일과 동일 쿼리) — 이 파일 적용 후에도 기존 데이터는
-- 그대로 남아있는 게 정상(이 파일은 새 진입만 막고 새 안전망만 추가, 기존 데이터
-- 정리는 하지 않음). 아래 결과가 이전과 동일하게 나오는지만 확인.
select m.id as membership_id, m.status as membership_status, m.remaining_count, m.total_count,
       r.id as reservation_id, r.status as reservation_status, c.start_time
from memberships m
join reservations r on r.membership_id = m.id
join classes c on c.id = r.class_id
where m.status = 'refunded'
  and r.status in ('confirmed', 'waitlisted');
