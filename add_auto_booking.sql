-- ============================================================
-- 요일반 수강권 자동예약
--
-- 하는 일:
--   1) products.auto_book_days : 이 수강권이 어느 요일 수업용인지 (0=일 ~ 6=토)
--        예) "화요일 4회권" → {2}
--   2) orders.auto_book        : 회원이 구매 시 "자동예약까지 해주세요"를 선택했는지
--   3) auto_book_membership()  : 발급된 수강권으로 해당 요일 수업을 잔여 횟수만큼 자동 예약
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table products add column if not exists auto_book_days int[];
alter table orders   add column if not exists auto_book boolean not null default false;


-- ============================================================
-- 발급된 수강권으로 자동 예약
--   - 수강권의 상품에 지정된 요일 수업만 대상
--   - 오늘 이후, 만료일 이전, 정원 여유 있는 수업을 빠른 순으로
--   - 잔여 횟수만큼만 예약하고 그만큼 차감
--   - 이미 예약된 수업은 건너뜀
-- ============================================================

create or replace function auto_book_membership(p_membership_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_mem     record;
    v_days    int[];
    v_left    int;
    v_booked  int := 0;
    v_class   record;
    v_taken   int;
begin
    select * into v_mem from memberships where id = p_membership_id for update;
    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;

    -- 이 수강권이 요일반인지 확인
    select auto_book_days into v_days from products where id = v_mem.product_id;
    if v_days is null or array_length(v_days, 1) is null then
        return json_build_object('booked', 0, 'reason', 'not_weekday_pass');
    end if;

    -- 남은 횟수 (무제한이면 자동예약 안 함)
    v_left := coalesce(v_mem.remaining_count, 0);
    if v_left <= 0 then
        return json_build_object('booked', 0, 'reason', 'no_remaining');
    end if;

    -- 대상 수업: 같은 센터 + 지정 요일 + 오늘 이후 + 만료 전, 빠른 순
    for v_class in
        select c.id, c.capacity, c.start_time
        from classes c
        where c.center_id = v_mem.center_id
          and c.status = 'open'
          and c.start_time > now()
          and (v_mem.expires_at is null or c.start_time::date <= v_mem.expires_at)
          and extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int = any(v_days)
        order by c.start_time asc
    loop
        exit when v_left <= 0;

        -- 이미 예약했으면 건너뜀
        if exists (
            select 1 from reservations r
            where r.class_id = v_class.id
              and r.profile_id = v_mem.profile_id
              and r.status in ('confirmed', 'waitlisted', 'attended')
        ) then
            continue;
        end if;

        -- 정원 확인
        select count(*) into v_taken
        from reservations
        where class_id = v_class.id and status in ('confirmed', 'attended');
        if v_taken >= v_class.capacity then
            continue;
        end if;

        insert into reservations (class_id, profile_id, membership_id, status)
        values (v_class.id, v_mem.profile_id, v_mem.id, 'confirmed');

        v_left := v_left - 1;
        v_booked := v_booked + 1;
    end loop;

    -- 예약한 만큼 차감
    if v_booked > 0 then
        update memberships
           set remaining_count = remaining_count - v_booked
         where id = p_membership_id
           and remaining_count is not null;
    end if;

    return json_build_object('booked', v_booked);
end;
$$;


-- ============================================================
-- fulfill_order 갱신 (발급 시 자동예약 연결)
-- ============================================================

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

    -- 3-1) 회원이 자동예약을 선택했고 요일반 수강권이면 자동 예약
    if coalesce(v_order.auto_book, false) then
        begin
            perform auto_book_membership(v_membership_id);
        exception when others then
            null;  -- 자동예약 실패해도 발급 자체는 성공 처리
        end;
    end if;

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
-- 확인
-- ============================================================
select column_name from information_schema.columns
where (table_name = 'products' and column_name = 'auto_book_days')
   or (table_name = 'orders' and column_name = 'auto_book');


-- ============================================================
-- 완료!
--   관리자: 수강권 관리 → 요일반 요일 지정
--   회원:   구매 시 "자동 예약까지 해주세요" 선택
-- ============================================================
