-- ============================================================
-- 구매 시 요일/시간 선택형 수강권 (Batch C)
--
-- 사전 조사 결과(코드로 확인, 이 파일 주석에 근거를 남김):
--   · products.auto_book_days(add_auto_booking.sql)는 상품 단위로 고정된 요일을
--     "자동 예약"해주는 완전히 다른 기능이다(구매자별 선택 없음, 제한이 아니라
--     자동 예약 트리거). 이 기능과 이름만 비슷할 뿐 서로 독립적이고, 이번 변경이
--     그 기능의 동작을 바꾸지 않는다.
--   · membership_schedule_rules(add_membership_rules.sql)는 상품 단위로 "이 상품은
--     이 요일/시간/수업명만 예약 가능"을 제한하는 기존 기능이다 — 하지만 같은 상품을
--     산 모든 회원에게 동일한 제한이 적용된다(구매자별로 다른 요일을 고를 수 없음).
--     이번 기능은 이 테이블을 "새로 만들지 않고" 그대로 재사용한다: 상품에 여러 rule을
--     미리 등록해두면(예: 월16:00/월20:00/수16:00/수20:00), 그 rule들이 "구매 시 고를 수
--     있는 요일/시간 후보"가 되고, 구매자가 그중 하나를 고르면 그 선택이
--     memberships.bound_day_of_week/bound_start_time에 개별로 저장된다. 기존
--     membership_schedule_rules에 의한 "이 상품 자체가 허용하는 요일/시간" 제한은
--     그대로 유지되고(AND 조건), 이번 컬럼은 "그 후보들 중 이 회원이 실제로 고른 것"만
--     별도로 좁힌다.
--   · is_membership_eligible_for_class()(add_shared_class_eligibility_and_show_all_
--     classes_filter.sql)가 reserve_class()/reserve_with_membership() 양쪽에서 이미
--     공용으로 쓰이는 유일한 자격판정 함수임을 확인했다 — 새 조건을 이 함수 한 곳에만
--     추가하면 두 예약 RPC 모두에 자동으로 적용된다(로직 중복/드리프트 방지, 기존 관례
--     그대로 따름). usable_memberships()/usable_memberships_for_classes()
--     (fix_usable_memberships_product_kind.sql)는 화면에 "사용 가능한 수강권" 목록을
--     보여주는 별도 함수라 같은 조건을 여기에도 추가해야 화면 표시와 실제 예약 허용
--     여부가 일치한다(안 하면 화면엔 보이는데 예약은 거부되는 혼란스러운 UX가 됨).
--   · fulfill_order()/_issue_membership_and_record_payment()
--     (fix_rolling_month_starts_at_not_null_regression.sql, 가장 최신 정의로 확인)가
--     주문으로부터 memberships 행을 만드는 두 경로다 — 구매 시 고른 요일/시간을
--     orders에 먼저 저장해두고, 이 두 함수가 그 값을 그대로 memberships에 복사하게
--     고친다.
--
-- 기존 상품 호환: 새 옵션이 꺼진(weekday_selectable=false) 기존 상품/기존 memberships는
-- bound_day_of_week/bound_start_time이 항상 null이라 is_membership_eligible_for_class()의
-- 새 조건이 자동으로 "제한 없음"으로 통과한다 — 기존 동작과 100% 동일.
--
-- [2026-10-01 재작성] 처음 버전은 저장소의 옛 migration 파일을 기준으로 함수를 다시 써서
-- 라이브 DB와 어긋났다(실행 시 42P13 — usable_memberships_for_classes에 라이브에만 있는
-- issued_at 반환 컬럼이 없었음. 그대로 실행됐다면 쿠폰 검증/사용 처리, 구매 자격 재검증,
-- pass_selection_mode 정책, starts_at 조건이 옛 버전으로 되돌아갔을 것). 이 버전의 다섯
-- 함수는 2026-10-01에 라이브 DB에서 pg_get_functiondef로 읽은 실제 정의 그대로이고,
-- [Batch C 신규] 표시한 줄만 추가했다 — 그 외 로직은 한 글자도 바꾸지 않았다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전(add column if not
-- exists, create or replace function). 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================

-- ------------------------------------------------------------
-- [1] 상품 설정 — 구매 시 요일/시간 선택 옵션
-- ------------------------------------------------------------
alter table products add column if not exists weekday_selectable boolean not null default false;
alter table products add column if not exists time_selectable boolean not null default false;

comment on column products.weekday_selectable is
  '구매 시 회원이 수강 요일을 고르게 할지. true면 membership_schedule_rules에 등록된
   day_of_week 후보 중에서 고른다(후보는 매니저가 기존 "예약조건 추가" 화면에서 미리
   등록). auto_book_days(자동예약, 별개 기능)와 무관.';
comment on column products.time_selectable is
  '요일 선택(weekday_selectable) 후에 시간까지 고르게 할지. weekday_selectable이 꺼져
   있으면 의미 없음(화면에서도 요일 선택이 꺼지면 같이 숨김).';

-- ------------------------------------------------------------
-- [2] 주문 — 구매 시점에 고른 요일/시간(결제 확정 전 orders에 먼저 저장)
-- ------------------------------------------------------------
alter table orders add column if not exists selected_day_of_week int;
alter table orders add column if not exists selected_start_time time;

comment on column orders.selected_day_of_week is '구매 시 고른 요일(0=일~6=토). weekday_selectable 상품만 채워짐.';
comment on column orders.selected_start_time is '구매 시 고른 시간. time_selectable 상품만 채워짐.';

-- ------------------------------------------------------------
-- [3] 수강권 — 실제로 귀속된 요일/시간(발급 시 1회 확정, 이후 자동으로 바뀌지 않음)
-- ------------------------------------------------------------
alter table memberships add column if not exists bound_day_of_week int;
alter table memberships add column if not exists bound_start_time time;

comment on column memberships.bound_day_of_week is
  '이 수강권으로 예약 가능한 요일(0=일~6=토, null=제한 없음). 구매/발급 시 한 번만
   설정되고 수업이 삭제되거나 스케줄이 바뀌어도 자동으로 바뀌지 않는다(C-12) — 좌표가
   아니라 회원과의 "계약 조건"이기 때문.';
comment on column memberships.bound_start_time is
  '이 수강권으로 예약 가능한 시간(null=제한 없음). bound_day_of_week와 함께 AND 조건으로
   적용된다(요일만 고르고 시간은 자유로 둔 경우 시간은 null).';

-- ------------------------------------------------------------
-- [4] 공용 자격판정 함수 — reserve_class()/reserve_with_membership()가 둘 다 호출하므로
--     여기 한 곳이 서버 쪽 강제 지점이다(우회 불가). 기존 조건과 AND로만 추가.
-- ------------------------------------------------------------
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
          -- [Batch C 신규] 구매 시 고른 요일/시간 귀속 — null이면(기존 상품/미선택) 제한 없음,
          -- 값이 있으면 수업의 실제 요일/시간과 일치해야 한다(기존 조건과 AND).
          and (
                m.bound_day_of_week is null
                or m.bound_day_of_week = extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int
          )
          and (
                m.bound_start_time is null
                or m.bound_start_time = (c.start_time at time zone 'Asia/Seoul')::time
          )
    );
$function$;

-- ------------------------------------------------------------
-- [5] 화면 표시용 함수 두 개 — 화면 목록과 실제 예약 허용 여부가 어긋나지 않게 같은 조건 추가
-- ------------------------------------------------------------
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
      -- [Batch C 신규] 구매 시 고른 요일/시간 귀속(is_membership_eligible_for_class와 동일 조건)
      and (m.bound_day_of_week is null or m.bound_day_of_week = cls.ldow)
      and (m.bound_start_time is null or m.bound_start_time = cls.ltime)
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
      )
      -- [Batch C 신규] 구매 시 고른 요일/시간 귀속(is_membership_eligible_for_class와 동일 조건)
      and (m.bound_day_of_week is null or m.bound_day_of_week = cls.ldow)
      and (m.bound_start_time is null or m.bound_start_time = cls.ltime);
$function$;

-- ------------------------------------------------------------
-- [6] 주문 → 수강권 발급 두 경로에서 선택값을 memberships로 복사(INSERT 컬럼만 추가)
-- ------------------------------------------------------------
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
        pass_type, total_count, remaining_count, expires_at, starts_at, status,
        bound_day_of_week, bound_start_time
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, v_starts, 'active',
        v_order.selected_day_of_week, v_order.selected_start_time
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
        pass_type, total_count, remaining_count, expires_at, starts_at, status,
        bound_day_of_week, bound_start_time
    ) values (
        p_order.profile_id, p_order.center_id, p_order.product_id, p_order.product_name,
        'count', v_count, v_count, v_expires, v_starts, 'active',
        p_order.selected_day_of_week, p_order.selected_start_time
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
-- 확인 — 아래 6개 컬럼이 보이고, 마지막 쿼리가 5개 함수 모두 true면 정상
-- ============================================================
select column_name from information_schema.columns
where table_name = 'products' and column_name in ('weekday_selectable', 'time_selectable')
union all
select column_name from information_schema.columns
where table_name = 'orders' and column_name in ('selected_day_of_week', 'selected_start_time')
union all
select column_name from information_schema.columns
where table_name = 'memberships' and column_name in ('bound_day_of_week', 'bound_start_time');

select p.proname, (pg_get_functiondef(p.oid) like '%bound_day_of_week%') as has_bound
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('is_membership_eligible_for_class', 'usable_memberships', 'usable_memberships_for_classes',
                    'fulfill_order', '_issue_membership_and_record_payment')
order by 1;

-- ============================================================
-- 완료!
-- ============================================================
