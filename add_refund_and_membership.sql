-- ============================================================
-- 환불 + 회원 자동 등록/복귀
--
-- 하는 일:
--   1) refund_membership  : 회원 셀프 환불 (24시간 이내·미사용)
--                           → 수강권 환불 + 매출 환불 기록 + 만료회원 전환
--   2) ensure_center_member: 수강권 발급 시 센터 회원목록 자동 등록/복귀
--   3) fulfill_order 갱신  : 발급할 때 회원 자동 등록까지 수행
--
-- ⚠ add_orders.sql, add_order_fulfillment.sql 을 먼저 실행했어야 해요.
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================


-- ============================================================
-- 수강권 환불 (회원 셀프)
--   조건: 결제 24시간 이내 + 미사용(횟수 미차감)
--   처리: 수강권 refunded 처리 + 매출 환불 기록 + 회원 상태 재계산
-- ============================================================

create or replace function refund_membership(p_membership_id uuid)
returns json
language plpgsql
security definer
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


-- ============================================================
-- 수강권 발급 시 회원 자동 등록/복귀
--   fulfill_order 등에서 호출. 센터 회원목록에 없으면 추가,
--   만료회원이면 다시 이용중으로.
-- ============================================================

create or replace function ensure_center_member(p_center_id uuid, p_profile_id uuid)
returns void
language plpgsql
security definer
as $$
begin
    insert into center_members (center_id, profile_id, status, registered_at, app_linked)
    values (p_center_id, p_profile_id, 'active', now(), true)
    on conflict (center_id, profile_id) do update
        set status = case
                        when center_members.status = 'dormant' then 'dormant'  -- 휴면은 유지
                        else 'active'
                     end;
end;
$$;



-- ============================================================
-- 주문 처리 완료 (수강권/상품 자동 발급 + 매출 자동 연동)
--   매니저가 주문관리에서 "처리 완료" 시, 또는 나중에 실제 결제 성공 시 호출.
--   하는 일:
--     1) order를 done 처리
--     2) 그 회원에게 수강권/상품(membership) 자동 발급
--     3) payments에 매출 기록 (매출관리에 자동 반영)
--   이미 done인 주문은 중복 발급 안 함.
-- ============================================================

create or replace function fulfill_order(p_order_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_order      record;
    v_product    record;
    v_membership_id uuid;
    v_count      int;
    v_kind       text;
    v_expires    date;
begin
    -- 주문 조회 + 잠금
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    -- 권한: 이 센터 매니저/오너만
    if not (v_order.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 주문을 처리할 권한이 없어요';
    end if;

    -- 이미 완료된 주문이면 중복 발급 방지
    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    -- 상품 정보 (횟수/종류)
    v_count := null; v_kind := 'pass';
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            v_count := v_product.total_count;
            v_kind := v_product.product_kind;
        end if;
    end if;

    -- 유효기간 기본 60일
    v_expires := (now() + interval '60 days')::date;

    -- 1) 수강권/상품 발급
    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, status
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, 'active'
    ) returning id into v_membership_id;

    -- 2) 매출 기록 (결제수단은 주문의 pay_method 기준으로 대략 분류)
    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, paid_at, status, memo
    ) values (
        v_order.center_id, v_order.profile_id, v_membership_id,
        'new', 'membership',
        case when v_order.pay_method in ('card','kakao','toss') then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'transfer' then v_order.amount else 0 end,
        0,
        v_order.amount, 0, now(), 'paid',
        '앱 주문 자동 발급'
    );

    -- 3) 센터 회원목록에 자동 등록 (없으면 추가, 만료회원이면 복귀)
    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    -- 4) 주문 완료 처리
    update orders set status = 'done', paid_at = now() where id = p_order_id;

    return json_build_object(
        'already_done', false,
        'membership_id', v_membership_id,
        'amount', v_order.amount
    );
end;
$$;


-- ============================================================
-- 완료!
--   회원: 마이페이지 → 수강권 → 환불하기
--   관리자: 매출관리에 환불(음수) 반영, 회원목록 상태 자동 갱신
-- ============================================================
