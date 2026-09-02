-- ============================================================
-- 상품(수강권/상품) 횟수·기간 옵션 확장
--
-- 지금까지는 상품이 pass_type(count/period) 양자택일이었는데, 실제로는 "5회권인데 1개월
-- 지나면 자동 만료" 같은 횟수+기간 동시 적용이 필요하다는 요청이다. pass_type 이분법 대신
-- "횟수 무제한 여부(unlimited_pass)" + "기간(expiry_mode: none/days/date)" 두 축의 조합으로
-- 처리한다(사용자 결정, 2026-09-01) — pass_type 컬럼 자체는 하위호환을 위해 그대로 두고
-- 신규 상품도 계속 'count'로 저장한다.
--
-- 조사 중 발견한 기존 버그도 같이 고친다: fulfill_order()/_issue_membership_and_record_payment()
-- 둘 다 pass_type='count', expires_at=60일 후를 하드코딩하고 있어서 products의 실제 설정을
-- 전혀 반영하지 않고 있었다.
--
-- 사용자 결정:
--   - 상품에 "특정 날짜"로 만료를 걸면(expiry_mode='date'), 구매 시점과 무관하게 그 상품을
--     산 모든 회원이 같은 날짜에 만료(시즌권 효과) — expiry_date를 그대로 씀.
--   - 기간 옵션을 꺼두면(expiry_mode='none', 기본값) 수강권은 무제한(만료 없음) — 기존
--     "무조건 60일" 하드코딩을 대체. 기존에 이미 발급된 수강권(과거 데이터)은 안 건드림.
--
-- 아래 두 함수(fulfill_order, _issue_membership_and_record_payment)는 실제 운영 DB에서
-- pg_get_functiondef()로 확인한 현재 정의(SEC-116/SEC-118 권한·검증 로직, 자동예약 호출 등)를
-- 그대로 보존하고 횟수/기간 계산 부분만 바꾼 것이다 — 기존 기능 회귀 없음.
--
-- 여러 번 실행해도 안전(idempotent).
-- ============================================================

-- 1) memberships.expires_at을 nullable로 (NULL = 무제한)
alter table memberships alter column expires_at drop not null;

-- 2) products에 컬럼 추가 (pass·goods 공용 테이블)
--    products.unlimited는 goods 전용으로 이미 실사용 중이라(lib/passes.ts, app/manager/goods)
--    그대로 두고, pass용 무제한은 새 컬럼으로 분리해 기존 goods 동작에 영향 없게 함.
alter table products add column if not exists unlimited_pass boolean not null default false;
alter table products add column if not exists expiry_mode text not null default 'none'
    check (expiry_mode in ('none', 'days', 'date'));
alter table products add column if not exists expiry_days int;   -- expiry_mode='days'일 때
alter table products add column if not exists expiry_date date;  -- expiry_mode='date'일 때(전원 동일 날짜)

comment on column products.unlimited_pass is '수강권(pass) 횟수 무제한 여부. goods의 unlimited와 별개 컬럼';
comment on column products.expiry_mode is 'none=기간 제한 없음(무제한 만료), days=구매일+expiry_days, date=expiry_date 고정(시즌권 효과)';

-- ============================================================
-- 3) fulfill_order() — 횟수/기간 계산 부분만 교체, 나머지(SEC-116 권한 체크, SEC-118 가격
--    검증, 결제 기록, 자동예약 호출 등)는 현재 운영 정의 그대로 보존.
-- ============================================================
create or replace function fulfill_order(p_order_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $function$
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

    -- [SEC-116] 권한: 이 센터에서 결제 등록 권한(pass.payment.create)이 있는 매니저/오너만.
    if not (has_permission(v_order.center_id, 'pass.payment.create') or is_platform_admin()) then
        raise exception '이 주문을 처리할 권한이 없어요';
    end if;

    -- 이미 완료된 주문이면 중복 발급 방지
    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    -- [SEC-118] verified=false(레거시/직접 insert 경로)면 현재 products.price와 직접 대조
    if not coalesce(v_order.verified, false) then
        if v_order.product_id is null or v_order.amount <> (select price from products where id = v_order.product_id) then
            raise exception '주문 금액을 확인할 수 없어요. 상품 가격과 다릅니다 — 센터에서 직접 확인해주세요.';
        end if;
    end if;

    -- 상품 정보 (횟수/종류/무제한·기간 설정)
    v_count := null; v_kind := 'pass'; v_expires := null;
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            v_count := case when v_product.unlimited_pass then null else v_product.total_count end;
            v_kind := v_product.product_kind;
            v_expires := case v_product.expiry_mode
                when 'date' then v_product.expiry_date
                when 'days' then (now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval)::date
                else null  -- 'none' = 무제한
            end;
        end if;
    end if;

    -- 1) 수강권/상품 발급
    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, status
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, 'active'
    ) returning id into v_membership_id;

    -- 2) 매출 기록 (결제수단별 분류 — 직접결제 포함)
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

    -- 3) 센터 회원목록에 자동 등록
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
$function$;

-- ============================================================
-- 4) _issue_membership_and_record_payment() — 동일하게 횟수/기간 계산 부분만 교체.
-- ============================================================
create or replace function _issue_membership_and_record_payment(p_order orders, p_provider_ref text, p_memo text)
returns json
language plpgsql
security definer
as $function$
declare
    v_product           record;
    v_membership_id     uuid;
    v_count             int;
    v_expires           date;
    v_verified_discount int;
    v_expected_amount   int;
    v_points_verified   boolean;
begin
    v_count := null;
    v_expires := null;
    if p_order.product_id is not null then
        select * into v_product from products where id = p_order.product_id;
        if found then
            v_count := case when v_product.unlimited_pass then null else v_product.total_count end;
            v_expires := case v_product.expiry_mode
                when 'date' then v_product.expiry_date
                when 'days' then (now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval)::date
                else null
            end;

            -- [SEC-118] 데모 쿠폰(app/checkout/page.tsx MY_COUPONS와 동일 값)만 서버가
            -- 신뢰하는 할인으로 인정.
            v_verified_discount := case p_order.coupon_code
                when 'WELCOME' then 5000
                when 'FIGURE10' then 10000
                else 0
            end;

            -- [SEC-118] points_used는 실제 point_transactions 차감 행이 남아 있어야만 인정.
            if coalesce(p_order.points_used, 0) > 0 then
                select exists(
                    select 1 from point_transactions
                    where order_id = p_order.id
                      and profile_id = p_order.profile_id
                      and center_id = p_order.center_id
                      and amount = -p_order.points_used
                ) into v_points_verified;
                if not v_points_verified then
                    raise exception '포인트 사용 내역이 확인되지 않아 주문을 처리할 수 없어요(관리자 문의)';
                end if;
            end if;

            v_expected_amount := greatest(0, v_product.price - v_verified_discount - coalesce(p_order.points_used, 0));

            if p_order.amount is distinct from v_expected_amount then
                raise exception '주문 금액이 상품 가격과 일치하지 않아요(관리자 문의)';
            end if;
        end if;
        -- product_id는 있는데 상품 자체가 이미 삭제된 경우(found=false)는 기존과 동일하게
        -- 검증을 건너뛴다.
    end if;

    update orders set status = 'paid', paid_at = now() where id = p_order.id;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, status
    ) values (
        p_order.profile_id, p_order.center_id, p_order.product_id, p_order.product_name,
        'count', v_count, v_count, v_expires, 'active'
    ) returning id into v_membership_id;

    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo
    ) values (
        p_order.center_id, p_order.profile_id, v_membership_id,
        'new', 'membership',
        p_order.amount, 0, 0, 0,
        p_order.amount, 0, p_provider_ref, now(), 'paid',
        p_memo
    );

    update orders set status = 'done' where id = p_order.id;

    return json_build_object('membership_id', v_membership_id, 'amount', p_order.amount);
end;
$function$;

-- ============================================================
-- 5) usable_memberships_for_classes() — expires_at null(무제한)이면 항상 통과하도록 가드만 추가.
--    나머지 로직(pass_selection_mode, membership_schedule_rules 매칭 등)은 현재 운영 정의 그대로.
-- ============================================================
create or replace function usable_memberships_for_classes(p_class_ids uuid[], p_profile_id uuid)
returns table(class_id uuid, membership_id uuid, product_name text, remaining_count integer, expires_at date, owner_profile text, is_mine boolean, issued_at date)
language sql
security definer
set search_path = public
as $function$
    with cls as (
        select c.id, c.center_id, c.title, c.pass_selection_mode,
               (c.start_time at time zone 'Asia/Seoul')::time as ltime,
               extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int as ldow
        from classes c
        where c.id = any(p_class_ids)
    )
    select
        cls.id,
        m.id,
        m.product_name,
        m.remaining_count,
        m.expires_at,
        coalesce(p.name, ''),
        (m.profile_id = p_profile_id),
        m.issued_at
    from cls
    join memberships m on m.center_id = cls.center_id
    join products pd on pd.id = m.product_id
    left join profiles p on p.id = m.profile_id
    where m.status = 'active'
      and pd.product_kind = 'pass'
      and (m.remaining_count is null or m.remaining_count > 0)
      and (m.expires_at is null or m.expires_at >= current_date)
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            cls.pass_selection_mode = 'all'
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            (
                cls.pass_selection_mode = 'selected'
                and exists (
                    select 1 from class_allowed_products cap
                    where cap.class_id = cls.id and cap.product_id = m.product_id
                )
            )
            or m.product_id is null
            or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
            or exists (
                select 1 from membership_schedule_rules r
                where r.product_id = m.product_id
                  and (r.day_of_week is null or r.day_of_week = cls.ldow)
                  and (r.start_time is null or r.start_time = cls.ltime)
                  and (r.class_title is null or r.class_title = cls.title)
            )
      );
$function$;

-- notify_expiring_passes()는 이미 `m.expires_at is not null`을 전제로 만료 조건을 검사하고
-- 있어서(add_notifications.sql) 수정 불필요 — NULL(무제한) 수강권은 자연히 대상에서 빠짐.
-- 알림톡 자동 발송 규칙(add_notification_rule_evaluators.sql)의 membership_expiring/
-- pause_ending 트리거도 `m.expires_at = current_date + N` 형태의 등호 비교라 NULL과는
-- 매칭이 안 돼 무제한 회원은 자연히 대상에서 빠진다(의도한 동작, 수정 불필요).

-- ============================================================
-- 확인
-- ============================================================
select column_name, is_nullable from information_schema.columns
where table_name = 'memberships' and column_name = 'expires_at';
select column_name from information_schema.columns
where table_name = 'products' and column_name in ('unlimited_pass', 'expiry_mode', 'expiry_days', 'expiry_date');
