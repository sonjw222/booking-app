-- ============================================================
-- 일반 환불 PG 우회 차단을 "허용 목록" 방식으로 강화(2026-10-16) — NICEPAY 도입 전 선행 필수 (검토용 초안, 미실행)
--
-- 문제: _refund_membership_core의 "앱 일반 환불 차단" 조건이 payment_provider in ('toss','portone')만 포함한다.
--   orders.payment_provider에 'nicepay'(또는 이후 어떤 PG 값)가 생기면 이 조건을 통과해 회원이 refund_membership RPC로
--   PG 결제 건을 외부 취소 없이 DB에서만 환불(돈은 그대로 카드사에 남음)할 수 있다.
-- 수정: 차단 대상을 "payment_provider가 NULL(직접결제/매니저 수동)도 아니고 'mock'도 아닌 모든 값"으로 바꾼다(미래 provider 자동 차단).
--   · NULL(직접결제) / 'mock'(QA) 환불 동작: 변경 없음   · toss/portone: 기존과 동일하게 차단(서버 라우트 p_allow_pg=true 경로만 통과)
-- 변경 범위: 아래 함수의 위 한 줄(exists 조건)만. 나머지(환불 정책/쿠폰·포인트 복원/KST 날짜/PG lock 해제)는
--   Production 라이브 정의(= fix_pg_order_refund_kst_dates_20261004.sql의 _refund_membership_core)를 그대로 복사했다.
-- 보안 계약 보존: 시그니처/SECURITY DEFINER/search_path 불변. 권한은 아래에서 기존과 동일하게 재확인(owner 외 실행 불가).
-- 순서: 이 파일 → add_nicepay_provider_support_20261016.sql. (이 파일은 단독 적용이 안전하며 nicepay 값이 생기기 전에 먼저 적용해야 한다.)
-- 롤백: rollback_fix_refund_block_all_pg_providers_20261016.sql. 검증: verify_fix_refund_block_all_pg_providers_20261016.sql(읽기 전용).
-- 이 세션에서는 DEV/Production에 실행하지 않았습니다.
-- ============================================================
begin;

CREATE OR REPLACE FUNCTION public._refund_membership_core(p_membership_id uuid, p_account_id uuid, p_allow_pg boolean, p_skip_time_check boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_mem          memberships;
    v_reason       text;
    v_amount       int := 0;
    v_still_active int := 0;
    v_order_id     uuid;
begin
    select * into v_mem from memberships
    where id = p_membership_id
      and profile_id in (select id from profiles where account_id = p_account_id)
    for update;

    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;
    if v_mem.status = 'refunded' then
        raise exception '이미 환불된 수강권이에요';
    end if;

    v_reason := _refund_block_reason(v_mem, coalesce(p_skip_time_check, false));
    if v_reason is not null then
        raise exception '%', v_reason;
    end if;

    select coalesce(total_amount, 0), order_id into v_amount, v_order_id
    from payments where membership_id = v_mem.id
    order by paid_at desc limit 1;
    v_amount := coalesce(v_amount, 0);

    if not coalesce(p_allow_pg, false) and v_order_id is not null and exists (
        select 1 from orders o where o.id = v_order_id and o.payment_provider is not null and o.payment_provider <> 'mock'
    ) then
        raise exception '카드/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요';
    end if;

    -- 환불 완료: 횟수를 0으로 만들고 환불 진행 표시를 해제(트리거에는 서버 쓰기임을 표시)
    perform set_config('app.pg_refund_write', 'on', true);
    update memberships
       set status = 'refunded', remaining_count = 0, pg_refund_started_at = null
     where id = v_mem.id;
    perform set_config('app.pg_refund_write', '', true);

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

    -- 이 결제에 쓰인 쿠폰이 있으면 available로 복원
    if v_order_id is not null then
        update member_coupons
           set status = 'available', used_at = null, order_id = null
         where order_id = v_order_id and status = 'used';

        -- 이 주문에 실제로 차감된 포인트를 전액 복원(원장 unique 인덱스로 1회)
        perform _restore_order_points(v_order_id, '환불 포인트 복원');
    end if;

    select count(*) into v_still_active
    from memberships m
    where m.profile_id = v_mem.profile_id
      and m.center_id = v_mem.center_id
      and m.status = 'active'
      and (m.remaining_count is null or m.remaining_count > 0)
      and (m.expires_at is null or m.expires_at >= (now() at time zone 'Asia/Seoul')::date);

    if v_still_active = 0 then
        update center_members
           set status = 'expired'
         where profile_id = v_mem.profile_id
           and center_id = v_mem.center_id
           and status <> 'dormant';
    end if;

    return json_build_object('refunded', true, 'amount', v_amount);
end;
$function$;

revoke all on function public._refund_membership_core(uuid, uuid, boolean, boolean) from public, anon, authenticated, service_role;

commit;
