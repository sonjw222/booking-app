-- ============================================================
-- add_weekday_time_fixed_memberships.sql 롤백
--
-- 다섯 함수를 이 migration 적용 전 라이브 정의(2026-10-01에 pg_get_functiondef로 읽은 값)
-- 그대로 복원한다 — 저장소의 옛 migration 파일 기준이 아니라 실제 라이브 기준이라
-- 쿠폰/자격 재검증/pass_selection_mode 등 이후 변경이 되돌아가지 않는다.
--
-- 컬럼은 기본적으로 지우지 않는다 — 이 옵션으로 이미 구매된 memberships/orders 행의
-- 귀속 정보(회원과의 계약 조건)가 영구히 사라지기 때문. 정말 필요하면 맨 아래 주석 처리된
-- DROP 문을 검토 후 직접 실행하세요.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_membership_eligible_for_class(p_membership_id uuid, p_class_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select exists (
        select 1
        from memberships m
        join classes c on c.id = p_class_id
        where m.id = p_membership_id
          and (
                c.pass_selection_mode = 'all'
                or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = c.id)
          )
          and (
                (
                    c.pass_selection_mode = 'selected'
                    and exists (
                        select 1 from class_allowed_products cap
                        where cap.class_id = c.id and cap.product_id = m.product_id
                    )
                )
                or m.product_id is null
                or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
                or exists (
                    select 1 from membership_schedule_rules r
                    where r.product_id = m.product_id
                      and (r.day_of_week is null or r.day_of_week = extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int)
                      and (r.start_time is null or r.start_time = (c.start_time at time zone 'Asia/Seoul')::time)
                      and (r.class_title is null or c.title like '%' || r.class_title || '%')
                )
          )
    );
$function$;

CREATE OR REPLACE FUNCTION public.usable_memberships(p_class_id uuid, p_profile_id uuid)
 RETURNS TABLE(membership_id uuid, product_name text, remaining_count integer, expires_at date, owner_profile text, is_mine boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    with cls as (
        select c.*,
               (c.start_time at time zone 'Asia/Seoul')::date as ldate,
               (c.start_time at time zone 'Asia/Seoul')::time as ltime,
               extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int as ldow
        from classes c where c.id = p_class_id
    )
    select
        m.id,
        m.product_name,
        m.remaining_count,
        m.expires_at,
        coalesce(p.name, ''),
        (m.profile_id = p_profile_id)
    from memberships m
    join cls on true
    join products pd on pd.id = m.product_id
    left join profiles p on p.id = m.profile_id
    where m.center_id = cls.center_id
      and m.status = 'active'
      and pd.product_kind = 'pass'
      and (m.remaining_count is null or m.remaining_count > 0)
      and m.expires_at >= current_date
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            -- [수강권 허용 정책 변경] 'all'이면 class_allowed_products 존재 여부와
            -- 무관하게 전부 허용(기존 "0건=전체허용"과 동일). 'selected'면 그 목록에
            -- 있는 product만 허용.
            cls.pass_selection_mode = 'all'
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            -- [P1-17 override, 정책 변경 반영] 'selected' 모드에서 이 product가 명시적으로
            -- 지정돼 있을 때만 override(schedule_rules 무시)한다. 'all' 모드는 override
            -- 대상이 아니다(모든 pass가 class_allowed_products에 없어도 허용되는 것과
            -- 마찬가지로, schedule_rules도 그대로 유지되는 기존 동작 보존).
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
      )
    order by (m.profile_id = p_profile_id) desc, m.expires_at asc;
$function$;

CREATE OR REPLACE FUNCTION public.usable_memberships_for_classes(p_class_ids uuid[], p_profile_id uuid)
 RETURNS TABLE(class_id uuid, membership_id uuid, product_name text, remaining_count integer, expires_at date, owner_profile text, is_mine boolean, issued_at date)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      and (m.starts_at is null or m.starts_at <= current_date)
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

CREATE OR REPLACE FUNCTION public.fulfill_order(p_order_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_order      record;
    v_product    record;
    v_membership_id uuid;
    v_count      int;
    v_kind       text;
    v_expires    date;
    v_starts     date;
    v_rm         record;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if not (has_permission(v_order.center_id, 'pass.payment.create') or is_platform_admin()) then
        raise exception '이 주문을 처리할 권한이 없어요';
    end if;

    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    if not coalesce(v_order.verified, false) then
        if v_order.product_id is null or v_order.amount <> (select price from products where id = v_order.product_id) then
            raise exception '주문 금액을 확인할 수 없어요. 상품 가격과 다릅니다 — 센터에서 직접 확인해주세요.';
        end if;
    end if;

    v_count := null; v_kind := 'pass'; v_expires := null; v_starts := current_date;
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            v_count := case when v_product.unlimited_pass then null else v_product.total_count end;
            v_kind := v_product.product_kind;
            if v_product.expiry_mode = 'rolling_month' then
                select * into v_rm from calc_rolling_month_dates(now(), v_product.rolling_month_cutoff_day);
                v_expires := v_rm.expires_at;
                if not coalesce(v_product.rolling_month_allow_early_use, false) then
                    v_starts := v_rm.starts_at;
                end if;
            else
                v_expires := case v_product.expiry_mode
                    when 'date' then v_product.expiry_date
                    when 'days' then (now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval)::date
                    else null
                end;
            end if;
        end if;
    end if;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, starts_at, status
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, v_starts, 'active'
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

    if coalesce(v_order.auto_book, false) then
        begin
            perform auto_book_membership(v_membership_id);
        exception when others then
            null;
        end;
    end if;

    update orders set status = 'done', paid_at = now() where id = p_order_id;

    return json_build_object(
        'already_done', false,
        'membership_id', v_membership_id,
        'amount', v_order.amount
    );
end;
$function$;

CREATE OR REPLACE FUNCTION public._issue_membership_and_record_payment(p_order orders, p_provider_ref text, p_memo text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
    v_product           record;
    v_membership_id     uuid;
    v_count             int;
    v_expires           date;
    v_starts            date;
    v_rm                record;
    v_verified_discount int;
    v_expected_amount   int;
    v_points_verified   boolean;
    v_coupon            record;
    v_member_coupon     record;
begin
    v_count := null;
    v_expires := null;
    v_starts := current_date;
    if p_order.product_id is not null then
        select * into v_product from products where id = p_order.product_id;
        if found then
            -- [FIX] 구매 자격 재검증(요청 5/17번) — 주문 생성 시점(orders INSERT RLS)에서
            -- 이미 확인했지만, 확정 시점 사이에 공개범위가 바뀌었을 수 있으므로 여기서
            -- 다시 한번 확인한다. UI 숨김이나 주문 생성 차단을 우회해 이 함수를 직접
            -- 호출할 방법은 없지만(confirm_test_payment/confirm_real_payment를 거쳐야
            -- 하고 둘 다 소유자 검증을 함), 그래도 이 함수 자체가 "최종 서버 검증
            -- 지점"이라는 원칙을 지키기 위해 독립적으로 재확인한다.
            if not member_can_purchase_product(p_order.product_id, p_order.profile_id) then
                raise exception '이 수강권을 구매할 수 있는 대상이 아닙니다.';
            end if;

            v_count := case when v_product.unlimited_pass then null else v_product.total_count end;
            if v_product.expiry_mode = 'rolling_month' then
                select * into v_rm from calc_rolling_month_dates(now(), v_product.rolling_month_cutoff_day);
                v_expires := v_rm.expires_at;
                if not coalesce(v_product.rolling_month_allow_early_use, false) then
                    v_starts := v_rm.starts_at;
                end if;
            else
                v_expires := case v_product.expiry_mode
                    when 'date' then v_product.expiry_date
                    when 'days' then (now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval)::date
                    else null
                end;
            end if;

            v_verified_discount := case p_order.coupon_code
                when 'WELCOME' then 5000
                when 'FIGURE10' then 10000
                else 0
            end;

            -- [FIX] 실제 member_coupon 기반 할인(요청 16번) — 클라이언트가 보낸 할인율/
            -- 할인금액/최종금액은 절대 신뢰하지 않고, member_coupon_id로부터 서버가
            -- 처음부터 다시 계산한다.
            if p_order.member_coupon_id is not null then
                -- [NEW, 2026-09-19] 상품 자체가 "쿠폰 적용 불가"면 쿠폰 소유/유효성과
                -- 무관하게 여기서 바로 차단한다 — 쿠폰 쪽 applies_to가 뭐든 이 상품의
                -- 설정이 우선한다.
                if not coalesce(v_product.coupon_eligible, true) then
                    raise exception '이 수강권은 쿠폰을 적용할 수 없어요.';
                end if;

                select mc.*, c.discount_type, c.discount_value, c.max_discount_amount,
                       c.minimum_order_amount, c.applies_to, c.valid_from, c.valid_until,
                       c.status as coupon_status, c.center_id as coupon_center_id
                  into v_member_coupon
                  from member_coupons mc
                  join coupons c on c.id = mc.coupon_id
                 where mc.id = p_order.member_coupon_id
                 for update;

                if not found then
                    raise exception '쿠폰을 찾을 수 없어요';
                end if;
                -- 쿠폰 소유자 확인(다른 회원 쿠폰 도용 차단, 요청 24-12번)
                if not exists (
                    select 1 from center_members cm
                    where cm.id = v_member_coupon.center_member_id
                      and cm.profile_id = p_order.profile_id
                ) then
                    raise exception '본인에게 지급된 쿠폰만 사용할 수 있어요';
                end if;
                -- 센터 일치(다른 센터 쿠폰 차단, 요청 24-13번)
                if v_member_coupon.coupon_center_id is distinct from p_order.center_id then
                    raise exception '이 센터에서 사용할 수 없는 쿠폰이에요';
                end if;
                if v_member_coupon.status <> 'available' then
                    raise exception '사용할 수 없는 쿠폰이에요(이미 사용됐거나 만료/회수됨)';
                end if;
                if v_member_coupon.valid_from is not null and now() < v_member_coupon.valid_from then
                    raise exception '아직 사용할 수 없는 쿠폰이에요';
                end if;
                if v_member_coupon.valid_until is not null and now() > v_member_coupon.valid_until then
                    raise exception '유효기간이 지난 쿠폰이에요';
                end if;
                if v_member_coupon.applies_to = 'selected' and not exists (
                    select 1 from coupon_products where coupon_id = v_member_coupon.coupon_id and product_id = p_order.product_id
                ) then
                    raise exception '이 수강권에는 사용할 수 없는 쿠폰이에요';
                end if;
                if v_member_coupon.minimum_order_amount is not null and v_product.price < v_member_coupon.minimum_order_amount then
                    raise exception '최소 결제금액(%s원) 미만이라 쿠폰을 사용할 수 없어요', v_member_coupon.minimum_order_amount;
                end if;

                if v_member_coupon.discount_type = 'fixed' then
                    v_verified_discount := v_verified_discount + v_member_coupon.discount_value;
                else
                    v_verified_discount := v_verified_discount +
                        least(
                            (v_product.price * v_member_coupon.discount_value) / 100,
                            coalesce(v_member_coupon.max_discount_amount, v_product.price)
                        );
                end if;
            end if;

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
    end if;

    update orders set status = 'paid', paid_at = now() where id = p_order.id;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, starts_at, status
    ) values (
        p_order.profile_id, p_order.center_id, p_order.product_id, p_order.product_name,
        'count', v_count, v_count, v_expires, v_starts, 'active'
    ) returning id into v_membership_id;

    insert into payments (
        center_id, profile_id, membership_id, order_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo
    ) values (
        p_order.center_id, p_order.profile_id, v_membership_id, p_order.id,
        'new', 'membership',
        p_order.amount, 0, 0, 0,
        p_order.amount, 0, p_provider_ref, now(), 'paid',
        p_memo
    );

    -- [FIX] 결제 성공 확정 시점에만 쿠폰을 used로 전환(요청 18번 — 선택 시점 X)
    if p_order.member_coupon_id is not null then
        update member_coupons
           set status = 'used', used_at = now(), order_id = p_order.id
         where id = p_order.member_coupon_id;
    end if;

    update orders set status = 'done' where id = p_order.id;

    return json_build_object('membership_id', v_membership_id, 'amount', p_order.amount);
end;
$function$;

-- ============================================================
-- 컬럼 삭제는 기본적으로 하지 않음. 정말 필요하면 아래 주석을 풀고 직접 실행하세요.
-- ============================================================
-- alter table products drop column if exists weekday_selectable;
-- alter table products drop column if exists time_selectable;
-- alter table orders drop column if exists selected_day_of_week;
-- alter table orders drop column if exists selected_start_time;
-- alter table memberships drop column if exists bound_day_of_week;
-- alter table memberships drop column if exists bound_start_time;
