-- ============================================================
-- 요일반 수강권: 미배치 잔여 횟수 관리
--
-- 하는 일:
--   1) fulfill_order 가 자동예약 결과(배치 수/잔여 수)를 반환
--   2) 관리자용 조회 함수: 요일반 수강권 중 아직 예약이 덜 잡힌 회원 목록
--      → 관리자가 정원을 늘리거나 수동으로 배치할 수 있게
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- fulfill_order: 자동예약 결과를 반환값에 포함
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
    v_auto       json;
    v_booked     int := 0;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if not (v_order.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 주문을 처리할 권한이 없어요';
    end if;

    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    v_count := null; v_kind := 'pass';
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            v_count := v_product.total_count;
            v_kind := v_product.product_kind;
        end if;
    end if;

    v_expires := (now() + interval '60 days')::date;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, status
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, 'active'
    ) returning id into v_membership_id;

    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount, direct_amount,
        total_amount, unpaid_amount, paid_at, status, memo
    ) values (
        v_order.center_id, v_order.profile_id, v_membership_id,
        'new', 'membership',
        case when v_order.pay_method in ('card','kakao','toss') then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'transfer' then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'direct' then v_order.amount else 0 end,
        v_order.amount, 0, now(), 'paid',
        '앱 주문 자동 발급'
    );

    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    -- 자동예약 (결과를 받아둠)
    if coalesce(v_order.auto_book, false) then
        begin
            v_auto := auto_book_membership(v_membership_id);
            v_booked := coalesce((v_auto->>'booked')::int, 0);
        exception when others then
            v_booked := 0;
        end;
    end if;

    update orders set status = 'done', paid_at = now() where id = p_order_id;

    return json_build_object(
        'already_done', false,
        'membership_id', v_membership_id,
        'amount', v_order.amount,
        'auto_booked', v_booked,                              -- 자동 배치된 수업 수
        'remaining', coalesce(v_count, 0) - v_booked          -- 아직 배치 못 한 횟수
    );
end;
$$;


-- ============================================================
-- 관리자용: 요일반 수강권 중 예약이 덜 잡힌 회원 목록
--   → 정원을 늘리거나 보강 예약으로 수동 배치할 대상
-- ============================================================

create or replace function unplaced_weekday_passes(p_center_id uuid)
returns table (
    membership_id   uuid,
    profile_id      uuid,
    member_name     text,
    product_name    text,
    total_count     int,
    remaining_count int,
    auto_book_days  int[],
    expires_at      date,
    purchased_at    timestamptz
)
language sql
security definer
as $$
    select
        m.id,
        m.profile_id,
        coalesce(p.name, '(이름 없음)'),
        m.product_name,
        m.total_count,
        m.remaining_count,
        pr.auto_book_days,
        m.expires_at,
        m.created_at
    from memberships m
    join products pr on pr.id = m.product_id
    left join profiles p on p.id = m.profile_id
    where m.center_id = p_center_id
      and m.status = 'active'
      and pr.auto_book_days is not null
      and array_length(pr.auto_book_days, 1) > 0
      and coalesce(m.remaining_count, 0) > 0          -- 아직 배치 못 한 횟수가 남음
      and (m.center_id in (select my_managed_center_ids()) or is_platform_admin())
    order by m.created_at asc;                        -- 먼저 구매한 순
$$;


-- ============================================================
-- 완료!
--   관리자 모드 → 수업 → 미배치 수강권 에서 확인
-- ============================================================
