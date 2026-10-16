-- 롤백: 일반 환불 차단 조건을 이전(라이브) 정의 — payment_provider in ('toss','portone') — 로 되돌린다.
-- ⚠ 되돌리면 'nicepay' 주문 환불 우회 위험이 다시 생긴다. nicepay 주문이 하나도 없을 때만 사용.
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
        select 1 from orders o where o.id = v_order_id and o.payment_provider in ('toss', 'portone')
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
