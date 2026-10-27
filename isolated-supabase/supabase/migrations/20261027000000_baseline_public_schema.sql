-- 격리 환경 baseline: 공유 DEV(mwhabit-ci-dev) public 스키마의 "스키마-only" 덤프 (2026-10-27, supabase db dump --schema public, 데이터 없음 — INSERT/COPY 0건, JWT/이메일/URL/프로젝트 ref 0건 확인).
-- 재생성: scripts/isolated/dumpBaseline.md 참고. 이 파일을 수정하지 말고 새 덤프로 교체한다.



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."_account_id_for_auth"("p_auth_uid" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select coalesce(
        (select coalesce(merged_into, id) from accounts where auth_id = p_auth_uid),
        (select account_id from account_auth_identities where auth_id = p_auth_uid)
    );
$$;


ALTER FUNCTION "public"."_account_id_for_auth"("p_auth_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_auto_book_membership_core"("p_membership_id" "uuid", "p_dry_run" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_mem     record;
    v_days    int[];
    v_left    int;
    v_start_left int;
    v_booked  int := 0;
    v_class   record;
    v_taken   int;
    v_used_dates date[] := '{}';
    v_cdate   date;
    v_today   date := (now() at time zone 'Asia/Seoul')::date;
    v_book_deadline timestamptz;
    v_open_deadline timestamptz;
    v_daily_enabled boolean;
    v_daily_limit   int;
    v_daily_count   int;
    v_pmc_enabled boolean;
    v_pmc_limit   int;
    v_concurrent  int;
    n_outside int := 0;   -- 조건은 맞지만 수강권 사용기간(시작~만료일) 밖
    n_mismatch int := 0;  -- 요일은 맞지만 예약 조건(시간/수강권 지정/규칙) 불일치
    n_dup int := 0;       -- 그 날짜에 이미 예약이 있음(또는 하루 한도)
    n_full int := 0;      -- 정원 부족
    n_window int := 0;    -- 휴무일/예약기간/동시 프라이빗 한도
    n_ok int := 0;        -- 사용기간 안 + 조건 일치 후보(위 장애물 포함)
    v_reason text;
begin
    if p_dry_run then
        select * into v_mem from memberships where id = p_membership_id;
    else
        select * into v_mem from memberships where id = p_membership_id for update;
    end if;
    if not found then
        return jsonb_build_object('booked', 0, 'unplaced', 0, 'reason', 'membership_not_found');
    end if;
    if v_mem.status <> 'active' then
        return jsonb_build_object('booked', 0, 'unplaced', coalesce(v_mem.remaining_count, 0), 'reason', 'membership_inactive');
    end if;

    v_days := case
        when v_mem.bound_day_of_week is not null then array[v_mem.bound_day_of_week]
        else (select auto_book_days from products where id = v_mem.product_id)
    end;
    if v_days is null or array_length(v_days, 1) is null then
        return jsonb_build_object('booked', 0, 'unplaced', coalesce(v_mem.remaining_count, 0), 'reason', 'not_weekday_pass');
    end if;

    v_left := coalesce(v_mem.remaining_count, 0);
    v_start_left := v_left;
    if v_left <= 0 then
        return jsonb_build_object('booked', 0, 'unplaced', 0, 'reason', 'no_remaining');
    end if;

    -- 이미 만료일이 지난 수강권은 어떤 수업도 배치할 수 없다(만료일 우선).
    if v_mem.expires_at is not null and v_mem.expires_at < v_today then
        return jsonb_build_object('booked', 0, 'unplaced', v_left, 'reason', 'outside_membership_period',
                                  'skipped', jsonb_build_object('outside_period', 0));
    end if;

    select daily_book_limit_enabled, daily_book_limit,
           private_max_concurrent_enabled, private_max_concurrent
      into v_daily_enabled, v_daily_limit, v_pmc_enabled, v_pmc_limit
    from center_settings where center_id = v_mem.center_id;

    for v_class in
        select c.id, c.capacity, c.start_time, c.end_time, c.class_format,
               c.booking_deadline_min, c.center_id,
               (c.start_time at time zone 'Asia/Seoul')::date as class_date
        from classes c
        where c.center_id = v_mem.center_id
          and c.status = 'open'
          and c.start_time > now()
          and extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int = any(v_days)
        order by c.start_time asc
    loop
        exit when v_left <= 0;
        v_cdate := v_class.class_date;

        -- 수동예약과 동일한 자격 판정(수강권 지정/예약조건 규칙/bound 요일·시간)
        if not is_membership_eligible_for_class(v_mem.id, v_class.id) then
            n_mismatch := n_mismatch + 1;
            continue;
        end if;

        -- 수강권 사용기간이 최우선: 만료일/시작일 밖의 수업은 횟수가 남아 있어도 절대 예약하지 않는다.
        if (v_mem.expires_at is not null and v_cdate > v_mem.expires_at)
           or (v_mem.starts_at is not null and v_cdate < v_mem.starts_at) then
            n_outside := n_outside + 1;
            continue;
        end if;
        n_ok := n_ok + 1;

        if exists (
            select 1 from center_holidays ch
            where ch.center_id = v_class.center_id and ch.holiday_date = v_cdate
        ) then
            n_window := n_window + 1;
            continue;
        end if;

        if v_cdate = any(v_used_dates) then
            n_dup := n_dup + 1;
            continue;
        end if;
        if exists (
            select 1 from reservations r
            join classes c2 on c2.id = r.class_id
            where r.profile_id = v_mem.profile_id
              and r.status in ('confirmed', 'waitlisted', 'attended')
              and (c2.start_time at time zone 'Asia/Seoul')::date = v_cdate
        ) then
            v_used_dates := array_append(v_used_dates, v_cdate);
            n_dup := n_dup + 1;
            continue;
        end if;

        if v_class.booking_deadline_min is not null then
            v_book_deadline := v_class.start_time - make_interval(mins => v_class.booking_deadline_min);
        else
            v_book_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'book');
            if v_book_deadline is null then
                v_book_deadline := v_class.start_time;
            end if;
        end if;
        if now() > v_book_deadline then
            n_window := n_window + 1;
            continue;
        end if;

        v_open_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'open');
        if v_open_deadline is not null and now() < v_open_deadline then
            n_window := n_window + 1;
            continue;
        end if;

        if v_class.class_format = 'private' and coalesce(v_pmc_enabled, false) and v_pmc_limit is not null then
            select count(*) into v_concurrent
            from classes c2
            join reservations r2 on r2.class_id = c2.id and r2.status = 'confirmed'
            where c2.center_id = v_mem.center_id
              and c2.class_format = 'private'
              and c2.id <> v_class.id
              and c2.status <> 'cancelled'
              and c2.start_time < v_class.end_time
              and c2.end_time > v_class.start_time;
            if v_concurrent >= v_pmc_limit then
                n_window := n_window + 1;
                continue;
            end if;
        end if;

        if coalesce(v_daily_enabled, false) and v_daily_limit is not null then
            select count(*) into v_daily_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = v_mem.profile_id
              and c.center_id = v_mem.center_id
              and (c.start_time at time zone 'Asia/Seoul')::date = v_cdate
              and r.status in ('confirmed', 'waitlisted');
            if v_daily_count >= v_daily_limit then
                v_used_dates := array_append(v_used_dates, v_cdate);
                n_dup := n_dup + 1;
                continue;
            end if;
        end if;

        select count(*) into v_taken
        from reservations
        where class_id = v_class.id and status in ('confirmed', 'attended');
        if v_taken >= v_class.capacity then
            n_full := n_full + 1;
            continue;
        end if;

        if not p_dry_run then
            insert into reservations (class_id, profile_id, membership_id, status)
            values (v_class.id, v_mem.profile_id, v_mem.id, 'confirmed');
        end if;
        v_used_dates := array_append(v_used_dates, v_cdate);
        v_left := v_left - 1;
        v_booked := v_booked + 1;
    end loop;

    if v_booked > 0 and not p_dry_run then
        update memberships
           set remaining_count = remaining_count - v_booked
         where id = p_membership_id
           and remaining_count is not null;
    end if;

    -- 못 채운 횟수가 있으면 주된 사유 하나를 고른다.
    --   outside_membership_period: 만료일 안에 둘 수 있는 후보는 다 찼고, 남은 건 만료일 이후 수업뿐
    if v_left <= 0 then
        v_reason := 'ok';
    elsif n_ok = 0 and n_outside > 0 then
        v_reason := 'outside_membership_period';
    elsif n_full > 0 then
        v_reason := 'capacity_full';
    elsif n_dup > 0 then
        v_reason := 'already_reserved';
    elsif n_window > 0 then
        v_reason := 'booking_window';
    elsif n_ok = 0 and n_mismatch > 0 then
        v_reason := 'condition_mismatch';
    elsif n_outside > 0 then
        v_reason := 'outside_membership_period';
    else
        v_reason := 'no_class_in_period';
    end if;

    return jsonb_build_object(
        'booked', v_booked,
        'unplaced', v_left,
        'reason', v_reason,
        'skipped', jsonb_build_object(
            'outside_period', n_outside, 'condition_mismatch', n_mismatch,
            'already_reserved', n_dup, 'capacity_full', n_full, 'booking_window', n_window)
    );
end;
$$;


ALTER FUNCTION "public"."_auto_book_membership_core"("p_membership_id" "uuid", "p_dry_run" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_is_owner_of_center"("p_center_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
    select exists (
        select 1
        from manager_centers mc
        join center_roles cr on cr.id = mc.role_id
        where mc.center_id = p_center_id
          and mc.account_id = my_account_id()
          and cr.is_owner
          and mc.status = 'active'
    );
$$;


ALTER FUNCTION "public"."_is_owner_of_center"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_is_phone_recently_verified"("p_phone" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select exists (
        select 1 from phone_verifications
        where phone = p_phone
          and verified_at is not null
          and verified_at > now() - interval '15 minutes'
    );
$$;


ALTER FUNCTION "public"."_is_phone_recently_verified"("p_phone" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "product_id" "uuid",
    "product_name" "text" NOT NULL,
    "amount" integer DEFAULT 0 NOT NULL,
    "pay_method" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "paid_at" timestamp with time zone,
    "selected_size" "text",
    "coupon_code" "text",
    "discount_amount" integer DEFAULT 0 NOT NULL,
    "auto_book" boolean DEFAULT false NOT NULL,
    "payment_provider" "text",
    "verified" boolean DEFAULT false NOT NULL,
    "points_used" integer DEFAULT 0 NOT NULL,
    "member_coupon_id" "uuid",
    "selected_day_of_week" integer,
    "selected_start_time" time without time zone,
    "selected_count" integer,
    "product_amount_snapshot" integer,
    CONSTRAINT "orders_payment_provider_check" CHECK ((("payment_provider" IS NULL) OR ("payment_provider" = ANY (ARRAY['mock'::"text", 'toss'::"text", 'portone'::"text"])))),
    CONSTRAINT "orders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'paid'::"text", 'cancelled'::"text", 'done'::"text"])))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


COMMENT ON COLUMN "public"."orders"."payment_provider" IS 'Payment Adapter가 이 주문을 처리한 provider(mock/toss/portone). null=레거시 매니저 수동 확인 경로';



COMMENT ON COLUMN "public"."orders"."verified" IS 'create_order_secure() RPC로 생성돼 서버가 금액을 직접 계산했는지. false=레거시/직접 insert 경로(fulfill_order 등에서 products.price와 재대조 필요)';



COMMENT ON COLUMN "public"."orders"."points_used" IS 'checkout에서 이 주문에 사용한 포인트(원 단위). use_points() 호출 시 이 주문번호로
     남긴 point_transactions 행이 실제로 있는지로 검증됨(클라이언트 주장을 그대로 믿지 않음)';



COMMENT ON COLUMN "public"."orders"."selected_day_of_week" IS '구매 시 고른 요일(0=일~6=토). weekday_selectable 상품만 채워짐.';



COMMENT ON COLUMN "public"."orders"."selected_start_time" IS '구매 시 고른 시간. time_selectable 상품만 채워짐.';



CREATE OR REPLACE FUNCTION "public"."_issue_membership_and_record_payment"("p_order" "public"."orders", "p_provider_ref" "text", "p_memo" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_product           record;
    v_membership_id     uuid;
    v_count             int;
    v_expires           date;
    v_starts            date;
    v_rm                record;
    v_expected_amount   int;
    v_auto              jsonb;
begin
    v_count := null;
    v_expires := null;
    v_starts := (now() at time zone 'Asia/Seoul')::date;
    if p_order.product_id is not null then
        select * into v_product from products where id = p_order.product_id;
        if found then
            if not member_can_purchase_product(p_order.product_id, p_order.profile_id) then
                raise exception '이 수강권을 구매할 수 있는 대상이 아닙니다.';
            end if;

            if coalesce(v_product.purchase_count_selectable, false) then
                if p_order.selected_count is null or p_order.selected_count < 1 then
                    raise exception '구매 횟수 정보가 없는 주문이에요(관리자 문의)';
                end if;
                v_count := p_order.selected_count;
            else
                v_count := case when v_product.unlimited_pass then null else v_product.total_count end;
            end if;

            if v_product.expiry_mode = 'rolling_month' then
                select * into v_rm from calc_rolling_month_dates(now(), v_product.rolling_month_cutoff_day);
                v_expires := v_rm.expires_at;
                if not coalesce(v_product.rolling_month_allow_early_use, false) then
                    v_starts := v_rm.starts_at;
                end if;
            else
                v_expires := case v_product.expiry_mode
                    when 'date' then v_product.expiry_date
                    when 'days' then ((now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval) at time zone 'Asia/Seoul')::date
                    else null
                end;
            end if;

            v_expected_amount := _order_expected_amount(p_order, true);
            if p_order.amount is distinct from v_expected_amount then
                raise exception '주문 금액이 상품 가격과 일치하지 않아요(관리자 문의)';
            end if;
        end if;
    end if;

    update orders set status = 'paid', paid_at = now() where id = p_order.id;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, starts_at, status,
        bound_day_of_week, bound_start_time, selected_size, auto_book_requested
    ) values (
        p_order.profile_id, p_order.center_id, p_order.product_id, p_order.product_name,
        'count', v_count, v_count, v_expires, v_starts, 'active',
        p_order.selected_day_of_week, p_order.selected_start_time, p_order.selected_size,
        coalesce(p_order.auto_book, false)
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

    if p_order.member_coupon_id is not null then
        update member_coupons
           set status = 'used', used_at = now(), order_id = p_order.id
         where id = p_order.member_coupon_id;
    end if;

    v_auto := _order_auto_book(v_membership_id, coalesce(p_order.auto_book, false));

    update orders set status = 'done' where id = p_order.id;

    return (jsonb_build_object('membership_id', v_membership_id, 'amount', p_order.amount) || v_auto)::json;
end;
$$;


ALTER FUNCTION "public"."_issue_membership_and_record_payment"("p_order" "public"."orders", "p_provider_ref" "text", "p_memo" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_order_auto_book"("p_membership_id" "uuid", "p_requested" boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_res jsonb;
begin
    if not coalesce(p_requested, false) then
        return jsonb_build_object('auto_book_requested', false, 'auto_booked_count', 0,
                                  'unplaced_count', 0, 'auto_book_reason', 'not_requested');
    end if;
    begin
        v_res := _auto_book_membership_core(p_membership_id, false);
    exception when others then
        -- 서브트랜잭션이라 코어가 일부 예약을 만들었어도 모두 되돌려진다(부분 차감 없음).
        return jsonb_build_object('auto_book_requested', true, 'auto_booked_count', 0,
                                  'unplaced_count', null, 'auto_book_reason', 'error',
                                  'auto_book_error', sqlstate || ': ' || sqlerrm);
    end;
    return jsonb_build_object('auto_book_requested', true,
                              'auto_booked_count', coalesce((v_res->>'booked')::int, 0),
                              'unplaced_count', coalesce((v_res->>'unplaced')::int, 0),
                              'auto_book_reason', v_res->>'reason');
end;
$$;


ALTER FUNCTION "public"."_order_auto_book"("p_membership_id" "uuid", "p_requested" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_order_expected_amount"("p_order" "public"."orders", "p_lock" boolean DEFAULT false) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_product           record;
    v_member_coupon     record;
    v_verified_discount int := 0;
    v_points_verified   boolean;
    v_base              int;
begin
    if p_order.product_id is null then
        return null;
    end if;
    select * into v_product from products where id = p_order.product_id;
    if not found then
        return null;
    end if;

    -- 상품 기본금액: 주문 생성 시점에 서버(orders BEFORE INSERT 트리거)가 확정한 snapshot — 이후 상품 가격이
    -- 바뀌어도 기존 주문의 검증/발급 금액이 변하지 않는다. snapshot이 없는 옛 주문만 현재 상품가로 계산한다.
    v_base := coalesce(p_order.product_amount_snapshot, v_product.price);

    if p_order.member_coupon_id is not null then
        if not coalesce(v_product.coupon_eligible, true) then
            raise exception '이 수강권은 쿠폰을 적용할 수 없어요.';
        end if;

        if p_lock then
            select mc.*, c.discount_type, c.discount_value, c.max_discount_amount,
                   c.minimum_order_amount, c.applies_to, c.valid_from, c.valid_until,
                   c.status as coupon_status, c.center_id as coupon_center_id
              into v_member_coupon
              from member_coupons mc
              join coupons c on c.id = mc.coupon_id
             where mc.id = p_order.member_coupon_id
             for update of mc;
        else
            select mc.*, c.discount_type, c.discount_value, c.max_discount_amount,
                   c.minimum_order_amount, c.applies_to, c.valid_from, c.valid_until,
                   c.status as coupon_status, c.center_id as coupon_center_id
              into v_member_coupon
              from member_coupons mc
              join coupons c on c.id = mc.coupon_id
             where mc.id = p_order.member_coupon_id;
        end if;

        if not found then
            raise exception '쿠폰을 찾을 수 없어요';
        end if;
        if not exists (
            select 1 from center_members cm
            where cm.id = v_member_coupon.center_member_id
              and cm.profile_id = p_order.profile_id
        ) then
            raise exception '본인에게 지급된 쿠폰만 사용할 수 있어요';
        end if;
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
        if v_member_coupon.minimum_order_amount is not null and v_base < v_member_coupon.minimum_order_amount then
            raise exception '최소 결제금액(%원) 미만이라 쿠폰을 사용할 수 없어요', v_member_coupon.minimum_order_amount;
        end if;

        if v_member_coupon.discount_type = 'fixed' then
            v_verified_discount := v_member_coupon.discount_value;
        else
            v_verified_discount := least(
                (v_base * v_member_coupon.discount_value) / 100,
                coalesce(v_member_coupon.max_discount_amount, v_base)
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

    return greatest(0, v_base - v_verified_discount - coalesce(p_order.points_used, 0));
end;
$$;


ALTER FUNCTION "public"."_order_expected_amount"("p_order" "public"."orders", "p_lock" boolean) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."memberships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "center_id" "uuid" NOT NULL,
    "product_name" "text" NOT NULL,
    "pass_type" "text" DEFAULT 'count'::"text" NOT NULL,
    "total_count" integer,
    "remaining_count" integer,
    "starts_at" "date" DEFAULT CURRENT_DATE NOT NULL,
    "expires_at" "date",
    "auto_renew" boolean DEFAULT false NOT NULL,
    "paused_from" "date",
    "paused_until" "date",
    "allow_multi_booking" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "trainer_account_id" "uuid",
    "issued_at" "date" DEFAULT CURRENT_DATE NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "product_id" "uuid",
    "bound_profile_id" "uuid",
    "bound_day_of_week" integer,
    "bound_start_time" time without time zone,
    "selected_size" "text",
    "auto_book_requested" boolean DEFAULT false NOT NULL,
    "pg_refund_started_at" timestamp with time zone,
    CONSTRAINT "memberships_pass_type_check" CHECK (("pass_type" = ANY (ARRAY['count'::"text", 'period'::"text"]))),
    CONSTRAINT "memberships_remaining_not_negative" CHECK ((("remaining_count" IS NULL) OR ("remaining_count" >= 0))),
    CONSTRAINT "memberships_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'expired'::"text", 'paused'::"text", 'refunded'::"text", 'transferred'::"text"])))
);


ALTER TABLE "public"."memberships" OWNER TO "postgres";


COMMENT ON TABLE "public"."memberships" IS '회원의 수강권. 횟수권/기간권 구분, 기간권은 자동연장 옵션 가능';



COMMENT ON COLUMN "public"."memberships"."starts_at" IS '이 수강권을 실제로 예약에 쓸 수 있는 시작일(KST), NOT NULL. 기본값(제한 없음,
     구매 즉시 사용 가능)은 current_date(구매일) — null이 아니다. rolling_month 상품이
     대상 월을 다음 달로 넘겼고 allow_early_use가 꺼져있을 때만 그 달 1일로 채워진다';



COMMENT ON COLUMN "public"."memberships"."auto_renew" IS '기간권 만료 시 자동결제로 연장 (CMS)';



COMMENT ON COLUMN "public"."memberships"."allow_multi_booking" IS '같은 시간대 복수 수업 동시 예약 허용 여부';



COMMENT ON COLUMN "public"."memberships"."status" IS 'active(사용중)/expired(만료)/paused(정지)/refunded(환불)/transferred(양도)';



COMMENT ON COLUMN "public"."memberships"."bound_day_of_week" IS '이 수강권으로 예약 가능한 요일(0=일~6=토, null=제한 없음). 구매/발급 시 한 번만
   설정되고 수업이 삭제되거나 스케줄이 바뀌어도 자동으로 바뀌지 않는다(C-12) — 좌표가
   아니라 회원과의 "계약 조건"이기 때문.';



COMMENT ON COLUMN "public"."memberships"."bound_start_time" IS '이 수강권으로 예약 가능한 시간(null=제한 없음). bound_day_of_week와 함께 AND 조건으로
   적용된다(요일만 고르고 시간은 자유로 둔 경우 시간은 null).';



CREATE OR REPLACE FUNCTION "public"."_refund_block_reason"("p_mem" "public"."memberships", "p_skip_time" boolean DEFAULT false) RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_unlimited boolean := false;
    v_hours     numeric;
begin
    select coalesce(p.unlimited, false) into v_unlimited from products p where p.id = p_mem.product_id;
    v_unlimited := coalesce(v_unlimited, false);

    v_hours := extract(epoch from (now() - p_mem.created_at)) / 3600;
    if v_hours > 24 and not coalesce(p_skip_time, false) then
        return '결제 후 24시간이 지나 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;
    -- 사용 여부는 p_skip_time과 무관하게 항상 확인한다
    -- (1) 횟수 소비: 횟수권의 남은 횟수가 총 횟수와 다르면 사용한 것
    if not v_unlimited and p_mem.total_count is not null
       and p_mem.remaining_count is distinct from p_mem.total_count then
        return '이미 사용한 수강권은 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;
    -- (2) 현재 활성 예약/사용 기록: 확정/대기/출석/결석 예약이 이 수강권에 연결돼 있으면 미사용이 아니다.
    --     대기(waitlisted)는 확정 전이라 횟수를 차감하지 않고, 무제한권은 횟수 차감 자체가 없으므로 예약 상태로 판정한다.
    --     취소(cancelled)된 예약은 횟수가 복구된 기존 동작과 같이 미사용으로 본다(예약 이력이 한 번 있었다고 영구 차단하지 않는다).
    if exists (
        select 1 from reservations r
         where r.membership_id = p_mem.id and r.status in ('confirmed', 'waitlisted', 'attended', 'no_show')
    ) then
        return '예약 중이거나 이용한 수업이 있는 수강권은 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;
    return null;
end;
$$;


ALTER FUNCTION "public"."_refund_block_reason"("p_mem" "public"."memberships", "p_skip_time" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_refund_membership_core"("p_membership_id" "uuid", "p_account_id" "uuid", "p_allow_pg" boolean, "p_skip_time_check" boolean) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_mem          memberships;
    v_reason       text;
    v_amount       int := 0;
    v_still_active int := 0;
    v_order_id     uuid;
begin
    select * into v_mem
    from memberships
    where id = p_membership_id
      and profile_id in (
          select id
          from profiles
          where account_id = p_account_id
      )
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

    select
        coalesce(total_amount, 0),
        order_id
    into
        v_amount,
        v_order_id
    from payments
    where membership_id = v_mem.id
    order by paid_at desc
    limit 1;

    v_amount := coalesce(v_amount, 0);

    if not coalesce(p_allow_pg, false)
       and v_order_id is not null
       and exists (
           select 1
           from orders o
           where o.id = v_order_id
             and o.payment_provider in ('toss', 'portone')
       )
    then
        raise exception '카드/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요';
    end if;

    perform set_config('app.pg_refund_write', 'on', true);

    update memberships
       set status = 'refunded',
           remaining_count = 0,
           pg_refund_started_at = null
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

    if v_order_id is not null then
        update member_coupons
           set status = 'available',
               used_at = null,
               order_id = null
         where order_id = v_order_id
           and status = 'used';

        perform _restore_order_points(v_order_id, '환불 포인트 복원');
    end if;

    select count(*)
    into v_still_active
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

    return json_build_object(
        'refunded', true,
        'amount', v_amount
    );
end;
$$;


ALTER FUNCTION "public"."_refund_membership_core"("p_membership_id" "uuid", "p_account_id" "uuid", "p_allow_pg" boolean, "p_skip_time_check" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_restore_order_points"("p_order_id" "uuid", "p_reason" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_row      record;
    v_inserted integer;
    v_restored integer := 0;
begin
    perform 1 from orders where id = p_order_id for update;   -- 주문 단위로 직렬화
    if not found then
        return 0;
    end if;

    for v_row in
        select id, profile_id, center_id, amount
          from point_transactions
         where order_id = p_order_id
           and reason = '결제 시 사용'
           and amount < 0
         order by created_at, id
    loop
        insert into point_transactions (profile_id, center_id, amount, reason, order_id, reverses_id)
        values (v_row.profile_id, v_row.center_id, -v_row.amount, p_reason, p_order_id, v_row.id)
        on conflict (reverses_id) where reverses_id is not null do nothing;
        get diagnostics v_inserted = row_count;
        if v_inserted > 0 then
            v_restored := v_restored + (-v_row.amount);
        end if;
    end loop;

    return v_restored;
end;
$$;


ALTER FUNCTION "public"."_restore_order_points"("p_order_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_holiday_safe"("p_center_id" "uuid", "p_date" "date", "p_reason" "text" DEFAULT NULL::"text", "p_force" boolean DEFAULT false) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    v_class_ids  uuid[];
    v_active_cnt int;
    v_admin_id   uuid;
begin
    -- 권한 확인 (센터 관리자/오너)
    if not has_permission(p_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '휴무일을 지정할 권한이 없어요';
    end if;

    v_admin_id := my_account_id();

    -- 그날 그 센터의 수업 id 모음 (KST 기준 날짜). 이미 폐강 처리된 수업은 다시 대상으로
    -- 잡지 않는다(재호출 시 멱등성 유지 — 기존에도 DELETE 후 재호출하면 대상이 없어 동일했음).
    select array_agg(id) into v_class_ids
    from classes
    where center_id = p_center_id
      and (start_time at time zone 'Asia/Seoul')::date = p_date
      and status <> 'cancelled';

    -- 살아있는 예약 수 (확정/대기/출석)
    v_active_cnt := 0;
    if v_class_ids is not null then
        select count(*) into v_active_cnt
        from reservations
        where class_id = any(v_class_ids)
          and status in ('confirmed','waitlisted','attended');
    end if;

    -- 예약이 있는데 강제 아님 → 확인 요청
    if v_active_cnt > 0 and not p_force then
        return json_build_object(
            'needs_confirm', true,
            'class_count', coalesce(array_length(v_class_ids, 1), 0),
            'reservation_count', v_active_cnt
        );
    end if;

    if v_class_ids is not null then
        -- [P0-6] 취소로 사라질 예약 중 실제로 수강권을 차감했던 것만 복구
        update memberships m
        set remaining_count = remaining_count + sub.cnt
        from (
            select r.membership_id, count(*) as cnt
            from reservations r
            where r.class_id = any(v_class_ids)
              and r.status in ('confirmed', 'attended')
              and r.membership_consumed
              and r.membership_id is not null
            group by r.membership_id
        ) sub
        where m.id = sub.membership_id
          and m.remaining_count is not null;

        -- [E-4/E-5 재설계] 예약을 삭제하지 않고 취소 처리로 남겨 이력을 보존한다.
        -- trg_notify_reservation_update가 이 UPDATE로 자동 발동해 회원에게 알림을 생성한다.
        update reservations
        set status = 'cancelled',
            cancel_reason = coalesce(p_reason, '센터 휴무일 지정으로 자동 취소'),
            cancel_source = 'HOLIDAY',
            cancelled_by = v_admin_id,
            cancelled_at = now()
        where class_id = any(v_class_ids)
          and status in ('confirmed', 'waitlisted', 'attended');

        -- 수업도 삭제 대신 폐강(cancelled) 처리 — 이력·스냅샷 보존, FK 문제 없음
        update classes set status = 'cancelled' where id = any(v_class_ids);
    end if;

    -- 휴무일 등록 (이미 있으면 무시)
    insert into center_holidays (center_id, holiday_date, reason)
    values (p_center_id, p_date, p_reason)
    on conflict do nothing;

    return json_build_object(
        'needs_confirm', false,
        'deleted_classes', coalesce(array_length(v_class_ids, 1), 0),
        'cancelled_reservations', v_active_cnt
    );
end;
$$;


ALTER FUNCTION "public"."add_holiday_safe"("p_center_id" "uuid", "p_date" "date", "p_reason" "text", "p_force" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_assign_reservation"("p_class_id" "uuid", "p_profile_id" "uuid", "p_assignment_type" "text", "p_membership_id" "uuid" DEFAULT NULL::"uuid", "p_reason_code" "text" DEFAULT NULL::"text", "p_reason_detail" "text" DEFAULT NULL::"text", "p_force_capacity" boolean DEFAULT false) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_class            record;
    v_mem              record;
    v_confirmed        int;
    v_is_override      boolean := false;
    v_reason_detail    text;
    v_reservation_id   uuid;
    v_admin_id         uuid;
    v_target_withdrawn boolean;
    v_target_status    text;
begin
    if p_assignment_type not in ('ADMIN_ASSIGNMENT', 'ADMIN_FREE') then
        raise exception '잘못된 배치 방식이에요';
    end if;
    if p_reason_code is not null and p_reason_code not in (
        'MEMBER_REQUEST', 'MAKEUP_CLASS', 'TRIAL', 'EVENT',
        'SERVICE_COMPENSATION', 'CENTER_OPERATION', 'VIP_INVITATION',
        'ERROR_CORRECTION', 'OTHER'
    ) then
        raise exception '잘못된 배치 사유예요';
    end if;

    v_admin_id := my_account_id();

    select * into v_class from classes where id = p_class_id for update;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;
    if v_class.status = 'cancelled' then
        raise exception '수업이 취소되었어요';
    end if;
    if v_class.status = 'closed' then
        raise exception '현재 배치할 수 없는 수업이에요';
    end if;
    if v_class.start_time <= now() then
        raise exception '수업이 이미 시작되었어요';
    end if;

    if not can_manage_center_reservations(v_class.center_id) then
        raise exception '관리자 권한이 없어요';
    end if;

    if not is_profile_assignable(p_profile_id) then
        raise exception '해당 회원을 찾을 수 없어요';
    end if;

    -- [P1-10] 탈퇴/휴면 회원은 customer.member.assign_any_status 권한이 있어야 배치 가능
    select
        (a.deactivated_at is not null),
        cm.status
    into v_target_withdrawn, v_target_status
    from profiles pr
    join accounts a on a.id = pr.account_id
    left join center_members cm on cm.center_id = v_class.center_id and cm.profile_id = pr.id
    where pr.id = p_profile_id;

    if (coalesce(v_target_withdrawn, false) or v_target_status = 'dormant')
       and not has_permission(v_class.center_id, 'customer.member.assign_any_status') then
        raise exception '이용정지·탈퇴·휴면 회원은 이 권한이 있어야 직접배치할 수 있어요';
    end if;

    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = p_profile_id
          and status in ('confirmed', 'waitlisted', 'attended')
    ) then
        raise exception '이미 이 수업에 예약된 회원이에요';
    end if;

    if v_class.class_format = 'private' then
        declare
            v_pmc_enabled boolean;
            v_pmc_limit   int;
            v_concurrent  int;
        begin
            select private_max_concurrent_enabled, private_max_concurrent
              into v_pmc_enabled, v_pmc_limit
            from center_settings where center_id = v_class.center_id;

            if coalesce(v_pmc_enabled, false) and v_pmc_limit is not null then
                select count(*) into v_concurrent
                from classes c2
                join reservations r2 on r2.class_id = c2.id and r2.status = 'confirmed'
                where c2.center_id = v_class.center_id
                  and c2.class_format = 'private'
                  and c2.id <> v_class.id
                  and c2.status <> 'cancelled'
                  and c2.start_time < v_class.end_time
                  and c2.end_time > v_class.start_time;

                if v_concurrent >= v_pmc_limit then
                    raise exception '같은 시간대에 진행 가능한 프라이빗 수업이 이미 다 찼어요(최대 %건)', v_pmc_limit;
                end if;
            end if;
        end;
    end if;

    if p_assignment_type = 'ADMIN_ASSIGNMENT' then
        if p_membership_id is null then
            raise exception '사용할 수강권을 선택해주세요';
        end if;
        select * into v_mem from memberships
        where id = p_membership_id and profile_id = p_profile_id
        for update;
        if not found then
            raise exception '수강권을 찾을 수 없어요';
        end if;
    else
        p_membership_id := null;
    end if;

    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status in ('confirmed', 'attended');

    if v_confirmed >= v_class.capacity then
        if v_class.class_format = 'private' then
            raise exception '이미 다른 회원이 예약한 프라이빗 수업이라 추가로 배치할 수 없어요';
        end if;
        if not p_force_capacity then
            return json_build_object('needs_capacity_confirm', true);
        end if;
    end if;
    v_is_override := v_confirmed >= v_class.capacity;

    if p_assignment_type = 'ADMIN_FREE' and p_reason_code is null then
        raise exception '무료 추가 배치 사유를 선택해주세요';
    end if;
    if v_is_override and p_reason_code is null then
        raise exception '정원 초과 배치 사유를 입력해주세요';
    end if;
    v_reason_detail := nullif(trim(coalesce(p_reason_detail, '')), '');
    if p_reason_code = 'OTHER' and v_reason_detail is null then
        raise exception '기타 사유를 입력해주세요';
    end if;
    if v_reason_detail is not null and char_length(v_reason_detail) > 200 then
        v_reason_detail := left(v_reason_detail, 200);
    end if;

    insert into reservations (
        class_id, profile_id, membership_id, status,
        reservation_type, reservation_source, created_by_account_id,
        admin_reason_code, admin_reason_detail, is_capacity_override, membership_consumed
    ) values (
        p_class_id, p_profile_id, p_membership_id, 'confirmed',
        p_assignment_type, 'ADMIN', v_admin_id,
        p_reason_code, v_reason_detail, v_is_override, (p_assignment_type = 'ADMIN_ASSIGNMENT')
    ) returning id into v_reservation_id;

    if p_assignment_type = 'ADMIN_ASSIGNMENT' then
        update memberships set remaining_count = remaining_count - 1
        where id = p_membership_id and remaining_count is not null;
    end if;

    insert into admin_action_logs (
        center_id, reservation_id, action_type, reservation_type, reservation_source,
        admin_id, member_profile_id, class_id, membership_id, source_unassigned_id,
        reason_code, reason_detail, capacity_override, membership_consumed,
        member_name_snapshot, class_title_snapshot, class_start_snapshot, after_state
    )
    select
        v_class.center_id, v_reservation_id,
        case when p_assignment_type = 'ADMIN_ASSIGNMENT' then 'CREATE_ASSIGNMENT' else 'CREATE_FREE' end,
        p_assignment_type, 'ADMIN',
        v_admin_id, p_profile_id, p_class_id, p_membership_id,
        case when p_assignment_type = 'ADMIN_ASSIGNMENT' then p_membership_id else null end,
        p_reason_code, v_reason_detail, v_is_override, (p_assignment_type = 'ADMIN_ASSIGNMENT'),
        coalesce(pr.nickname, pr.name, '회원'), v_class.title, v_class.start_time,
        json_build_object('reservation_id', v_reservation_id, 'status', 'confirmed')
    from profiles pr where pr.id = p_profile_id;

    return json_build_object(
        'reservation_id', v_reservation_id,
        'status', 'confirmed',
        'over_capacity', v_is_override
    );
end;
$$;


ALTER FUNCTION "public"."admin_assign_reservation"("p_class_id" "uuid", "p_profile_id" "uuid", "p_assignment_type" "text", "p_membership_id" "uuid", "p_reason_code" "text", "p_reason_detail" "text", "p_force_capacity" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_cancel_center_subscription"("p_center_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
    if not is_platform_admin() then
        raise exception '플랫폼 운영자만 센터의 구독을 취소할 수 있어요';
    end if;

    update center_subscriptions set status = 'canceled', updated_at = now()
    where center_id = p_center_id;

    if not found then
        raise exception '이 센터의 구독 정보를 찾을 수 없어요';
    end if;
end;
$$;


ALTER FUNCTION "public"."admin_cancel_center_subscription"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_cancel_reservation"("p_reservation_id" "uuid", "p_cancel_reason" "text" DEFAULT NULL::"text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_res      record;
    v_class    record;
    v_admin_id uuid;
    v_restored boolean := false;
    v_reason   text;
begin
    select * into v_res from reservations where id = p_reservation_id for update;
    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;
    if v_res.reservation_type not in ('ADMIN_ASSIGNMENT', 'ADMIN_FREE') then
        raise exception '이 예약은 관리자 취소 대상이 아니에요';
    end if;

    select * into v_class from classes where id = v_res.class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_admin_id := my_account_id();
    if not can_manage_center_reservations(v_class.center_id) then
        raise exception '관리자 권한이 없어요';
    end if;

    -- 중복 취소 방지 (같은 예약을 두 번 취소해도 복구가 두 번 일어나지 않도록)
    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이에요';
    end if;

    v_reason := nullif(trim(coalesce(p_cancel_reason, '')), '');
    if v_reason is not null and char_length(v_reason) > 200 then
        v_reason := left(v_reason, 200);
    end if;

    update reservations
       set status = 'cancelled',
           cancelled_by = v_admin_id,
           cancel_reason = v_reason,
           cancelled_at = now(),
           updated_at = now()
     where id = p_reservation_id;

    -- ADMIN_ASSIGNMENT + 실제 차감된 경우에만 수강권 복구. ADMIN_FREE는 복구할 것이 없음.
    if v_res.reservation_type = 'ADMIN_ASSIGNMENT'
       and v_res.membership_consumed
       and v_res.membership_id is not null then
        update memberships set remaining_count = remaining_count + 1
        where id = v_res.membership_id and remaining_count is not null;
        v_restored := true;
    end if;

    insert into admin_action_logs (
        center_id, reservation_id, action_type, reservation_type, reservation_source,
        admin_id, member_profile_id, class_id, membership_id,
        reason_code, reason_detail, capacity_override, membership_consumed,
        member_name_snapshot, class_title_snapshot, class_start_snapshot, before_state, after_state
    )
    select
        v_class.center_id, v_res.id,
        case when v_res.reservation_type = 'ADMIN_ASSIGNMENT' then 'CANCEL_ASSIGNMENT' else 'CANCEL_FREE' end,
        v_res.reservation_type, v_res.reservation_source,
        v_admin_id, v_res.profile_id, v_res.class_id, v_res.membership_id,
        v_res.admin_reason_code, v_reason, v_res.is_capacity_override, v_restored,
        coalesce(pr.nickname, pr.name, '회원'), v_class.title, v_class.start_time,
        json_build_object('status', v_res.status),
        json_build_object('status', 'cancelled', 'restored', v_restored)
    from profiles pr where pr.id = v_res.profile_id;

    return json_build_object('cancelled', true, 'restored', v_restored);
end;
$$;


ALTER FUNCTION "public"."admin_cancel_reservation"("p_reservation_id" "uuid", "p_cancel_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_center_settlement_summary"("p_start" "date", "p_end" "date") RETURNS TABLE("center_id" "uuid", "center_name" "text", "bank_name" "text", "account_number" "text", "account_holder_name" "text", "total_amount" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if not is_platform_admin() then
        raise exception '운영자만 조회할 수 있어요';
    end if;

    return query
    select
        c.id,
        c.name,
        csa.bank_name,
        csa.account_number,
        csa.account_holder_name,
        coalesce(sum(p.total_amount), 0)::bigint
    from centers c
    left join center_settlement_accounts csa on csa.center_id = c.id
    left join payments p
        on p.center_id = c.id
       and p.status = 'paid'
       and p.payment_provider in ('toss', 'portone')
       and p.paid_at::date between p_start and p_end
    group by c.id, c.name, csa.bank_name, csa.account_number, csa.account_holder_name
    having coalesce(sum(p.total_amount), 0) <> 0
    order by c.name;
end;
$$;


ALTER FUNCTION "public"."admin_center_settlement_summary"("p_start" "date", "p_end" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_centers"("p_status" "text") RETURNS TABLE("id" "uuid", "name" "text", "address" "text", "phone" "text", "business_number" "text", "business_license_url" "text", "status" "text", "reject_reason" "text", "created_at" timestamp with time zone, "owner_name" "text", "owner_phone" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
    if public.is_platform_admin() is not true then   -- NULL(계정 없음/함수가 NULL 반환)도 거부: `not NULL`은 NULL이라 통과해 버리므로 IS NOT TRUE로 검사
        raise exception 'forbidden' using errcode = '42501';
    end if;
    if p_status is null or p_status not in ('pending', 'approved', 'rejected') then
        raise exception 'invalid status' using errcode = '22023';
    end if;

    return query
    select c.id, c.name, c.address, c.phone, c.business_number, c.business_license_url,
           c.status, c.reject_reason, c.created_at, o.name, o.phone
    from public.centers c
    left join lateral (
        select a.name, a.phone
        from public.manager_centers mc
        join public.accounts a on a.id = mc.account_id
        where mc.center_id = c.id
        order by mc.created_at asc
        limit 1
    ) o on true
    where c.status = p_status
    order by c.created_at desc;
end;
$$;


ALTER FUNCTION "public"."admin_list_centers"("p_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_centers_page"("p_status" "text", "p_keyword" "text" DEFAULT ''::"text", "p_limit" integer DEFAULT 30, "p_before_created_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_before_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "name" "text", "address" "text", "phone" "text", "business_number" "text", "business_license_url" "text", "status" "text", "reject_reason" "text", "created_at" timestamp with time zone, "owner_name" "text", "owner_phone" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
    if public.is_platform_admin() is not true then   -- NULL(계정 없음/함수가 NULL 반환)도 거부: `not NULL`은 NULL이라 통과해 버리므로 IS NOT TRUE로 검사
        raise exception 'forbidden' using errcode = '42501';
    end if;
    if p_status is null or p_status not in ('pending', 'approved', 'rejected') then
        raise exception 'invalid status' using errcode = '22023';
    end if;

    if p_limit is null or p_limit < 1 or p_limit > 100
       or p_keyword is null or length(p_keyword) > 200
       or (p_before_created_at is null) <> (p_before_id is null) then
        raise exception 'invalid pagination input' using errcode = '22023';
    end if;

    return query
    select c.id, c.name, c.address, c.phone, c.business_number, c.business_license_url,
           c.status, c.reject_reason, c.created_at, o.name, o.phone
    from public.centers c
    left join lateral (
        select a.name, a.phone
        from public.manager_centers mc
        join public.accounts a on a.id = mc.account_id
        where mc.center_id = c.id
        order by mc.created_at asc, mc.id asc
        limit 1
    ) o on true
    where c.status = p_status
      and (p_before_created_at is null or (c.created_at, c.id) < (p_before_created_at, p_before_id))
      and (
        btrim(p_keyword) = ''
        or strpos(lower(coalesce(c.name, '')), lower(btrim(p_keyword))) > 0
        or strpos(lower(coalesce(c.address, '')), lower(btrim(p_keyword))) > 0
        or strpos(lower(coalesce(o.name, '')), lower(btrim(p_keyword))) > 0
        or (regexp_replace(p_keyword, '[^0-9]', '', 'g') <> '' and (
          strpos(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), regexp_replace(p_keyword, '[^0-9]', '', 'g')) > 0
          or strpos(regexp_replace(coalesce(o.phone, ''), '[^0-9]', '', 'g'), regexp_replace(p_keyword, '[^0-9]', '', 'g')) > 0
          or strpos(regexp_replace(coalesce(c.business_number, ''), '[^0-9]', '', 'g'), regexp_replace(p_keyword, '[^0-9]', '', 'g')) > 0
        ))
      )
    order by c.created_at desc, c.id desc
    limit p_limit + 1;
end;
$$;


ALTER FUNCTION "public"."admin_list_centers_page"("p_status" "text", "p_keyword" "text", "p_limit" integer, "p_before_created_at" timestamp with time zone, "p_before_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_reactivate_center_subscription"("p_center_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    v_card_last4 text;
begin
    if not is_platform_admin() then
        raise exception '플랫폼 운영자만 센터의 구독을 재개할 수 있어요';
    end if;

    select card_last4 into v_card_last4 from center_subscriptions where center_id = p_center_id;
    if not found then
        raise exception '이 센터의 구독 정보를 찾을 수 없어요';
    end if;

    update center_subscriptions
    set status = case when v_card_last4 is not null then 'active' else 'pending_billing_setup' end,
        updated_at = now()
    where center_id = p_center_id;
end;
$$;


ALTER FUNCTION "public"."admin_reactivate_center_subscription"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_center_alimtalk_addon"("p_center_id" "uuid", "p_enabled" boolean, "p_price" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    v_existing_price int;
begin
    if not is_platform_admin() then
        raise exception '플랫폼 운영자만 센터의 알림톡 애드온을 설정할 수 있어요';
    end if;

    select alimtalk_addon_unit_price into v_existing_price
    from center_subscriptions where center_id = p_center_id;

    if not found then
        raise exception '이 센터의 구독 정보를 찾을 수 없어요';
    end if;

    if p_enabled and p_price is null and v_existing_price is null then
        raise exception '건당 요금을 입력해주세요';
    end if;

    update center_subscriptions
    set alimtalk_addon = p_enabled,
        alimtalk_addon_unit_price = coalesce(p_price, v_existing_price),
        updated_at = now()
    where center_id = p_center_id;
end;
$$;


ALTER FUNCTION "public"."admin_set_center_alimtalk_addon"("p_center_id" "uuid", "p_enabled" boolean, "p_price" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_center_subscription_plan"("p_center_id" "uuid", "p_plan_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
    if not is_platform_admin() then
        raise exception '플랫폼 운영자만 센터의 구독 플랜을 바꿀 수 있어요';
    end if;

    if not exists (select 1 from subscription_plans where id = p_plan_id) then
        raise exception '존재하지 않는 플랜이에요';
    end if;

    update center_subscriptions set plan_id = p_plan_id, updated_at = now()
    where center_id = p_center_id;

    if not found then
        raise exception '이 센터의 구독 정보를 찾을 수 없어요';
    end if;
end;
$$;


ALTER FUNCTION "public"."admin_set_center_subscription_plan"("p_center_id" "uuid", "p_plan_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_book_membership"("p_membership_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center_id uuid;
begin
    select center_id into v_center_id from memberships where id = p_membership_id;
    if v_center_id is null then
        raise exception '수강권을 찾을 수 없어요';
    end if;
    if not (v_center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 수강권을 자동예약 처리할 권한이 없어요';
    end if;
    return _auto_book_membership_core(p_membership_id, false)::json;
end;
$$;


ALTER FUNCTION "public"."auto_book_membership"("p_membership_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."calc_deadline"("p_center_id" "uuid", "p_class_format" "text", "p_start_time" timestamp with time zone, "p_kind" "text") RETURNS timestamp with time zone
    LANGUAGE "plpgsql" STABLE
    AS $$
declare
    v_settings record;
    v_days int;
    v_time time;
    v_class_date date;
    v_deadline_date date;
begin
    select * into v_settings from center_settings where center_id = p_center_id;
    if not found then
        return null;   -- 설정 없음 → 폴백
    end if;

    -- 형태 + 종류에 맞는 (일수, 시각) 선택
    if p_class_format = 'private' then
        if p_kind = 'book' then
            v_days := v_settings.private_book_days_before;
            v_time := v_settings.private_book_time;
        elsif p_kind = 'open' then
            v_days := v_settings.private_open_days_before;
            v_time := v_settings.private_open_time;
        else
            v_days := v_settings.private_cancel_days_before;
            v_time := v_settings.private_cancel_time;
        end if;
    else
        if p_kind = 'book' then
            v_days := v_settings.group_book_days_before;
            v_time := v_settings.group_book_time;
        elsif p_kind = 'open' then
            v_days := v_settings.group_open_days_before;
            v_time := v_settings.group_open_time;
        else
            v_days := v_settings.group_cancel_days_before;
            v_time := v_settings.group_cancel_time;
        end if;
    end if;

    -- 수업일(한국시간) 기준 N일 전 날짜의 HH:MM (한국시간) 을 마감으로
    v_class_date := (p_start_time at time zone 'Asia/Seoul')::date;
    v_deadline_date := v_class_date - make_interval(days => v_days);

    -- 한국시간의 (날짜 + 시각) 을 timestamptz 로
    return ((v_deadline_date::text || ' ' || v_time::text) || '+09')::timestamptz;
end;
$$;


ALTER FUNCTION "public"."calc_deadline"("p_center_id" "uuid", "p_class_format" "text", "p_start_time" timestamp with time zone, "p_kind" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."calc_rolling_month_dates"("p_purchase_ts" timestamp with time zone, "p_cutoff_day" integer) RETURNS TABLE("starts_at" "date", "expires_at" "date")
    LANGUAGE "sql" STABLE
    AS $$
    select
        case
            when extract(day from (p_purchase_ts at time zone 'Asia/Seoul')) >= p_cutoff_day
                then (date_trunc('month', (p_purchase_ts at time zone 'Asia/Seoul')::date) + interval '1 month')::date
            else date_trunc('month', (p_purchase_ts at time zone 'Asia/Seoul')::date)::date
        end as starts_at,
        case
            when extract(day from (p_purchase_ts at time zone 'Asia/Seoul')) >= p_cutoff_day
                then (date_trunc('month', (p_purchase_ts at time zone 'Asia/Seoul')::date) + interval '2 months' - interval '1 day')::date
            else (date_trunc('month', (p_purchase_ts at time zone 'Asia/Seoul')::date) + interval '1 month' - interval '1 day')::date
        end as expires_at;
$$;


ALTER FUNCTION "public"."calc_rolling_month_dates"("p_purchase_ts" timestamp with time zone, "p_cutoff_day" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_manage_center_reservations"("p_center_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select has_permission(p_center_id, 'schedule.makeup') or is_platform_admin();
$$;


ALTER FUNCTION "public"."can_manage_center_reservations"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_write_class"("p_class_id" "uuid", "p_center_id" "uuid", "p_class_format" "text", "p_start_time" timestamp with time zone, "p_action" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_is_own boolean;
    v_verb   text;
    v_key    text;
begin
    if p_action = 'create' then
        -- create_class_safe()와 동일: 생성 시점엔 아직 담당 강사 배정이 없으므로 항상 own.
        v_is_own := true;
    else
        v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
                 or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    end if;

    v_verb := case when p_start_time < now() then 'past_' || p_action else p_action end;
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when p_class_format = 'private' then 'private' else 'group' end) || '.' || v_verb;

    return has_permission(p_center_id, v_key) or is_platform_admin();
end;
$$;


ALTER FUNCTION "public"."can_write_class"("p_class_id" "uuid", "p_center_id" "uuid", "p_class_format" "text", "p_start_time" timestamp with time zone, "p_action" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_real_payment"("p_order_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_order orders;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if v_order.payment_provider is distinct from 'toss' and v_order.payment_provider is distinct from 'portone' then
        raise exception '실 결제 취소는 실제 PG 주문에만 사용할 수 있어요';
    end if;

    if v_order.status = 'done' then
        raise exception '이미 발급된 주문은 취소할 수 없어요';
    end if;

    update orders set status = 'cancelled' where id = p_order_id;

    return json_build_object('cancelled', true);
end;
$$;


ALTER FUNCTION "public"."cancel_real_payment"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_reservation"("p_reservation_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_res         record;
    v_class       record;
    v_next        record;
    v_next_mem    record;
    v_promoted    boolean := false;
    v_skip_refund boolean := false;
    v_can_promote boolean := true;
begin
    select *
    into v_res
    from reservations
    where id = p_reservation_id
      and profile_id in (
          select id
          from profiles
          where account_id = my_account_id()
      )
    for update;

    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;

    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이에요';
    end if;

    select *
    into v_class
    from classes
    where id = v_res.class_id;

    if found then
        if now() >= v_class.start_time then
            raise exception '수업이 이미 시작되어 취소할 수 없어요';
        end if;

        declare
            v_cancel_deadline    timestamptz;
            v_deduct_late        boolean := false;
            v_is_late            boolean := false;
            v_grace_deadline     timestamptz;
            v_same_day_deadline  timestamptz;
            v_effective_deadline timestamptz;
            v_settings           record;
        begin
            if v_class.cancel_deadline_min is not null then
                v_cancel_deadline :=
                    v_class.start_time
                    - make_interval(
                        mins => v_class.cancel_deadline_min
                    );
            else
                v_cancel_deadline :=
                    calc_deadline(
                        v_class.center_id,
                        v_class.class_format,
                        v_class.start_time,
                        'cancel'
                    );

                if v_cancel_deadline is null then
                    v_cancel_deadline := v_class.start_time;
                end if;
            end if;

            v_grace_deadline :=
                least(
                    v_res.created_at + interval '10 minutes',
                    v_class.start_time
                );

            if v_class.allow_cancel is false
               and now() > v_grace_deadline then
                raise exception '이 수업은 예약 취소가 불가능해요';
            end if;

            select *
            into v_settings
            from center_settings
            where center_id = v_class.center_id;

            if v_settings.center_id is not null
               and (
                    v_res.created_at
                    at time zone 'Asia/Seoul'
               )::date = (
                    v_class.start_time
                    at time zone 'Asia/Seoul'
               )::date
               and (
                    v_cancel_deadline
                    at time zone 'Asia/Seoul'
               )::date < (
                    now()
                    at time zone 'Asia/Seoul'
               )::date
            then
                v_same_day_deadline :=
                    v_class.start_time
                    - make_interval(
                        hours => coalesce(
                            v_settings.same_day_change_hours,
                            0
                        ),
                        mins => coalesce(
                            v_settings.same_day_change_minutes,
                            0
                        )
                    );

                v_effective_deadline :=
                    greatest(
                        v_cancel_deadline,
                        v_grace_deadline,
                        v_same_day_deadline
                    );
            else
                v_effective_deadline :=
                    greatest(
                        v_cancel_deadline,
                        v_grace_deadline
                    );
            end if;

            v_is_late := now() > v_effective_deadline;

            v_deduct_late :=
                coalesce(
                    v_settings.deduct_on_late_cancel,
                    false
                );

            if v_is_late and not v_deduct_late then
                raise exception '취소 마감시간이 지났어요';
            end if;

            v_skip_refund :=
                v_is_late
                and v_deduct_late;

            if coalesce(v_settings.waitlist_auto_hours, 0) = 0
               and coalesce(v_settings.waitlist_auto_minutes, 0) = 0 then

                v_can_promote := true;
            else
                v_can_promote :=
                    now()
                    < v_class.start_time
                    - make_interval(
                        hours => v_settings.waitlist_auto_hours,
                        mins => v_settings.waitlist_auto_minutes
                    );
            end if;
        end;
    end if;

    update reservations
    set status = 'cancelled',
        cancel_source = 'MEMBER'
    where id = p_reservation_id;

    if v_res.status = 'confirmed' then
        if not v_skip_refund then
            update memberships
            set remaining_count = remaining_count + 1
            where id = v_res.membership_id
              and status not in ('refunded', 'transferred');
        end if;

        if v_can_promote then
            for v_next in
                select *
                from reservations
                where class_id = v_res.class_id
                  and status = 'waitlisted'
                order by waitlist_order asc
                for update
            loop
                select *
                into v_next_mem
                from memberships m
                where m.id = v_next.membership_id
                  and m.status = 'active'
                  and (
                      m.remaining_count is null
                      or m.remaining_count > 0
                  )
                  and (
                      m.expires_at is null
                      or m.expires_at >= (
                          now()
                          at time zone 'Asia/Seoul'
                      )::date
                  )
                  and (
                      m.starts_at is null
                      or m.starts_at <= (
                          now()
                          at time zone 'Asia/Seoul'
                      )::date
                  )
                  and is_membership_eligible_for_class(
                      m.id,
                      v_res.class_id
                  )
                for update;

                if found then
                    update reservations
                    set status = 'confirmed',
                        waitlist_order = null,
                        membership_consumed = true
                    where id = v_next.id;

                    update memberships
                    set remaining_count = remaining_count - 1
                    where id = v_next_mem.id
                      and remaining_count is not null;

                    v_promoted := true;
                    exit;
                end if;
            end loop;
        end if;
    end if;

    return json_build_object(
        'cancelled', true,
        'waitlist_promoted', v_promoted,
        'deducted', v_skip_refund
    );
end;
$$;


ALTER FUNCTION "public"."cancel_reservation"("p_reservation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_test_payment"("p_order_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    v_order record;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if v_order.profile_id not in (select my_profile_ids()) then
        raise exception '본인 주문만 취소할 수 있어요';
    end if;

    if v_order.payment_provider is distinct from 'mock' then
        raise exception '테스트 결제 취소는 Mock 결제 주문에만 사용할 수 있어요';
    end if;

    if v_order.status = 'done' then
        raise exception '이미 발급된 주문은 취소할 수 없어요';
    end if;

    update orders set status = 'cancelled' where id = p_order_id;

    return json_build_object('cancelled', true);
end;
$$;


ALTER FUNCTION "public"."cancel_test_payment"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."center_cancel_own_subscription"("p_center_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
    if not _is_owner_of_center(p_center_id) then
        raise exception '이 센터의 오너만 구독을 취소할 수 있어요';
    end if;

    update center_subscriptions set status = 'canceled', updated_at = now() where center_id = p_center_id;
end;
$$;


ALTER FUNCTION "public"."center_cancel_own_subscription"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."center_change_own_subscription_plan"("p_center_id" "uuid", "p_plan_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    v_plan       subscription_plans;
    v_room_count int;
    v_staff_count int;
    v_member_count int;
    v_product_count int;
begin
    if not _is_owner_of_center(p_center_id) then
        raise exception '이 센터의 오너만 구독 플랜을 바꿀 수 있어요';
    end if;

    select * into v_plan from subscription_plans where id = p_plan_id;
    if not found then
        raise exception '존재하지 않는 플랜이에요';
    end if;

    if v_plan.max_rooms is not null then
        select count(*) into v_room_count from rooms where center_id = p_center_id;
        if v_room_count > v_plan.max_rooms then
            raise exception '현재 룸이 %개라 이 플랜(최대 %개)으로 바꿀 수 없어요. 먼저 룸을 정리해주세요.', v_room_count, v_plan.max_rooms;
        end if;
    end if;

    if v_plan.max_staff is not null then
        select count(*) into v_staff_count
        from manager_centers mc join center_roles cr on cr.id = mc.role_id
        where mc.center_id = p_center_id and mc.status in ('pending', 'active') and not cr.is_owner;
        if v_staff_count > v_plan.max_staff then
            raise exception '현재 스태프가 %명이라 이 플랜(최대 %명)으로 바꿀 수 없어요. 먼저 스태프를 정리해주세요.', v_staff_count, v_plan.max_staff;
        end if;
    end if;

    if v_plan.max_members is not null then
        select count(*) into v_member_count from center_members where center_id = p_center_id;
        if v_member_count > v_plan.max_members then
            raise exception '현재 회원이 %명이라 이 플랜(최대 %명)으로 바꿀 수 없어요. 먼저 회원을 정리해주세요.', v_member_count, v_plan.max_members;
        end if;
    end if;

    if v_plan.max_products is not null then
        select count(*) into v_product_count from products where center_id = p_center_id and is_active;
        if v_product_count > v_plan.max_products then
            raise exception '현재 판매 중 상품이 %종이라 이 플랜(최대 %종)으로 바꿀 수 없어요. 먼저 상품을 정리해주세요.', v_product_count, v_plan.max_products;
        end if;
    end if;

    update center_subscriptions set plan_id = p_plan_id, updated_at = now() where center_id = p_center_id;
end;
$$;


ALTER FUNCTION "public"."center_change_own_subscription_plan"("p_center_id" "uuid", "p_plan_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."center_is_pending"("p_center_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    return exists(select 1 from centers where id = p_center_id and status = 'pending');
end;
$$;


ALTER FUNCTION "public"."center_is_pending"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."center_review_stats"("p_center_id" "uuid") RETURNS TABLE("total" bigint, "avg_rating" numeric, "no_reply" bigint)
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
    select
        count(*),
        round(avg(rating)::numeric, 1),
        count(*) filter (where reply is null)
    from center_reviews
    where center_id = p_center_id
      and (p_center_id in (select my_managed_center_ids()) or is_platform_admin());
$$;


ALTER FUNCTION "public"."center_review_stats"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."center_rows_visible"("p_center_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select coalesce(
        p_center_id is null
        or not exists (select 1 from public.centers c where c.id = p_center_id and c.is_internal)
        or p_center_id in (select public.my_member_center_ids())
        or p_center_id in (select public.my_managed_center_ids())
        or public.is_platform_admin(),
        false);
$$;


ALTER FUNCTION "public"."center_rows_visible"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."class_revenue_daily_summary"("p_center_id" "uuid", "p_from" "date", "p_to" "date") RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_mode   text;
    result   json;
begin
    if not (p_center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 센터의 수업매출을 볼 권한이 없어요';
    end if;
    if p_from > p_to then
        raise exception '시작일이 종료일보다 늦을 수 없어요';
    end if;

    select coalesce(unlimited_pass_revenue_mode, 'usage_split') into v_mode
    from center_settings where center_id = p_center_id;
    v_mode := coalesce(v_mode, 'usage_split');

    with count_sessions as (
        select
            r.membership_id,
            (c.start_time at time zone 'Asia/Seoul')::date as rev_date,
            row_number() over (partition by r.membership_id order by c.start_time) as session_index
        from reservations r
        join classes c on c.id = r.class_id and c.status <> 'cancelled'
        join memberships m on m.id = r.membership_id and m.center_id = p_center_id
        join products pr on pr.id = m.product_id and pr.product_kind = 'pass'
            and m.pass_type = 'count' and coalesce(pr.unlimited_pass, false) = false
        where r.status in ('confirmed', 'attended', 'no_show')
    ),
    membership_paid as (
        select membership_id, sum(total_amount) as paid_total
        from payments
        where center_id = p_center_id and payment_provider is distinct from 'mock' and sale_type <> 'refund'
        group by membership_id
    ),
    count_amounts as (
        select
            cs.rev_date,
            coalesce(
                msa.amount,
                floor(coalesce(mp.paid_total, 0)::numeric / nullif(m.total_count, 0))::int
                    + (case when cs.session_index <= (coalesce(mp.paid_total, 0) % nullif(m.total_count, 1)) then 1 else 0 end)
            , 0) as amount
        from count_sessions cs
        join memberships m on m.id = cs.membership_id
        left join membership_paid mp on mp.membership_id = cs.membership_id
        left join membership_session_amounts msa on msa.membership_id = cs.membership_id and msa.session_index = cs.session_index
        where cs.rev_date between p_from and p_to
    ),
    period_usage_sessions as (
        select
            r.membership_id,
            (c.start_time at time zone 'Asia/Seoul')::date as rev_date,
            count(*) over (partition by r.membership_id) as total_used
        from reservations r
        join classes c on c.id = r.class_id and c.status <> 'cancelled'
        join memberships m on m.id = r.membership_id and m.center_id = p_center_id
        join products pr on pr.id = m.product_id and pr.product_kind = 'pass'
            and (m.pass_type = 'period' or coalesce(pr.unlimited_pass, false) = true)
        where r.status in ('confirmed', 'attended', 'no_show') and v_mode = 'usage_split'
    ),
    period_usage_amounts as (
        select
            pus.rev_date,
            coalesce(floor(coalesce(mp.paid_total, 0)::numeric / nullif(pus.total_used, 0))::int, 0) as amount
        from period_usage_sessions pus
        left join membership_paid mp on mp.membership_id = pus.membership_id
        where pus.rev_date between p_from and p_to
    ),
    period_purchase_amounts as (
        select (p.paid_at at time zone 'Asia/Seoul')::date as rev_date, p.total_amount as amount
        from payments p
        join memberships m on m.id = p.membership_id and m.center_id = p_center_id
        join products pr on pr.id = m.product_id and pr.product_kind = 'pass'
            and (m.pass_type = 'period' or coalesce(pr.unlimited_pass, false) = true)
        where p.center_id = p_center_id and p.payment_provider is distinct from 'mock' and p.sale_type <> 'refund'
          and v_mode = 'purchase_date_full'
          and (p.paid_at at time zone 'Asia/Seoul')::date between p_from and p_to
    ),
    goods_amounts as (
        select (p.paid_at at time zone 'Asia/Seoul')::date as rev_date, p.total_amount as amount
        from payments p
        join memberships m on m.id = p.membership_id and m.center_id = p_center_id
        join products pr on pr.id = m.product_id and pr.product_kind = 'goods'
        where p.center_id = p_center_id and p.payment_provider is distinct from 'mock' and p.sale_type <> 'refund'
          and (p.paid_at at time zone 'Asia/Seoul')::date between p_from and p_to
    ),
    refund_amounts as (
        select (p.paid_at at time zone 'Asia/Seoul')::date as rev_date, p.total_amount as amount
        from payments p
        where p.center_id = p_center_id and p.payment_provider is distinct from 'mock' and p.sale_type = 'refund'
          and (p.paid_at at time zone 'Asia/Seoul')::date between p_from and p_to
    ),
    daily as (
        select
            days.date,
            coalesce((select sum(amount) from count_amounts ca where ca.rev_date = days.date), 0) as class_revenue,
            coalesce((select sum(amount) from period_usage_amounts pa where pa.rev_date = days.date), 0)
                + coalesce((select sum(amount) from period_purchase_amounts ppa where ppa.rev_date = days.date), 0) as period_pass_revenue,
            coalesce((select sum(amount) from goods_amounts ga where ga.rev_date = days.date), 0) as goods_revenue,
            coalesce((select sum(amount) from refund_amounts ra where ra.rev_date = days.date), 0) as refund_amount
        from (select gs::date as date from generate_series(p_from, p_to, interval '1 day') gs) days
    )
    select json_agg(json_build_object(
        'date', d.date,
        'classRevenue', d.class_revenue,
        'periodPassRevenue', d.period_pass_revenue,
        'goodsRevenue', d.goods_revenue,
        'refundAmount', d.refund_amount,
        'total', d.class_revenue + d.period_pass_revenue + d.goods_revenue + d.refund_amount
    ) order by d.date)
    into result
    from daily d;

    return coalesce(result, '[]'::json);
end;
$$;


ALTER FUNCTION "public"."class_revenue_daily_summary"("p_center_id" "uuid", "p_from" "date", "p_to" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."class_revenue_for_date"("p_center_id" "uuid", "p_date" "date") RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_mode  text;
    result  json;
begin
    if not (p_center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 센터의 수업매출을 볼 권한이 없어요';
    end if;

    select coalesce(unlimited_pass_revenue_mode, 'usage_split') into v_mode
    from center_settings where center_id = p_center_id;
    v_mode := coalesce(v_mode, 'usage_split');

    with count_sessions as (
        select
            r.membership_id, r.profile_id, c.id as class_id, c.start_time as class_start_time,
            row_number() over (partition by r.membership_id order by c.start_time) as session_index
        from reservations r
        join classes c on c.id = r.class_id and c.status <> 'cancelled'
        join memberships m on m.id = r.membership_id and m.center_id = p_center_id
        join products pr on pr.id = m.product_id and pr.product_kind = 'pass'
            and m.pass_type = 'count' and coalesce(pr.unlimited_pass, false) = false
        where r.status in ('confirmed', 'attended', 'no_show')
    ),
    membership_paid as (
        select membership_id, sum(total_amount) as paid_total
        from payments
        where center_id = p_center_id and payment_provider is distinct from 'mock' and sale_type <> 'refund'
        group by membership_id
    ),
    period_usage as (
        select membership_id, count(*) as total_used
        from reservations r2
        join classes c2 on c2.id = r2.class_id and c2.status <> 'cancelled'
        where r2.status in ('confirmed', 'attended', 'no_show')
        group by membership_id
    ),
    rows_union as (
        select
            'class'::text as type,
            c.id as class_id, c.title as class_title, c.start_time as time, c.place as place,
            null::text as product_name,
            coalesce(pf.name, '(회원)') as profile_name,
            coalesce(
                msa.amount,
                floor(coalesce(mp.paid_total, 0)::numeric / nullif(m.total_count, 0))::int
                    + (case when cs.session_index <= (coalesce(mp.paid_total, 0) % nullif(m.total_count, 1)) then 1 else 0 end)
            , 0) as amount,
            cs.membership_id as membership_id,
            cs.session_index as session_index,
            m.total_count as total_sessions
        from count_sessions cs
        join memberships m on m.id = cs.membership_id
        join classes c on c.id = cs.class_id
        left join profiles pf on pf.id = cs.profile_id
        left join membership_paid mp on mp.membership_id = cs.membership_id
        left join membership_session_amounts msa on msa.membership_id = cs.membership_id and msa.session_index = cs.session_index
        where (cs.class_start_time at time zone 'Asia/Seoul')::date = p_date

        union all

        select
            'class'::text as type,
            c.id as class_id, c.title as class_title, c.start_time as time, c.place as place,
            null::text as product_name,
            coalesce(pf.name, '(회원)') as profile_name,
            coalesce(floor(coalesce(mp.paid_total, 0)::numeric / nullif(pu.total_used, 0))::int, 0) as amount,
            null::uuid as membership_id,
            null::int as session_index,
            null::int as total_sessions
        from reservations r
        join classes c on c.id = r.class_id and c.status <> 'cancelled'
        join memberships m on m.id = r.membership_id and m.center_id = p_center_id
        join products pr on pr.id = m.product_id and pr.product_kind = 'pass'
            and (m.pass_type = 'period' or coalesce(pr.unlimited_pass, false) = true)
        left join profiles pf on pf.id = r.profile_id
        left join membership_paid mp on mp.membership_id = r.membership_id
        left join period_usage pu on pu.membership_id = r.membership_id
        where r.status in ('confirmed', 'attended', 'no_show')
          and (c.start_time at time zone 'Asia/Seoul')::date = p_date
          and v_mode = 'usage_split'

        union all

        select
            'period_pass'::text as type,
            null::uuid, null::text, null::timestamptz, null::text,
            pr.name as product_name,
            coalesce(pf.name, '(회원)') as profile_name,
            p.total_amount as amount,
            null::uuid, null::int, null::int
        from payments p
        join memberships m on m.id = p.membership_id and m.center_id = p_center_id
        join products pr on pr.id = m.product_id and pr.product_kind = 'pass'
            and (m.pass_type = 'period' or coalesce(pr.unlimited_pass, false) = true)
        left join profiles pf on pf.id = p.profile_id
        where p.center_id = p_center_id and p.payment_provider is distinct from 'mock' and p.sale_type <> 'refund'
          and v_mode = 'purchase_date_full'
          and (p.paid_at at time zone 'Asia/Seoul')::date = p_date

        union all

        select
            'goods'::text as type,
            null::uuid, null::text, null::timestamptz, null::text,
            pr.name as product_name,
            coalesce(pf.name, '(회원)') as profile_name,
            p.total_amount as amount,
            null::uuid, null::int, null::int
        from payments p
        join memberships m on m.id = p.membership_id and m.center_id = p_center_id
        join products pr on pr.id = m.product_id and pr.product_kind = 'goods'
        left join profiles pf on pf.id = p.profile_id
        where p.center_id = p_center_id and p.payment_provider is distinct from 'mock' and p.sale_type <> 'refund'
          and (p.paid_at at time zone 'Asia/Seoul')::date = p_date

        union all

        select
            'refund'::text as type,
            null::uuid, null::text, null::timestamptz, null::text,
            null::text as product_name,
            coalesce(pf.name, '(회원)') as profile_name,
            p.total_amount as amount,
            null::uuid, null::int, null::int
        from payments p
        left join profiles pf on pf.id = p.profile_id
        where p.center_id = p_center_id and p.payment_provider is distinct from 'mock' and p.sale_type = 'refund'
          and (p.paid_at at time zone 'Asia/Seoul')::date = p_date
    )
    select json_agg(json_build_object(
        'type', type, 'classId', class_id, 'classTitle', class_title,
        'time', time, 'place', place, 'productName', product_name,
        'profileName', profile_name, 'amount', amount,
        'membershipId', membership_id, 'sessionIndex', session_index, 'totalSessions', total_sessions
    ))
    into result
    from rows_union;

    return coalesce(result, '[]'::json);
end;
$$;


ALTER FUNCTION "public"."class_revenue_for_date"("p_center_id" "uuid", "p_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."class_rows_visible"("p_class_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select public.center_rows_visible((select c.center_id from public.classes c where c.id = p_class_id));
$$;


ALTER FUNCTION "public"."class_rows_visible"("p_class_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."class_trainer_names"("p_class_ids" "uuid"[]) RETURNS TABLE("class_id" "uuid", "account_id" "uuid", "name" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select ct.class_id, ct.account_id, a.name
    from class_trainers ct
    join accounts a on a.id = ct.account_id
    where ct.class_id = any(p_class_ids)
      and auth.uid() is not null
    order by ct.class_id, ct.sort_order, ct.id;
$$;


ALTER FUNCTION "public"."class_trainer_names"("p_class_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."collect_unpaid_payment"("p_original_payment_id" "uuid", "p_card_amount" numeric, "p_cash_amount" numeric, "p_transfer_amount" numeric, "p_point_amount" numeric, "p_paid_at" timestamp with time zone, "p_memo" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_orig       payments%rowtype;
    v_collected  numeric;
    v_new_id     uuid;
begin
    select * into v_orig from payments where id = p_original_payment_id for update;
    if not found then
        raise exception '원본 결제를 찾을 수 없어요';
    end if;
    if not (has_permission(v_orig.center_id, 'pass.payment.create') or is_platform_admin()) then
        raise exception '매출을 등록할 권한이 없어요';
    end if;
    if coalesce(v_orig.unpaid_amount, 0) <= 0 then
        raise exception '이 결제는 미수금이 없어요';
    end if;

    v_collected := coalesce(p_card_amount, 0) + coalesce(p_cash_amount, 0)
                 + coalesce(p_transfer_amount, 0) + coalesce(p_point_amount, 0);
    if v_collected <= 0 then
        raise exception '받은 금액을 입력해주세요';
    end if;

    insert into payments (
        center_id, profile_id, membership_id, sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, trainer_account_id, paid_at, memo, status,
        linked_unpaid_payment_id
    ) values (
        v_orig.center_id, v_orig.profile_id, v_orig.membership_id, 'unpaid_pay', v_orig.revenue_category,
        coalesce(p_card_amount, 0), coalesce(p_cash_amount, 0), coalesce(p_transfer_amount, 0), coalesce(p_point_amount, 0),
        v_collected, 0, v_orig.trainer_account_id, p_paid_at, p_memo, 'paid',
        p_original_payment_id
    ) returning id into v_new_id;

    update payments
    set unpaid_amount = greatest(0, coalesce(unpaid_amount, 0) - v_collected)
    where id = p_original_payment_id;

    return v_new_id;
end;
$$;


ALTER FUNCTION "public"."collect_unpaid_payment"("p_original_payment_id" "uuid", "p_card_amount" numeric, "p_cash_amount" numeric, "p_transfer_amount" numeric, "p_point_amount" numeric, "p_paid_at" timestamp with time zone, "p_memo" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_real_payment"("p_order_id" "uuid", "p_payment_key" "text", "p_amount" integer) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_order  orders;
    v_result json;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if v_order.payment_provider is distinct from 'toss' and v_order.payment_provider is distinct from 'portone' then
        raise exception '실 결제 확정은 실제 PG 주문에만 사용할 수 있어요';
    end if;

    if v_order.amount is distinct from p_amount then
        raise exception '결제 금액이 주문 금액과 일치하지 않아요';
    end if;

    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    -- [NEW 2026-10-02] 취소된 주문은 다시 확정할 수 없다(취소 시 포인트가 이미 복원됨).
    if v_order.status = 'cancelled' then
        raise exception '취소된 주문은 결제를 확정할 수 없어요';
    end if;

    v_result := _issue_membership_and_record_payment(v_order, p_payment_key, '실 결제(' || v_order.payment_provider || ') 자동 발급');

    return (jsonb_build_object('already_done', false) || v_result::jsonb)::json;
end;
$$;


ALTER FUNCTION "public"."confirm_real_payment"("p_order_id" "uuid", "p_payment_key" "text", "p_amount" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_test_payment"("p_order_id" "uuid", "p_provider_ref" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_order  orders;
    v_result json;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if v_order.profile_id not in (select my_profile_ids()) then
        raise exception '본인 주문만 확정할 수 있어요';
    end if;

    if v_order.payment_provider is distinct from 'mock' then
        raise exception '테스트 결제 확정은 Mock 결제 주문에만 사용할 수 있어요';
    end if;

    -- [NEW 2026-10-02] Mock 확정은 결제 없이 수강권을 만든다 — 내부 QA 센터에서만 허용(실제 센터의 mock 주문으로 무료 발급 방지).
    if not exists (select 1 from centers where id = v_order.center_id and coalesce(is_internal, false)) then
        raise exception '테스트 결제는 내부 QA 센터에서만 사용할 수 있어요';
    end if;

    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    v_result := _issue_membership_and_record_payment(v_order, p_provider_ref, '테스트 결제(Mock Provider) 자동 발급');

    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    return (jsonb_build_object('already_done', false) || v_result::jsonb)::json;
end;
$$;


ALTER FUNCTION "public"."confirm_test_payment"("p_order_id" "uuid", "p_provider_ref" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_email_check_attempt"("p_ip_hash" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    v_lock_key bigint;
    v_recent_count int;
begin
    -- advisory lock 키는 ip_hash 문자열(이미 SHA-256 hex)을 64비트 정수로 접어 만든다 —
    -- hashtext()는 세션 search_path와 무관하게 항상 pg_catalog에 있어 search_path=''에서도
    -- 안전하게 호출된다.
    v_lock_key := ('x' || substr(md5(p_ip_hash), 1, 16))::bit(64)::bigint;
    perform pg_advisory_xact_lock(v_lock_key);

    select count(*) into v_recent_count
    from public.email_check_attempts
    where ip_hash = p_ip_hash
      and created_at >= now() - interval '10 minutes';

    if v_recent_count >= 20 then
        return false;
    end if;

    insert into public.email_check_attempts (ip_hash) values (p_ip_hash);
    return true;
end;
$$;


ALTER FUNCTION "public"."consume_email_check_attempt"("p_ip_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_account_link_code"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_account_id uuid;
    v_code text;
begin
    v_account_id := my_account_id();
    if v_account_id is null then
        raise exception '로그인이 필요해요';
    end if;

    -- 이미 유효한 대기 코드가 있으면 재사용
    select code into v_code from account_link_requests
        where requester_account_id = v_account_id and status = 'pending' and expires_at > now();
    if v_code is not null then
        return v_code;
    end if;

    -- 만료된 pending 행이 남아있으면 정리(unique 인덱스가 계정당 1개 pending만 허용하므로)
    update account_link_requests set status = 'expired'
        where requester_account_id = v_account_id and status = 'pending';

    loop
        v_code := lpad((floor(random() * 100000000))::text, 8, '0');
        exit when not exists (select 1 from account_link_requests where code = v_code and status = 'pending');
    end loop;

    insert into account_link_requests (requester_account_id, code, status, expires_at)
    values (v_account_id, v_code, 'pending', now() + interval '10 minutes');

    return v_code;
end;
$$;


ALTER FUNCTION "public"."create_account_link_code"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_announcement"("p_center_id" "uuid", "p_title" "text", "p_body" "text", "p_photos" "text"[] DEFAULT NULL::"text"[], "p_pinned" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_id uuid;
    v_center_name text;
    r record;
begin
    if not (has_permission(p_center_id, 'board.notice.write') or is_platform_admin()) then
        raise exception '이 센터에 공지할 권한이 없어요';
    end if;

    insert into center_announcements(center_id, title, body, photos, pinned, created_by)
    values (p_center_id, p_title, p_body, p_photos, p_pinned, my_account_id())
    returning id into v_id;

    select name into v_center_name from centers where id = p_center_id;

    -- 이 센터에 관계된 회원 전원(계정 단위 중복 제거)에게 알림
    for r in
        select distinct pr.account_id
          from memberships m
          join profiles pr on pr.id = m.profile_id
         where m.center_id = p_center_id
        union
        select distinct pr2.account_id
          from reservations rv
          join classes c on c.id = rv.class_id
          join profiles pr2 on pr2.id = rv.profile_id
         where c.center_id = p_center_id
    loop
        perform push_notification(
            r.account_id, 'announcement',
            coalesce(v_center_name, '센터') || ' 공지',
            p_title, p_center_id, '/notifications', jsonb_build_object('announcement_id', v_id)
        );
    end loop;

    return v_id;
end;
$$;


ALTER FUNCTION "public"."create_announcement"("p_center_id" "uuid", "p_title" "text", "p_body" "text", "p_photos" "text"[], "p_pinned" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_class_safe"("p_center_id" "uuid", "p_title" "text", "p_description" "text", "p_start_time" timestamp with time zone, "p_end_time" timestamp with time zone, "p_capacity" integer, "p_allow_goods" boolean, "p_room_id" "uuid", "p_cancel_deadline_min" integer, "p_booking_deadline_min" integer, "p_class_format" "text", "p_pass_selection_mode" "text", "p_allow_cancel" boolean DEFAULT true) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_id uuid;
    v_key text;
    v_verb text;
begin
    v_verb := case when p_start_time < now() then 'past_create' else 'create' end;
    v_key := 'schedule.own.' || (case when p_class_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
    if not (has_permission(p_center_id, v_key) or is_platform_admin()) then
        raise exception '이 센터에 수업을 등록할 권한이 없어요';
    end if;

    insert into classes (
        center_id, title, description, start_time, end_time, capacity,
        allow_goods, room_id, cancel_deadline_min, booking_deadline_min,
        class_format, pass_selection_mode, allow_cancel
    ) values (
        p_center_id, p_title, p_description, p_start_time, p_end_time, p_capacity,
        coalesce(p_allow_goods, true), p_room_id, coalesce(p_cancel_deadline_min, 0), p_booking_deadline_min,
        coalesce(p_class_format, 'group'), coalesce(p_pass_selection_mode, 'all'), coalesce(p_allow_cancel, true)
    ) returning id into v_id;

    return v_id;
end;
$$;


ALTER FUNCTION "public"."create_class_safe"("p_center_id" "uuid", "p_title" "text", "p_description" "text", "p_start_time" timestamp with time zone, "p_end_time" timestamp with time zone, "p_capacity" integer, "p_allow_goods" boolean, "p_room_id" "uuid", "p_cancel_deadline_min" integer, "p_booking_deadline_min" integer, "p_class_format" "text", "p_pass_selection_mode" "text", "p_allow_cancel" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_default_center_payout_account"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    insert into center_payout_accounts (center_id, status)
    values (new.id, 'not_registered')
    on conflict (center_id) do nothing;
    return new;
end;
$$;


ALTER FUNCTION "public"."create_default_center_payout_account"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_default_center_roles"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    insert into center_roles (center_id, name, role_key, is_system, is_owner, sort_order) values
        (new.id, '스튜디오 오너', 'owner',   true, true,  0),
        (new.id, '매니저',       'manager', true, false, 1),
        (new.id, '강사',         'trainer', true, false, 2);
    return new;
end;
$$;


ALTER FUNCTION "public"."create_default_center_roles"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_default_center_settlement_account"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    insert into center_settlement_accounts (center_id)
    values (new.id)
    on conflict (center_id) do nothing;
    return new;
end;
$$;


ALTER FUNCTION "public"."create_default_center_settlement_account"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_default_center_subscription"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_plan_id uuid;
begin
    select id into v_plan_id
    from subscription_plans
    where is_active
    order by created_at asc
    limit 1;

    if v_plan_id is not null then
        insert into center_subscriptions (center_id, plan_id, status)
        values (new.id, v_plan_id, 'pending_billing_setup')
        on conflict (center_id) do nothing;
    end if;

    return new;
end;
$$;


ALTER FUNCTION "public"."create_default_center_subscription"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_marketing_message_safe"("p_title" "text", "p_body" "text", "p_link" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_id uuid;
    v_count int := 0;
    r record;
begin
    if not is_platform_admin() then
        raise exception '운영자만 마케팅 알림을 보낼 수 있어요';
    end if;

    if coalesce(trim(p_title), '') = ''
       or coalesce(trim(p_body), '') = '' then
        raise exception '제목과 내용을 모두 입력해주세요';
    end if;

    insert into marketing_messages (title, body, link, created_by)
    values (p_title, p_body, p_link, my_account_id())
    returning id into v_id;

    for r in
        select id
        from accounts
        where is_member = true
          and marketing_consent is true
          and deactivated_at is null
    loop
        perform push_notification(
            r.id,
            'marketing',
            p_title,
            p_body,
            null,
            p_link,
            jsonb_build_object('marketing_message_id', v_id)
        );

        v_count := v_count + 1;
    end loop;

    update marketing_messages
    set target_count = v_count
    where id = v_id;

    return v_id;
end;
$$;


ALTER FUNCTION "public"."create_marketing_message_safe"("p_title" "text", "p_body" "text", "p_link" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."create_marketing_message_safe"("p_title" "text", "p_body" "text", "p_link" "text") IS '운영자가 전체 회원에게 마케팅(혜택·이벤트) 알림을 발송한다. 발송 대상은 accounts.marketing_consent = true이고 탈퇴하지 않은 회원 역할 계정만(광고성 정보 opt-in).';



CREATE OR REPLACE FUNCTION "public"."create_order_secure"("p_product_id" "uuid", "p_pay_method" "text" DEFAULT NULL::"text", "p_selected_size" "text" DEFAULT NULL::"text", "p_point_used" integer DEFAULT 0, "p_auto_book" boolean DEFAULT false, "p_provider" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_profile_id uuid;
    v_product    record;
    v_amount     int;
    v_order_id   uuid;
begin
    -- 대표 프로필 우선, 없으면 가장 먼저 만든 프로필 (기존 lib/orders.ts의 createOrder와
    -- 동일한 선택 규칙)
    select id into v_profile_id from profiles
    where account_id = my_account_id()
    order by is_primary desc, created_at asc
    limit 1;
    if v_profile_id is null then
        raise exception '프로필을 찾을 수 없어요. 프로필 관리에서 프로필을 만들어주세요.';
    end if;

    select * into v_product from products where id = p_product_id;
    if not found then
        raise exception '상품을 찾을 수 없어요';
    end if;
    if not v_product.is_active or not v_product.is_on_sale then
        raise exception '지금은 구매할 수 없는 상품이에요';
    end if;

    if p_provider is not null and p_provider not in ('mock', 'toss', 'portone') then
        raise exception '잘못된 결제 provider예요';
    end if;

    -- 포인트는 여기서 직접 차감(use_points가 실제 잔액을 확인·차감·로그까지 원자적으로
    -- 처리) — 클라이언트가 미리 차감해두고 "이만큼 썼다"고 주장하는 값을 그대로 믿지
    -- 않는다. 잔액 부족이면 use_points가 예외를 던져 여기서 전체 롤백된다.
    if p_point_used > 0 then
        perform use_points(v_product.center_id, v_profile_id, p_point_used);
    end if;

    v_amount := v_product.price - greatest(p_point_used, 0);
    if v_amount < 0 then
        raise exception '포인트 사용액이 상품 가격을 초과할 수 없어요';
    end if;

    insert into orders (
        center_id, profile_id, product_id, product_name, amount,
        pay_method, selected_size, auto_book, payment_provider,
        status, verified
    ) values (
        v_product.center_id, v_profile_id, v_product.id, v_product.name, v_amount,
        p_pay_method, p_selected_size, coalesce(p_auto_book, false), p_provider,
        'pending', true
    ) returning id into v_order_id;

    return v_order_id;
end;
$$;


ALTER FUNCTION "public"."create_order_secure"("p_product_id" "uuid", "p_pay_method" "text", "p_selected_size" "text", "p_point_used" integer, "p_auto_book" boolean, "p_provider" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_phone_verification"("p_phone" "text", "p_code" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
begin
  insert into phone_verifications (phone, code_hash, expires_at)
  values (p_phone, crypt(p_code, gen_salt('bf')), now() + interval '5 minutes');
end;
$$;


ALTER FUNCTION "public"."create_phone_verification"("p_phone" "text", "p_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_recurring_classes_safe"("p_center_id" "uuid", "p_rows" "jsonb", "p_is_copy" boolean DEFAULT false) RETURNS "uuid"[]
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_ids uuid[];
begin
    if not (has_permission(p_center_id, 'schedule.own.group.create') or is_platform_admin()) then
        raise exception '이 센터에 수업을 등록할 권한이 없어요';
    end if;
    if p_is_copy and not (has_permission(p_center_id, 'schedule.copy') or is_platform_admin()) then
        raise exception '일정을 복사할 권한이 없어요';
    end if;

    with inserted as (
        insert into classes (
            center_id, title, description, start_time, end_time, capacity, room_id,
            cancel_deadline_min, booking_deadline_min, recurring_group_id,
            pass_selection_mode, allow_goods, status
        )
        select
            p_center_id,
            r->>'title',
            nullif(btrim(coalesce(r->>'description', '')), ''),
            (r->>'start_time')::timestamptz,
            (r->>'end_time')::timestamptz,
            (r->>'capacity')::int,
            nullif(r->>'room_id', '')::uuid,
            coalesce((r->>'cancel_deadline_min')::int, 0),
            nullif(r->>'booking_deadline_min', '')::int,
            nullif(r->>'recurring_group_id', '')::uuid,
            coalesce(r->>'pass_selection_mode', 'all'),
            coalesce((r->>'allow_goods')::boolean, true),
            'open'
        from jsonb_array_elements(p_rows) as r
        returning id
    )
    select array_agg(id) into v_ids from inserted;

    return coalesce(v_ids, array[]::uuid[]);
end;
$$;


ALTER FUNCTION "public"."create_recurring_classes_safe"("p_center_id" "uuid", "p_rows" "jsonb", "p_is_copy" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_class_group_safe"("p_group_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    v_center_id uuid;
    v_format    text;
    v_title     text;
    v_active    int;
    v_is_own    boolean;
    v_is_past   boolean;
    v_key       text;
    v_verb      text;
begin
    select center_id, class_format, title into v_center_id, v_format, v_title
    from classes where recurring_group_id = p_group_id limit 1;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (
            select 1 from class_trainers ct join classes c on c.id = ct.class_id
             where c.recurring_group_id = p_group_id
        )
        or exists (
            select 1 from class_trainers ct join classes c on c.id = ct.class_id
             where c.recurring_group_id = p_group_id and ct.account_id = my_account_id()
        );
    v_is_past := exists (select 1 from classes where recurring_group_id = p_group_id and start_time < now());
    v_verb := case when v_is_past then 'past_delete' else 'delete' end;
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
    if not has_permission(v_center_id, v_key) and not is_platform_admin() then
        raise exception '이 수업을 삭제할 권한이 없어요';
    end if;

    select count(*) into v_active from reservations
    where class_id in (select id from classes where recurring_group_id = p_group_id)
      and status in ('confirmed','waitlisted','attended');
    if v_active > 0 then
        raise exception '확정·대기·출석 예약이 있어 삭제할 수 없어요 (%건). 먼저 처리해주세요', v_active;
    end if;

    delete from reservations
    where class_id in (select id from classes where recurring_group_id = p_group_id);
    delete from classes where recurring_group_id = p_group_id;

    if not exists (select 1 from classes where center_id = v_center_id and title = v_title) then
        delete from membership_schedule_rules
        where class_title = v_title
          and product_id in (select id from products where center_id = v_center_id);
    end if;

    return json_build_object('deleted', true);
end;
$$;


ALTER FUNCTION "public"."delete_class_group_safe"("p_group_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_class_safe"("p_class_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    v_center_id uuid;
    v_format    text;
    v_title     text;
    v_start     timestamptz;
    v_active    int;
    v_is_own    boolean;
    v_key       text;
    v_verb      text;
begin
    select center_id, class_format, title, start_time into v_center_id, v_format, v_title, v_start
    from classes where id = p_class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
             or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    v_verb := case when v_start < now() then 'past_delete' else 'delete' end;
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
    if not has_permission(v_center_id, v_key) and not is_platform_admin() then
        raise exception '이 수업을 삭제할 권한이 없어요';
    end if;

    select count(*) into v_active from reservations
    where class_id = p_class_id and status in ('confirmed','waitlisted','attended');
    if v_active > 0 then
        raise exception '확정·대기·출석 예약이 있어 삭제할 수 없어요 (%건). 먼저 처리해주세요', v_active;
    end if;

    delete from reservations where class_id = p_class_id;
    delete from classes where id = p_class_id;

    if not exists (select 1 from classes where center_id = v_center_id and title = v_title) then
        delete from membership_schedule_rules
        where class_title = v_title
          and product_id in (select id from products where center_id = v_center_id);
    end if;

    return json_build_object('deleted', true);
end;
$$;


ALTER FUNCTION "public"."delete_class_safe"("p_class_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_inquiry_message_safe"("p_message_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center  uuid;
    v_sender  uuid;
    v_role    text;
begin
    select t.center_id, m.sender_account_id, m.sender_role
      into v_center, v_sender, v_role
      from inquiry_messages m
      join inquiry_threads t on t.id = m.thread_id
     where m.id = p_message_id;

    if v_center is null then
        raise exception '메시지를 찾을 수 없어요';
    end if;

    if v_role <> 'manager' then
        raise exception '회원이 보낸 메시지는 이 기능으로 삭제할 수 없어요';
    end if;

    if not (
        (v_sender = my_account_id() and has_permission(v_center, 'board.inquiry.comment'))
        or has_permission(v_center, 'board.inquiry.comment_other')
        or is_platform_admin()
    ) then
        raise exception '이 댓글을 삭제할 권한이 없어요';
    end if;

    delete from inquiry_messages where id = p_message_id;
end;
$$;


ALTER FUNCTION "public"."delete_inquiry_message_safe"("p_message_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_test_center_cascade"("p_center_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    -- ---- 1단계: centers를 간접 참조하는(hop-2) 테이블 중 NO ACTION인 것들 ----
    delete from point_transactions where payment_id in (select id from payments where center_id = p_center_id);
    delete from membership_transfers where membership_id in (select id from memberships where center_id = p_center_id);
    delete from product_passes
     where product_id in (select id from products where center_id = p_center_id)
        or linked_membership_id in (select id from memberships where center_id = p_center_id);
    delete from reservations
     where class_id in (select id from classes where center_id = p_center_id)
        or membership_id in (select id from memberships where center_id = p_center_id);
    delete from locker_assignments where locker_id in (select id from lockers where center_id = p_center_id);
    delete from community_comments where post_id in (select id from community_posts where center_id = p_center_id);
    delete from progress_records where category_id in (select id from progress_categories where center_id = p_center_id);

    -- ---- 2단계: centers를 직접 참조(hop-1)하면서, 다른 hop-1 테이블을 막는 것들 ----
    delete from admin_action_logs where center_id = p_center_id;   -- memberships를 막음
    delete from contracts where center_id = p_center_id;            -- memberships/contract_templates를 막음
    delete from payments where center_id = p_center_id;             -- memberships를 막음(point_transactions는 이미 정리됨)
    delete from classes where center_id = p_center_id;              -- class_types/rooms를 막음(reservations는 이미 정리됨)
    delete from memberships where center_id = p_center_id;          -- products를 막음(관련 자식 전부 이미 정리됨)
    delete from manager_centers where center_id = p_center_id;      -- center_roles를 막음
    delete from center_members where center_id = p_center_id;       -- member_grades를 막음
    delete from notification_logs where center_id = p_center_id;    -- notification_rules를 막음
    delete from reviews where center_id = p_center_id or target_center_id = p_center_id;

    -- ---- 3단계: 이제 막는 게 없어진 hop-1 테이블들 ----
    delete from products where center_id = p_center_id;
    delete from center_roles where center_id = p_center_id;
    delete from member_grades where center_id = p_center_id;
    delete from notification_rules where center_id = p_center_id;
    delete from class_types where center_id = p_center_id;
    delete from rooms where center_id = p_center_id;
    delete from contract_templates where center_id = p_center_id;
    delete from progress_categories where center_id = p_center_id;
    delete from lockers where center_id = p_center_id;
    delete from community_posts where center_id = p_center_id;
    delete from center_settings where center_id = p_center_id;
    delete from center_contacts where center_id = p_center_id;
    delete from center_holidays where center_id = p_center_id;
    delete from center_member_fields where center_id = p_center_id;
    delete from change_logs where center_id = p_center_id;
    delete from expenses where center_id = p_center_id;
    delete from leads where center_id = p_center_id;
    delete from messages where center_id = p_center_id;
    delete from popup_notices where center_id = p_center_id;
    delete from profile_center_fields where center_id = p_center_id;
    delete from schedule_templates where center_id = p_center_id;
    delete from staff_salaries where center_id = p_center_id;
    delete from staff_schedules where center_id = p_center_id;      -- schedule_memos는 CASCADE라 자동 정리
    delete from terms where center_id = p_center_id;

    -- ---- 4단계: 센터 자체. 남은 CASCADE 테이블(cart_items/center_announcements/
    -- center_reviews/inquiry_threads/orders/point_accounts/point_logs/purchase_requests)은
    -- 여기서 자동 삭제되고, notifications.center_id는 SET NULL로 자동 처리된다.
    delete from centers where id = p_center_id;
end;
$$;


ALTER FUNCTION "public"."delete_test_center_cascade"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."email_signup_available"("p_email" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select not exists (
    select 1 from auth.users
    where lower(email) = lower(trim(p_email))
       or lower(raw_user_meta_data->>'naver_email') = lower(trim(p_email))
  );
$$;


ALTER FUNCTION "public"."email_signup_available"("p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_accounts_is_platform_admin_admin_only"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.is_platform_admin is distinct from old.is_platform_admin then
    if auth.uid() is not null and not is_platform_admin() then
      raise exception '이 값은 운영자만 변경할 수 있어요';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_accounts_is_platform_admin_admin_only"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_accounts_merged_into_via_linking_only"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.merged_into is distinct from old.merged_into then
    if auth.uid() is not null
       and coalesce(current_setting('app.allow_merged_into_change', true), 'false') <> 'true' then
      raise exception 'merged_into는 계정 연동 절차(link_accounts_by_code)를 통해서만 변경할 수 있어요';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_accounts_merged_into_via_linking_only"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_billing_review_override_admin_only"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.billing_review_override is distinct from old.billing_review_override then
    if auth.uid() is not null and not is_platform_admin() then
      raise exception '이 값은 운영자만 변경할 수 있어요';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_billing_review_override_admin_only"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_member_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
    v_max   int;
    v_count int;
begin
    select sp.max_members into v_max
    from center_subscriptions cs join subscription_plans sp on sp.id = cs.plan_id
    where cs.center_id = new.center_id;

    if v_max is null then
        return new;
    end if;

    select count(*) into v_count from center_members where center_id = new.center_id;
    if v_count >= v_max then
        raise exception '현재 플랜은 회원을 최대 %명까지만 등록할 수 있어요. 플랜을 업그레이드해주세요.', v_max;
    end if;

    return new;
end;
$$;


ALTER FUNCTION "public"."enforce_member_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_pg_checkout_override_admin_only"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.pg_checkout_override is distinct from old.pg_checkout_override then
    if auth.uid() is not null and not is_platform_admin() then
      raise exception '이 값은 운영자만 변경할 수 있어요';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_pg_checkout_override_admin_only"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_phone_verified_before_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.phone is not null and new.phone is distinct from old.phone then
    if not _is_phone_recently_verified(new.phone) then
      raise exception '휴대폰 번호 인증이 필요해요';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_phone_verified_before_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_product_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
    v_max   int;
    v_count int;
begin
    -- is_active=false로 등록되는 상품(있다면)은 애초에 슬롯을 안 쓰므로 검사 불필요
    if coalesce(new.is_active, true) = false then
        return new;
    end if;

    select sp.max_products into v_max
    from center_subscriptions cs join subscription_plans sp on sp.id = cs.plan_id
    where cs.center_id = new.center_id;

    if v_max is null then
        return new;
    end if;

    select count(*) into v_count from products where center_id = new.center_id and is_active;
    if v_count >= v_max then
        raise exception '현재 플랜은 상품을 최대 %종까지만 등록할 수 있어요. 플랜을 업그레이드해주세요.', v_max;
    end if;

    return new;
end;
$$;


ALTER FUNCTION "public"."enforce_product_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_product_sale_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_max  int;
    v_sold int;
begin
    if new.product_id is null then
        return new;
    end if;
    if new.status = 'refunded' then
        return new;
    end if;

    -- UPDATE인데 상품도 안 바뀌고 이미 카운트되고 있던 행(원래도 refunded가 아니었음)
    -- 이면 한도 재확인이 필요 없다 — remaining_count 차감 등 흔한 업데이트마다 매번
    -- 다시 세면, 이미 정원이 찬 상품의 기존 보유자 행을 만지는 것만으로 잘못 차단될 수
    -- 있음(자기 자신이 이미 sold 카운트에 포함돼 있으므로).
    if TG_OP = 'UPDATE'
       and new.product_id is not distinct from old.product_id
       and old.status <> 'refunded' then
        return new;
    end if;

    -- 같은 상품에 대한 동시 발급/재지정 요청을 직렬화 — 이 잠금이 없으면 두 요청이
    -- 동시에 "아직 여유 있음"으로 판정해 정원을 넘길 수 있음(경쟁 상태).
    select max_quantity into v_max from products where id = new.product_id for update;

    if v_max is null then
        return new;
    end if;

    select count(*) into v_sold from memberships
    where product_id = new.product_id and status <> 'refunded';

    if v_sold >= v_max then
        raise exception '이 상품은 판매 수량이 모두 소진됐어요';
    end if;

    return new;
end;
$$;


ALTER FUNCTION "public"."enforce_product_sale_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_room_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
    v_max   int;
    v_count int;
begin
    select sp.max_rooms into v_max
    from center_subscriptions cs join subscription_plans sp on sp.id = cs.plan_id
    where cs.center_id = new.center_id;

    if v_max is null then
        return new; -- 플랜 없음(예외 상황) 또는 무제한
    end if;

    select count(*) into v_count from rooms where center_id = new.center_id;
    if v_count >= v_max then
        raise exception '현재 플랜은 룸을 최대 %개까지만 만들 수 있어요. 플랜을 업그레이드해주세요.', v_max;
    end if;

    return new;
end;
$$;


ALTER FUNCTION "public"."enforce_room_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_staff_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
    v_max     int;
    v_count   int;
    v_is_owner boolean;
begin
    select cr.is_owner into v_is_owner from center_roles cr where cr.id = new.role_id;
    if coalesce(v_is_owner, false) then
        return new; -- 오너 본인 행은 슬롯 소비 안 함(센터 생성 시 자동 생성되는 행 포함)
    end if;

    select sp.max_staff into v_max
    from center_subscriptions cs join subscription_plans sp on sp.id = cs.plan_id
    where cs.center_id = new.center_id;

    if v_max is null then
        return new;
    end if;

    select count(*) into v_count
    from manager_centers mc join center_roles cr on cr.id = mc.role_id
    where mc.center_id = new.center_id
      and mc.status in ('pending', 'active')
      and not cr.is_owner;

    if v_count >= v_max then
        raise exception '현재 플랜은 스태프를 최대 %명까지만 초대할 수 있어요. 플랜을 업그레이드해주세요.', v_max;
    end if;

    return new;
end;
$$;


ALTER FUNCTION "public"."enforce_staff_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_center_member"("p_center_id" "uuid", "p_profile_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."ensure_center_member"("p_center_id" "uuid", "p_profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."evaluate_notification_rules"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    rule record;
    target record;
    v_tpl text;
    v_tplcode text;
    v_msg text;
    v_count int := 0;
begin
    for rule in
        select *
        from notification_rules
        where is_active = true
          and send_alimtalk = true
          and template_id is not null
    loop
        select content, aligo_template_code
        into v_tpl, v_tplcode
        from alimtalk_templates
        where id = rule.template_id
          and status = 'approved'
          and is_active = true;

        if v_tpl is null then
            continue;
        end if;

        if rule.trigger_type = 'count_low'
           and rule.threshold_count is not null then

            for target in
                select
                    m.id as membership_id,
                    m.profile_id,
                    coalesce(m.product_name, '수강권') as pass_name,
                    m.remaining_count,
                    pr.name as member_name
                from memberships m
                join profiles pr on pr.id = m.profile_id
                where m.status = 'active'
                  and m.center_id = rule.center_id
                  and m.remaining_count = rule.threshold_count
            loop
                continue when exists (
                    select 1
                    from messages
                    where rule_id = rule.id
                      and target_profile_ids = array[target.profile_id]
                      and created_at::date = current_date
                );

                v_msg := replace(
                    replace(
                        replace(
                            v_tpl,
                            '[[회원명]]',
                            target.member_name
                        ),
                        '[[수강권명]]',
                        target.pass_name
                    ),
                    '[[수강권 잔여횟수]]',
                    target.remaining_count::text
                );

                insert into messages (
                    center_id,
                    channel,
                    content,
                    target_profile_ids,
                    scheduled_at,
                    status,
                    rule_id,
                    aligo_template_code
                )
                values (
                    rule.center_id,
                    'alimtalk',
                    v_msg,
                    array[target.profile_id],
                    now(),
                    'scheduled',
                    rule.id,
                    v_tplcode
                );

                v_count := v_count + 1;
            end loop;


        elsif rule.trigger_type = 'membership_expiring'
          and rule.days_before is not null then

            for target in
                select
                    m.id as membership_id,
                    m.profile_id,
                    coalesce(m.product_name, '수강권') as pass_name,
                    m.expires_at,
                    pr.name as member_name
                from memberships m
                join profiles pr on pr.id = m.profile_id
                where m.status = 'active'
                  and m.center_id = rule.center_id
                  and m.expires_at = current_date + rule.days_before
            loop
                continue when exists (
                    select 1
                    from messages
                    where rule_id = rule.id
                      and target_profile_ids = array[target.profile_id]
                      and created_at::date = current_date
                );

                v_msg := replace(
                    replace(
                        replace(
                            v_tpl,
                            '[[회원명]]',
                            target.member_name
                        ),
                        '[[수강권명]]',
                        target.pass_name
                    ),
                    '[[수강권 잔여일]]',
                    rule.days_before::text
                );

                insert into messages (
                    center_id,
                    channel,
                    content,
                    target_profile_ids,
                    scheduled_at,
                    status,
                    rule_id,
                    aligo_template_code
                )
                values (
                    rule.center_id,
                    'alimtalk',
                    v_msg,
                    array[target.profile_id],
                    now(),
                    'scheduled',
                    rule.id,
                    v_tplcode
                );

                v_count := v_count + 1;
            end loop;


        elsif rule.trigger_type = 'expired_rebuy'
          and rule.days_before is not null then

            for target in
                select
                    m.id as membership_id,
                    m.profile_id,
                    coalesce(m.product_name, '수강권') as pass_name,
                    pr.name as member_name
                from memberships m
                join profiles pr on pr.id = m.profile_id
                join accounts a on a.id = pr.account_id
                where m.status = 'expired'
                  and m.center_id = rule.center_id
                  and m.expires_at = current_date - rule.days_before
                  and a.marketing_consent is true
                  and a.deactivated_at is null
            loop
                continue when exists (
                    select 1
                    from messages
                    where rule_id = rule.id
                      and target_profile_ids = array[target.profile_id]
                      and created_at::date = current_date
                );

                v_msg := replace(
                    replace(
                        v_tpl,
                        '[[회원명]]',
                        target.member_name
                    ),
                    '[[수강권명]]',
                    target.pass_name
                );

                insert into messages (
                    center_id,
                    channel,
                    content,
                    target_profile_ids,
                    scheduled_at,
                    status,
                    rule_id,
                    aligo_template_code
                )
                values (
                    rule.center_id,
                    'alimtalk',
                    v_msg,
                    array[target.profile_id],
                    now(),
                    'scheduled',
                    rule.id,
                    v_tplcode
                );

                v_count := v_count + 1;
            end loop;


        elsif rule.trigger_type = 'pause_ending'
          and rule.days_before is not null then

            for target in
                select
                    m.id as membership_id,
                    m.profile_id,
                    coalesce(m.product_name, '수강권') as pass_name,
                    pr.name as member_name
                from memberships m
                join profiles pr on pr.id = m.profile_id
                where m.status = 'paused'
                  and m.center_id = rule.center_id
                  and m.paused_until = current_date + rule.days_before
            loop
                continue when exists (
                    select 1
                    from messages
                    where rule_id = rule.id
                      and target_profile_ids = array[target.profile_id]
                      and created_at::date = current_date
                );

                v_msg := replace(
                    replace(
                        v_tpl,
                        '[[회원명]]',
                        target.member_name
                    ),
                    '[[수강권명]]',
                    target.pass_name
                );

                insert into messages (
                    center_id,
                    channel,
                    content,
                    target_profile_ids,
                    scheduled_at,
                    status,
                    rule_id,
                    aligo_template_code
                )
                values (
                    rule.center_id,
                    'alimtalk',
                    v_msg,
                    array[target.profile_id],
                    now(),
                    'scheduled',
                    rule.id,
                    v_tplcode
                );

                v_count := v_count + 1;
            end loop;


        elsif rule.trigger_type = 'birthday' then

            for target in
                select distinct
                    pr.id as profile_id,
                    pr.name as member_name
                from memberships m
                join profiles pr on pr.id = m.profile_id
                join accounts a on a.id = pr.account_id
                where m.center_id = rule.center_id
                  and pr.birth_date is not null
                  and a.marketing_consent is true
                  and a.deactivated_at is null
                  and extract(month from pr.birth_date)
                      = extract(month from (now() at time zone 'Asia/Seoul'))
                  and extract(day from pr.birth_date)
                      = extract(day from (now() at time zone 'Asia/Seoul'))
            loop
                continue when exists (
                    select 1
                    from messages
                    where rule_id = rule.id
                      and target_profile_ids = array[target.profile_id]
                      and created_at::date = current_date
                );

                v_msg := replace(
                    v_tpl,
                    '[[회원명]]',
                    target.member_name
                );

                insert into messages (
                    center_id,
                    channel,
                    content,
                    target_profile_ids,
                    scheduled_at,
                    status,
                    rule_id,
                    aligo_template_code
                )
                values (
                    rule.center_id,
                    'alimtalk',
                    v_msg,
                    array[target.profile_id],
                    now(),
                    'scheduled',
                    rule.id,
                    v_tplcode
                );

                v_count := v_count + 1;
            end loop;

        end if;
    end loop;

    return v_count;
end;
$$;


ALTER FUNCTION "public"."evaluate_notification_rules"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."evaluate_notification_rules"() IS '활성 알림톡 자동 발송 규칙을 평가해 대상 회원에게 messages 큐 행을 만든다(템플릿 코드 포함). 광고성 규칙(birthday/expired_rebuy)은 accounts.marketing_consent = true이면서 탈퇴하지 않은 회원만 대상으로 하고, 필수 운영 알림(count_low/membership_expiring/pause_ending)은 동의 여부와 무관하게 전원 대상. 실제 발송은 dispatch-alimtalk cron이 담당';



CREATE OR REPLACE FUNCTION "public"."extend_passes_after_dormant"("p_center_member_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_cm   center_members;
    v_days integer;
    v_n    integer;
begin
    select * into v_cm from center_members where id = p_center_member_id for update;
    if not found then
        raise exception '회원을 찾을 수 없어요';
    end if;
    if not (has_permission(v_cm.center_id, 'customer.member.update') or is_platform_admin()) then
        raise exception '회원 상태를 변경할 권한이 없어요';
    end if;
    if v_cm.status <> 'dormant' or v_cm.dormant_since is null then
        return 0;
    end if;
    v_days := floor(extract(epoch from (now() - v_cm.dormant_since)) / 86400)::integer;
    if v_days <= 0 then
        return 0;
    end if;

    perform set_config('app.membership_expiry_write', 'on', true);
    update memberships set expires_at = expires_at + v_days
     where profile_id = v_cm.profile_id and center_id = v_cm.center_id
       and status = 'active' and expires_at is not null;
    get diagnostics v_n = row_count;
    perform set_config('app.membership_expiry_write', '', true);
    return v_n;
end;
$$;


ALTER FUNCTION "public"."extend_passes_after_dormant"("p_center_member_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fetch_member_phones_safe"("p_profile_ids" "uuid"[], "p_center_id" "uuid") RETURNS TABLE("profile_id" "uuid", "account_phone" "text", "profile_phone" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_can boolean;
begin
    v_can := has_permission(p_center_id, 'customer.member.phone') or is_platform_admin();

    return query
        select p.id,
               case when v_can then a.phone else null end,
               case when v_can then p.phone else null end
        from profiles p
        left join accounts a on a.id = p.account_id
        where p.id = any(p_profile_ids)
          and exists (
              select 1 from center_members cm
              where cm.center_id = p_center_id and cm.profile_id = p.id
          );
end;
$$;


ALTER FUNCTION "public"."fetch_member_phones_safe"("p_profile_ids" "uuid"[], "p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fetch_public_product_schedule_rules"("p_center_id" "uuid") RETURNS TABLE("product_id" "uuid", "day_of_week" integer, "start_time" time without time zone, "class_title" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select r.product_id, r.day_of_week, r.start_time, r.class_title
      from public.membership_schedule_rules r
      join public.fetch_public_storefront_products(p_center_id) s on s.id = r.product_id
     where p_center_id is not null
       and s.center_id = p_center_id
       and s.product_kind = 'pass'
     order by r.product_id, r.created_at, r.id
     limit 5000;
$$;


ALTER FUNCTION "public"."fetch_public_product_schedule_rules"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fetch_public_storefront_products"("p_center_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "center_id" "uuid", "center_name" "text", "name" "text", "price" integer, "product_kind" "text", "description" "text", "total_count" integer, "unlimited" boolean, "unlimited_pass" boolean, "group_label" "text", "remaining" integer, "purchase_count_selectable" boolean, "min_purchase_count" integer, "max_purchase_count" integer, "min_tier_price" integer, "max_tier_price" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select
        p.id,
        p.center_id,
        c.name,
        p.name,
        p.price,
        p.product_kind,
        p.description,
        p.total_count,
        p.unlimited,
        p.unlimited_pass,
        p.group_label,
        case
            when p.max_quantity is null then null
            else greatest(
                0,
                p.max_quantity - (
                    select count(*)::int from memberships m
                    where m.product_id = p.id and m.status <> 'refunded'
                )
            )
        end,
        coalesce(p.purchase_count_selectable, false),
        (select min(t.count) from product_count_prices t where t.product_id = p.id),
        (select max(t.count) from product_count_prices t where t.product_id = p.id),
        (select min(t.price) from product_count_prices t where t.product_id = p.id),
        (select max(t.price) from product_count_prices t where t.product_id = p.id)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal   -- QA/내부 센터는 공개 목록에 절대 나오지 않는다
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      -- 횟수 선택형인데 가격표가 아직 없으면(설정 중) 공개하지 않는다
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and (p_center_id is null or p.center_id = p_center_id)
    order by c.name asc, p.product_kind asc, p.price asc
    limit 500;
$$;


ALTER FUNCTION "public"."fetch_public_storefront_products"("p_center_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."fetch_public_storefront_products"("p_center_id" "uuid") IS '비로그인 포함 누구나 조회 가능한 공개 판매상품 목록. 승인된 센터의 활성/판매중/전체공개(visibility_type=all) 상품만 최소 컬럼으로 반환한다. 등급 전용/지정 회원 전용 상품은 절대 포함하지 않는다. 회원별 구매 가능 상품은 fetch_purchasable_products()(authenticated 전용)가 담당.';



CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "price" integer DEFAULT 0 NOT NULL,
    "pass_type" "text" DEFAULT 'count'::"text" NOT NULL,
    "total_count" integer,
    "is_on_sale" boolean DEFAULT true NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "product_kind" "text" DEFAULT 'pass'::"text" NOT NULL,
    "unlimited" boolean DEFAULT false NOT NULL,
    "description" "text",
    "sizes" "text"[],
    "auto_book_days" integer[],
    "unlimited_pass" boolean DEFAULT false NOT NULL,
    "expiry_mode" "text" DEFAULT 'none'::"text" NOT NULL,
    "expiry_days" integer,
    "expiry_date" "date",
    "group_label" "text",
    "rolling_month_cutoff_day" integer,
    "rolling_month_allow_early_use" boolean DEFAULT false NOT NULL,
    "max_quantity" integer,
    "visibility_type" "text" DEFAULT 'all'::"text" NOT NULL,
    "coupon_eligible" boolean DEFAULT true NOT NULL,
    "weekday_selectable" boolean DEFAULT false NOT NULL,
    "time_selectable" boolean DEFAULT false NOT NULL,
    "purchase_count_selectable" boolean DEFAULT false NOT NULL,
    CONSTRAINT "products_expiry_mode_check" CHECK (("expiry_mode" = ANY (ARRAY['none'::"text", 'days'::"text", 'date'::"text", 'rolling_month'::"text"]))),
    CONSTRAINT "products_kind_check" CHECK (("product_kind" = ANY (ARRAY['pass'::"text", 'goods'::"text"]))),
    CONSTRAINT "products_max_quantity_positive" CHECK ((("max_quantity" IS NULL) OR ("max_quantity" > 0))),
    CONSTRAINT "products_pass_type_check" CHECK (("pass_type" = ANY (ARRAY['count'::"text", 'period'::"text"]))),
    CONSTRAINT "products_rolling_month_cutoff_day_check" CHECK ((("rolling_month_cutoff_day" IS NULL) OR (("rolling_month_cutoff_day" >= 1) AND ("rolling_month_cutoff_day" <= 31)))),
    CONSTRAINT "products_selectable_count_check" CHECK (((NOT "purchase_count_selectable") OR (("unlimited" = false) AND ("unlimited_pass" = false)))),
    CONSTRAINT "products_visibility_type_check" CHECK (("visibility_type" = ANY (ARRAY['all'::"text", 'grades'::"text", 'selected_members'::"text"])))
);


ALTER TABLE "public"."products" OWNER TO "postgres";


COMMENT ON TABLE "public"."products" IS '수강권과 별개로 판매하는 상품 (대여권 등)';



COMMENT ON COLUMN "public"."products"."unlimited_pass" IS '수강권(pass) 횟수 무제한 여부. goods의 unlimited와 별개 컬럼';



COMMENT ON COLUMN "public"."products"."expiry_mode" IS 'none=기간 제한 없음(무제한 만료), days=구매일+expiry_days, date=expiry_date 고정(시즌권 효과)';



COMMENT ON COLUMN "public"."products"."group_label" IS '수강권 표시용 대분류 라벨(자유 텍스트, 센터가 직접 입력) — 예: 요일고정, 자유이용. null이면 미분류로 표시';



COMMENT ON COLUMN "public"."products"."rolling_month_cutoff_day" IS '매달 자동 갱신(expiry_mode=rolling_month) 상품의 컷오프 일자(1~31). 구매일(KST)의
     "일"이 이 값보다 작으면 이번 달, 이 값 이상이면 다음 달이 대상 월이 된다';



COMMENT ON COLUMN "public"."products"."rolling_month_allow_early_use" IS 'rolling_month 상품에서 대상 월이 다음 달로 넘어간 경우에도 구매 즉시 사용을 허용할지.
     false(기본)면 memberships.starts_at이 대상 월 1일로 찍혀 그 전까지는 예약에 못 쓴다';



COMMENT ON COLUMN "public"."products"."max_quantity" IS 'null이면 무제한 판매. 설정하면 이 개수만큼 발급된 뒤(환불 제외) 추가 발급이 트리거에서 차단됨.';



COMMENT ON COLUMN "public"."products"."visibility_type" IS '수강권 공개범위: all(전체 회원)/grades(특정 등급)/selected_members(지정 회원). 기본값 all — 기존 상품은 마이그레이션 후 자동으로 전체 공개 유지(요청 원문 3번).';



COMMENT ON COLUMN "public"."products"."coupon_eligible" IS '이 상품에 쿠폰을 적용할 수 있는지. false면 어떤 쿠폰 정의(coupons.applies_to)로도 이 상품에는 쿠폰을 쓸 수 없다 — 쿠폰 쪽 설정보다 이 값이 항상 우선한다. 기본값 true(기존 상품 전부 기존과 동일하게 쿠폰 적용 가능, 회귀 없음).';



COMMENT ON COLUMN "public"."products"."weekday_selectable" IS '구매 시 회원이 수강 요일을 고르게 할지. true면 membership_schedule_rules에 등록된
   day_of_week 후보 중에서 고른다(후보는 매니저가 기존 "예약조건 추가" 화면에서 미리
   등록). auto_book_days(자동예약, 별개 기능)와 무관.';



COMMENT ON COLUMN "public"."products"."time_selectable" IS '요일 선택(weekday_selectable) 후에 시간까지 고르게 할지. weekday_selectable이 꺼져
   있으면 의미 없음(화면에서도 요일 선택이 꺼지면 같이 숨김).';



CREATE OR REPLACE FUNCTION "public"."fetch_purchasable_products"("p_center_id" "uuid") RETURNS SETOF "public"."products"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select p.* from products p
    where p.center_id = p_center_id
      -- QA/내부 센터(centers.is_internal)는 그 센터의 회원/관리자만 상품을 조회할 수 있다(UUID를 알아도 일반 계정은 빈 목록)
      and (
        not exists (select 1 from centers c where c.id = p.center_id and c.is_internal)
        or p.center_id in (select my_member_center_ids())
        or p.center_id in (select my_managed_center_ids())
      )
      and p.is_active
      and p.is_on_sale
      and (
        p.visibility_type = 'all'
        or (
            p.visibility_type = 'grades' and exists (
                select 1 from membership_product_grades mpg
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.grade_id = mpg.grade_id
                where mpg.product_id = p.id
            )
        )
        or (
            p.visibility_type = 'selected_members' and exists (
                select 1 from membership_product_members mpm
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.id = mpm.center_member_id
                where mpm.product_id = p.id
            )
        )
      )
    order by p.product_kind asc, p.price asc;
$$;


ALTER FUNCTION "public"."fetch_purchasable_products"("p_center_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."fetch_purchasable_products"("p_center_id" "uuid") IS '로그인한 회원(my_profile_ids())이 실제로 구매 가능한 상품만 서버에서 필터링해 반환. products SELECT RLS 자체는 안 건드림(매니저 전체 관리 화면은 그대로 전체를 봄) — 이 RPC만 회원용 "내가 살 수 있는 것" 뷰를 제공.';



CREATE OR REPLACE FUNCTION "public"."filter_eligible_class_ids"("p_membership_ids" "uuid"[], "p_class_ids" "uuid"[]) RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select coalesce(array_agg(distinct c.id), array[]::uuid[])
    from classes c
    where c.id = any(p_class_ids)
      and exists (
          select 1 from unnest(p_membership_ids) as mid
          where is_membership_eligible_for_class(mid, c.id)
      );
$$;


ALTER FUNCTION "public"."filter_eligible_class_ids"("p_membership_ids" "uuid"[], "p_class_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."find_mergeable_account_by_my_email"() RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_my_email text;
    v_other_auth_id uuid;
begin
    select email into v_my_email from auth.users where id = auth.uid();
    if v_my_email is null then
        return null;
    end if;

    select au.id into v_other_auth_id
    from auth.users au
    join accounts a on a.auth_id = au.id
    where au.email = v_my_email
      and au.id <> auth.uid()
      and a.merged_into is null
    limit 1;

    if v_other_auth_id is null then
        return null;
    end if;

    return json_build_object('email', v_my_email);
end;
$$;


ALTER FUNCTION "public"."find_mergeable_account_by_my_email"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fulfill_order"("p_order_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_order      orders;
    v_product    record;
    v_membership_id uuid;
    v_count      int;
    v_expires    date;
    v_starts     date;
    v_rm         record;
    v_expected   int;
    v_auto       jsonb;
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

    if v_order.status = 'cancelled' then
        raise exception '취소된 주문은 발급할 수 없어요';
    end if;

    if not coalesce(v_order.verified, false) or v_order.member_coupon_id is not null then
        if v_order.product_id is null then
            raise exception '주문 금액을 확인할 수 없어요. 상품 정보가 없어요 — 센터에서 직접 확인해주세요.';
        end if;

        v_expected := _order_expected_amount(v_order, true);

        if not coalesce(v_order.verified, false) and v_order.amount is distinct from v_expected then
            raise exception '주문 금액이 서버 계산 금액과 달라요 (주문 %원, 확인된 금액 %원) — 쿠폰/포인트를 확인해주세요.',
                v_order.amount, v_expected;
        end if;
    end if;

    v_count := null;
    v_expires := null;
    v_starts := (now() at time zone 'Asia/Seoul')::date;

    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            if coalesce(v_product.purchase_count_selectable, false) then
                if v_order.selected_count is null or v_order.selected_count < 1 then
                    raise exception '구매 횟수 정보가 없는 주문이에요(관리자 문의)';
                end if;
                v_count := v_order.selected_count;
            else
                v_count := case when v_product.unlimited_pass then null else v_product.total_count end;
            end if;

            if v_product.expiry_mode = 'rolling_month' then
                select * into v_rm from calc_rolling_month_dates(now(), v_product.rolling_month_cutoff_day);
                v_expires := v_rm.expires_at;
                if not coalesce(v_product.rolling_month_allow_early_use, false) then
                    v_starts := v_rm.starts_at;
                end if;
            else
                v_expires := case v_product.expiry_mode
                    when 'date' then v_product.expiry_date
                    when 'days' then ((now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval) at time zone 'Asia/Seoul')::date
                    else null
                end;
            end if;
        end if;
    end if;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, starts_at, status,
        bound_day_of_week, bound_start_time, selected_size, auto_book_requested
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, v_starts, 'active',
        v_order.selected_day_of_week, v_order.selected_start_time, v_order.selected_size,
        coalesce(v_order.auto_book, false)
    ) returning id into v_membership_id;

    insert into payments (
        center_id, profile_id, membership_id, order_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount, direct_amount,
        total_amount, unpaid_amount, paid_at, status, memo
    ) values (
        v_order.center_id, v_order.profile_id, v_membership_id, v_order.id,
        'new', 'membership',
        case when v_order.pay_method in ('card','kakao','toss') then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'transfer' then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'direct' then v_order.amount else 0 end,
        v_order.amount, 0, now(), 'paid',
        '앱 주문 자동 발급'
    );

    if v_order.member_coupon_id is not null then
        update member_coupons
           set status = 'used', used_at = now(), order_id = v_order.id
         where id = v_order.member_coupon_id;
    end if;

    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    v_auto := _order_auto_book(v_membership_id, coalesce(v_order.auto_book, false));

    update orders
       set status = 'done',
           paid_at = now()
     where id = p_order_id;

    return (
        jsonb_build_object(
            'already_done', false,
            'membership_id', v_membership_id,
            'amount', v_order.amount
        ) || v_auto
    )::json;
end;
$$;


ALTER FUNCTION "public"."fulfill_order"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_center_sensitive_fields_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if new.pay_methods is distinct from old.pay_methods then
        if not (is_platform_admin() or has_permission(new.id, 'facility.paymethod')) then
            raise exception '결제수단을 변경할 권한이 없어요';
        end if;
    end if;

    if new.review_point is distinct from old.review_point then
        if not (is_platform_admin() or is_center_owner(new.id)) then
            raise exception '후기 적립 포인트를 변경할 권한이 없어요(오너만 가능)';
        end if;
    end if;

    return new;
end;
$$;


ALTER FUNCTION "public"."guard_center_sensitive_fields_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_center_status_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
    if new.status is distinct from old.status and not is_platform_admin() then
        raise exception '센터 승인 상태는 플랫폼 운영자만 변경할 수 있어요';
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."guard_center_status_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_permission"("p_center_id" "uuid", "p_permission" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    with me as (
        select mc.id as mc_id, r.is_owner, mc.role_id
        from manager_centers mc
        join center_roles r on r.id = mc.role_id and r.center_id = mc.center_id
        where mc.account_id = my_account_id()
          and mc.center_id = p_center_id
          and mc.status = 'active'
        limit 1
    )
    select coalesce((
        select
            case
                when m.is_owner then true
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'deny'
                ) then false
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'allow'
                ) then true
                when exists (
                    select 1 from role_permissions rp
                    where rp.role_id = m.role_id
                      and rp.permission_key = p_permission
                ) then true
                else false
            end
        from me m
    ), false);
$$;


ALTER FUNCTION "public"."has_permission"("p_center_id" "uuid", "p_permission" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_center_owner"("p_center_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select exists (
        select 1
        from manager_centers mc
        join center_roles r on r.id = mc.role_id
        where mc.account_id = my_account_id()
          and mc.center_id = p_center_id
          and mc.status = 'active'
          and r.is_owner = true
    );
$$;


ALTER FUNCTION "public"."is_center_owner"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_membership_eligible_for_class"("p_membership_id" "uuid", "p_class_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select exists (
        select 1
        from memberships m
        join classes c on c.id = p_class_id
        where m.id = p_membership_id
          -- [F3] 수업 예약에는 pass 수강권만(대여권 등 goods 상품의 membership 차단). product_id가 없는 legacy/수동 membership은 기존 동작 유지.
          and (
                m.product_id is null
                or exists (select 1 from products pd where pd.id = m.product_id and pd.product_kind = 'pass')
          )
          -- A. 수업의 수강권 허용 정책: 'all'이면 통과, 'selected'면 class_allowed_products에 있는 상품만
          and (
                c.pass_selection_mode = 'all'
                or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = c.id)
          )
          -- B. 예약조건(membership_schedule_rules): 없으면 통과, 있으면 요일/시간/수업명이 "정확히" 맞는 규칙이 하나 이상.
          --    [F2] 'selected'에 지정된 상품이라는 이유로 이 조건을 건너뛰지 않는다(A AND B AND C). [F1] 수업명은 LIKE가 아니라 정확 일치(UI 후보 함수와 동일).
          and (
                m.product_id is null
                or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
                or exists (
                    select 1 from membership_schedule_rules r
                    where r.product_id = m.product_id
                      and (r.day_of_week is null or r.day_of_week = extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int)
                      and (r.start_time is null or r.start_time = (c.start_time at time zone 'Asia/Seoul')::time)
                      and (r.class_title is null or r.class_title = c.title)
                )
          )
          -- C. 구매 시 고른 요일/시간 귀속 — null이면(기존 상품/미선택) 제한 없음, 값이 있으면 수업의 실제 요일/시간과 일치해야 한다.
          and (
                m.bound_day_of_week is null
                or m.bound_day_of_week = extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int
          )
          and (
                m.bound_start_time is null
                or m.bound_start_time = (c.start_time at time zone 'Asia/Seoul')::time
          )
    );
$$;


ALTER FUNCTION "public"."is_membership_eligible_for_class"("p_membership_id" "uuid", "p_class_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_platform_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    -- my_account_id() 경유로 재작성 — 병합된 계정으로 로그인해도 원래(A) 계정의
    -- 플랫폼 어드민 여부를 그대로 물려받는다.
    select coalesce((select is_platform_admin from accounts where id = my_account_id()), false);
$$;


ALTER FUNCTION "public"."is_platform_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_profile_assignable"("p_profile_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select exists (select 1 from profiles where id = p_profile_id);
$$;


ALTER FUNCTION "public"."is_profile_assignable"("p_profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."issue_coupon_to_members"("p_coupon_id" "uuid", "p_center_member_ids" "uuid"[]) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_coupon        record;
    v_issued_count  int := 0;
    v_skipped_count int := 0;
    v_member_id     uuid;
begin
    select * into v_coupon from coupons where id = p_coupon_id;
    if not found then
        raise exception '쿠폰을 찾을 수 없어요';
    end if;
    if not (has_permission(v_coupon.center_id, 'customer.member.issue_pass') or is_platform_admin()) then
        raise exception '쿠폰을 지급할 권한이 없어요';
    end if;
    if v_coupon.status <> 'active' then
        raise exception '보관된(archived) 쿠폰은 지급할 수 없어요';
    end if;

    foreach v_member_id in array p_center_member_ids loop
        -- 다른 센터 회원에게는 지급 불가(요청 13/22번) — center_members가 실제로
        -- 이 쿠폰의 센터 소속인지 매번 확인.
        if not exists (
            select 1 from center_members cm
            where cm.id = v_member_id and cm.center_id = v_coupon.center_id
        ) then
            raise exception '다른 센터 회원에게는 쿠폰을 지급할 수 없어요';
        end if;

        -- 이미 같은 쿠폰을 available 상태로 갖고 있으면 건너뜀(중복 지급 방지,
        -- uniq_member_coupon_active와 동일 조건을 여기서 먼저 확인해 예외 대신
        -- "skipped"로 부드럽게 처리 — 일괄 지급 중 하나가 막혀 전체가 롤백되는
        -- 것을 방지).
        if exists (
            select 1 from member_coupons
            where coupon_id = p_coupon_id and center_member_id = v_member_id and status = 'available'
        ) then
            v_skipped_count := v_skipped_count + 1;
            continue;
        end if;

        insert into member_coupons (coupon_id, center_member_id, status)
        values (p_coupon_id, v_member_id, 'available');
        v_issued_count := v_issued_count + 1;
    end loop;

    return json_build_object('issued_count', v_issued_count, 'skipped_count', v_skipped_count);
end;
$$;


ALTER FUNCTION "public"."issue_coupon_to_members"("p_coupon_id" "uuid", "p_center_member_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."issue_coupon_to_members"("p_coupon_id" "uuid", "p_center_member_ids" "uuid"[]) IS '쿠폰 일괄 지급. has_permission(center_id, customer.member.issue_pass) 재사용(기존 수강권 발급 권한과 동일 — 새 권한 키를 만들지 않음). 이미 active 쿠폰을 가진 회원은 건너뛰고 나머지는 계속 진행(부분 성공 허용, 중복만 skip).';



CREATE OR REPLACE FUNCTION "public"."kr_phone_digits"("p" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
    select case
        when d ~ '^82' and length(d) between 11 and 13 then
            case
                when substr(d, 3) ~ '^0'
                    then substr(d, 3)
                else '0' || substr(d, 3)
            end
        else d
    end
    from (
        select regexp_replace(
            coalesce(p, ''),
            '[^0-9]',
            '',
            'g'
        ) as d
    ) x;
$$;


ALTER FUNCTION "public"."kr_phone_digits"("p" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."link_accounts_by_code"("p_code" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
    v_b_id uuid;   -- 호출자(합쳐질 계정)
    v_a_id uuid;   -- 코드 발급자(남을 계정)
    v_req  record;
    v_a_name text;
begin
    v_b_id := my_account_id();
    if v_b_id is null then
        raise exception '로그인이 필요해요';
    end if;

    select * into v_req from account_link_requests
        where code = p_code and status = 'pending'
        for update;

    if v_req is null then
        raise exception '유효하지 않은 코드예요';
    end if;
    if v_req.expires_at < now() then
        update account_link_requests set status = 'expired' where id = v_req.id;
        raise exception '코드가 만료됐어요. 코드를 다시 발급해주세요';
    end if;

    v_a_id := v_req.requester_account_id;

    if v_a_id = v_b_id then
        raise exception '같은 계정끼리는 연결할 수 없어요';
    end if;
    if exists (select 1 from accounts where id = v_a_id and merged_into is not null) then
        raise exception '연동 코드를 만든 계정이 이미 다른 계정에 합쳐져 있어요. 코드를 다시 발급해주세요';
    end if;
    if exists (select 1 from accounts where id = v_b_id and merged_into is not null) then
        raise exception '이 계정은 이미 다른 계정에 합쳐져 있어요';
    end if;

    -- 급여 정보가 같은 센터에 둘 다 있으면 자동 병합하지 않고 중단(금액 데이터라 신중하게)
    if exists (
        select 1 from staff_salaries sa
        join staff_salaries sb on sa.center_id = sb.center_id
        where sa.account_id = v_a_id and sb.account_id = v_b_id
    ) then
        raise exception '두 계정에 같은 센터의 급여 정보가 각각 있어서 자동으로 합칠 수 없어요. 운영자에게 문의해주세요';
    end if;

    -- manager_centers: 겹치는 센터는 더 높은 권한(오너>낮은 sort_order)으로 A의 행을 승격시키고 B의 행은 삭제
    with overlap as (
        select ma.id as a_row_id, mb.id as b_row_id,
               coalesce(ra.is_owner, false) as a_owner, coalesce(ra.sort_order, 999999) as a_sort,
               coalesce(rb.is_owner, false) as b_owner, coalesce(rb.sort_order, 999999) as b_sort,
               mb.role_id as b_role_id
        from manager_centers ma
        join manager_centers mb on mb.center_id = ma.center_id and mb.account_id = v_b_id
        left join center_roles ra on ra.id = ma.role_id
        left join center_roles rb on rb.id = mb.role_id
        where ma.account_id = v_a_id
    )
    update manager_centers m
    set role_id = o.b_role_id, status = 'active'
    from overlap o
    where m.id = o.a_row_id
      and ((o.b_owner and not o.a_owner) or (o.b_owner = o.a_owner and o.b_sort < o.a_sort));

    delete from manager_centers mb
    using manager_centers ma
    where mb.account_id = v_b_id
      and ma.account_id = v_a_id
      and ma.center_id = mb.center_id;

    -- 남은(안 겹치는) manager_centers는 그대로 A 소유로 재배정
    update manager_centers set account_id = v_a_id where account_id = v_b_id;

    -- class_trainers: 겹치는 수업은 중복만 버림(정보 손실 없음)
    delete from class_trainers cb
    using class_trainers ca
    where cb.account_id = v_b_id and ca.account_id = v_a_id and ca.class_id = cb.class_id;
    update class_trainers set account_id = v_a_id where account_id = v_b_id;

    -- member_center_colors: A 우선, 겹치는 건 B 것 폐기(UI 취향값, 무해)
    delete from member_center_colors cb
    using member_center_colors ca
    where cb.account_id = v_b_id and ca.account_id = v_a_id and ca.center_id = cb.center_id;
    update member_center_colors set account_id = v_a_id where account_id = v_b_id;

    -- inquiry_threads: 같은 센터에 둘 다 문의방이 있으면 B의 메시지를 A 스레드로 옮기고 B 스레드 삭제
    update inquiry_messages im
    set thread_id = ta.id,
        sender_account_id = case when im.sender_account_id = v_b_id then v_a_id else im.sender_account_id end
    from inquiry_threads tb
    join inquiry_threads ta on ta.center_id = tb.center_id and ta.member_account_id = v_a_id
    where tb.member_account_id = v_b_id and im.thread_id = tb.id;

    delete from inquiry_threads tb
    where tb.member_account_id = v_b_id
      and exists (select 1 from inquiry_threads ta where ta.center_id = tb.center_id and ta.member_account_id = v_a_id);

    update inquiry_threads set member_account_id = v_a_id where member_account_id = v_b_id;

    -- profiles: B의 대표 프로필은 추가 프로필로 전환한 뒤 전부 A 소유로 재배정
    update profiles set is_primary = false where account_id = v_b_id and is_primary = true;
    update profiles set account_id = v_a_id where account_id = v_b_id;

    -- 단순 FK 재배정(충돌 가능한 unique 제약 없음)
    update memberships set trainer_account_id = v_a_id where trainer_account_id = v_b_id;
    update payments set trainer_account_id = v_a_id where trainer_account_id = v_b_id;
    update chat_messages set sender_account_id = v_a_id where sender_account_id = v_b_id;
    update chat_messages set receiver_account_id = v_a_id where receiver_account_id = v_b_id;
    update community_posts set author_account_id = v_a_id where author_account_id = v_b_id;
    update community_comments set author_account_id = v_a_id where author_account_id = v_b_id;
    update reviews set reviewer_account_id = v_a_id where reviewer_account_id = v_b_id;
    update reviews set target_account_id = v_a_id where target_account_id = v_b_id;
    update progress_records set coach_account_id = v_a_id where coach_account_id = v_b_id;
    update change_logs set actor_account_id = v_a_id where actor_account_id = v_b_id;
    update staff_schedules set account_id = v_a_id where account_id = v_b_id;
    update schedule_memos set author_account_id = v_a_id where author_account_id = v_b_id;
    update messages set sender_account_id = v_a_id where sender_account_id = v_b_id;
    update notifications set recipient_account_id = v_a_id where recipient_account_id = v_b_id;
    update center_announcements set created_by = v_a_id where created_by = v_b_id;
    update push_subscriptions set account_id = v_a_id where account_id = v_b_id;
    update admin_action_logs set admin_id = v_a_id where admin_id = v_b_id;

    -- native_push_tokens는 add_native_push_tokens.sql 적용 전엔 존재하지 않을 수 있음(Firebase
    -- 설정 대기 중, docs/TODO.md P1-3c) — 나중에 생겨도 코드 변경 없이 그대로 동작하게 존재
    -- 여부를 확인하고 실행한다.
    if to_regclass('public.native_push_tokens') is not null then
        execute 'update native_push_tokens set account_id = $1 where account_id = $2' using v_a_id, v_b_id;
    end if;

    -- 권한 플래그는 능력의 합집합(OR) — 병합 후 권한이 사라지면 안 됨
    select name into v_a_name from accounts where id = v_a_id;
    update accounts a
    set is_member = a.is_member or b.is_member,
        is_manager = a.is_manager or b.is_manager,
        is_platform_admin = a.is_platform_admin or b.is_platform_admin
    from accounts b
    where a.id = v_a_id and b.id = v_b_id;

    -- B의 auth_id를 A로 매핑하고 B를 병합됨으로 표시(auth.users 행 자체는 지우지 않음)
    insert into account_auth_identities (account_id, auth_id)
    select v_a_id, auth.uid()
    where not exists (select 1 from account_auth_identities where auth_id = auth.uid());

    -- 이번 트랜잭션 안에서만 merged_into 보호 트리거를 통과시킨다(트랜잭션 로컬,
    -- is_local=true라 커밋/롤백 시 자동으로 사라짐 — 위 [2]번 설명 참고).
    perform set_config('app.allow_merged_into_change', 'true', true);
    update accounts set merged_into = v_a_id where id = v_b_id;

    update account_link_requests set status = 'used', used_at = now() where id = v_req.id;

    return json_build_object('mergedAccountName', v_a_name);
end;
$_$;


ALTER FUNCTION "public"."link_accounts_by_code"("p_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."manager_book_member"("p_class_id" "uuid", "p_profile_id" "uuid", "p_membership_id" "uuid" DEFAULT NULL::"uuid", "p_deduct" boolean DEFAULT true) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    v_class     record;
    v_mem       record;
    v_confirmed int;
    v_existing  int;
    v_type      text;
    v_consumed  boolean;
begin
    select * into v_class from classes where id = p_class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    if not (v_class.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 수업에 예약할 권한이 없어요';
    end if;

    select count(*) into v_existing
    from reservations
    where class_id = p_class_id
      and profile_id = p_profile_id
      and status in ('confirmed', 'waitlisted', 'attended');
    if v_existing > 0 then
        raise exception '이미 이 수업에 예약되어 있어요';
    end if;

    if p_membership_id is not null then
        select * into v_mem from memberships
        where id = p_membership_id and profile_id = p_profile_id
        for update;
        if not found then
            raise exception '수강권을 찾을 수 없어요';
        end if;
        if p_deduct and v_mem.remaining_count is not null and v_mem.remaining_count <= 0 then
            raise exception '남은 횟수가 없어요';
        end if;
    end if;

    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status in ('confirmed', 'attended');

    v_consumed := (p_membership_id is not null and p_deduct);
    v_type := case when v_consumed then 'ADMIN_ASSIGNMENT' else 'ADMIN_FREE' end;

    insert into reservations (
        class_id, profile_id, membership_id, status,
        reservation_type, reservation_source, created_by_account_id,
        membership_consumed, is_capacity_override
    )
    values (
        p_class_id, p_profile_id, p_membership_id, 'confirmed',
        v_type, 'ADMIN', my_account_id(),
        v_consumed, (v_confirmed >= v_class.capacity)
    );

    if v_consumed then
        update memberships
           set remaining_count = remaining_count - 1
         where id = p_membership_id
           and remaining_count is not null;
    end if;

    return json_build_object(
        'booked', true,
        'over_capacity', v_confirmed >= v_class.capacity,
        'deducted', v_consumed
    );
end;
$$;


ALTER FUNCTION "public"."manager_book_member"("p_class_id" "uuid", "p_profile_id" "uuid", "p_membership_id" "uuid", "p_deduct" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."manager_centers_enforce_role_center_match"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if new.role_id is not null and not exists (
        select 1 from center_roles cr
        where cr.id = new.role_id and cr.center_id = new.center_id
    ) then
        raise exception 'manager_centers.role_id는 반드시 같은 center_id의 center_roles여야 해요 (center_id=%, role_id=%)',
            new.center_id, new.role_id;
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."manager_centers_enforce_role_center_match"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."manager_centers_has_any_row"("p_center_id" "uuid", "p_exclude_id" "uuid" DEFAULT NULL::"uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select exists(
        select 1 from manager_centers
        where center_id = p_center_id
          and (p_exclude_id is null or id <> p_exclude_id)
    );
$$;


ALTER FUNCTION "public"."manager_centers_has_any_row"("p_center_id" "uuid", "p_exclude_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."manager_centers_is_last_active_owner"("p_center_id" "uuid", "p_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select
        exists (
            select 1 from manager_centers mc
            join center_roles r on r.id = mc.role_id and r.center_id = mc.center_id
            where mc.id = p_id and mc.center_id = p_center_id and mc.status = 'active' and r.is_owner
        )
        and not exists (
            select 1 from manager_centers mc
            join center_roles r on r.id = mc.role_id and r.center_id = mc.center_id
            where mc.center_id = p_center_id and mc.id <> p_id and mc.status = 'active' and r.is_owner
        );
$$;


ALTER FUNCTION "public"."manager_centers_is_last_active_owner"("p_center_id" "uuid", "p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."manager_centers_protect_last_owner"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    -- OLD가 활성 오너가 아니면 관심 없음(대부분의 UPDATE는 여기서 바로 통과).
    if not (
        old.status = 'active'
        and old.role_id is not null
        and role_id_is_owner_for_center(old.role_id, old.center_id)
    ) then
        return new;
    end if;

    -- NEW도 같은 센터의 활성 오너면 owner 자격이 유지되는 수정(이름/전문분야 등) — 통과.
    if new.center_id = old.center_id
       and new.status = 'active'
       and new.role_id is not null
       and role_id_is_owner_for_center(new.role_id, new.center_id) then
        return new;
    end if;

    -- 여기까지 왔다면 이 UPDATE는 활성 오너 자격을 제거한다 — 센터별 직렬화 후 다른 활성 오너 확인.
    perform pg_advisory_xact_lock(hashtextextended('manager_centers_owner:' || old.center_id::text, 0));
    if not exists (
        select 1 from manager_centers mc
        join center_roles r on r.id = mc.role_id and r.center_id = mc.center_id
        where mc.center_id = old.center_id and mc.id <> old.id and mc.status = 'active' and r.is_owner
    ) then
        raise exception '센터의 마지막 활성 오너는 강등하거나 비활성화할 수 없어요. 먼저 다른 오너를 지정해주세요.'
            using errcode = '23514';
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."manager_centers_protect_last_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."manager_dashboard_summary"("p_center_id" "uuid", "p_from" "date", "p_to" "date") RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
declare
    v_today       date := (now() at time zone 'Asia/Seoul')::date;
    v_month_start date := date_trunc('month', v_today)::date;
    result        json;
begin
    if not (p_center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 센터의 매출 통계를 볼 권한이 없어요';
    end if;
    if p_from > p_to then
        raise exception '시작일이 종료일보다 늦을 수 없어요';
    end if;

    select json_build_object(
        'todayRevenue', coalesce((
            select sum(total_amount) from payments
            where center_id = p_center_id and status = 'paid'
              and payment_provider is distinct from 'mock'
              and (paid_at at time zone 'Asia/Seoul')::date = v_today
        ), 0),
        'monthRevenue', coalesce((
            select sum(total_amount) from payments
            where center_id = p_center_id and status = 'paid'
              and payment_provider is distinct from 'mock'
              and (paid_at at time zone 'Asia/Seoul')::date between v_month_start and v_today
        ), 0),
        'periodRevenue', coalesce((
            select sum(total_amount) from payments
            where center_id = p_center_id and status = 'paid'
              and payment_provider is distinct from 'mock'
              and (paid_at at time zone 'Asia/Seoul')::date between p_from and p_to
        ), 0),
        'periodPaymentCount', coalesce((
            select count(*) from payments
            where center_id = p_center_id and status = 'paid'
              and payment_provider is distinct from 'mock'
              and (paid_at at time zone 'Asia/Seoul')::date between p_from and p_to
        ), 0),
        'periodMembershipRevenue', coalesce((
            select sum(p.total_amount) from payments p
            left join memberships m on m.id = p.membership_id
            left join products pr on pr.id = m.product_id
            where p.center_id = p_center_id and p.status = 'paid'
              and p.payment_provider is distinct from 'mock'
              and (p.paid_at at time zone 'Asia/Seoul')::date between p_from and p_to
              and (pr.product_kind is null or pr.product_kind = 'pass')
        ), 0),
        'periodGoodsRevenue', coalesce((
            select sum(p.total_amount) from payments p
            join memberships m on m.id = p.membership_id
            join products pr on pr.id = m.product_id
            where p.center_id = p_center_id and p.status = 'paid'
              and p.payment_provider is distinct from 'mock'
              and (p.paid_at at time zone 'Asia/Seoul')::date between p_from and p_to
              and pr.product_kind = 'goods'
        ), 0),
        'unpaidTotal', coalesce((
            select sum(unpaid_amount) from payments
            where center_id = p_center_id and status = 'paid'
              and payment_provider is distinct from 'mock'
        ), 0),
        'byMethod', json_build_object(
            'card', coalesce((select sum(card_amount) from payments where center_id = p_center_id and status = 'paid' and payment_provider is distinct from 'mock' and (paid_at at time zone 'Asia/Seoul')::date between p_from and p_to), 0),
            'cash', coalesce((select sum(cash_amount) from payments where center_id = p_center_id and status = 'paid' and payment_provider is distinct from 'mock' and (paid_at at time zone 'Asia/Seoul')::date between p_from and p_to), 0),
            'transfer', coalesce((select sum(transfer_amount) from payments where center_id = p_center_id and status = 'paid' and payment_provider is distinct from 'mock' and (paid_at at time zone 'Asia/Seoul')::date between p_from and p_to), 0),
            'point', coalesce((select sum(point_amount) from payments where center_id = p_center_id and status = 'paid' and payment_provider is distinct from 'mock' and (paid_at at time zone 'Asia/Seoul')::date between p_from and p_to), 0)
        ),
        'daily', coalesce((
            select json_agg(json_build_object('date', days.date, 'revenue', coalesce(d.revenue, 0)) order by days.date)
            from (
                select gs::date as date
                from generate_series(p_from, p_to, interval '1 day') gs
            ) days
            left join (
                select (paid_at at time zone 'Asia/Seoul')::date as pdate, sum(total_amount) as revenue
                from payments
                where center_id = p_center_id and status = 'paid'
                  and payment_provider is distinct from 'mock'
                  and (paid_at at time zone 'Asia/Seoul')::date between p_from and p_to
                group by 1
            ) d on d.pdate = days.date
        ), '[]'::json)
    ) into result;

    return result;
end;
$$;


ALTER FUNCTION "public"."manager_dashboard_summary"("p_center_id" "uuid", "p_from" "date", "p_to" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."manager_extend_membership_expiry"("p_membership_id" "uuid", "p_mode" "text", "p_days" integer DEFAULT NULL::integer, "p_new_expires_at" "date" DEFAULT NULL::"date", "p_reason" "text" DEFAULT NULL::"text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_mem    memberships;
    v_kind   text;
    v_today  date := (now() at time zone 'Asia/Seoul')::date;
    v_old    date;
    v_new    date;
    v_reason text;
    v_name   text;
    v_days   integer;
begin
    if my_account_id() is null then
        raise exception '로그인이 필요해요';
    end if;

    select * into v_mem from memberships where id = p_membership_id for update;
    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;

    -- 서버 최종 권한: 센터는 클라이언트 입력이 아니라 수강권 행에서 찾는다(다른 센터 수강권은 자연히 거부)
    if not (has_permission(v_mem.center_id, 'customer.member.pass_expiry.update') or is_platform_admin()) then
        raise exception '수강권 만료일을 연장할 권한이 없어요';
    end if;

    if v_mem.status not in ('active', 'paused') then
        raise exception '연장할 수 없는 상태의 수강권이에요(환불·양도·만료 처리됨)';
    end if;

    select product_kind into v_kind from products where id = v_mem.product_id;   -- product_id가 null인 기존 수강권은 v_kind null
    if v_kind = 'goods' then
        raise exception '대여상품은 만료일을 연장할 수 없어요';
    end if;

    if v_mem.expires_at is null then
        raise exception '무제한 수강권은 만료일을 연장할 수 없어요';
    end if;
    v_old := v_mem.expires_at;

    if p_mode = 'days' then
        if p_days is null or p_days < 1 then
            raise exception '연장 일수는 1일 이상이어야 해요';
        end if;
        if p_days > 3650 then
            raise exception '한 번에 연장할 수 있는 일수를 넘었어요(최대 3650일)';
        end if;
        v_new := v_old + p_days;
    elsif p_mode = 'date' then
        if p_new_expires_at is null then
            raise exception '새 만료일을 선택해주세요';
        end if;
        v_new := p_new_expires_at;
    else
        raise exception '연장 방식이 올바르지 않아요';
    end if;

    if v_new <= v_old then
        raise exception '새 만료일은 현재 만료일(%)보다 뒤여야 해요. 만료일은 연장만 할 수 있어요.', v_old;
    end if;
    if v_new < v_today then
        raise exception '이미 만료된 수강권이에요. 새 만료일이 오늘 이후가 되도록 연장해주세요.';
    end if;

    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is not null and char_length(v_reason) > 200 then
        raise exception '연장 사유는 200자 이내로 입력해주세요';
    end if;

    v_days := v_new - v_old;

    perform set_config('app.membership_expiry_write', 'on', true);
    update memberships set expires_at = v_new where id = v_mem.id;   -- expires_at "만"
    perform set_config('app.membership_expiry_write', '', true);

    select coalesce(pr.nickname, pr.name, '회원') into v_name from profiles pr where pr.id = v_mem.profile_id;

    insert into admin_action_logs (
        center_id, action_type, admin_id, member_profile_id, membership_id,
        reason_code, reason_detail, capacity_override, membership_consumed,
        member_name_snapshot, before_state, after_state
    ) values (
        v_mem.center_id, 'MEMBERSHIP_UPDATE', my_account_id(), v_mem.profile_id, v_mem.id,
        'EXPIRY_EXTEND', v_reason, false, false,
        v_name,
        json_build_object('expires_at', v_old),
        json_build_object('expires_at', v_new, 'mode', p_mode, 'days', case when p_mode = 'days' then p_days else null end, 'days_added', v_days)
    );

    return json_build_object(
        'membershipId', v_mem.id,
        'oldExpiresAt', v_old,
        'newExpiresAt', v_new,
        'daysAdded', v_days
    );
end;
$$;


ALTER FUNCTION "public"."manager_extend_membership_expiry"("p_membership_id" "uuid", "p_mode" "text", "p_days" integer, "p_new_expires_at" "date", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."manager_grant_product"("p_center_id" "uuid", "p_profile_id" "uuid", "p_product_id" "uuid", "p_price" integer, "p_pay_method" "text", "p_memo" "text" DEFAULT NULL::"text", "p_paid_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_trainer_account_id" "uuid" DEFAULT NULL::"uuid", "p_bound_day_of_week" integer DEFAULT NULL::integer, "p_bound_start_time" time without time zone DEFAULT NULL::time without time zone, "p_selected_size" "text" DEFAULT NULL::"text", "p_selected_count" integer DEFAULT NULL::integer) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_product       products;
    v_is_goods      boolean;
    v_unlimited     boolean;
    v_count         int;
    v_expires       date;
    v_starts        date := (now() at time zone 'Asia/Seoul')::date;
    v_rm            record;
    v_size          text;
    v_bound_dow     int;
    v_bound_time    time;
    v_sold          int;
    v_granter       text;
    v_memo          text;
    v_membership_id uuid;
    v_payment_id    uuid;
    v_granted_count int;
begin
    if not (
        (
            has_permission(p_center_id, 'customer.member.issue_pass')
            and has_permission(p_center_id, 'pass.payment.create')
        )
        or is_platform_admin()
    ) then
        raise exception '수강권/상품을 지급할 권한이 없어요';
    end if;

    if p_price is null or p_price < 0 then
        raise exception '가격을 올바르게 입력해주세요';
    end if;

    if p_pay_method not in ('card', 'cash', 'transfer', 'service') then
        raise exception '결제방법이 올바르지 않아요';
    end if;

    if p_price = 0 and p_pay_method <> 'service' then
        raise exception '가격이 0원이면 결제방법은 서비스(무상 지급)여야 해요';
    end if;

    if p_price > 0 and p_pay_method = 'service' then
        raise exception '가격이 있으면 서비스로는 지급할 수 없어요 — 결제방법을 골라주세요';
    end if;

    if not exists (
        select 1
        from center_members cm
        where cm.center_id = p_center_id
          and cm.profile_id = p_profile_id
    ) then
        raise exception '이 센터의 회원이 아니에요';
    end if;

    select *
    into v_product
    from products
    where id = p_product_id
      and center_id = p_center_id
    for update;

    if not found then
        raise exception '이 센터의 상품이 아니에요';
    end if;

    if not coalesce(v_product.is_active, false) then
        raise exception '삭제되었거나 비활성화된 상품이에요';
    end if;

    v_is_goods := v_product.product_kind = 'goods';

    if v_product.sizes is not null
       and coalesce(array_length(v_product.sizes, 1), 0) > 0 then

        v_size := nullif(btrim(coalesce(p_selected_size, '')), '');

        if v_size is null then
            raise exception '사이즈를 선택해주세요';
        end if;

        if not (v_size = any(v_product.sizes)) then
            raise exception '선택할 수 없는 사이즈예요';
        end if;
    else
        v_size := null;
    end if;

    if not v_is_goods
       and coalesce(v_product.weekday_selectable, false) then

        if p_bound_day_of_week is null
           or p_bound_day_of_week < 0
           or p_bound_day_of_week > 6 then
            raise exception '이용 요일을 선택해주세요';
        end if;

        v_bound_dow := p_bound_day_of_week;

        if coalesce(v_product.time_selectable, false) then
            if p_bound_start_time is null then
                raise exception '이용 시간을 선택해주세요';
            end if;

            v_bound_time := p_bound_start_time;
        end if;

        perform public.validate_product_schedule_selection(
            v_product.id,
            v_bound_dow,
            v_bound_time
        );
    end if;

    if v_product.max_quantity is not null then
        select count(*)
        into v_sold
        from memberships
        where product_id = v_product.id
          and status <> 'refunded';

        if v_sold >= v_product.max_quantity then
            raise exception '지급 가능한 수량이 없어요(판매 수량이 모두 소진됐어요)';
        end if;
    end if;

    v_unlimited :=
        case
            when v_is_goods
                then coalesce(v_product.unlimited, false)
            else coalesce(v_product.unlimited_pass, false)
        end;

    if coalesce(v_product.purchase_count_selectable, false) then
        if p_selected_count is null then
            raise exception '지급할 횟수를 선택해주세요';
        end if;

        if not exists (
            select 1
            from product_count_prices
            where product_id = v_product.id
              and count = p_selected_count
        ) then
            raise exception '이 상품에서 지급할 수 없는 횟수예요(%회)', p_selected_count;
        end if;

        v_count := p_selected_count;
    else
        if p_selected_count is not null then
            raise exception '이 상품은 지급 횟수를 고를 수 없어요(상품 정의의 횟수로 지급돼요)';
        end if;

        v_count :=
            case
                when v_unlimited then null
                else v_product.total_count
            end;
    end if;

    v_granted_count := v_count;

    if v_product.expiry_mode = 'rolling_month' then
        select *
        into v_rm
        from calc_rolling_month_dates(
            now(),
            v_product.rolling_month_cutoff_day
        );

        v_expires := v_rm.expires_at;

        if not coalesce(v_product.rolling_month_allow_early_use, false) then
            v_starts := v_rm.starts_at;
        end if;

    elsif v_product.expiry_mode = 'date' then
        v_expires := v_product.expiry_date;

    elsif v_product.expiry_mode = 'days' then
        v_expires :=
            (
                (
                    now()
                    + (
                        coalesce(v_product.expiry_days, 0)
                        || ' days'
                    )::interval
                )
                at time zone 'Asia/Seoul'
            )::date;

    else
        v_expires := null;
    end if;

    insert into memberships (
        profile_id,
        center_id,
        product_id,
        product_name,
        pass_type,
        total_count,
        remaining_count,
        expires_at,
        starts_at,
        status,
        bound_day_of_week,
        bound_start_time,
        selected_size
    )
    values (
        p_profile_id,
        p_center_id,
        v_product.id,
        v_product.name,
        'count',
        v_count,
        v_count,
        v_expires,
        v_starts,
        'active',
        v_bound_dow,
        v_bound_time,
        v_size
    )
    returning id into v_membership_id;

    select name
    into v_granter
    from accounts
    where id = my_account_id();

    v_memo :=
        '[관리자 지급'
        || coalesce(' · ' || v_granter, '')
        || ']'
        || coalesce(
            ' ' || nullif(btrim(coalesce(p_memo, '')), ''),
            ''
        );

    insert into payments (
        center_id,
        profile_id,
        membership_id,
        sale_type,
        revenue_category,
        card_amount,
        cash_amount,
        transfer_amount,
        point_amount,
        total_amount,
        unpaid_amount,
        trainer_account_id,
        paid_at,
        memo,
        status
    )
    values (
        p_center_id,
        p_profile_id,
        v_membership_id,
        case
            when p_pay_method = 'service'
                then 'service'
            else 'new'
        end,
        case
            when v_is_goods
                then 'etc'
            else 'membership'
        end,
        case when p_pay_method = 'card' then p_price else 0 end,
        case when p_pay_method = 'cash' then p_price else 0 end,
        case when p_pay_method = 'transfer' then p_price else 0 end,
        0,
        p_price,
        0,
        p_trainer_account_id,
        coalesce(p_paid_at, now()),
        v_memo,
        'paid'
    )
    returning id into v_payment_id;

    return json_build_object(
        'membership_id', v_membership_id,
        'payment_id', v_payment_id,
        'product_kind', v_product.product_kind,
        'selected_size', v_size,
        'granted_count', v_granted_count
    );
end;
$$;


ALTER FUNCTION "public"."manager_grant_product"("p_center_id" "uuid", "p_profile_id" "uuid", "p_product_id" "uuid", "p_price" integer, "p_pay_method" "text", "p_memo" "text", "p_paid_at" timestamp with time zone, "p_trainer_account_id" "uuid", "p_bound_day_of_week" integer, "p_bound_start_time" time without time zone, "p_selected_size" "text", "p_selected_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."manager_set_attendance"("p_reservation_id" "uuid", "p_status" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_res      record;
    v_class    record;
    v_restored boolean := false;
    v_admin_id uuid;
    v_is_own   boolean;
    v_format   text;
    v_verb     text;
    v_key      text;
begin
    if p_status not in ('attended', 'no_show', 'confirmed', 'cancelled') then
        raise exception '잘못된 상태예요';
    end if;

    select * into v_res from reservations where id = p_reservation_id for update;
    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;

    select * into v_class from classes where id = v_res.class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    if p_status in ('attended', 'no_show') then
        if not (has_permission(v_class.center_id, 'schedule.attendance') or is_platform_admin()) then
            raise exception '이 예약을 처리할 권한이 없어요';
        end if;
    else
        v_is_own := not exists (select 1 from class_trainers where class_id = v_class.id)
                 or exists (select 1 from class_trainers where class_id = v_class.id and account_id = my_account_id());
        v_format := case when v_class.class_format = 'private' then 'private' else 'group' end;
        v_verb := case when p_status = 'confirmed' then 'booking' else 'cancel' end;
        if v_class.start_time < now() then
            v_verb := 'past_' || v_verb;
        end if;
        v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' || v_format || '.' || v_verb;
        if not (has_permission(v_class.center_id, v_key) or is_platform_admin()) then
            raise exception '이 예약을 처리할 권한이 없어요';
        end if;
    end if;

    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이라 출결 상태를 바꿀 수 없어요';
    end if;

    if v_res.status = 'waitlisted' and p_status in ('attended', 'no_show') then
        raise exception '대기 중인 예약은 출석/결석으로 표시할 수 없어요 — 먼저 확정돼야 해요';
    end if;

    if v_res.status = 'waitlisted' and p_status = 'confirmed' then
        raise exception '대기 예약은 이 화면에서 바로 확정으로 바꿀 수 없어요 — 정원이 비면 자동으로 승격돼요';
    end if;

    v_admin_id := my_account_id();

    if p_status = 'cancelled' then
        if v_res.status in ('confirmed', 'attended', 'no_show') and v_res.membership_id is not null then
            update memberships
               set remaining_count = remaining_count + 1
             where id = v_res.membership_id
               and remaining_count is not null;
            v_restored := true;
        end if;

        update reservations
           set status = p_status,
               cancelled_by = v_admin_id,
               cancelled_at = now(),
               updated_at = now()
         where id = p_reservation_id;
    else
        update reservations
           set status = p_status, updated_at = now()
         where id = p_reservation_id;
    end if;

    return json_build_object('status', p_status, 'restored', v_restored);
end;
$$;


ALTER FUNCTION "public"."manager_set_attendance"("p_reservation_id" "uuid", "p_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_notifications_read"("p_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if p_ids is null then
        update notifications set read_at = now()
         where recipient_account_id = my_account_id() and read_at is null;
    else
        update notifications set read_at = now()
         where recipient_account_id = my_account_id() and id = any(p_ids);
    end if;
end;
$$;


ALTER FUNCTION "public"."mark_notifications_read"("p_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."member_can_purchase_product"("p_product_id" "uuid", "p_profile_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select coalesce((
        select
            case p.visibility_type
                when 'all' then true
                when 'grades' then exists (
                    select 1 from membership_product_grades mpg
                    join center_members cm
                      on cm.center_id = p.center_id
                     and cm.profile_id = p_profile_id
                     and cm.grade_id = mpg.grade_id
                    where mpg.product_id = p.id
                )
                when 'selected_members' then exists (
                    select 1 from membership_product_members mpm
                    join center_members cm
                      on cm.center_id = p.center_id
                     and cm.profile_id = p_profile_id
                     and cm.id = mpm.center_member_id
                    where mpm.product_id = p.id
                )
                else false
            end
        from products p
        where p.id = p_product_id
          and p.is_active
          and p.is_on_sale
    ), false);
$$;


ALTER FUNCTION "public"."member_can_purchase_product"("p_product_id" "uuid", "p_profile_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."member_can_purchase_product"("p_product_id" "uuid", "p_profile_id" "uuid") IS '특정 회원(profile_id)이 특정 상품을 구매할 자격이 있는지 서버에서 판정한다. orders INSERT RLS와 _issue_membership_and_record_payment() 양쪽에서 재사용(요청 5번 "UI 숨김만으로 끝내지 말 것" — 두 지점 모두에서 독립적으로 강제).';



CREATE OR REPLACE FUNCTION "public"."memberships_guard_expiry_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if new.expires_at is not distinct from old.expires_at then
        return new;   -- 만료일을 바꾸지 않는 UPDATE(차감/복원/상태 변경 등)는 영향 없음
    end if;
    -- 전용 RPC들이 같은 트랜잭션 안에서만 켜는 표식(클라이언트는 설정할 방법이 없다)
    if coalesce(current_setting('app.membership_expiry_write', true), '') = 'on' then
        return new;
    end if;
    -- 로그인 사용자 JWT가 없는 서버 작업(service_role, cron, SQL Editor)은 통과
    if auth.uid() is null then
        return new;
    end if;
    raise exception '수강권 만료일은 "수강권 만료일 연장" 기능으로만 변경할 수 있어요'
        using errcode = '42501';
end;
$$;


ALTER FUNCTION "public"."memberships_guard_expiry_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."memberships_guard_pg_refund"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_writer boolean := coalesce(current_setting('app.pg_refund_write', true), '') = 'on';
begin
    -- 표시 자체는 서버 함수만 바꿀 수 있다(회원/매니저가 REST로 만들거나 풀 수 없다). service_role/서버 작업(JWT 없음)은 통과.
    if new.pg_refund_started_at is distinct from old.pg_refund_started_at and not v_writer and auth.uid() is not null then
        raise exception '환불 진행 상태는 서버에서만 변경할 수 있어요' using errcode = '42501';
    end if;
    -- 환불 진행 중인 수강권의 횟수 차감(예약/출석 등 모든 사용 경로)은 거부. 복구(증가)는 허용.
    if old.pg_refund_started_at is not null and not v_writer
       and new.remaining_count is not null and old.remaining_count is not null and new.remaining_count < old.remaining_count then
        raise exception '환불 처리 중인 수강권이라 지금은 사용할 수 없어요. 잠시 후 다시 시도해주세요';
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."memberships_guard_pg_refund"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_account_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    -- security definer: 정책 안에서 이 함수를 호출해도 accounts RLS를 다시
    --   타지 않게 함 (그렇지 않으면 accounts 조회 정책 ↔ 이 함수 사이 무한 재귀)
    select coalesce(
        (select coalesce(merged_into, id) from accounts where auth_id = auth.uid()),
        (select account_id from account_auth_identities where auth_id = auth.uid())
    );
$$;


ALTER FUNCTION "public"."my_account_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_center_ids_any_status"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select center_id from manager_centers where account_id = my_account_id();
$$;


ALTER FUNCTION "public"."my_center_ids_any_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_managed_center_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select center_id from manager_centers
    where account_id = my_account_id() and status = 'active';
$$;


ALTER FUNCTION "public"."my_managed_center_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_member_center_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select cm.center_id from center_members cm
    where cm.profile_id in (select my_profile_ids());
$$;


ALTER FUNCTION "public"."my_member_center_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_point_balance"("p_center_id" "uuid", "p_profile_id" "uuid") RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select coalesce(sum(amount), 0)
    from point_transactions
    where center_id = p_center_id
      and profile_id = p_profile_id
      and p_profile_id in (select my_profile_ids());
$$;


ALTER FUNCTION "public"."my_point_balance"("p_center_id" "uuid", "p_profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_point_balances"("p_profile_id" "uuid") RETURNS TABLE("center_id" "uuid", "center_name" "text", "balance" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select pt.center_id, c.name, sum(pt.amount) as balance
    from point_transactions pt
    join centers c on c.id = pt.center_id
    where pt.profile_id = p_profile_id
      and p_profile_id in (select my_profile_ids())
    group by pt.center_id, c.name
    having sum(pt.amount) <> 0
    order by sum(pt.amount) desc;
$$;


ALTER FUNCTION "public"."my_point_balances"("p_profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_profile_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select id from profiles where account_id = my_account_id();
$$;


ALTER FUNCTION "public"."my_profile_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_related_center_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select center_id from memberships where profile_id in (select my_profile_ids())
    union
    select c.center_id
      from reservations r
      join classes c on c.id = r.class_id
     where r.profile_id in (select my_profile_ids())
$$;


ALTER FUNCTION "public"."my_related_center_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_visible_account_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select mc.account_id from manager_centers mc
    where mc.center_id in (
        select center_id from manager_centers
        where account_id = (select id from accounts where auth_id = auth.uid())
          and status = 'active'
    )
    union
    select p.account_id from profiles p
    join center_members cm on cm.profile_id = p.id
    where cm.center_id in (
        select center_id from manager_centers
        where account_id = (select id from accounts where auth_id = auth.uid())
          and status = 'active'
    );
$$;


ALTER FUNCTION "public"."my_visible_account_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_expiring_passes"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    r record;
    v_count int := 0;
    v_kind text;
    v_msg text;
begin
    for r in
        select m.id as membership_id, m.profile_id, pr.account_id, m.center_id,
               ct.name as center_name,
               m.remaining_count, m.expires_at,
               coalesce(m.product_name, ct.name || ' 수강권') as pass_name
          from memberships m
          join profiles pr on pr.id = m.profile_id
          join centers ct on ct.id = m.center_id
         where m.status = 'active'
           and (
                (m.remaining_count is not null and m.remaining_count <= 0)
             or (m.expires_at is not null
                 and (m.expires_at at time zone 'Asia/Seoul')::date
                     <= (now() at time zone 'Asia/Seoul')::date)
           )
    loop
        if (r.remaining_count is not null and r.remaining_count <= 0) then
            v_kind := 'pass_used_up';
            v_msg := r.pass_name || ' 횟수를 모두 사용했어요. 재등록하고 계속 이용해보세요.';
        else
            v_kind := 'pass_expired';
            v_msg := r.pass_name || ' 이용 기간이 만료됐어요. 재등록하고 계속 이용해보세요.';
        end if;

        if exists (
            select 1 from notifications
             where recipient_account_id = r.account_id
               and kind = v_kind
               and data->>'membership_id' = r.membership_id::text
        ) then
            continue;
        end if;

        perform push_notification(
            r.account_id, v_kind, '재등록 안내', v_msg,
            r.center_id, '/center/' || r.center_id::text,
            jsonb_build_object('membership_id', r.membership_id)
        );
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;


ALTER FUNCTION "public"."notify_expiring_passes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_refund_completed_managers"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_mem       public.memberships;
    v_recipient uuid;
    v_amount    bigint;
    v_body      text;
begin
    select *
      into v_mem
      from public.memberships
     where id = new.id;

    if not found or v_mem.status <> 'refunded' then
        return null;
    end if;

    begin
        insert into public.refund_notification_events(membership_id)
        values (new.id)
        on conflict (membership_id) do nothing;

        if not found then
            return null;
        end if;

        select coalesce(sum(-total_amount), 0)
          into v_amount
          from public.payments
         where membership_id = new.id
           and sale_type = 'refund'
           and total_amount < 0;

        v_body :=
            left(coalesce(v_mem.product_name, '수강권'), 80)
            || ' · '
            || case
                 when v_amount > 0 then
                   to_char(v_amount, 'FM999,999,999,999,999,999,990')
                   || '원 환불 완료'
                 else
                   '환불 처리 완료(환불 금액 없음)'
               end;

        for v_recipient in
            select distinct account_id
              from public.manager_centers
             where center_id = v_mem.center_id
               and status = 'active'
        loop
            perform public.push_notification(
                v_recipient,
                'refund_completed',
                '수강권 환불이 완료됐어요',
                v_body,
                v_mem.center_id,
                '/manager/sales?center=' || v_mem.center_id::text,
                jsonb_build_object(
                    'membership_id', v_mem.id,
                    'center_id', v_mem.center_id,
                    'refund_amount', v_amount
                )
            );
        end loop;

    exception
        when others then
            raise warning
                'refund_completed notification skipped for membership %: %',
                new.id,
                sqlerrm;
    end;

    return null;
end;
$$;


ALTER FUNCTION "public"."notify_refund_completed_managers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_upcoming_reservations"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    r record;
    v_count int := 0;
    v_kind text;
    v_when text;
    v_days int;
begin
    for r in
        select rv.id as reservation_id, rv.profile_id, pr.account_id,
               c.center_id, c.title, c.start_time,
               (c.start_time at time zone 'Asia/Seoul')::date as class_date
          from reservations rv
          join classes c on c.id = rv.class_id
          join profiles pr on pr.id = rv.profile_id
         where rv.status = 'confirmed'
           and (c.start_time at time zone 'Asia/Seoul')::date
               in ( (now() at time zone 'Asia/Seoul')::date,
                    (now() at time zone 'Asia/Seoul')::date + 3 )
    loop
        v_days := r.class_date - (now() at time zone 'Asia/Seoul')::date;
        if v_days = 0 then
            v_kind := 'reservation_today'; v_when := '오늘';
        else
            v_kind := 'reservation_3days'; v_when := '3일 뒤';
        end if;

        -- 중복 방지: 같은 예약/같은 종류 알림이 이미 있으면 건너뜀
        if exists (
            select 1 from notifications
             where recipient_account_id = r.account_id
               and kind = v_kind
               and data->>'reservation_id' = r.reservation_id::text
        ) then
            continue;
        end if;

        perform push_notification(
            r.account_id, v_kind,
            v_when || ' 수업이 있어요',
            r.title || ' · ' || to_char(r.start_time at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
            r.center_id, '/my-reservations',
            jsonb_build_object('reservation_id', r.reservation_id)
        );
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;


ALTER FUNCTION "public"."notify_upcoming_reservations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_inquiry_thread"("p_center_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_account uuid := my_account_id();
    v_id uuid;
begin
    if v_account is null then
        raise exception '로그인이 필요해요';
    end if;

    select id into v_id from inquiry_threads
     where center_id = p_center_id and member_account_id = v_account;

    if v_id is null then
        insert into inquiry_threads(center_id, member_account_id)
        values (p_center_id, v_account)
        returning id into v_id;
    end if;

    return v_id;
end;
$$;


ALTER FUNCTION "public"."open_inquiry_thread"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."orders_force_server_fields_on_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if auth.uid() is not null then
        new.verified := false;
        new.status := 'pending';
        new.paid_at := null;
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."orders_force_server_fields_on_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."orders_guard_snapshot_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if auth.uid() is not null then
        raise exception '주문의 상품/횟수/금액 정보는 변경할 수 없어요';
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."orders_guard_snapshot_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."orders_guard_status_transition"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if new.status is not distinct from old.status then
        return new;
    end if;
    if old.status = 'cancelled' then
        raise exception '이미 취소된 주문은 다시 처리할 수 없어요';
    end if;
    if old.status = 'done' then
        raise exception '이미 발급된 주문은 상태를 바꿀 수 없어요. 환불은 환불 기능을 이용해주세요';
    end if;
    -- 명시적 허용 전이(Mock/실 결제의 pending→paid→done 흐름과 기존 취소 경로 호환)
    if old.status = 'pending' and new.status in ('paid', 'done', 'cancelled') then
        return new;
    end if;
    if old.status = 'paid' and new.status in ('done', 'cancelled') then
        return new;
    end if;
    raise exception '허용되지 않는 주문 상태 변경이에요(% → %)', old.status, new.status;
end;
$$;


ALTER FUNCTION "public"."orders_guard_status_transition"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."orders_require_schedule_selection"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_weekday boolean;
    v_time    boolean;
    v_kind    text;
begin
    if new.product_id is null then
        return new;
    end if;
    select coalesce(weekday_selectable, false), coalesce(time_selectable, false), product_kind
      into v_weekday, v_time, v_kind
      from products where id = new.product_id;
    if not found or not v_weekday or v_kind = 'goods' then
        return new;
    end if;

    if new.selected_day_of_week is null then
        raise exception '이용할 요일을 선택해 주세요';
    end if;
    if not exists (
        select 1 from membership_schedule_rules r
         where r.product_id = new.product_id and r.day_of_week = new.selected_day_of_week
    ) then
        raise exception '선택할 수 없는 요일이에요. 센터에 문의해주세요';
    end if;
    if v_time then
        if new.selected_start_time is null then
            raise exception '이용할 시간을 선택해 주세요';
        end if;
        if not exists (
            select 1 from membership_schedule_rules r
             where r.product_id = new.product_id and r.day_of_week = new.selected_day_of_week and r.start_time = new.selected_start_time
        ) then
            raise exception '선택할 수 없는 시간이에요. 센터에 문의해주세요';
        end if;
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."orders_require_schedule_selection"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."orders_restore_points_on_cancel"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
        perform _restore_order_points(new.id, '주문 취소 포인트 복원');
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."orders_restore_points_on_cancel"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."orders_snapshot_product_amount"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_p     products;
    v_price int;
begin
    if new.product_id is null then
        new.selected_count := null;
        new.product_amount_snapshot := null;
        return new;
    end if;
    select * into v_p from products where id = new.product_id;
    if not found then
        return new;   -- FK가 처리
    end if;

    if coalesce(v_p.purchase_count_selectable, false) then
        if new.selected_count is null then
            raise exception '구매할 횟수를 선택해주세요';
        end if;
        select price into v_price from product_count_prices
         where product_id = v_p.id and count = new.selected_count;
        if v_price is null then
            raise exception '구매할 수 없는 횟수예요(%회)', new.selected_count;
        end if;
        new.product_amount_snapshot := v_price;
    else
        if new.selected_count is not null then
            raise exception '이 상품은 구매 횟수를 선택할 수 없어요';
        end if;
        new.product_amount_snapshot := v_p.price;
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."orders_snapshot_product_amount"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pg_order_context"("p_order_id" "uuid", "p_auth_uid" "uuid") RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_account uuid := _account_id_for_auth(p_auth_uid);
    v_order   orders;
begin
    if v_account is null then
        return null;
    end if;
    select * into v_order from orders
     where id = p_order_id and profile_id in (select id from profiles where account_id = v_account);
    if not found then
        return null;
    end if;
    return json_build_object(
        'orderId', v_order.id,
        'status', v_order.status,
        'amount', v_order.amount,
        'provider', v_order.payment_provider
    );
end;
$$;


ALTER FUNCTION "public"."pg_order_context"("p_order_id" "uuid", "p_auth_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pg_refund_begin"("p_membership_id" "uuid", "p_auth_uid" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_account uuid := _account_id_for_auth(p_auth_uid);
    v_mem     memberships;
    v_reason  text;
begin
    if v_account is null then
        raise exception '로그인 정보를 확인할 수 없어요';
    end if;
    select * into v_mem from memberships
     where id = p_membership_id and profile_id in (select id from profiles where account_id = v_account)
     for update;
    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;
    if v_mem.status = 'refunded' then
        return json_build_object('state', 'refunded');
    end if;
    if v_mem.pg_refund_started_at is not null then
        return json_build_object('state', 'resumed');
    end if;
    v_reason := _refund_block_reason(v_mem);
    if v_reason is not null then
        return json_build_object('state', 'blocked', 'reason', v_reason);
    end if;

    perform set_config('app.pg_refund_write', 'on', true);
    update memberships set pg_refund_started_at = now() where id = v_mem.id;
    perform set_config('app.pg_refund_write', '', true);
    return json_build_object('state', 'locked');
end;
$$;


ALTER FUNCTION "public"."pg_refund_begin"("p_membership_id" "uuid", "p_auth_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pg_refund_context"("p_membership_id" "uuid", "p_auth_uid" "uuid") RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_account uuid := _account_id_for_auth(p_auth_uid);
    v_mem     memberships;
    v_pay     record;
    v_provider text;
begin
    if v_account is null then
        return null;
    end if;
    select * into v_mem from memberships
     where id = p_membership_id and profile_id in (select id from profiles where account_id = v_account);
    if not found then
        return null;
    end if;

    select order_id, total_amount, pg_transaction_id into v_pay
      from payments where membership_id = v_mem.id order by paid_at desc limit 1;
    if v_pay.order_id is not null then
        select payment_provider into v_provider from orders where id = v_pay.order_id;
    end if;

    return json_build_object(
        'membershipId', v_mem.id,
        'status', v_mem.status,
        'blockReason', case when v_mem.status = 'refunded' then null else _refund_block_reason(v_mem) end,
        'refundPending', v_mem.pg_refund_started_at is not null,
        'orderId', v_pay.order_id,
        'provider', v_provider,
        'paymentKey', v_pay.pg_transaction_id,
        'amount', coalesce(v_pay.total_amount, 0)
    );
end;
$$;


ALTER FUNCTION "public"."pg_refund_context"("p_membership_id" "uuid", "p_auth_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pg_refund_release"("p_membership_id" "uuid", "p_auth_uid" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_account  uuid := _account_id_for_auth(p_auth_uid);
    v_released integer := 0;
begin
    if v_account is null then
        raise exception '로그인 정보를 확인할 수 없어요';
    end if;
    perform set_config('app.pg_refund_write', 'on', true);
    update memberships set pg_refund_started_at = null
     where id = p_membership_id and status <> 'refunded' and pg_refund_started_at is not null
       and profile_id in (select id from profiles where account_id = v_account);
    get diagnostics v_released = row_count;
    perform set_config('app.pg_refund_write', '', true);
    return json_build_object('released', v_released > 0);
end;
$$;


ALTER FUNCTION "public"."pg_refund_release"("p_membership_id" "uuid", "p_auth_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."product_rows_visible"("p_product_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select public.center_rows_visible((select p.center_id from public.products p where p.id = p_product_id));
$$;


ALTER FUNCTION "public"."product_rows_visible"("p_product_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."progress_categories_guard_tree"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_parent_center uuid;
    v_parent_type   text;
    v_parent_depth  integer;
    v_below         integer := 0;
    v_cycle         boolean := false;
begin
    if tg_op = 'UPDATE' then
        if new.center_id is distinct from old.center_id then
            raise exception '분류의 센터는 바꿀 수 없어요';
        end if;
        if new.node_type is distinct from old.node_type then
            raise exception '분류와 기술은 서로 바꿀 수 없어요';
        end if;
    end if;
    -- 아래 검증 쿼리들이 읽기 전에 센터 단위 lock을 먼저 잡는다(read committed에서 lock 대기 후의 문장은 다른 TX의 커밋 결과를 본다).
    perform pg_advisory_xact_lock(hashtextextended('progress_categories_tree:' || new.center_id::text, 0));

    -- 구버전 웹 호환: node_type 없이 들어온 INSERT는 옛 의미로 채운다(최상위=분류, 하위=기술)
    if new.node_type is null then
        new.node_type := case when new.parent_id is null then 'category' else 'skill' end;
    end if;
    if new.node_type not in ('category', 'skill') then
        raise exception '분류 유형이 올바르지 않아요';
    end if;
    if new.parent_id is null then
        if new.node_type = 'skill' then
            raise exception '기술은 분류 아래에만 만들 수 있어요';
        end if;
        return new;
    end if;
    if new.parent_id = new.id then
        raise exception '자기 자신을 상위 분류로 지정할 수 없어요';
    end if;

    select center_id, node_type into v_parent_center, v_parent_type from public.progress_categories where id = new.parent_id;
    if not found then
        raise exception '상위 분류를 찾을 수 없어요';
    end if;
    if v_parent_center is distinct from new.center_id then
        raise exception '다른 센터의 분류를 상위 분류로 지정할 수 없어요';
    end if;
    if v_parent_type <> 'category' then
        raise exception '기술 아래에는 분류나 기술을 만들 수 없어요';
    end if;

    -- 새 부모에서 위로 올라가며 분류 깊이를 세고, 자기 자신이 조상에 있으면 순환
    with recursive up(id, parent_id, lvl) as (
        select id, parent_id, 1 from public.progress_categories where id = new.parent_id
        union all
        select c.id, c.parent_id, up.lvl + 1 from public.progress_categories c join up on c.id = up.parent_id where up.lvl < 16
    )
    select max(lvl), coalesce(bool_or(id = new.id), false) into v_parent_depth, v_cycle from up;
    if v_cycle then
        raise exception '하위 분류를 상위 분류로 지정할 수 없어요(순환)';
    end if;

    -- 분류 깊이만 7단계로 제한(기술은 깊이에 포함하지 않는다). 분류를 옮기는 경우 자신의 하위 "분류" 높이도 포함한다.
    if new.node_type = 'category' then
        if tg_op = 'UPDATE' then
            with recursive down(id, lvl) as (
                select id, 1 from public.progress_categories where parent_id = new.id and node_type = 'category'
                union all
                select c.id, down.lvl + 1 from public.progress_categories c join down on c.parent_id = down.id where c.node_type = 'category' and down.lvl < 16
            )
            select coalesce(max(lvl), 0) into v_below from down;
        end if;
        if v_parent_depth + 1 + v_below > 7 then
            raise exception '분류는 최대 7단계까지 만들 수 있어요';
        end if;
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."progress_categories_guard_tree"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."progress_records_guard_skill"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_type text;
begin
    select node_type into v_type from public.progress_categories where id = new.category_id;
    if not found then
        raise exception '기술을 찾을 수 없어요';
    end if;
    if v_type <> 'skill' then
        raise exception '분류에는 진도를 기록할 수 없어요. 기술을 선택해주세요';
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."progress_records_guard_skill"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."push_notification"("p_recipient" "uuid", "p_kind" "text", "p_title" "text", "p_body" "text", "p_center" "uuid" DEFAULT NULL::"uuid", "p_link" "text" DEFAULT NULL::"text", "p_data" "jsonb" DEFAULT NULL::"jsonb") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    insert into notifications(recipient_account_id, kind, title, body, center_id, link, data)
    values (p_recipient, p_kind, p_title, p_body, p_center, p_link, p_data);
$$;


ALTER FUNCTION "public"."push_notification"("p_recipient" "uuid", "p_kind" "text", "p_title" "text", "p_body" "text", "p_center" "uuid", "p_link" "text", "p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."read_inquiry_thread"("p_thread_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_account uuid := my_account_id();
    v_center uuid;
    v_member uuid;
begin
    select center_id, member_account_id into v_center, v_member
      from inquiry_threads where id = p_thread_id;
    if v_center is null then return; end if;

    if v_account = v_member then
        update inquiry_threads set member_unread = 0 where id = p_thread_id;
    elsif v_center in (select my_managed_center_ids()) or is_platform_admin() then
        update inquiry_threads set manager_unread = 0 where id = p_thread_id;
    end if;
end;
$$;


ALTER FUNCTION "public"."read_inquiry_thread"("p_thread_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refund_membership"("p_membership_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    return _refund_membership_core(p_membership_id, my_account_id(), false, false);
end;
$$;


ALTER FUNCTION "public"."refund_membership"("p_membership_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refund_membership_server"("p_membership_id" "uuid", "p_auth_uid" "uuid", "p_allow_pg" boolean, "p_skip_time_check" boolean) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_account uuid := _account_id_for_auth(p_auth_uid);
begin
    if v_account is null then
        raise exception '로그인 정보를 확인할 수 없어요';
    end if;
    return _refund_membership_core(p_membership_id, v_account, p_allow_pg, p_skip_time_check);
end;
$$;


ALTER FUNCTION "public"."refund_membership_server"("p_membership_id" "uuid", "p_auth_uid" "uuid", "p_allow_pg" boolean, "p_skip_time_check" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."register_center_for_account_safe"("p_name" "text", "p_address" "text", "p_phone" "text", "p_business_number" "text", "p_business_license_url" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_account_id uuid;
    v_center_id uuid;
    v_owner_role_id uuid;
begin
    v_account_id := my_account_id();
    if v_account_id is null then
        raise exception '로그인이 필요해요';
    end if;

    if coalesce(trim(p_name), '') = '' then
        raise exception '센터 이름을 입력해주세요';
    end if;
    if coalesce(trim(p_address), '') = '' then
        raise exception '센터 주소를 입력해주세요';
    end if;
    if coalesce(trim(p_phone), '') = '' then
        raise exception '센터 대표번호를 입력해주세요';
    end if;
    if coalesce(trim(p_business_number), '') = '' then
        raise exception '사업자등록번호를 입력해주세요';
    end if;
    if coalesce(trim(p_business_license_url), '') = '' then
        raise exception '사업자등록증을 첨부해주세요';
    end if;

    v_center_id := gen_random_uuid();

    begin
        -- status는 지정하지 않음 → 기본값 'pending'(플랫폼 관리자 승인 대기)
        insert into centers (id, name, address, phone, business_number, business_license_url)
        values (v_center_id, p_name, p_address, p_phone, p_business_number, p_business_license_url);
    exception when unique_violation then
        raise exception '이미 등록된 사업자등록번호예요';
    end;

    -- 방금 만든 v_center_id는 이 트랜잭션 안에서 막 생성했으므로 다른 manager_centers
    -- 행이 이미 참조하고 있을 수 없다 — "오너 스태프 자가등록" RLS 정책이 원래 확인하던
    -- "센터당 최초 1명" 조건을 자동으로 만족한다.
    insert into manager_centers (account_id, center_id, status)
    values (v_account_id, v_center_id, 'active');

    -- centers AFTER INSERT 트리거(create_default_center_roles)가 같은 트랜잭션 안에서
    -- 이미 실행되어 오너/매니저/강사 3개 역할을 만들어둔 상태 — 바로 조회 가능.
    select id into v_owner_role_id
    from center_roles
    where center_id = v_center_id and role_key = 'owner';

    if v_owner_role_id is null then
        raise exception '오너 역할 연결 중 문제가 발생했어요: 기본 역할이 생성되지 않았어요';
    end if;

    update manager_centers
    set role_id = v_owner_role_id
    where account_id = v_account_id and center_id = v_center_id;

    return v_center_id;
end;
$$;


ALTER FUNCTION "public"."register_center_for_account_safe"("p_name" "text", "p_address" "text", "p_phone" "text", "p_business_number" "text", "p_business_license_url" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_holiday_safe"("p_holiday_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    v_center_id uuid;
    v_date      date;
    v_restored  int;
begin
    select center_id, holiday_date into v_center_id, v_date
    from center_holidays where id = p_holiday_id;
    if not found then
        raise exception '휴무일을 찾을 수 없어요';
    end if;

    if not has_permission(v_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '휴무일을 삭제할 권한이 없어요';
    end if;

    delete from center_holidays where id = p_holiday_id;

    -- 이 휴무일 때문에 폐강 처리됐던 수업을 다시 예약 가능(open) 상태로 되돌린다.
    update classes
    set status = 'open'
    where center_id = v_center_id
      and (start_time at time zone 'Asia/Seoul')::date = v_date
      and status = 'cancelled';
    get diagnostics v_restored = row_count;

    return json_build_object('restored_classes', v_restored);
end;
$$;


ALTER FUNCTION "public"."remove_holiday_safe"("p_holiday_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reply_review"("p_review_id" "uuid", "p_reply" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    v_center uuid;
begin
    select center_id into v_center from center_reviews where id = p_review_id;
    if v_center is null then
        raise exception '후기를 찾을 수 없어요';
    end if;
    if not (has_permission(v_center, 'facility.review.reply') or is_platform_admin()) then
        raise exception '이 후기에 답변할 권한이 없어요';
    end if;

    update center_reviews
       set reply = nullif(trim(p_reply), ''),
           replied_at = case when nullif(trim(p_reply), '') is null then null else now() end
     where id = p_review_id;
end;
$$;


ALTER FUNCTION "public"."reply_review"("p_review_id" "uuid", "p_reply" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reservations_guard_pg_refund_lock"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_started timestamptz;
    v_status  text;
begin
    if new.membership_id is null or new.status not in ('confirmed', 'waitlisted', 'attended', 'no_show') then
        return new;
    end if;
    if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.membership_id is not distinct from old.membership_id then
        return new;
    end if;
    -- 같은 FOR UPDATE 조회에서 status와 환불 표시를 함께 읽는다: 환불 core는 "status='refunded' + 표시 해제"를 한 UPDATE로 처리하므로,
    -- 그 잠금을 기다리다 깨어난 예약은 표시가 null이어도 status로 차단된다(환불 완료 직후 race). direct/manual 환불과 예약 사이에도 같은 방어선이다.
    select status, pg_refund_started_at into v_status, v_started from memberships where id = new.membership_id for update;
    if not found then
        raise exception '사용할 수 없는 수강권이에요';
    end if;
    if v_status is distinct from 'active' then
        raise exception '사용할 수 없는 수강권이에요';
    end if;
    if v_started is not null then
        raise exception '환불 처리 중인 수강권이라 지금은 예약에 사용할 수 없어요. 잠시 후 다시 시도해주세요';
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."reservations_guard_pg_refund_lock"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_class"("p_class_id" "uuid", "p_profile_id" "uuid" DEFAULT NULL::"uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_profile_id    uuid;
    v_class         record;
    v_membership    record;
    v_confirmed     int;
    v_status        text;
    v_wait_order    int;
    v_reservation_id uuid;
    v_day_of_week   int;
    v_local_date    date;
    v_local_time    time;
    v_is_same_day    boolean;
    v_allow_same_day boolean;
    v_book_deadline  timestamptz;
begin
    if p_profile_id is not null then
        select id into v_profile_id from profiles
        where id = p_profile_id and account_id = my_account_id();
    else
        select id into v_profile_id from profiles
        where account_id = my_account_id() and is_primary = true
        limit 1;
    end if;

    if v_profile_id is null then
        raise exception '로그인이 필요하거나 프로필을 찾을 수 없어요';
    end if;

    select * into v_class
    from classes
    where id = p_class_id
    for update;

    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_local_date := (v_class.start_time at time zone 'Asia/Seoul')::date;
    v_local_time := (v_class.start_time at time zone 'Asia/Seoul')::time;
    v_day_of_week := extract(dow from (v_class.start_time at time zone 'Asia/Seoul'))::int;

    if v_class.status = 'cancelled' then
        raise exception '폐강된 수업이에요';
    end if;

    if v_class.status = 'closed' then
        raise exception '예약이 마감된 수업이에요';
    end if;

    if not exists (
        select 1
        from centers
        where id = v_class.center_id
          and status = 'approved'
    ) then
        raise exception '아직 승인되지 않은 센터예요';
    end if;

    if now() >= v_class.start_time then
        raise exception '수업이 시작되었습니다.';
    end if;

    v_is_same_day := v_local_date = (now() at time zone 'Asia/Seoul')::date;

    if v_is_same_day and v_class.booking_deadline_min is null then
        select coalesce(allow_same_day_booking, true)
          into v_allow_same_day
        from center_settings
        where center_id = v_class.center_id;

        if not v_allow_same_day then
            raise exception '당일 예약은 허용되지 않아요';
        end if;
    end if;

    if v_class.booking_deadline_min is not null then
        v_book_deadline :=
            v_class.start_time
            - make_interval(mins => v_class.booking_deadline_min);
    else
        v_book_deadline :=
            calc_deadline(
                v_class.center_id,
                v_class.class_format,
                v_class.start_time,
                'book'
            );

        if v_book_deadline is null then
            v_book_deadline := v_class.start_time;
        end if;

        if v_is_same_day then
            v_book_deadline := v_class.start_time;
        end if;
    end if;

    if now() > v_book_deadline then
        raise exception '예약 마감시간이 지났어요';
    end if;

    declare
        v_open_deadline timestamptz;
    begin
        v_open_deadline :=
            calc_deadline(
                v_class.center_id,
                v_class.class_format,
                v_class.start_time,
                'open'
            );

        if v_open_deadline is not null
           and now() < v_open_deadline then
            raise exception '아직 예약이 열리지 않았어요';
        end if;
    end;

    declare
        v_daily_enabled boolean;
        v_daily_limit   int;
        v_daily_count   int;
    begin
        select daily_book_limit_enabled, daily_book_limit
          into v_daily_enabled, v_daily_limit
        from center_settings
        where center_id = v_class.center_id;

        if coalesce(v_daily_enabled, false)
           and v_daily_limit is not null then

            select count(*)
              into v_daily_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = v_profile_id
              and c.center_id = v_class.center_id
              and (c.start_time at time zone 'Asia/Seoul')::date = v_local_date
              and r.status in ('confirmed', 'waitlisted');

            if v_daily_count >= v_daily_limit then
                raise exception
                    '하루 예약 가능 횟수(%회)를 초과했어요',
                    v_daily_limit;
            end if;
        end if;
    end;

    if exists (
        select 1
        from center_holidays
        where center_id = v_class.center_id
          and holiday_date = v_local_date
    ) then
        raise exception '센터 휴무일이라 예약할 수 없어요';
    end if;

    if v_class.class_format = 'private' then
        declare
            v_pmc_enabled boolean;
            v_pmc_limit   int;
            v_concurrent  int;
        begin
            select private_max_concurrent_enabled, private_max_concurrent
              into v_pmc_enabled, v_pmc_limit
            from center_settings
            where center_id = v_class.center_id;

            if coalesce(v_pmc_enabled, false)
               and v_pmc_limit is not null then

                select count(*)
                  into v_concurrent
                from classes c2
                join reservations r2
                  on r2.class_id = c2.id
                 and r2.status = 'confirmed'
                where c2.center_id = v_class.center_id
                  and c2.class_format = 'private'
                  and c2.id <> v_class.id
                  and c2.status <> 'cancelled'
                  and c2.start_time < v_class.end_time
                  and c2.end_time > v_class.start_time;

                if v_concurrent >= v_pmc_limit then
                    raise exception
                        '같은 시간대에 진행 가능한 프라이빗 수업이 이미 다 찼어요(최대 %건)',
                        v_pmc_limit;
                end if;
            end if;
        end;
    end if;

    if exists (
        select 1
        from reservations
        where class_id = p_class_id
          and profile_id = v_profile_id
          and status in ('confirmed', 'waitlisted')
    ) then
        raise exception '이미 예약(또는 대기)한 수업이에요';
    end if;

    select m.*
      into v_membership
    from memberships m
    where m.profile_id = v_profile_id
      and m.center_id = v_class.center_id
      and m.status = 'active'
      and (m.remaining_count is null or m.remaining_count > 0)
      and (
            m.expires_at is null
            or m.expires_at >= (now() at time zone 'Asia/Seoul')::date
      )
      and (
            m.starts_at is null
            or m.starts_at <= (now() at time zone 'Asia/Seoul')::date
      )
      and is_membership_eligible_for_class(m.id, v_class.id)
    order by m.expires_at asc
    limit 1
    for update;

    if not found then
        raise exception
            '이 수업에 사용할 수 있는 수강권이 없어요 (잔여횟수/기간/예약조건을 확인해주세요)';
    end if;

    select count(*)
      into v_confirmed
    from reservations
    where class_id = p_class_id
      and status = 'confirmed';

    if v_confirmed < v_class.capacity then
        v_status := 'confirmed';

        update memberships
        set remaining_count = remaining_count - 1
        where id = v_membership.id;

        insert into reservations (
            class_id,
            profile_id,
            membership_id,
            status,
            membership_consumed
        )
        values (
            p_class_id,
            v_profile_id,
            v_membership.id,
            'confirmed',
            true
        )
        returning id into v_reservation_id;

    else
        if v_class.class_format = 'private' then
            raise exception '이미 다른 회원이 예약한 프라이빗 수업이에요';
        end if;

        declare
            v_weekly_limit int;
            v_week_start   date;
            v_week_count   int;
        begin
            select waitlist_weekly_limit
              into v_weekly_limit
            from center_settings
            where center_id = v_class.center_id;

            if coalesce(v_weekly_limit, 0) = 0 then
                raise exception
                    '이 수업은 정원이 찼고, 이 센터는 대기예약을 사용하지 않아요';
            end if;

            v_week_start := date_trunc('week', v_local_date)::date;

            select count(*)
              into v_week_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = v_profile_id
              and c.center_id = v_class.center_id
              and r.status = 'waitlisted'
              and (c.start_time at time zone 'Asia/Seoul')::date >= v_week_start
              and (c.start_time at time zone 'Asia/Seoul')::date < v_week_start + 7;

            if v_week_count >= v_weekly_limit then
                raise exception
                    '이번 주 대기예약 가능 횟수(%회)를 초과했어요',
                    v_weekly_limit;
            end if;
        end;

        v_status := 'waitlisted';

        select coalesce(max(waitlist_order), 0) + 1
          into v_wait_order
        from reservations
        where class_id = p_class_id
          and status = 'waitlisted';

        insert into reservations (
            class_id,
            profile_id,
            membership_id,
            status,
            waitlist_order,
            membership_consumed
        )
        values (
            p_class_id,
            v_profile_id,
            v_membership.id,
            'waitlisted',
            v_wait_order,
            false
        )
        returning id into v_reservation_id;
    end if;

    return json_build_object(
        'status', v_status,
        'reservation_id', v_reservation_id
    );
end;
$$;


ALTER FUNCTION "public"."reserve_class"("p_class_id" "uuid", "p_profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_class_with_goods"("p_class_id" "uuid", "p_profile_id" "uuid" DEFAULT NULL::"uuid", "p_goods_membership_id" "uuid" DEFAULT NULL::"uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    return reserve_with_goods(p_class_id, p_profile_id, null, p_goods_membership_id);
end;
$$;


ALTER FUNCTION "public"."reserve_class_with_goods"("p_class_id" "uuid", "p_profile_id" "uuid", "p_goods_membership_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_with_goods"("p_class_id" "uuid", "p_profile_id" "uuid" DEFAULT NULL::"uuid", "p_membership_id" "uuid" DEFAULT NULL::"uuid", "p_goods_membership_id" "uuid" DEFAULT NULL::"uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_profile_id  uuid;
    v_class       classes;
    v_goods       memberships;
    v_goods_prod  products;
    v_profile     profiles;
    v_result      json;
    v_res_id      uuid;
    v_res_status  text;
    v_size        text;
    v_size_source text := 'none';
    v_unlimited   boolean := false;
    v_usage_state text;
begin
    if p_profile_id is not null then
        select id
        into v_profile_id
        from profiles
        where id = p_profile_id
          and account_id = my_account_id();
    else
        select id
        into v_profile_id
        from profiles
        where account_id = my_account_id()
          and is_primary = true
        limit 1;
    end if;

    if v_profile_id is null then
        raise exception '본인 계정의 프로필만 예약할 수 있어요';
    end if;

    if p_goods_membership_id is not null then
        select *
        into v_class
        from classes
        where id = p_class_id;

        if not found then
            raise exception '수업을 찾을 수 없어요';
        end if;

        if not coalesce(v_class.allow_goods, false) then
            raise exception '이 수업은 대여상품을 사용할 수 없어요';
        end if;

        select *
        into v_goods
        from memberships
        where id = p_goods_membership_id
        for update;

        if not found
           or v_goods.profile_id <> v_profile_id
           or v_goods.center_id <> v_class.center_id
           or v_goods.status <> 'active'
           or (
               v_goods.expires_at is not null
               and v_goods.expires_at < (
                   now()
                   at time zone 'Asia/Seoul'
               )::date
           )
           or (
               v_goods.starts_at is not null
               and v_goods.starts_at > (
                   now()
                   at time zone 'Asia/Seoul'
               )::date
           ) then
            raise exception '사용할 수 없는 상품이에요';
        end if;

        select *
        into v_goods_prod
        from products
        where id = v_goods.product_id;

        if not found
           or v_goods_prod.product_kind <> 'goods' then
            raise exception '대여상품만 선택할 수 있어요';
        end if;

        v_unlimited :=
            coalesce(
                v_goods_prod.unlimited,
                false
            );

        if not v_unlimited
           and coalesce(v_goods.remaining_count, 0) <= 0 then
            raise exception '남은 횟수가 없는 상품이에요';
        end if;

        if nullif(
            trim(coalesce(v_goods.selected_size, '')),
            ''
        ) is not null then
            v_size := trim(v_goods.selected_size);
            v_size_source := 'membership';
        else
            select *
            into v_profile
            from profiles
            where id = v_profile_id;

            if nullif(
                trim(coalesce(v_profile.shoe_size, '')),
                ''
            ) is not null then
                v_size := trim(v_profile.shoe_size);
                v_size_source := 'profile';
            end if;
        end if;
    end if;

    if p_membership_id is null then
        v_result :=
            reserve_class(
                p_class_id,
                v_profile_id
            );
    else
        v_result :=
            reserve_with_membership(
                p_class_id,
                v_profile_id,
                p_membership_id
            );
    end if;

    if p_goods_membership_id is null then
        return v_result;
    end if;

    v_res_id :=
        (v_result->>'reservation_id')::uuid;

    v_res_status :=
        v_result->>'status';

    if v_res_status = 'confirmed' then
        if not v_unlimited then
            update memberships
            set remaining_count = remaining_count - 1
            where id = p_goods_membership_id
              and remaining_count is not null;
        end if;

        v_usage_state := 'deducted';
    else
        v_usage_state := 'pending';
    end if;

    insert into reservation_goods_usages (
        reservation_id,
        goods_membership_id,
        center_id,
        profile_id,
        product_name_snapshot,
        size_snapshot,
        size_source,
        unlimited,
        status,
        deducted_at
    )
    values (
        v_res_id,
        p_goods_membership_id,
        v_goods.center_id,
        v_profile_id,
        v_goods.product_name,
        v_size,
        v_size_source,
        v_unlimited,
        v_usage_state,
        case
            when v_usage_state = 'deducted'
                then now()
            else null
        end
    );

    return (
        v_result::jsonb
        || jsonb_build_object(
            'goods_status',
            v_usage_state
        )
    )::json;
end;
$$;


ALTER FUNCTION "public"."reserve_with_goods"("p_class_id" "uuid", "p_profile_id" "uuid", "p_membership_id" "uuid", "p_goods_membership_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_with_membership"("p_class_id" "uuid", "p_profile_id" "uuid", "p_membership_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_class record;
    v_mem record;
    v_confirmed int;
    v_status text;
    v_order int;
    v_reservation_id uuid;
    v_local_date date;
    v_day_of_week int;
    v_local_time time;
    v_is_same_day    boolean;
    v_allow_same_day boolean;
    v_book_deadline  timestamptz;
begin
    if not exists (
        select 1 from profiles where id = p_profile_id and account_id = my_account_id()
    ) then
        raise exception '본인 계정의 프로필만 예약할 수 있어요';
    end if;

    select * into v_class from classes where id = p_class_id for update;
    if not found then raise exception '수업을 찾을 수 없어요'; end if;
    if v_class.status = 'cancelled' then raise exception '폐강된 수업이에요'; end if;
    if v_class.status = 'closed' then raise exception '예약이 마감된 수업이에요'; end if;

    v_local_date := (v_class.start_time at time zone 'Asia/Seoul')::date;
    v_local_time := (v_class.start_time at time zone 'Asia/Seoul')::time;
    v_day_of_week := extract(dow from (v_class.start_time at time zone 'Asia/Seoul'))::int;

    if now() >= v_class.start_time then
        raise exception '수업이 시작되었습니다.';
    end if;

    -- 당일예약 버그 수정 — reserve_class()와 완전히 동일한 정책(위 파일 상단 설명 참고).
    v_is_same_day := v_local_date = (now() at time zone 'Asia/Seoul')::date;

    if v_is_same_day and v_class.booking_deadline_min is null then
        select coalesce(allow_same_day_booking, true) into v_allow_same_day
        from center_settings where center_id = v_class.center_id;
        if not v_allow_same_day then
            raise exception '당일 예약은 허용되지 않아요';
        end if;
    end if;

    if v_class.booking_deadline_min is not null then
        v_book_deadline := v_class.start_time - make_interval(mins => v_class.booking_deadline_min);
    else
        v_book_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'book');
        if v_book_deadline is null then
            v_book_deadline := v_class.start_time;
        end if;
        if v_is_same_day then
            v_book_deadline := v_class.start_time;
        end if;
    end if;
    if now() > v_book_deadline then
        raise exception '예약 마감시간이 지났어요';
    end if;

    declare
        v_open_deadline timestamptz;
    begin
        v_open_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'open');
        if v_open_deadline is not null and now() < v_open_deadline then
            raise exception '아직 예약이 열리지 않았어요';
        end if;
    end;

    declare
        v_daily_enabled boolean;
        v_daily_limit   int;
        v_daily_count   int;
    begin
        select daily_book_limit_enabled, daily_book_limit
          into v_daily_enabled, v_daily_limit
        from center_settings where center_id = v_class.center_id;

        if coalesce(v_daily_enabled, false) and v_daily_limit is not null then
            select count(*) into v_daily_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = p_profile_id
              and c.center_id = v_class.center_id
              and (c.start_time at time zone 'Asia/Seoul')::date = v_local_date
              and r.status in ('confirmed', 'waitlisted');

            if v_daily_count >= v_daily_limit then
                raise exception '하루 예약 가능 횟수(%회)를 초과했어요', v_daily_limit;
            end if;
        end if;
    end;

    if exists (
        select 1 from center_holidays
        where center_id = v_class.center_id
          and holiday_date = v_local_date
    ) then
        raise exception '센터 휴무일이라 예약할 수 없어요';
    end if;

    if v_class.class_format = 'private' then
        declare
            v_pmc_enabled boolean;
            v_pmc_limit   int;
            v_concurrent  int;
        begin
            select private_max_concurrent_enabled, private_max_concurrent
              into v_pmc_enabled, v_pmc_limit
            from center_settings where center_id = v_class.center_id;

            if coalesce(v_pmc_enabled, false) and v_pmc_limit is not null then
                select count(*) into v_concurrent
                from classes c2
                join reservations r2 on r2.class_id = c2.id and r2.status = 'confirmed'
                where c2.center_id = v_class.center_id
                  and c2.class_format = 'private'
                  and c2.id <> v_class.id
                  and c2.status <> 'cancelled'
                  and c2.start_time < v_class.end_time
                  and c2.end_time > v_class.start_time;

                if v_concurrent >= v_pmc_limit then
                    raise exception '같은 시간대에 진행 가능한 프라이빗 수업이 이미 다 찼어요(최대 %건)', v_pmc_limit;
                end if;
            end if;
        end;
    end if;

    select m.* into v_mem
    from memberships m
    where m.id = p_membership_id
      and m.center_id = v_class.center_id
      and m.status = 'active'
      and (m.remaining_count is null or m.remaining_count > 0)
      and (m.expires_at is null or m.expires_at >= (now() at time zone 'Asia/Seoul')::date)
      and (m.starts_at is null or m.starts_at <= (now() at time zone 'Asia/Seoul')::date)
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and is_membership_eligible_for_class(m.id, v_class.id)
    for update;
    if not found then
        raise exception '사용할 수 없는 수강권이에요';
    end if;

    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = p_profile_id
          and status in ('confirmed', 'waitlisted', 'attended')
    ) then
        raise exception '이미 예약한 수업이에요';
    end if;

    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status in ('confirmed', 'attended');

    if v_confirmed >= v_class.capacity then
        if v_class.class_format = 'private' then
            raise exception '이미 다른 회원이 예약한 프라이빗 수업이에요';
        end if;

        declare
            v_weekly_limit int;
            v_week_start   date;
            v_week_count   int;
        begin
            select waitlist_weekly_limit into v_weekly_limit
            from center_settings where center_id = v_class.center_id;

            if coalesce(v_weekly_limit, 0) = 0 then
                raise exception '이 수업은 정원이 찼고, 이 센터는 대기예약을 사용하지 않아요';
            end if;

            v_week_start := date_trunc('week', v_local_date)::date;
            select count(*) into v_week_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = p_profile_id
              and c.center_id = v_class.center_id
              and r.status = 'waitlisted'
              and (c.start_time at time zone 'Asia/Seoul')::date >= v_week_start
              and (c.start_time at time zone 'Asia/Seoul')::date < v_week_start + 7;

            if v_week_count >= v_weekly_limit then
                raise exception '이번 주 대기예약 가능 횟수(%회)를 초과했어요', v_weekly_limit;
            end if;
        end;

        select coalesce(max(waitlist_order), 0) + 1 into v_order
        from reservations where class_id = p_class_id and status = 'waitlisted';
        v_status := 'waitlisted';
        insert into reservations (
            class_id, profile_id, membership_id, status, waitlist_order,
            reservation_type, reservation_source, created_by_account_id, membership_consumed
        )
        values (
            p_class_id, p_profile_id, p_membership_id, v_status, v_order,
            'MEMBER', 'USER', my_account_id(), false
        )
        returning id into v_reservation_id;
    else
        v_status := 'confirmed';
        insert into reservations (
            class_id, profile_id, membership_id, status,
            reservation_type, reservation_source, created_by_account_id, membership_consumed
        )
        values (
            p_class_id, p_profile_id, p_membership_id, v_status,
            'MEMBER', 'USER', my_account_id(), true
        )
        returning id into v_reservation_id;
        update memberships set remaining_count = remaining_count - 1
        where id = p_membership_id and remaining_count is not null;
    end if;

    return json_build_object('status', v_status, 'waitlist_order', v_order, 'reservation_id', v_reservation_id);
end;
$$;


ALTER FUNCTION "public"."reserve_with_membership"("p_class_id" "uuid", "p_profile_id" "uuid", "p_membership_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."retry_auto_book_membership_safe"("p_membership_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center_id uuid;
begin
    select center_id into v_center_id from memberships where id = p_membership_id;
    if v_center_id is null then
        raise exception '수강권을 찾을 수 없어요';
    end if;

    if not (has_permission(v_center_id, 'pass.autobook') or is_platform_admin()) then
        raise exception '요일반 자동배치를 실행할 권한이 없어요';
    end if;

    return auto_book_membership(p_membership_id);
end;
$$;


ALTER FUNCTION "public"."retry_auto_book_membership_safe"("p_membership_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."revoke_member_coupon"("p_member_coupon_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_mc record;
    v_center_id uuid;
begin
    -- record 변수(v_mc)와 스칼라 변수(v_center_id)를 같은 INTO 리스트에 섞을 수 없어서
    -- (PL/pgSQL 제약, 실제 재현된 오류: "record variable cannot be part of
    -- multiple-item INTO list") 조회를 두 단계로 분리한다 — 잠금은 member_coupons
    -- 행 하나에만 걸면 충분하다(coupons는 여기서 상태를 바꾸지 않으므로 잠글 필요 없음).
    select * into v_mc from member_coupons where id = p_member_coupon_id for update;
    if not found then
        raise exception '쿠폰을 찾을 수 없어요';
    end if;

    select center_id into v_center_id from coupons where id = v_mc.coupon_id;
    if not (has_permission(v_center_id, 'customer.member.issue_pass') or is_platform_admin()) then
        raise exception '쿠폰을 회수할 권한이 없어요';
    end if;
    if v_mc.status = 'used' then
        raise exception '이미 사용한 쿠폰은 회수할 수 없어요';
    end if;
    if v_mc.status = 'revoked' then
        return json_build_object('revoked', true, 'already', true);
    end if;

    update member_coupons set status = 'revoked' where id = p_member_coupon_id;
    return json_build_object('revoked', true, 'already', false);
end;
$$;


ALTER FUNCTION "public"."revoke_member_coupon"("p_member_coupon_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."revoke_member_coupon"("p_member_coupon_id" "uuid") IS '아직 사용하지 않은(available/expired) 쿠폰만 회수 가능(요청 21번 — used는 회수 금지).';



CREATE OR REPLACE FUNCTION "public"."role_id_belongs_to_center"("p_role_id" "uuid", "p_center_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select exists(select 1 from center_roles where id = p_role_id and center_id = p_center_id);
$$;


ALTER FUNCTION "public"."role_id_belongs_to_center"("p_role_id" "uuid", "p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."role_id_is_owner_for_center"("p_role_id" "uuid", "p_center_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select exists(
        select 1 from center_roles where id = p_role_id and center_id = p_center_id and is_owner = true
    );
$$;


ALTER FUNCTION "public"."role_id_is_owner_for_center"("p_role_id" "uuid", "p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_autocancel_sweep"() RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_class    record;
    v_res      record;
    v_restored boolean;
    v_cancelled_classes int := 0;
    v_cancelled_reservations int := 0;
    v_center_name text;
begin
    for v_class in
        select c.*
        from classes c
        join center_settings cs on cs.center_id = c.center_id
        where c.status = 'open'
          and cs.autocancel_enabled = true
          and now() < c.start_time
          and now() >= c.start_time - make_interval(hours => cs.autocancel_hours, mins => cs.autocancel_minutes)
          and c.min_capacity > (
              select count(*) from reservations r
              where r.class_id = c.id and r.status in ('confirmed', 'attended')
          )
        for update of c
    loop
        update classes set status = 'cancelled' where id = v_class.id;
        v_cancelled_classes := v_cancelled_classes + 1;

        select name into v_center_name from centers where id = v_class.center_id;

        for v_res in
            select * from reservations
            where class_id = v_class.id and status in ('confirmed', 'waitlisted', 'attended')
            for update
        loop
            v_restored := false;
            if v_res.status = 'confirmed' then
                update memberships set remaining_count = remaining_count + 1
                where id = v_res.membership_id
                  and status not in ('refunded', 'transferred')
                  and remaining_count is not null;
                v_restored := true;
            end if;

            update reservations
            set status = 'cancelled', cancel_source = 'ADMIN', cancelled_at = now()
            where id = v_res.id;

            v_cancelled_reservations := v_cancelled_reservations + 1;

            perform push_notification(
                (select account_id from profiles where id = v_res.profile_id),
                'admin_cancelled',
                coalesce(v_center_name, '센터') || ' 수업이 폐강됐어요',
                v_class.title || ' (최소 인원 미달)' ||
                    case when v_restored then ' — 수강권 횟수가 복구됐어요' else '' end,
                v_class.center_id, '/my-reservations',
                jsonb_build_object('class_id', v_class.id)
            );
        end loop;
    end loop;

    return json_build_object(
        'classes_cancelled', v_cancelled_classes,
        'reservations_cancelled', v_cancelled_reservations
    );
end;
$$;


ALTER FUNCTION "public"."run_autocancel_sweep"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_accounts_for_member"("p_keyword" "text") RETURNS TABLE("profile_id" "uuid", "name" "text", "phone" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_kw     text := trim(p_keyword);
    v_digits text := regexp_replace(coalesce(p_keyword, ''), '[^0-9]', '', 'g');
begin
    if length(v_kw) < 2 then
        return;
    end if;

    if not exists (
        select 1 from manager_centers mc
        where mc.account_id = my_account_id()
          and mc.status = 'active'
          and has_permission(mc.center_id, 'customer.member.create')
    ) then
        raise exception '회원 등록 권한이 없어요';
    end if;

    return query
    select p.id, p.name, a.phone
    from profiles p
    join accounts a on a.id = p.account_id
    where p.is_primary = true
      and (
          p.name ilike '%' || v_kw || '%'
          or (length(v_digits) >= 2 and a.phone ilike '%' || v_digits || '%')
      )
    limit 20;
end;
$$;


ALTER FUNCTION "public"."search_accounts_for_member"("p_keyword" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_member_candidates"("p_center_id" "uuid", "p_keyword" "text") RETURNS TABLE("profile_id" "uuid", "name" "text", "phone" "text", "already_member" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
    v_kw      text := trim(coalesce(p_keyword, ''));
    v_digits  text := public.kr_phone_digits(p_keyword);
    v_exact   text;
    v_can_phone boolean;
    v_caller    uuid := public.my_account_id();
    v_lock_key  bigint;
    v_recent    int;
    v_daily     int;
begin
    if p_center_id is null or not public.has_permission(p_center_id, 'customer.member.create') then
        raise exception '회원 등록 권한이 없어요';
    end if;
    -- 기존 센터 회원의 전화번호를 보거나 전화로 검색할 수 있는지: fetch_member_phones_safe와 같은 기준(customer.member.phone 또는 platform admin). 권한 검사는 데이터 조회 전에 끝낸다.
    v_can_phone := public.has_permission(p_center_id, 'customer.member.phone') or public.is_platform_admin();
    if length(v_kw) < 2 then
        return;
    end if;

    -- 정규화된 입력이 완전한 휴대폰 번호(01X 10~11자리)일 때만 "정확 일치" 후보로 쓴다.
    if v_digits ~ '^01[0-9]{8,9}$' then
        v_exact := v_digits;
    end if;

    -- [rate limit] "전체 번호 exact-search 시도"(센터 밖 가입자 존재 여부를 알아낼 수 있는 유일한 경로, 결과 유무와 무관)의 호출 횟수를 제한한다. 이름/부분 검색은 제한하지 않는다.
    -- 권한 검사 뒤에 수행하므로 권한 없는 호출은 이 한도/오류로 개인정보 존재 여부를 알 수 없다. 서버에서 강제(client debounce는 보안 수단이 아님).
    -- 한도: (호출 계정, 센터)당 10분 30회 + 계정당 24시간 200회. 한도 초과 시 이번 호출은 기록하지 않고 generic 오류를 낸다.
    if v_exact is not null then
        if v_caller is null then
            raise exception '로그인이 필요해요';
        end if;
        v_lock_key := ('x' || substr(md5(v_caller::text), 1, 16))::bit(64)::bigint;
        perform pg_advisory_xact_lock(v_lock_key);   -- 같은 계정의 동시 호출을 직렬화(check-then-act race 방지)
        select count(*) filter (where center_id = p_center_id and created_at >= now() - interval '10 minutes'), count(*)
          into v_recent, v_daily
          from public.member_candidate_search_attempts
         where caller_account_id = v_caller and created_at >= now() - interval '24 hours';
        if v_recent >= 30 or v_daily >= 200 then
            raise exception '검색 요청이 너무 많아요. 잠시 후 다시 시도해주세요' using errcode = 'P0001';
        end if;
        insert into public.member_candidate_search_attempts (caller_account_id, center_id) values (v_caller, p_center_id);
        -- 보관 정리: 2일 지난 기록은 호출 중에 함께 지운다(한도 계산은 24시간만 사용).
        delete from public.member_candidate_search_attempts where created_at < now() - interval '2 days';
    end if;

    return query
    with members as (
        -- 이 센터에 이미 등록된 회원(대표 프로필): 이름/전화 일부 검색. position()으로 비교해 %, _가 wildcard로 동작하지 않는다.
        select p.id as pid, p.name as pname, case when v_can_phone then a.phone else null end as pphone
          from public.center_members cm
          join public.profiles p on p.id = cm.profile_id and p.deleted_at is null
          join public.accounts a on a.id = p.account_id
         where cm.center_id = p_center_id
           and p.is_primary = true
           and (
                position(lower(v_kw) in lower(coalesce(p.name, ''))) > 0
                or (v_can_phone and length(v_digits) >= 2 and position(v_digits in public.kr_phone_digits(a.phone)) > 0)
           )
         limit 20
    ), exact as (
        -- 아직 이 센터에 없는 사람: 정확한 전체 번호만. 이름/마스킹 번호만 반환.
        select p.id as pid, p.name as pname, a.phone as pphone
          from public.accounts a
          join public.profiles p on p.account_id = a.id and p.is_primary = true and p.deleted_at is null
         where v_exact is not null
           and public.kr_phone_digits(a.phone) = v_exact
           and a.merged_into is null
           and a.deactivated_at is null
           and not exists (select 1 from public.center_members cm where cm.center_id = p_center_id and cm.profile_id = p.id)
         limit 5
    )
    select m.pid, m.pname, m.pphone, true from members m
    union all
    select e.pid, e.pname, left(v_exact, 3) || '-****-' || right(v_exact, 4), false from exact e;
end;
$_$;


ALTER FUNCTION "public"."search_member_candidates"("p_center_id" "uuid", "p_keyword" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_staff_candidates"("p_center_id" "uuid", "p_phone" "text") RETURNS TABLE("account_id" "uuid", "name" "text", "phone" "text", "already_staff" boolean, "staff_status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
    v_digits  text;
    v_ids     uuid[];
    v_caller  uuid := public.my_account_id();
    v_lock_key bigint;
    v_recent  int;
    v_daily   int;
begin
    if auth.uid() is null then
        raise exception '로그인이 필요해요';
    end if;
    -- 요청한 "그 센터"에 대한 권한만 인정한다(다른 센터의 권한/오너 여부로는 불가).
    if p_center_id is null or not public.has_permission(p_center_id, 'facility.staff.create') then
        raise exception '스태프를 추가할 권한이 없어요';
    end if;

    v_digits := public.kr_phone_digits(p_phone);
    -- 정확한 전체 휴대폰 번호(01X 10~11자리)가 아니면 아무것도 찾지 않는다(부분 번호/이름 검색 금지).
    if v_digits !~ '^01[0-9]{8,9}$' then
        return;
    end if;

    -- [rate limit] 전체 번호 exact-search 시도를 센다(권한 확인 뒤, 검색 전). (계정, 센터) 10분 30회 + 계정 24시간 200회.
    if v_caller is null then
        raise exception '로그인이 필요해요';
    end if;
    v_lock_key := ('x' || substr(md5(v_caller::text), 1, 16))::bit(64)::bigint;
    perform pg_advisory_xact_lock(v_lock_key);   -- 같은 계정의 동시 호출 직렬화
    select count(*) filter (where center_id = p_center_id and created_at >= now() - interval '10 minutes'), count(*)
      into v_recent, v_daily
      from public.staff_candidate_search_attempts
     where caller_account_id = v_caller and created_at >= now() - interval '24 hours';
    if v_recent >= 30 or v_daily >= 200 then
        raise exception '검색 요청이 너무 많아요. 잠시 후 다시 시도해주세요' using errcode = 'P0001';
    end if;
    insert into public.staff_candidate_search_attempts (caller_account_id, center_id) values (v_caller, p_center_id);
    delete from public.staff_candidate_search_attempts where created_at < now() - interval '2 days';

    select array_agg(a.id) into v_ids
      from public.accounts a
     where public.kr_phone_digits(a.phone) = v_digits
       and a.merged_into is null
       and a.deactivated_at is null;

    if v_ids is null then
        return;
    end if;
    if array_length(v_ids, 1) > 1 then
        -- 정규화하면 같은 번호인 활성 계정이 여러 개(데이터 이상): 임의의 한 계정을 고르지 않고 0건으로 응답한다.
        -- exception을 쓰지 않는다 — 함수가 예외로 끝나면 위에서 INSERT한 rate-limit 시도 기록도 같은 트랜잭션에서 롤백돼
        -- "유효한 전체 번호 시도는 결과와 무관하게 센다"는 보장이 깨지고, 오류 문구가 번호 중복 계정의 존재를 외부에 알려주기도 한다.
        -- (데이터 이상의 진단은 서버/운영 쪽에서: select kr_phone_digits(phone), count(*) from accounts where merged_into is null and deactivated_at is null group by 1 having count(*) > 1 — 이 API 응답으로는 노출하지 않는다.)
        return;
    end if;

    return query
    select a.id,
           a.name,
           left(v_digits, 3) || '-****-' || right(v_digits, 4),
           (mc.id is not null),
           mc.status
      from public.accounts a
      left join public.manager_centers mc on mc.account_id = a.id and mc.center_id = p_center_id
     where a.id = v_ids[1];
end;
$_$;


ALTER FUNCTION "public"."search_staff_candidates"("p_center_id" "uuid", "p_phone" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."send_inquiry_message"("p_thread_id" "uuid", "p_body" "text", "p_photos" "text"[] DEFAULT NULL::"text"[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_account uuid := my_account_id();
    v_center uuid;
    v_member uuid;
    v_role text;
    v_id uuid;
    v_preview text;
    v_center_name text;
    m record;
begin
    select center_id, member_account_id into v_center, v_member
      from inquiry_threads where id = p_thread_id;
    if v_center is null then
        raise exception '문의방을 찾을 수 없어요';
    end if;

    -- 발신자 역할 판별
    if v_account = v_member then
        v_role := 'member';
    elsif has_permission(v_center, 'board.inquiry.comment') or is_platform_admin() then
        v_role := 'manager';
    else
        raise exception '이 문의방에 메시지를 보낼 권한이 없어요';
    end if;

    insert into inquiry_messages(thread_id, sender_account_id, sender_role, body, photos)
    values (p_thread_id, v_account, v_role, coalesce(p_body, ''), p_photos)
    returning id into v_id;

    -- 미리보기 텍스트
    v_preview := left(coalesce(p_body, ''), 40);
    if v_preview = '' and p_photos is not null and array_length(p_photos, 1) > 0 then
        v_preview := '(사진)';
    end if;

    update inquiry_threads
       set last_message = v_preview,
           last_message_at = now(),
           member_unread = case when v_role = 'manager' then member_unread + 1 else member_unread end,
           manager_unread = case when v_role = 'member' then manager_unread + 1 else manager_unread end
     where id = p_thread_id;

    return v_id;
end;
$$;


ALTER FUNCTION "public"."send_inquiry_message"("p_thread_id" "uuid", "p_body" "text", "p_photos" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_class_trainers_bulk_safe"("p_class_ids" "uuid"[], "p_account_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center_id uuid;
    v_ids       uuid[];
    v_found     integer;
    v_centers   integer;
    v_accounts  uuid[];
begin
    if p_class_ids is null or array_length(p_class_ids, 1) is null then
        return;
    end if;

    -- [NEW 2026-10-02] 교차 센터 id 주입 차단: 모든 수업이 존재하고 같은 센터여야 한다(권한은 그 센터 기준). 검증은 INSERT보다 먼저.
    -- (이전에는 첫 번째 수업의 센터 권한만 확인한 뒤 SECURITY DEFINER로 배열 전체에 INSERT해, 다른 센터 수업을 섞어 넣을 수 있었다.)
    select array_agg(distinct x) into v_ids from unnest(p_class_ids) x;   -- 중복 제거(null이 있으면 아래 존재 검사에서 거부)
    select count(*), count(distinct center_id), min(center_id::text)::uuid into v_found, v_centers, v_center_id
      from classes where id = any(v_ids);
    if v_found <> array_length(v_ids, 1) then
        raise exception '수업을 찾을 수 없어요';
    end if;
    if v_centers <> 1 then
        raise exception '같은 센터의 수업만 한 번에 지정할 수 있어요';
    end if;
    if not (has_permission(v_center_id, 'schedule.own.group.create') or is_platform_admin()) then
        raise exception '담당 강사를 지정할 권한이 없어요';
    end if;

    -- [NEW 2026-10-02] 담당 강사 대상 검증: 원래 class_trainers INSERT RLS는 "그 수업 센터의 active manager_centers 스태프"만 허용했는데
    -- 이 함수는 SECURITY DEFINER라 RLS를 우회한다 — 같은 불변식을 여기서 보장한다(플랫폼 관리자가 호출해도 동일).
    -- 중복은 첫 위치만 남긴 "검증된 배열"(v_accounts)만 이후 INSERT에 쓰고, 검증은 DELETE/INSERT보다 먼저 한다.
    if p_account_ids is not null and array_length(p_account_ids, 1) > 0 then
        select array_agg(t.aid order by t.first_ord) into v_accounts
          from (select x.aid, min(x.ord) as first_ord from unnest(p_account_ids) with ordinality as x(aid, ord) group by x.aid) t;
        if exists (
            select 1 from unnest(v_accounts) a(aid)
             where a.aid is null
                or not exists (select 1 from manager_centers mc where mc.center_id = v_center_id and mc.account_id = a.aid and mc.status = 'active')
        ) then
            raise exception '이 센터의 활성 스태프만 담당 강사로 지정할 수 있어요';
        end if;
    end if;

    if v_accounts is not null then
        insert into class_trainers (class_id, account_id, sort_order)
        select cid, a.aid, (a.ord - 1)::int from unnest(v_ids) as cid, unnest(v_accounts) with ordinality as a(aid, ord);
    end if;
end;
$$;


ALTER FUNCTION "public"."set_class_trainers_bulk_safe"("p_class_ids" "uuid"[], "p_account_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_class_trainers_for_group_safe"("p_class_ids" "uuid"[], "p_account_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center_id uuid;
    v_is_own boolean;
    v_key text;
    v_ids       uuid[];
    v_found     integer;
    v_centers   integer;
    v_groups    integer;
    v_no_group  boolean;
    v_accounts  uuid[];
begin
    if p_class_ids is null or array_length(p_class_ids, 1) is null then
        return;
    end if;

    -- [NEW 2026-10-02] 교차 센터/교차 그룹 주입 차단: 모든 수업이 존재하고, 같은 센터이며, 같은 반복 그룹(recurring_group_id가 null이 아님)이어야 한다.
    -- 검증은 DELETE/INSERT보다 먼저, own/other 권한 판정도 검증된 id 집합으로만 한다.
    select array_agg(distinct x) into v_ids from unnest(p_class_ids) x;
    select count(*), count(distinct center_id), count(distinct recurring_group_id), coalesce(bool_or(recurring_group_id is null), false), min(center_id::text)::uuid
      into v_found, v_centers, v_groups, v_no_group, v_center_id
      from classes where id = any(v_ids);
    if v_found <> array_length(v_ids, 1) then
        raise exception '수업을 찾을 수 없어요';
    end if;
    if v_centers <> 1 then
        raise exception '같은 센터의 수업만 한 번에 지정할 수 있어요';
    end if;
    if v_no_group or v_groups <> 1 then
        raise exception '같은 반복 수업 그룹의 수업만 한 번에 지정할 수 있어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = any(v_ids))
             or exists (select 1 from class_trainers where class_id = any(v_ids) and account_id = my_account_id());
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.group.update';
    if not (has_permission(v_center_id, v_key) or is_platform_admin()) then
        raise exception '담당 강사를 지정할 권한이 없어요';
    end if;

    -- [NEW 2026-10-02] 담당 강사 대상 검증: 원래 class_trainers INSERT RLS는 "그 수업 센터의 active manager_centers 스태프"만 허용했는데
    -- 이 함수는 SECURITY DEFINER라 RLS를 우회한다 — 같은 불변식을 여기서 보장한다(플랫폼 관리자가 호출해도 동일).
    -- 중복은 첫 위치만 남긴 "검증된 배열"(v_accounts)만 이후 INSERT에 쓰고, 검증은 DELETE/INSERT보다 먼저 한다.
    if p_account_ids is not null and array_length(p_account_ids, 1) > 0 then
        select array_agg(t.aid order by t.first_ord) into v_accounts
          from (select x.aid, min(x.ord) as first_ord from unnest(p_account_ids) with ordinality as x(aid, ord) group by x.aid) t;
        if exists (
            select 1 from unnest(v_accounts) a(aid)
             where a.aid is null
                or not exists (select 1 from manager_centers mc where mc.center_id = v_center_id and mc.account_id = a.aid and mc.status = 'active')
        ) then
            raise exception '이 센터의 활성 스태프만 담당 강사로 지정할 수 있어요';
        end if;
    end if;

    delete from class_trainers where class_id = any(v_ids);
    if v_accounts is not null then
        insert into class_trainers (class_id, account_id, sort_order)
        select cid, a.aid, (a.ord - 1)::int from unnest(v_ids) as cid, unnest(v_accounts) with ordinality as a(aid, ord);
    end if;
end;
$$;


ALTER FUNCTION "public"."set_class_trainers_for_group_safe"("p_class_ids" "uuid"[], "p_account_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_class_trainers_safe"("p_class_id" "uuid", "p_account_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center_id uuid;
    v_format text;
    v_is_own boolean;
    v_key text;
    v_accounts uuid[];
begin
    select center_id, class_format into v_center_id, v_format from classes where id = p_class_id;
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
             or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.update';
    if not (has_permission(v_center_id, v_key) or is_platform_admin()) then
        raise exception '담당 강사를 지정할 권한이 없어요';
    end if;

    -- [NEW 2026-10-02] 담당 강사 대상 검증: 원래 class_trainers INSERT RLS는 "그 수업 센터의 active manager_centers 스태프"만 허용했는데
    -- 이 함수는 SECURITY DEFINER라 RLS를 우회한다 — 같은 불변식을 여기서 보장한다(플랫폼 관리자가 호출해도 동일).
    -- 중복은 첫 위치만 남긴 "검증된 배열"(v_accounts)만 이후 INSERT에 쓰고, 검증은 DELETE/INSERT보다 먼저 한다.
    if p_account_ids is not null and array_length(p_account_ids, 1) > 0 then
        select array_agg(t.aid order by t.first_ord) into v_accounts
          from (select x.aid, min(x.ord) as first_ord from unnest(p_account_ids) with ordinality as x(aid, ord) group by x.aid) t;
        if exists (
            select 1 from unnest(v_accounts) a(aid)
             where a.aid is null
                or not exists (select 1 from manager_centers mc where mc.center_id = v_center_id and mc.account_id = a.aid and mc.status = 'active')
        ) then
            raise exception '이 센터의 활성 스태프만 담당 강사로 지정할 수 있어요';
        end if;
    end if;

    delete from class_trainers where class_id = p_class_id;
    if v_accounts is not null then
        -- 선택한 순서(검증된 배열 순서)를 sort_order로 저장
        insert into class_trainers (class_id, account_id, sort_order)
        select p_class_id, a.aid, (a.ord - 1)::int from unnest(v_accounts) with ordinality as a(aid, ord);
    end if;
end;
$$;


ALTER FUNCTION "public"."set_class_trainers_safe"("p_class_id" "uuid", "p_account_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_default_subscription_plan"("p_plan_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
    if not is_platform_admin() then
        raise exception '플랫폼 운영자만 기본 플랜을 지정할 수 있어요';
    end if;

    update subscription_plans set is_default = false where is_default;
    update subscription_plans set is_default = true where id = p_plan_id;
end;
$$;


ALTER FUNCTION "public"."set_default_subscription_plan"("p_plan_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_membership_session_amounts"("p_membership_id" "uuid", "p_amounts" integer[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center_id  uuid;
    v_total_count int;
    v_paid_total  int;
    v_amounts_sum int;
    i             int;
begin
    select center_id, total_count into v_center_id, v_total_count
    from memberships where id = p_membership_id;
    if v_center_id is null then
        raise exception '수강권을 찾을 수 없어요';
    end if;

    if not has_permission(v_center_id, 'pass.payment.update') then
        raise exception '이 수강권의 회차별 매출을 수정할 권한이 없어요';
    end if;

    if v_total_count is null or v_total_count < 1 then
        raise exception '횟수제가 아닌 수강권은 회차별 금액을 지정할 수 없어요';
    end if;
    if coalesce(array_length(p_amounts, 1), 0) <> v_total_count then
        raise exception '회차 수(%)가 이 수강권의 총 횟수(%)와 일치하지 않아요', coalesce(array_length(p_amounts, 1), 0), v_total_count;
    end if;

    v_amounts_sum := 0;
    for i in 1 .. array_length(p_amounts, 1) loop
        if p_amounts[i] is null or p_amounts[i] < 0 then
            raise exception '회차별 금액은 0 이상이어야 해요(%회차)', i;
        end if;
        v_amounts_sum := v_amounts_sum + p_amounts[i];
    end loop;

    select coalesce(sum(total_amount), 0) into v_paid_total
    from payments where membership_id = p_membership_id;

    if v_amounts_sum <> v_paid_total then
        raise exception '회차별 금액 합계(%)가 이 수강권의 총 결제금액(%)과 일치하지 않아요', v_amounts_sum, v_paid_total;
    end if;

    delete from membership_session_amounts where membership_id = p_membership_id;
    for i in 1 .. array_length(p_amounts, 1) loop
        insert into membership_session_amounts (membership_id, session_index, amount)
        values (p_membership_id, i, p_amounts[i]);
    end loop;
end;
$$;


ALTER FUNCTION "public"."set_membership_session_amounts"("p_membership_id" "uuid", "p_amounts" integer[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_product_count_prices"("p_product_id" "uuid", "p_tiers" "jsonb") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
    v_product products;
    v_n       int;
    v_min     int;
begin
    select * into v_product from products where id = p_product_id for update;
    if not found then
        raise exception '상품을 찾을 수 없어요';
    end if;
    if not (
        has_permission(v_product.center_id, 'pass.create') or has_permission(v_product.center_id, 'pass.update')
        or is_platform_admin()
    ) then
        raise exception '횟수별 가격을 설정할 권한이 없어요';
    end if;

    if p_tiers is null or jsonb_typeof(p_tiers) <> 'array' or jsonb_array_length(p_tiers) = 0 then
        delete from product_count_prices where product_id = p_product_id;
        update products set purchase_count_selectable = false where id = p_product_id;
        return json_build_object('selectable', false, 'tiers', 0);
    end if;

    if v_product.unlimited or v_product.unlimited_pass then
        raise exception '무제한 상품은 횟수 선택형으로 만들 수 없어요';
    end if;

    -- 형식/제약 검증(중복 count, count<1, price<=0 거부)
    select count(*), min((t->>'price')::int)
      into v_n, v_min
      from jsonb_array_elements(p_tiers) t
     where (t->>'count') ~ '^[0-9]+$' and (t->>'price') ~ '^[0-9]+$'
       and (t->>'count')::int >= 1 and (t->>'price')::int > 0;
    if v_n <> jsonb_array_length(p_tiers) then
        raise exception '횟수는 1 이상, 가격은 0원보다 커야 해요';
    end if;
    if (select count(distinct (t->>'count')::int) from jsonb_array_elements(p_tiers) t) <> v_n then
        raise exception '같은 횟수를 두 번 등록할 수 없어요';
    end if;

    delete from product_count_prices where product_id = p_product_id;
    insert into product_count_prices (product_id, count, price)
    select p_product_id, (t->>'count')::int, (t->>'price')::int
      from jsonb_array_elements(p_tiers) t;

    -- 호환 값: products.price = 최저 가격(정렬/"~원부터"/기존 쿼리용). 선택형은 총 횟수를 상품에 고정하지 않는다.
    update products
       set purchase_count_selectable = true,
           price = v_min,
           total_count = null
     where id = p_product_id;

    return json_build_object('selectable', true, 'tiers', v_n, 'min_price', v_min);
end;
$_$;


ALTER FUNCTION "public"."set_product_count_prices"("p_product_id" "uuid", "p_tiers" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."toggle_product_sale_safe"("p_product_id" "uuid", "p_on_sale" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center_id uuid;
begin
    select center_id into v_center_id from products where id = p_product_id;
    if v_center_id is null then
        raise exception '상품을 찾을 수 없어요';
    end if;

    if not (has_permission(v_center_id, 'pass.sale_toggle') or is_platform_admin()) then
        raise exception '판매정지/재개 권한이 없어요';
    end if;

    update products set is_on_sale = p_on_sale where id = p_product_id;
end;
$$;


ALTER FUNCTION "public"."toggle_product_sale_safe"("p_product_id" "uuid", "p_on_sale" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_notify_new_order"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    m record;
    v_center_name text;
    v_buyer text;
begin
    select name into v_center_name from centers where id = new.center_id;
    select coalesce(pr.nickname, pr.name, '회원') into v_buyer
      from profiles pr where pr.id = new.profile_id;

    for m in
        select account_id from manager_centers
         where center_id = new.center_id and status = 'active'
    loop
        perform push_notification(
            m.account_id, 'new_order',
            '새 구매가 있어요',
            coalesce(v_buyer,'회원') || '님이 ' || coalesce(new.product_name, '상품') || ' 구매',
            new.center_id, '/manager/orders',
            jsonb_build_object('order_id', new.id)
        );
    end loop;
    return new;
end;
$$;


ALTER FUNCTION "public"."trg_notify_new_order"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_notify_new_review"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    m record;
begin
    for m in
        select account_id from manager_centers
         where center_id = new.center_id and status = 'active'
    loop
        perform push_notification(
            m.account_id, 'new_review',
            '새 후기가 등록됐어요',
            '별점 ' || coalesce(new.rating, 0) || '점 후기가 달렸어요',
            new.center_id, '/manager/reviews',
            jsonb_build_object('review_id', new.id)
        );
    end loop;
    return new;
end;
$$;


ALTER FUNCTION "public"."trg_notify_new_review"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_notify_reservation_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center uuid;
    v_title text;
    v_start timestamptz;
    v_account uuid;
    v_who text;
    m record;
begin
    select c.center_id, c.title, c.start_time into v_center, v_title, v_start
      from classes c where c.id = new.class_id;

    select pr.account_id, coalesce(pr.nickname, pr.name, '회원')
      into v_account, v_who
      from profiles pr where pr.id = new.profile_id;

    if new.reservation_type in ('ADMIN_ASSIGNMENT', 'ADMIN_FREE') then
        -- 관리자 배치: 회원에게는 무료/사유/관리자명/정원초과 등 내부 정보 노출 안 함
        if v_account is not null and new.status = 'confirmed' then
            perform push_notification(
                v_account, 'admin_assigned', '관리자가 예약을 등록했습니다',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object(
                    'reservation_id', new.id, 'class_id', new.class_id, 'action', 'assigned',
                    'date', to_char(v_start at time zone 'Asia/Seoul', 'YYYY-MM-DD')
                )
            );
        end if;
        -- 관리자가 만든 예약이므로 다른 매니저에게 별도 "새 예약" 알림은 생략(소음 방지)
        return new;
    end if;

    -- 회원 본인 확인 알림 (기존과 동일)
    if v_account is not null then
        if new.status = 'confirmed' then
            perform push_notification(
                v_account, 'reservation_confirmed', '예약이 확정됐어요',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        elsif new.status = 'waitlisted' then
            perform push_notification(
                v_account, 'reservation_waitlisted', '대기자로 등록됐어요',
                v_title || ' · 자리가 나면 알려드릴게요',
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        end if;
    end if;

    -- 매니저 알림 (확정 예약만; 대기는 소음이라 제외)
    if new.status = 'confirmed' then
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'new_reservation', '새 예약이 있어요',
                v_who || '님 · ' || v_title || ' ' ||
                    to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;
    end if;

    return new;
end;
$$;


ALTER FUNCTION "public"."trg_notify_reservation_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_notify_reservation_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center      uuid;
    v_center_name text;
    v_title       text;
    v_start       timestamptz;
    v_account     uuid;
    v_who         text;
    v_restored    boolean;
    m record;
begin
    if new.status = old.status then
        return new;  -- 상태 안 바뀌면 무시
    end if;

    select c.center_id, c.title, c.start_time, ct.name
      into v_center, v_title, v_start, v_center_name
      from classes c
      left join centers ct on ct.id = c.center_id
      where c.id = new.class_id;
    select pr.account_id, coalesce(pr.nickname, pr.name, '회원')
      into v_account, v_who
      from profiles pr where pr.id = new.profile_id;

    -- 대기 → 확정
    if old.status = 'waitlisted' and new.status = 'confirmed' then
        if v_account is not null then
            perform push_notification(
                v_account, 'waitlist_promoted', '대기하던 수업이 확정됐어요',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        end if;

    -- 취소
    elsif new.status = 'cancelled' then
        if v_account is not null then
            if new.cancel_source = 'HOLIDAY' then
                -- [NOTIF-001 E-4] 휴무일 자동취소 전용 문구: 센터명·수업명·시간·취소사유·
                -- 수강권 복구 여부. 복구 여부는 add_holiday_safe와 동일한 조건으로 판정한다
                -- (old.status가 확정/출석이고 membership_consumed && membership_id가 있으면
                -- 그 함수가 복구했다는 뜻).
                v_restored := old.status in ('confirmed', 'attended')
                    and new.membership_consumed
                    and new.membership_id is not null;
                perform push_notification(
                    v_account, 'reservation_canceled', '센터 휴무일로 예약이 취소됐어요',
                    coalesce(v_center_name, '센터') || ' · ' || v_title || ' · ' ||
                        to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI') ||
                        coalesce(' · ' || new.cancel_reason, '') ||
                        case when v_restored then ' · 사용한 수강권 횟수는 복구됐어요' else '' end,
                    v_center, '/my-reservations',
                    jsonb_build_object('reservation_id', new.id, 'cancel_source', 'HOLIDAY')
                );
            else
                perform push_notification(
                    v_account, 'reservation_canceled', '예약이 취소됐어요',
                    v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                    v_center, '/my-reservations',
                    jsonb_build_object('reservation_id', new.id)
                );
            end if;
        end if;
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'reservation_canceled', '예약이 취소됐어요',
                v_who || '님 · ' || v_title || ' ' ||
                    to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;

    -- 노쇼
    elsif new.status = 'no_show' then
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'no_show', '노쇼가 발생했어요',
                v_who || '님이 ' || v_title || ' 수업에 오지 않았어요',
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;
    end if;

    return new;
end;
$$;


ALTER FUNCTION "public"."trg_notify_reservation_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_reservation_goods_restore_on_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_u record;
begin
    for v_u in
        select id, goods_membership_id, unlimited
          from reservation_goods_usages
         where reservation_id = old.id and status = 'deducted'
    loop
        if not v_u.unlimited then
            update memberships set remaining_count = remaining_count + 1
             where id = v_u.goods_membership_id
               and remaining_count is not null
               and status not in ('refunded', 'transferred');
        end if;
    end loop;
    return old;
end;
$$;


ALTER FUNCTION "public"."trg_reservation_goods_restore_on_delete"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_reservation_goods_sync"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_u record;
begin
    if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
        for v_u in
            with upd as (
                update reservation_goods_usages
                   set status = case when status = 'deducted' then 'restored' else 'skipped' end,
                       restored_at = case when status = 'deducted' then now() else restored_at end
                 where reservation_id = new.id and status in ('deducted', 'pending')
             returning goods_membership_id, unlimited, status
            )
            select goods_membership_id, unlimited, status from upd
        loop
            if v_u.status = 'restored' and not v_u.unlimited then
                update memberships set remaining_count = remaining_count + 1
                 where id = v_u.goods_membership_id
                   and remaining_count is not null
                   and status not in ('refunded', 'transferred');
            end if;
        end loop;
    elsif old.status = 'waitlisted' and new.status = 'confirmed' then
        for v_u in
            select u.id, u.goods_membership_id, u.unlimited
              from reservation_goods_usages u
             where u.reservation_id = new.id and u.status = 'pending'
        loop
            if v_u.unlimited then
                update reservation_goods_usages set status = 'deducted', deducted_at = now() where id = v_u.id;
            else
                update memberships set remaining_count = remaining_count - 1
                 where id = v_u.goods_membership_id
                   and status = 'active'
                   and remaining_count > 0;
                if found then
                    update reservation_goods_usages set status = 'deducted', deducted_at = now() where id = v_u.id;
                else
                    update reservation_goods_usages set status = 'skipped' where id = v_u.id;  -- 잔여 없음: 차감 안 함
                end if;
            end if;
        end loop;
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."trg_reservation_goods_sync"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unplaced_weekday_passes"("p_center_id" "uuid") RETURNS TABLE("membership_id" "uuid", "profile_id" "uuid", "member_name" "text", "product_name" "text", "total_count" integer, "remaining_count" integer, "auto_book_days" integer[], "expires_at" "date", "purchased_at" timestamp with time zone, "bound_day_of_week" integer, "bound_start_time" time without time zone, "expired" boolean, "can_retry" boolean, "reason_code" "text", "placeable_count" integer, "skipped" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_row record;
    v_res jsonb;
    v_today date := (now() at time zone 'Asia/Seoul')::date;
begin
    if not (p_center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        return;
    end if;
    for v_row in
        select m.id as mid, m.profile_id as pid, coalesce(p.name, '(이름 없음)') as pname,
               m.product_name as prod, m.total_count as tc, m.remaining_count as rc,
               pr.auto_book_days as abd, m.expires_at as exp, m.created_at as cat,
               m.bound_day_of_week as bdow, m.bound_start_time as bst
        from memberships m
        join products pr on pr.id = m.product_id
        left join profiles p on p.id = m.profile_id
        where m.center_id = p_center_id
          and m.status = 'active'
          and ((pr.auto_book_days is not null and array_length(pr.auto_book_days, 1) > 0) or m.auto_book_requested)
          and coalesce(m.remaining_count, 0) > 0
        order by m.created_at asc
    loop
        v_res := _auto_book_membership_core(v_row.mid, true);
        membership_id := v_row.mid; profile_id := v_row.pid; member_name := v_row.pname;
        product_name := v_row.prod; total_count := v_row.tc; remaining_count := v_row.rc;
        auto_book_days := v_row.abd; expires_at := v_row.exp; purchased_at := v_row.cat;
        bound_day_of_week := v_row.bdow; bound_start_time := v_row.bst;
        expired := v_row.exp is not null and v_row.exp < v_today;
        can_retry := not expired;
        reason_code := coalesce(v_res->>'reason', 'unknown');
        placeable_count := coalesce((v_res->>'booked')::int, 0);
        skipped := coalesce(v_res->'skipped', '{}'::jsonb);
        return next;
    end loop;
end;
$$;


ALTER FUNCTION "public"."unplaced_weekday_passes"("p_center_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_class_group_safe"("p_group_id" "uuid", "p_title" "text", "p_capacity" integer, "p_updates" "jsonb") RETURNS "uuid"[]
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center_id uuid;
    v_is_own boolean;
    v_is_past boolean;
    v_key text;
    v_verb text;
    v_ids uuid[];
    v_row jsonb;
    v_confirmed int;
begin
    select center_id into v_center_id from classes where recurring_group_id = p_group_id limit 1;
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (
            select 1 from class_trainers ct join classes c on c.id = ct.class_id
             where c.recurring_group_id = p_group_id
        )
        or exists (
            select 1 from class_trainers ct join classes c on c.id = ct.class_id
             where c.recurring_group_id = p_group_id and ct.account_id = my_account_id()
        );
    v_is_past := exists (
        select 1 from classes c, jsonb_array_elements(p_updates) as u
        where c.id = (u->>'id')::uuid and c.recurring_group_id = p_group_id and c.start_time < now()
    );
    v_verb := case when v_is_past then 'past_update' else 'update' end;
    -- 반복 등록은 group 수업만 지원(create_recurring_classes_safe와 동일한 전제)
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.group.' || v_verb;
    if not (has_permission(v_center_id, v_key) or is_platform_admin()) then
        raise exception '이 수업을 수정할 권한이 없어요';
    end if;

    -- 선택 항목 검증: 룸은 같은 센터 것만, 정원은 현재 확정 인원 아래로 줄일 수 없다(update_class_safe와 동일한 불변식).
    for v_row in select u from jsonb_array_elements(p_updates) u loop
        if v_row ? 'room_id' and nullif(v_row->>'room_id', '') is not null
           and not exists (select 1 from rooms r where r.id = (v_row->>'room_id')::uuid and r.center_id = v_center_id) then
            raise exception '이 센터의 룸이 아니에요';
        end if;
        if v_row ? 'capacity' then
            select count(*) into v_confirmed from reservations
             where class_id = (v_row->>'id')::uuid and status in ('confirmed', 'attended');
            if (v_row->>'capacity')::int < v_confirmed then
                raise exception '현재 확정 예약 인원(%명)보다 적게 정원을 줄일 수 없어요', v_confirmed;
            end if;
        end if;
    end loop;

    -- [NEW 2026-10-02] 반복 수업 전체 적용에 "예약 가능 수강권 설정"도 포함할 수 있다 — 행의 선택 키:
    --   pass_selection_mode('all'|'selected'), allowed_product_ids(uuid 문자열 배열, 'selected'일 때만 의미)
    -- 모든 검증을 갱신 전에 끝내고, 수업 갱신과 허용 수강권 교체는 같은 트랜잭션(이 함수)에서 처리한다.
    for v_row in select u from jsonb_array_elements(p_updates) u where u ? 'pass_selection_mode' loop
        if (v_row->>'pass_selection_mode') not in ('all', 'selected') then
            raise exception '수강권 허용 방식이 올바르지 않아요';
        end if;
        if (v_row->>'pass_selection_mode') = 'selected' then
            if coalesce(jsonb_array_length(v_row->'allowed_product_ids'), 0) = 0 then
                raise exception '예약 가능 수강권을 1개 이상 선택해주세요';
            end if;
            if exists (
                select 1 from jsonb_array_elements_text(v_row->'allowed_product_ids') pid
                 where not exists (select 1 from products p where p.id = pid::uuid and p.center_id = v_center_id and p.product_kind = 'pass')
            ) then
                raise exception '이 센터의 수강권만 선택할 수 있어요';
            end if;
        end if;
    end loop;

    -- 같은 center_id + 같은 recurring_group_id의 수업만, 한 문장(=한 트랜잭션)으로 갱신한다.
    -- p_updates 각 행은 id/start_time/end_time(각 수업의 기존 값 또는 의도된 값)과, "바뀐 공통 필드만" 선택 키로 온다:
    --   description, capacity, room_id, allow_goods, allow_cancel, cancel_deadline_min, booking_deadline_min
    -- 키가 없으면 그 수업의 기존 값을 유지한다(요일마다 다른 정원/룸/마감 설정을 덮어쓰지 않음).
    -- p_capacity는 하위 호환용으로만 남겼고 더 이상 그룹 전체에 강제하지 않는다(행의 'capacity' 키가 대신한다).
    with upd as (
        update classes c set
            title = p_title,
            start_time = (u->>'start_time')::timestamptz,
            end_time = (u->>'end_time')::timestamptz,
            capacity = case when u ? 'capacity' then (u->>'capacity')::int else c.capacity end,
            description = case when u ? 'description' then nullif(btrim(coalesce(u->>'description', '')), '') else c.description end,
            room_id = case when u ? 'room_id' then nullif(u->>'room_id', '')::uuid else c.room_id end,
            allow_goods = case when u ? 'allow_goods' then (u->>'allow_goods')::boolean else c.allow_goods end,
            allow_cancel = case when u ? 'allow_cancel' then (u->>'allow_cancel')::boolean else c.allow_cancel end,
            cancel_deadline_min = case when u ? 'cancel_deadline_min' then nullif(u->>'cancel_deadline_min', '')::int else c.cancel_deadline_min end,
            booking_deadline_min = case when u ? 'booking_deadline_min' then nullif(u->>'booking_deadline_min', '')::int else c.booking_deadline_min end,
            pass_selection_mode = case when u ? 'pass_selection_mode' then u->>'pass_selection_mode' else c.pass_selection_mode end
        from jsonb_array_elements(p_updates) as u
        where c.id = (u->>'id')::uuid
          and c.recurring_group_id = p_group_id
          and c.center_id = v_center_id
        returning c.id
    )
    select array_agg(id) into v_ids from upd;

    -- 허용 수강권 교체: 키가 온 행만(없으면 그 수업의 기존 설정 보존). 'all'은 행을 비워 "그 순간의 모든 수강권"을 가리킨다.
    if v_ids is not null then
        delete from class_allowed_products cap
         using jsonb_array_elements(p_updates) u
         where u ? 'pass_selection_mode' and cap.class_id = (u->>'id')::uuid and cap.class_id = any(v_ids);
        insert into class_allowed_products (class_id, product_id)
        select distinct (u->>'id')::uuid, pid::uuid
          from jsonb_array_elements(p_updates) u, jsonb_array_elements_text(u->'allowed_product_ids') pid
         where u ? 'pass_selection_mode' and u->>'pass_selection_mode' = 'selected' and (u->>'id')::uuid = any(v_ids);
    end if;

    return coalesce(v_ids, array[]::uuid[]);
end;
$$;


ALTER FUNCTION "public"."update_class_group_safe"("p_group_id" "uuid", "p_title" "text", "p_capacity" integer, "p_updates" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_class_pass_selection_mode_safe"("p_class_id" "uuid", "p_mode" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center_id uuid;
    v_format text;
    v_orig_start timestamptz;
    v_is_own boolean;
    v_key text;
    v_verb text;
begin
    select center_id, class_format, start_time into v_center_id, v_format, v_orig_start from classes where id = p_class_id;
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
             or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    v_verb := case when v_orig_start < now() then 'past_update' else 'update' end;
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
    if not (has_permission(v_center_id, v_key) or is_platform_admin()) then
        raise exception '이 수업을 수정할 권한이 없어요';
    end if;

    update classes set pass_selection_mode = p_mode where id = p_class_id;
end;
$$;


ALTER FUNCTION "public"."update_class_pass_selection_mode_safe"("p_class_id" "uuid", "p_mode" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_class_safe"("p_class_id" "uuid", "p_title" "text", "p_description" "text", "p_start_time" timestamp with time zone, "p_end_time" timestamp with time zone, "p_capacity" integer, "p_allow_goods" boolean, "p_room_id" "uuid", "p_cancel_deadline_min" integer, "p_booking_deadline_min" integer, "p_class_format" "text", "p_pass_selection_mode" "text", "p_allow_cancel" boolean DEFAULT true) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_center_id uuid;
    v_format text;
    v_orig_start timestamptz;
    v_is_own boolean;
    v_key text;
    v_verb text;
    v_old_capacity int;
    v_confirmed_count int;
    v_promoted_count int := 0;
    v_next record;
    v_next_mem record;
begin
    select
        center_id,
        class_format,
        start_time,
        capacity
    into
        v_center_id,
        v_format,
        v_orig_start,
        v_old_capacity
    from classes
    where id = p_class_id
    for update;

    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own :=
        not exists (
            select 1
            from class_trainers
            where class_id = p_class_id
        )
        or exists (
            select 1
            from class_trainers
            where class_id = p_class_id
              and account_id = my_account_id()
        );

    v_verb :=
        case
            when v_orig_start < now()
                then 'past_update'
            else 'update'
        end;

    v_key :=
        'schedule.'
        || (
            case
                when v_is_own then 'own'
                else 'other'
            end
        )
        || '.'
        || (
            case
                when v_format = 'private'
                    then 'private'
                else 'group'
            end
        )
        || '.'
        || v_verb;

    if not (
        has_permission(v_center_id, v_key)
        or is_platform_admin()
    ) then
        raise exception '이 수업을 수정할 권한이 없어요';
    end if;

    if p_capacity is not null
       and p_capacity < v_old_capacity then

        select count(*)
        into v_confirmed_count
        from reservations
        where class_id = p_class_id
          and status = 'confirmed';

        if p_capacity < v_confirmed_count then
            raise exception
                '현재 확정 예약 인원(%명)보다 적게 정원을 줄일 수 없습니다.',
                v_confirmed_count;
        end if;
    end if;

    update classes
    set
        title = p_title,
        description = p_description,
        start_time = p_start_time,
        end_time = p_end_time,
        capacity = p_capacity,
        allow_goods = coalesce(p_allow_goods, true),
        room_id = p_room_id,
        cancel_deadline_min = coalesce(p_cancel_deadline_min, 0),
        booking_deadline_min = p_booking_deadline_min,
        class_format = coalesce(p_class_format, 'group'),
        pass_selection_mode = coalesce(p_pass_selection_mode, 'all'),
        allow_cancel = coalesce(p_allow_cancel, true)
    where id = p_class_id;

    if p_capacity is not null
       and p_capacity > v_old_capacity then

        select count(*)
        into v_confirmed_count
        from reservations
        where class_id = p_class_id
          and status = 'confirmed';

        for v_next in
            select *
            from reservations
            where class_id = p_class_id
              and status = 'waitlisted'
            order by waitlist_order asc
            for update
        loop
            exit when v_confirmed_count >= p_capacity;

            select *
            into v_next_mem
            from memberships m
            where m.id = v_next.membership_id
              and m.status = 'active'
              and (
                  m.remaining_count is null
                  or m.remaining_count > 0
              )
              and (
                  m.expires_at is null
                  or m.expires_at >= (
                      now()
                      at time zone 'Asia/Seoul'
                  )::date
              )
              and (
                  m.starts_at is null
                  or m.starts_at <= (
                      now()
                      at time zone 'Asia/Seoul'
                  )::date
              )
              and is_membership_eligible_for_class(
                  m.id,
                  p_class_id
              )
            for update;

            if found then
                update reservations
                set
                    status = 'confirmed',
                    waitlist_order = null,
                    membership_consumed = true
                where id = v_next.id;

                update memberships
                set remaining_count = remaining_count - 1
                where id = v_next_mem.id
                  and remaining_count is not null;

                v_confirmed_count := v_confirmed_count + 1;
                v_promoted_count := v_promoted_count + 1;
            end if;
        end loop;
    end if;

    return json_build_object(
        'promoted_count',
        v_promoted_count
    );
end;
$$;


ALTER FUNCTION "public"."update_class_safe"("p_class_id" "uuid", "p_title" "text", "p_description" "text", "p_start_time" timestamp with time zone, "p_end_time" timestamp with time zone, "p_capacity" integer, "p_allow_goods" boolean, "p_room_id" "uuid", "p_cancel_deadline_min" integer, "p_booking_deadline_min" integer, "p_class_format" "text", "p_pass_selection_mode" "text", "p_allow_cancel" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."usable_memberships"("p_class_id" "uuid", "p_profile_id" "uuid") RETURNS TABLE("membership_id" "uuid", "product_name" "text", "remaining_count" integer, "expires_at" "date", "owner_profile" "text", "is_mine" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
      -- [usable_memberships_for_classes와 동일] 무제한(expires_at NULL) 보존, 미래 시작(starts_at) 제외 — 둘 다 KST 날짜 기준
      and (m.expires_at is null or m.expires_at >= (now() at time zone 'Asia/Seoul')::date)
      and (m.starts_at is null or m.starts_at <= (now() at time zone 'Asia/Seoul')::date)
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            -- [수강권 허용 정책 변경] 'all'이면 class_allowed_products 존재 여부와
            -- 무관하게 전부 허용(기존 "0건=전체허용"과 동일). 'selected'면 그 목록에
            -- 있는 product만 허용.
            cls.pass_selection_mode = 'all'
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            -- [F2] 'selected' 지정 상품도 예약조건을 건너뛰지 않는다(서버 is_membership_eligible_for_class와 동일: A AND B AND C)
            m.product_id is null
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
$$;


ALTER FUNCTION "public"."usable_memberships"("p_class_id" "uuid", "p_profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."usable_memberships_for_classes"("p_class_ids" "uuid"[], "p_profile_id" "uuid") RETURNS TABLE("class_id" "uuid", "membership_id" "uuid", "product_name" "text", "remaining_count" integer, "expires_at" "date", "owner_profile" "text", "is_mine" boolean, "issued_at" "date")
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
      and (m.expires_at is null or m.expires_at >= (now() at time zone 'Asia/Seoul')::date)
      and (m.starts_at is null or m.starts_at <= (now() at time zone 'Asia/Seoul')::date)
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            cls.pass_selection_mode = 'all'
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            -- [F2] 'selected' 지정 상품도 예약조건을 건너뛰지 않는다(서버 is_membership_eligible_for_class와 동일: A AND B AND C)
            m.product_id is null
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
$$;


ALTER FUNCTION "public"."usable_memberships_for_classes"("p_class_ids" "uuid"[], "p_profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."use_points"("p_center_id" "uuid", "p_profile_id" "uuid", "p_amount" integer, "p_order_id" "uuid" DEFAULT NULL::"uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_balance  int;
    v_order    orders;
    v_existing int;
begin
    if p_profile_id not in (select my_profile_ids()) then
        raise exception '본인 포인트만 사용할 수 있어요';
    end if;
    if p_amount <= 0 then
        return json_build_object('used', 0);
    end if;

    perform 1 from profiles where id = p_profile_id for update;

    if p_order_id is not null then
        select * into v_order from orders where id = p_order_id for update;
        if not found then
            raise exception '주문을 찾을 수 없어요';
        end if;
        if v_order.profile_id is distinct from p_profile_id or v_order.center_id is distinct from p_center_id then
            raise exception '본인 주문에만 포인트를 사용할 수 있어요';
        end if;
        if v_order.status <> 'pending' then
            raise exception '결제 대기 중인 주문에만 포인트를 사용할 수 있어요';
        end if;
        if coalesce(v_order.points_used, 0) <> p_amount then
            raise exception '주문의 포인트 사용 금액과 일치하지 않아요';
        end if;
        select coalesce(sum(-amount), 0) into v_existing
          from point_transactions
         where order_id = p_order_id and reason = '결제 시 사용' and amount < 0;
        if v_existing > 0 then
            -- 이미 차감된 주문 — 같은 요청이 다시 와도 두 번 차감하지 않는다
            return json_build_object('used', v_existing, 'already_used', true);
        end if;
    end if;

    select coalesce(sum(amount), 0) into v_balance
    from point_transactions
    where center_id = p_center_id and profile_id = p_profile_id;

    if v_balance < p_amount then
        raise exception '포인트가 부족해요';
    end if;

    insert into point_transactions (profile_id, center_id, amount, reason, order_id)
    values (p_profile_id, p_center_id, -p_amount, '결제 시 사용', p_order_id);

    return json_build_object('used', p_amount);
end;
$$;


ALTER FUNCTION "public"."use_points"("p_center_id" "uuid", "p_profile_id" "uuid", "p_amount" integer, "p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_product_schedule_selection"("p_product_id" "uuid", "p_day" integer, "p_time" time without time zone) RETURNS "void"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if p_day is null or not exists (
        select 1
        from membership_schedule_rules r
        where r.product_id = p_product_id
          and r.day_of_week = p_day
    ) then
        raise exception '선택할 수 없는 요일이에요. 이 상품의 예약조건에 없는 요일이에요';
    end if;

    if p_time is not null and not exists (
        select 1
        from membership_schedule_rules r
        where r.product_id = p_product_id
          and r.day_of_week = p_day
          and r.start_time = p_time
    ) then
        raise exception '선택할 수 없는 시간이에요. 이 상품의 예약조건에 없는 시간이에요';
    end if;
end;
$$;


ALTER FUNCTION "public"."validate_product_schedule_selection"("p_product_id" "uuid", "p_day" integer, "p_time" time without time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_phone_otp"("p_phone" "text", "p_code" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  v_row phone_verifications%rowtype;
begin
  select * into v_row from phone_verifications
    where phone = p_phone order by created_at desc limit 1;

  if v_row.id is null then
    raise exception '인증번호를 먼저 요청해주세요';
  end if;
  if v_row.expires_at < now() then
    raise exception '인증번호가 만료됐어요. 다시 요청해주세요';
  end if;
  if v_row.attempt_count >= 5 then
    raise exception '시도 횟수를 초과했어요. 다시 요청해주세요';
  end if;

  update phone_verifications set attempt_count = attempt_count + 1 where id = v_row.id;

  if v_row.code_hash <> crypt(p_code, v_row.code_hash) then
    return false;
  end if;

  update phone_verifications set verified_at = now() where id = v_row.id;
  return true;
end;
$$;


ALTER FUNCTION "public"."verify_phone_otp"("p_phone" "text", "p_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."write_review"("p_center_id" "uuid", "p_profile_id" "uuid", "p_rating" integer, "p_content" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    v_has_pass int;
    v_point    int;
    v_exists   int;
begin
    if p_profile_id not in (select my_profile_ids()) then
        raise exception '본인 프로필로만 후기를 쓸 수 있어요';
    end if;

    select count(*) into v_has_pass
    from memberships
    where profile_id = p_profile_id and center_id = p_center_id;
    if v_has_pass = 0 then
        raise exception '이 센터의 수강권을 구매한 회원만 후기를 쓸 수 있어요';
    end if;

    select count(*) into v_exists
    from reviews where center_id = p_center_id and profile_id = p_profile_id;
    if v_exists > 0 then
        raise exception '이미 이 센터에 후기를 작성했어요';
    end if;

    insert into reviews (center_id, profile_id, rating, content)
    values (p_center_id, p_profile_id, p_rating, p_content);

    select coalesce(review_point, 0) into v_point from centers where id = p_center_id;
    if v_point > 0 then
        insert into point_transactions (profile_id, center_id, amount, reason)
        values (p_profile_id, p_center_id, v_point, '후기 작성 적립');
    end if;

    return json_build_object('point', v_point);
end;
$$;


ALTER FUNCTION "public"."write_review"("p_center_id" "uuid", "p_profile_id" "uuid", "p_rating" integer, "p_content" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."write_review"("p_center_id" "uuid", "p_profile_id" "uuid", "p_rating" integer, "p_content" "text", "p_photos" "text"[] DEFAULT NULL::"text"[]) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    v_has_pass int;
    v_point    int;
    v_exists   int;
begin
    if p_profile_id not in (select my_profile_ids()) then
        raise exception '본인 프로필로만 후기를 쓸 수 있어요';
    end if;

    -- 구매 이력 확인 (보유 중 + 과거 구매 모두 인정)
    select count(*) into v_has_pass
    from memberships
    where profile_id = p_profile_id and center_id = p_center_id;

    -- 주문 이력도 인정 (아직 발급 전이거나 발급 기록이 없는 경우 대비)
    if v_has_pass = 0 then
        select count(*) into v_has_pass
        from orders
        where profile_id = p_profile_id
          and center_id = p_center_id
          and status in ('paid', 'done');
    end if;

    if v_has_pass = 0 then
        raise exception '이 센터의 수강권을 구매한 적이 있는 회원만 후기를 쓸 수 있어요';
    end if;

    select count(*) into v_exists
    from center_reviews where center_id = p_center_id and profile_id = p_profile_id;
    if v_exists > 0 then
        raise exception '이미 이 센터에 후기를 작성했어요';
    end if;

    insert into center_reviews (center_id, profile_id, rating, content, photos)
    values (p_center_id, p_profile_id, p_rating, p_content, p_photos);

    -- 포인트 적립
    select coalesce(review_point, 0) into v_point from centers where id = p_center_id;
    if v_point > 0 then
        insert into point_accounts (center_id, profile_id, balance)
        values (p_center_id, p_profile_id, v_point)
        on conflict (center_id, profile_id) do update
            set balance = point_accounts.balance + v_point,
                updated_at = now();

        insert into point_logs (center_id, profile_id, amount, reason, memo)
        values (p_center_id, p_profile_id, v_point, 'review', '후기 작성 적립');
    end if;

    return json_build_object('point', v_point);
end;
$$;


ALTER FUNCTION "public"."write_review"("p_center_id" "uuid", "p_profile_id" "uuid", "p_rating" integer, "p_content" "text", "p_photos" "text"[]) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."account_auth_identities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_id" "uuid" NOT NULL,
    "auth_id" "uuid" NOT NULL,
    "provider_label" "text",
    "linked_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."account_auth_identities" OWNER TO "postgres";


COMMENT ON TABLE "public"."account_auth_identities" IS '병합으로 흡수된 auth.users.id → 남은 accounts.id 매핑. my_account_id()가 1차 조회에
     실패하면 이 표를 2차로 확인한다.';



CREATE TABLE IF NOT EXISTS "public"."account_center_permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "manager_center_id" "uuid" NOT NULL,
    "permission_key" "text" NOT NULL,
    "grant_type" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "account_center_permissions_grant_type_check" CHECK (("grant_type" = ANY (ARRAY['allow'::"text", 'deny'::"text"])))
);


ALTER TABLE "public"."account_center_permissions" OWNER TO "postgres";


COMMENT ON TABLE "public"."account_center_permissions" IS '개인별 권한 예외. allow=역할에 없어도 부여, deny=역할에 있어도 차단';



CREATE TABLE IF NOT EXISTS "public"."account_link_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "requester_account_id" "uuid" NOT NULL,
    "code" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "account_link_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'used'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."account_link_requests" OWNER TO "postgres";


COMMENT ON TABLE "public"."account_link_requests" IS '계정 연동 일회성 코드. 계정당 대기 중인 코드는 하나뿐';



CREATE TABLE IF NOT EXISTS "public"."accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "auth_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "phone" "text",
    "is_member" boolean DEFAULT true NOT NULL,
    "is_manager" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_platform_admin" boolean DEFAULT false NOT NULL,
    "address" "text",
    "deactivated_at" timestamp with time zone,
    "pg_checkout_override" boolean DEFAULT false NOT NULL,
    "merged_into" "uuid",
    "marketing_consent" boolean DEFAULT false NOT NULL,
    "marketing_consent_at" timestamp with time zone
);


ALTER TABLE "public"."accounts" OWNER TO "postgres";


COMMENT ON TABLE "public"."accounts" IS '로그인 단위. is_member/is_manager로 어떤 역할을 쓸 수 있는지 표시';



COMMENT ON COLUMN "public"."accounts"."is_platform_admin" IS '플랫폼 운영자. 센터 가입 승인/반려 권한. 일반 가입으로는 부여되지 않음';



COMMENT ON COLUMN "public"."accounts"."deactivated_at" IS '계정 탈퇴(소프트 삭제) 시각. null이면 활성 계정. 실제 로그인 차단은 auth.users.banned_until(Admin API)로 별도 처리됨(supabase/functions/delete-account, add_account_deactivation.sql).';



COMMENT ON COLUMN "public"."accounts"."merged_into" IS '이 계정이 다른 계정에 합쳐졌으면 그 계정의 id. null이면 정상 계정';



COMMENT ON COLUMN "public"."accounts"."marketing_consent" IS '마케팅 정보 수신 동의(선택). true/false 어느 쪽이든 marketing_consent_at이 그 값으로 바뀐 시각.';



COMMENT ON COLUMN "public"."accounts"."marketing_consent_at" IS 'marketing_consent가 마지막으로 바뀐 시각(동의/철회 공통 — 최초 기본값 false는 시각 없음).';



CREATE TABLE IF NOT EXISTS "public"."admin_action_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "reservation_id" "uuid",
    "action_type" "text" NOT NULL,
    "reservation_type" "text",
    "reservation_source" "text",
    "admin_id" "uuid" NOT NULL,
    "member_profile_id" "uuid",
    "class_id" "uuid",
    "membership_id" "uuid",
    "source_unassigned_id" "uuid",
    "reason_code" "text",
    "reason_detail" "text",
    "capacity_override" boolean DEFAULT false NOT NULL,
    "membership_consumed" boolean DEFAULT false NOT NULL,
    "member_name_snapshot" "text",
    "class_title_snapshot" "text",
    "class_start_snapshot" timestamp with time zone,
    "before_state" "jsonb",
    "after_state" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "admin_action_logs_action_type_check" CHECK (("action_type" = ANY (ARRAY['CREATE_ASSIGNMENT'::"text", 'CREATE_FREE'::"text", 'CANCEL_ASSIGNMENT'::"text", 'CANCEL_FREE'::"text", 'NOTICE_CREATE'::"text", 'NOTICE_DELETE'::"text", 'CLASS_CREATE'::"text", 'CLASS_UPDATE'::"text", 'CLASS_CANCEL'::"text", 'MEMBERSHIP_CREATE'::"text", 'MEMBERSHIP_UPDATE'::"text"])))
);


ALTER TABLE "public"."admin_action_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."admin_action_logs" IS '관리자 직접배치/무료배치/취소 작업 로그. 일반 매니저 UI에서 수정·삭제 불가(RLS에 update/delete 정책 없음).';



COMMENT ON COLUMN "public"."admin_action_logs"."reservation_id" IS '예약 관련 액션(CREATE_*/CANCEL_*)에서만 채워짐. 공지/수업/수강권 등 향후 비예약 액션에는 NULL.';



COMMENT ON COLUMN "public"."admin_action_logs"."class_id" IS '예약 관련 액션에서만 채워짐. CLASS_CREATE/CLASS_UPDATE 같은 향후 액션은 이 컬럼 대신 별도 식별자를 쓸 수 있음.';



CREATE TABLE IF NOT EXISTS "public"."alimtalk_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid",
    "aligo_template_code" "text",
    "title" "text" NOT NULL,
    "content" "text" NOT NULL,
    "variables" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "alimtalk_templates_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."alimtalk_templates" OWNER TO "postgres";


COMMENT ON TABLE "public"."alimtalk_templates" IS '센터별 카카오 알림톡 승인 템플릿. 자유 문장 발송이 안 돼서 자동 발송 규칙은 이 중 승인된 것만 골라 씀';



COMMENT ON COLUMN "public"."alimtalk_templates"."center_id" IS '이 템플릿을 쓸 수 있는 센터. null이면 "공통" — 플랫폼 전체 센터가 다 쓸 수 있음(운영자만 생성/수정 가능)';



CREATE TABLE IF NOT EXISTS "public"."cart_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "center_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "product_name" "text" NOT NULL,
    "price" integer DEFAULT 0 NOT NULL,
    "selected_size" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "selected_count" integer
);


ALTER TABLE "public"."cart_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."center_announcements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "photos" "text"[],
    "pinned" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone
);


ALTER TABLE "public"."center_announcements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."center_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "channel_type" "text" NOT NULL,
    "value" "text" NOT NULL,
    "label" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "center_contacts_channel_type_check" CHECK (("channel_type" = ANY (ARRAY['kakao_channel'::"text", 'kakao_personal'::"text", 'sms'::"text", 'instagram'::"text", 'phone'::"text"])))
);


ALTER TABLE "public"."center_contacts" OWNER TO "postgres";


COMMENT ON TABLE "public"."center_contacts" IS '센터가 지정한 1:1 상담 채널. 회원이 누르면 해당 메신저로 연결';



CREATE TABLE IF NOT EXISTS "public"."center_holidays" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "holiday_date" "date" NOT NULL,
    "reason" "text"
);


ALTER TABLE "public"."center_holidays" OWNER TO "postgres";


COMMENT ON TABLE "public"."center_holidays" IS '센터 휴무일. 회원 달력에 빨간색으로 표시됨';



CREATE TABLE IF NOT EXISTS "public"."center_member_fields" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "field_key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "field_type" "text" DEFAULT 'text'::"text" NOT NULL,
    "options" "text"[],
    "is_required" boolean DEFAULT false NOT NULL,
    "show_in_member_list" boolean DEFAULT false NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "center_member_fields_field_type_check" CHECK (("field_type" = ANY (ARRAY['text'::"text", 'number'::"text", 'date'::"text", 'select'::"text"])))
);


ALTER TABLE "public"."center_member_fields" OWNER TO "postgres";


COMMENT ON TABLE "public"."center_member_fields" IS '센터가 직접 지정하는 회원정보 항목. 필수 여부·목록 노출 여부 설정';



CREATE TABLE IF NOT EXISTS "public"."center_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "grade_id" "uuid",
    "registered_at" "date" DEFAULT CURRENT_DATE NOT NULL,
    "last_attended_at" "date",
    "app_linked" boolean DEFAULT false NOT NULL,
    "app_email" "text",
    "memo" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "dormant_since" timestamp with time zone,
    CONSTRAINT "center_members_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'expired'::"text", 'dormant'::"text"])))
);


ALTER TABLE "public"."center_members" OWNER TO "postgres";


COMMENT ON TABLE "public"."center_members" IS '센터에 등록된 회원 명단. 등급·출석·앱연결 여부·메모 관리';



CREATE TABLE IF NOT EXISTS "public"."center_payout_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "payout_provider" "text" DEFAULT 'toss_payouts'::"text" NOT NULL,
    "status" "text" DEFAULT 'not_registered'::"text" NOT NULL,
    "rejection_reason" "text",
    "bank_name" "text",
    "bank_account_last4" "text",
    "account_holder_name" "text",
    "verified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "center_payout_accounts_status_check" CHECK (("status" = ANY (ARRAY['not_registered'::"text", 'approval_required'::"text", 'partially_approved'::"text", 'kyc_required'::"text", 'approved'::"text", 'rejected'::"text", 'suspended'::"text"])))
);


ALTER TABLE "public"."center_payout_accounts" OWNER TO "postgres";


COMMENT ON TABLE "public"."center_payout_accounts" IS '센터별 Toss 지급대행 셀러 등록·심사 상태(센터당 1행). 계좌 원본 정보는 저장하지 않음 — Toss가 보관, 여기는 상태·마스킹 정보만. insert/update 정책 없음(service_role 전용)';



COMMENT ON COLUMN "public"."center_payout_accounts"."status" IS 'not_registered/approval_required/partially_approved/kyc_required/approved/rejected/suspended';



CREATE TABLE IF NOT EXISTS "public"."center_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "rating" integer NOT NULL,
    "content" "text" NOT NULL,
    "photos" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reply" "text",
    "replied_at" timestamp with time zone,
    "hidden" boolean DEFAULT false NOT NULL,
    CONSTRAINT "center_reviews_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);


ALTER TABLE "public"."center_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."center_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "role_key" "text",
    "is_system" boolean DEFAULT false NOT NULL,
    "is_owner" boolean DEFAULT false NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."center_roles" OWNER TO "postgres";


COMMENT ON TABLE "public"."center_roles" IS '센터별 관리자 역할. 스튜디오 오너가 새 역할을 추가할 수 있음';



CREATE TABLE IF NOT EXISTS "public"."center_settings" (
    "center_id" "uuid" NOT NULL,
    "private_book_days_before" integer DEFAULT 1 NOT NULL,
    "private_book_time" time without time zone DEFAULT '22:00:00'::time without time zone NOT NULL,
    "group_book_days_before" integer DEFAULT 1 NOT NULL,
    "group_book_time" time without time zone DEFAULT '22:00:00'::time without time zone NOT NULL,
    "private_cancel_days_before" integer DEFAULT 1 NOT NULL,
    "private_cancel_time" time without time zone DEFAULT '22:00:00'::time without time zone NOT NULL,
    "group_cancel_days_before" integer DEFAULT 1 NOT NULL,
    "group_cancel_time" time without time zone DEFAULT '22:00:00'::time without time zone NOT NULL,
    "same_day_change_hours" integer DEFAULT 24 NOT NULL,
    "same_day_change_minutes" integer DEFAULT 0 NOT NULL,
    "autocancel_hours" integer DEFAULT 0 NOT NULL,
    "autocancel_minutes" integer DEFAULT 0 NOT NULL,
    "waitlist_auto_hours" integer DEFAULT 0 NOT NULL,
    "waitlist_auto_minutes" integer DEFAULT 0 NOT NULL,
    "waitlist_weekly_limit" integer DEFAULT 0 NOT NULL,
    "daily_book_limit_enabled" boolean DEFAULT false NOT NULL,
    "daily_book_limit" integer,
    "private_open_days_before" integer DEFAULT 60 NOT NULL,
    "private_open_time" time without time zone DEFAULT '15:00:00'::time without time zone NOT NULL,
    "group_open_days_before" integer DEFAULT 60 NOT NULL,
    "group_open_time" time without time zone DEFAULT '15:00:00'::time without time zone NOT NULL,
    "private_slot_unit" "text" DEFAULT '30min'::"text" NOT NULL,
    "private_max_concurrent_enabled" boolean DEFAULT false NOT NULL,
    "private_max_concurrent" integer,
    "show_group_reserved_count" boolean DEFAULT true NOT NULL,
    "show_group_waitlist_count" boolean DEFAULT true NOT NULL,
    "use_inquiry_board" boolean DEFAULT true NOT NULL,
    "show_all_classes" boolean DEFAULT true NOT NULL,
    "use_locker" boolean DEFAULT false NOT NULL,
    "deduct_on_late_cancel" boolean DEFAULT false NOT NULL,
    "auto_unpaid_input" boolean DEFAULT false NOT NULL,
    "use_lounge" boolean DEFAULT true NOT NULL,
    "show_point_history" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "allow_same_day_booking" boolean DEFAULT true NOT NULL,
    "unlimited_pass_revenue_mode" "text" DEFAULT 'usage_split'::"text" NOT NULL,
    "autocancel_enabled" boolean DEFAULT false NOT NULL,
    CONSTRAINT "center_settings_private_slot_unit_check" CHECK (("private_slot_unit" = ANY (ARRAY['hour'::"text", '30min'::"text", '20min'::"text", '15min'::"text", '10min'::"text", '5min'::"text"]))),
    CONSTRAINT "center_settings_unlimited_pass_revenue_mode_check" CHECK (("unlimited_pass_revenue_mode" = ANY (ARRAY['usage_split'::"text", 'purchase_date_full'::"text"])))
);


ALTER TABLE "public"."center_settings" OWNER TO "postgres";


COMMENT ON TABLE "public"."center_settings" IS '센터별 운영 규칙(설정>운영정보 17개 항목). 예약/취소/폐강/대기 기본값';



COMMENT ON COLUMN "public"."center_settings"."deduct_on_late_cancel" IS '취소 가능 시간이 지난 후 취소하면 횟수가 차감되며 취소됨';



COMMENT ON COLUMN "public"."center_settings"."unlimited_pass_revenue_mode" IS '수업매출 캘린더: 무제한/기간제(pass_type=period) 정기권 매출을 어떻게 배분할지.
     usage_split(기본) = 기간 중 실제 이용 횟수로 나눠 각 수업 날짜에 배분(동적 추정,
     스냅샷 저장 안 함). purchase_date_full = 정기권 매출 전액을 구매일에 표시하고
     수업별로 안 나눔.';



CREATE TABLE IF NOT EXISTS "public"."center_settlement_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "bank_name" "text",
    "account_number" "text",
    "account_holder_name" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."center_settlement_accounts" OWNER TO "postgres";


COMMENT ON TABLE "public"."center_settlement_accounts" IS '수동(은행 대량이체) 정산용 센터 계좌 정보. 계좌 전체번호를 저장하므로 RLS를 오너/운영자로만 좁게 유지해야 한다 — centers 테이블처럼 공개 SELECT 정책을 절대 추가하지 말 것';



CREATE TABLE IF NOT EXISTS "public"."center_subscription_charges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "amount" integer NOT NULL,
    "status" "text" NOT NULL,
    "toss_payment_key" "text",
    "failure_reason" "text",
    "charged_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "order_id" "text",
    CONSTRAINT "center_subscription_charges_status_check" CHECK (("status" = ANY (ARRAY['succeeded'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."center_subscription_charges" OWNER TO "postgres";


COMMENT ON TABLE "public"."center_subscription_charges" IS '센터 플랫폼 구독료 청구 이력(성공/실패). append 전용 — insert/update 정책 없음';



COMMENT ON COLUMN "public"."center_subscription_charges"."order_id" IS '토스에 보낸 주문번호. 정기 청구는 sub-recur-{centerId}-{그 회차의 next_billing_date} 형태로 결정적으로 만든다(app/api/billing/charge-due) — 같은 회차를 재시도해도 동일한 orderId를 재사용해서, 토스 쪽 orderId 유일성 제약이 이중 청구를 한 번 더 막아준다(DB 리스가 실패하더라도 토스가 중복 orderId를 거부).';



CREATE TABLE IF NOT EXISTS "public"."center_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending_billing_setup'::"text" NOT NULL,
    "billing_key" "text",
    "billing_customer_key" "text",
    "card_last4" "text",
    "card_company" "text",
    "next_billing_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "alimtalk_addon" boolean DEFAULT false NOT NULL,
    "alimtalk_addon_unit_price" integer,
    "alimtalk_addon_price" integer,
    "billing_review_override" boolean DEFAULT false NOT NULL,
    "billing_locked_until" timestamp with time zone,
    "retry_count" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "center_subscriptions_status_check" CHECK (("status" = ANY (ARRAY['pending_billing_setup'::"text", 'active'::"text", 'past_due'::"text", 'canceled'::"text", 'payment_failed'::"text"])))
);


ALTER TABLE "public"."center_subscriptions" OWNER TO "postgres";


COMMENT ON TABLE "public"."center_subscriptions" IS '센터별 플랫폼 구독 상태. 센터당 1행(center_id unique), status로 생애주기 전이. insert/update 정책 없음 — service_role 또는 security definer RPC만 기록 가능';



COMMENT ON COLUMN "public"."center_subscriptions"."status" IS 'pending_billing_setup(카드 미등록) / active(정상) / past_due(청구 실패, 자동 재시도 중, 최대 7일) / payment_failed(7회 재시도 소진 또는 재시도 무의미한 오류로 자동중지 — 새 카드 등록 전까지 청구 안 됨) / canceled(오너가 직접 해지)';



COMMENT ON COLUMN "public"."center_subscriptions"."alimtalk_addon" IS '카카오 알림톡/SMS 발송 애드온 신청 여부. false면 이 센터는 send-alimtalk Edge Function이 발송을 거부한다(자동 규칙·매니저 즉시발송 모두 포함)';



COMMENT ON COLUMN "public"."center_subscriptions"."alimtalk_addon_unit_price" IS '이 센터에 적용 중인 알림톡 애드온 건당 요금(원, 발송 1건마다). 신청 이력이 있으면 해지 후에도 마지막 가격을 남겨둔다(재신청 시 참고용) — null이면 한 번도 설정된 적 없음. 실제 매월 청구는 토스 자동결제 심사 전이라 아직 자동화되지 않음(사장님이 이 값 × 발송건수로 수동 청구)';



COMMENT ON COLUMN "public"."center_subscriptions"."alimtalk_addon_price" IS '이 센터에 적용 중인 알림톡 애드온 월 추가요금(원). 신청 이력이 있으면 해지 후에도 마지막 가격을 남겨둔다(재신청 시 참고용) — null이면 한 번도 설정된 적 없음';



COMMENT ON COLUMN "public"."center_subscriptions"."billing_locked_until" IS '자동 청구 처리 중 잠금(리스) 만료 시각. app/api/billing/charge-due가 청구 대상을 고를 때 UPDATE...WHERE (billing_locked_until is null or < now())로 원자적으로 선점해 같은 구독이 동시에 두 번 청구되는 것을 막는다. 처리가 끝나면(성공/실패 무관) 항상 null로 해제한다 — 만약 서버가 처리 도중 죽어서 해제가 안 되더라도 리스가 만료되면(15분) 다음 실행에서 다시 집힐 수 있다.';



COMMENT ON COLUMN "public"."center_subscriptions"."retry_count" IS '정기 청구 연속 실패 횟수. 성공하면 0으로 리셋(app/api/billing/charge-due). 7에 도달하면 status가 payment_failed로 전환되고 자동 재시도 대상에서 제외된다. 카드 만료/분실 등 재시도 무의미한 오류는 이 값과 무관하게 즉시 payment_failed로 전환될 수 있다(app/api/billing/charge-due의 오류코드 분류 참고).';



CREATE TABLE IF NOT EXISTS "public"."centers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "address" "text",
    "phone" "text",
    "latitude" numeric(9,6),
    "longitude" numeric(9,6),
    "business_number" "text",
    "business_license_url" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reject_reason" "text",
    "payment_methods" "text"[] DEFAULT '{card,transfer,onsite}'::"text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "intro" "text",
    "photo_url" "text",
    "instagram" "text",
    "kakao" "text",
    "sns" "text",
    "categories" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "intro_blocks" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "pay_methods" "text"[],
    "review_point" integer DEFAULT 1000 NOT NULL,
    "is_internal" boolean DEFAULT false NOT NULL,
    CONSTRAINT "centers_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."centers" OWNER TO "postgres";


COMMENT ON TABLE "public"."centers" IS '운동센터/스튜디오 정보 (필라테스샵, 헬스장 등)';



COMMENT ON COLUMN "public"."centers"."status" IS '가입 후 승인대기. approved 되어야 회원에게 노출됨';



COMMENT ON COLUMN "public"."centers"."payment_methods" IS '이 센터가 받는 결제방식 목록';



CREATE TABLE IF NOT EXISTS "public"."change_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "target_table" "text" NOT NULL,
    "target_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "changed_fields" "jsonb",
    "actor_account_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."change_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."change_logs" IS '수강권 등 주요 정보 변경이력. 누가 언제 무엇을 바꿨는지 추적';



CREATE TABLE IF NOT EXISTS "public"."chat_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sender_account_id" "uuid" NOT NULL,
    "receiver_account_id" "uuid" NOT NULL,
    "content" "text" NOT NULL,
    "is_read" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."chat_messages" OWNER TO "postgres";


COMMENT ON TABLE "public"."chat_messages" IS '개인번호 노출 없이 회원-트레이너/센터 간 소통 (하이파이브 참고 기능)';



CREATE TABLE IF NOT EXISTS "public"."class_allowed_products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "class_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."class_allowed_products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reservations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "class_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "membership_id" "uuid",
    "status" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "waitlist_order" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "member_memo" "text",
    "reservation_type" "text" DEFAULT 'MEMBER'::"text" NOT NULL,
    "reservation_source" "text" DEFAULT 'USER'::"text" NOT NULL,
    "created_by_account_id" "uuid",
    "admin_reason_code" "text",
    "admin_reason_detail" "text",
    "is_capacity_override" boolean DEFAULT false NOT NULL,
    "membership_consumed" boolean DEFAULT true NOT NULL,
    "cancelled_by" "uuid",
    "cancel_reason" "text",
    "cancelled_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cancel_source" "text",
    CONSTRAINT "reservations_admin_reason_code_check" CHECK ((("admin_reason_code" IS NULL) OR ("admin_reason_code" = ANY (ARRAY['MEMBER_REQUEST'::"text", 'MAKEUP_CLASS'::"text", 'TRIAL'::"text", 'EVENT'::"text", 'SERVICE_COMPENSATION'::"text", 'CENTER_OPERATION'::"text", 'VIP_INVITATION'::"text", 'ERROR_CORRECTION'::"text", 'OTHER'::"text"])))),
    CONSTRAINT "reservations_admin_reason_detail_check" CHECK ((("admin_reason_detail" IS NULL) OR ("char_length"("admin_reason_detail") <= 200))),
    CONSTRAINT "reservations_cancel_source_check" CHECK ((("cancel_source" IS NULL) OR ("cancel_source" = ANY (ARRAY['MEMBER'::"text", 'ADMIN'::"text", 'HOLIDAY'::"text"])))),
    CONSTRAINT "reservations_reservation_source_check" CHECK (("reservation_source" = ANY (ARRAY['USER'::"text", 'ADMIN'::"text", 'SYSTEM'::"text"]))),
    CONSTRAINT "reservations_reservation_type_check" CHECK (("reservation_type" = ANY (ARRAY['MEMBER'::"text", 'ADMIN_ASSIGNMENT'::"text", 'ADMIN_FREE'::"text"]))),
    CONSTRAINT "reservations_status_check" CHECK (("status" = ANY (ARRAY['confirmed'::"text", 'waitlisted'::"text", 'cancelled'::"text", 'attended'::"text", 'no_show'::"text"])))
);


ALTER TABLE "public"."reservations" OWNER TO "postgres";


COMMENT ON TABLE "public"."reservations" IS '예약/취소/대기 내역. status 컬럼으로 현재 상태 구분 (하이파이브+스튜디오메이트 참고 기능)';



COMMENT ON COLUMN "public"."reservations"."membership_id" IS '사용한 수강권. 관리자 직접배치(ADMIN_ASSIGNMENT)의 "어떤 미배치건/수강권을 사용했는지"도 이 컬럼이 그대로 표현함(중복 컬럼 없음)';



COMMENT ON COLUMN "public"."reservations"."reservation_type" IS 'MEMBER=회원 셀프예약 / ADMIN_ASSIGNMENT=관리자 일반 직접배치(수강권 차감) / ADMIN_FREE=관리자 무료 추가배치(차감 없음)';



COMMENT ON COLUMN "public"."reservations"."reservation_source" IS 'USER=회원 본인 / ADMIN=관리자 / SYSTEM=자동예약 등 시스템';



COMMENT ON COLUMN "public"."reservations"."cancel_source" IS '취소 출처(MEMBER=회원 셀프취소/ADMIN=관리자취소/HOLIDAY=휴무일 자동취소). null=구분 미기록(과거 데이터 또는 아직 이 값을 쓰지 않는 취소 경로)';



CREATE OR REPLACE VIEW "public"."class_reservation_counts" AS
 SELECT "class_id",
    ("count"(*) FILTER (WHERE ("status" = 'confirmed'::"text")))::integer AS "confirmed_count",
    ("count"(*) FILTER (WHERE ("status" = 'waitlisted'::"text")))::integer AS "waitlisted_count"
   FROM "public"."reservations"
  WHERE ("status" = ANY (ARRAY['confirmed'::"text", 'waitlisted'::"text"]))
  GROUP BY "class_id";


ALTER VIEW "public"."class_reservation_counts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."class_trainers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "class_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."class_trainers" OWNER TO "postgres";


COMMENT ON TABLE "public"."class_trainers" IS '수업별 담당 강사(복수 가능)';



CREATE TABLE IF NOT EXISTS "public"."class_types" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."class_types" OWNER TO "postgres";


COMMENT ON TABLE "public"."class_types" IS '센터가 정의하는 수업 구분. classes.class_type_id로 연결';



CREATE TABLE IF NOT EXISTS "public"."classes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "class_format" "text" DEFAULT 'group'::"text" NOT NULL,
    "class_type_id" "uuid",
    "room_id" "uuid",
    "place" "text",
    "start_time" timestamp with time zone NOT NULL,
    "end_time" timestamp with time zone NOT NULL,
    "min_capacity" integer DEFAULT 1 NOT NULL,
    "capacity" integer DEFAULT 1 NOT NULL,
    "booking_deadline_min" integer,
    "cancel_deadline_min" integer,
    "autocancel_deadline_min" integer,
    "waitlist_deadline_min" integer,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "recurring_group_id" "uuid",
    "allow_goods" boolean DEFAULT false NOT NULL,
    "pass_selection_mode" "text" DEFAULT 'all'::"text" NOT NULL,
    "allow_cancel" boolean DEFAULT true NOT NULL,
    CONSTRAINT "classes_class_format_check" CHECK (("class_format" = ANY (ARRAY['group'::"text", 'private'::"text"]))),
    CONSTRAINT "classes_pass_selection_mode_check" CHECK (("pass_selection_mode" = ANY (ARRAY['all'::"text", 'selected'::"text"]))),
    CONSTRAINT "classes_private_capacity_check" CHECK ((("class_format" <> 'private'::"text") OR ("capacity" = 1))),
    CONSTRAINT "classes_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."classes" OWNER TO "postgres";


COMMENT ON TABLE "public"."classes" IS '센터에서 개설하는 수업 스케줄. 정원까지 예약 가능, 마감시간·폐강 규칙 포함';



COMMENT ON COLUMN "public"."classes"."class_type_id" IS '수업구분(class_types 참조). 수강권 종류에 따라 예약 가능한 수업이 달라짐';



COMMENT ON COLUMN "public"."classes"."place" IS '장소. 같은 시간대 한 장소에 여러 수업 중복 허용';



COMMENT ON COLUMN "public"."classes"."booking_deadline_min" IS '개별 수업 예약마감 재지정(분, 수업 시작 기준). null이면 운영설정(center_settings) 기본값을 그대로 씀 — CLASS-001';



COMMENT ON COLUMN "public"."classes"."cancel_deadline_min" IS '개별 수업 취소마감 재지정(분, 수업 시작 기준). null이면 운영설정(center_settings) 기본값을 그대로 씀';



COMMENT ON COLUMN "public"."classes"."pass_selection_mode" IS '수강권 허용 모드. all=이 센터의 모든 active pass 허용(class_allowed_products는 비워둠,
     schedule_rules override 미발동, 새 pass도 자동 포함). selected=class_allowed_products에
     명시적으로 저장된 product만 허용(1개 이상 필수, 그 product들에 한해 P1-17 override 발동).';



COMMENT ON COLUMN "public"."classes"."allow_cancel" IS 'false면 이 수업 예약은 회원이 스스로 취소할 수 없음(특강 등). 매니저의 관리자 취소/노쇼 처리에는 영향 없음.';



CREATE TABLE IF NOT EXISTS "public"."community_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "author_account_id" "uuid" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."community_comments" OWNER TO "postgres";


COMMENT ON TABLE "public"."community_comments" IS '커뮤니티 게시글에 달리는 댓글';



CREATE TABLE IF NOT EXISTS "public"."community_posts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "author_account_id" "uuid" NOT NULL,
    "center_id" "uuid",
    "title" "text" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."community_posts" OWNER TO "postgres";


COMMENT ON TABLE "public"."community_posts" IS '회원 커뮤니티 게시판 (앱 컨셉에 맞는 커뮤니티 기능)';



CREATE TABLE IF NOT EXISTS "public"."competitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "category" "text" NOT NULL,
    "region" "text",
    "event_date" "date" NOT NULL,
    "description" "text",
    "source_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."competitions" OWNER TO "postgres";


COMMENT ON TABLE "public"."competitions" IS '종목별로 필터링해 조회하는 대회/이벤트 정보';



CREATE TABLE IF NOT EXISTS "public"."contract_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "content" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contract_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contracts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "template_id" "uuid",
    "membership_id" "uuid",
    "content" "text" NOT NULL,
    "signature_url" "text",
    "signed_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "contracts_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'signed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."contracts" OWNER TO "postgres";


COMMENT ON TABLE "public"."contracts" IS '회원이 서명한 전자계약서. 서명 시점 내용을 스냅샷으로 보관';



CREATE TABLE IF NOT EXISTS "public"."coupon_products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "coupon_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."coupon_products" OWNER TO "postgres";


COMMENT ON TABLE "public"."coupon_products" IS 'applies_to=selected인 쿠폰의 적용 대상 수강권 목록.';



CREATE TABLE IF NOT EXISTS "public"."coupons" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "discount_type" "text" NOT NULL,
    "discount_value" integer NOT NULL,
    "max_discount_amount" integer,
    "minimum_order_amount" integer,
    "applies_to" "text" DEFAULT 'all'::"text" NOT NULL,
    "valid_from" timestamp with time zone,
    "valid_until" timestamp with time zone,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "coupons_applies_to_check" CHECK (("applies_to" = ANY (ARRAY['all'::"text", 'selected'::"text"]))),
    CONSTRAINT "coupons_check" CHECK ((("discount_type" <> 'percentage'::"text") OR ("discount_value" <= 100))),
    CONSTRAINT "coupons_discount_type_check" CHECK (("discount_type" = ANY (ARRAY['fixed'::"text", 'percentage'::"text"]))),
    CONSTRAINT "coupons_discount_value_check" CHECK (("discount_value" > 0)),
    CONSTRAINT "coupons_max_discount_amount_check" CHECK ((("max_discount_amount" IS NULL) OR ("max_discount_amount" > 0))),
    CONSTRAINT "coupons_minimum_order_amount_check" CHECK ((("minimum_order_amount" IS NULL) OR ("minimum_order_amount" >= 0))),
    CONSTRAINT "coupons_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."coupons" OWNER TO "postgres";


COMMENT ON TABLE "public"."coupons" IS '센터 관리자가 만드는 쿠폰 정의(템플릿). 실제 회원에게 지급된 개별 쿠폰은 member_coupons.';



CREATE TABLE IF NOT EXISTS "public"."email_check_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ip_hash" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."email_check_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "category" "text" NOT NULL,
    "amount" integer NOT NULL,
    "spent_at" "date" DEFAULT CURRENT_DATE NOT NULL,
    "memo" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."expenses" OWNER TO "postgres";


COMMENT ON TABLE "public"."expenses" IS '센터 지출 내역. 매출 리포트에서 수입-지출 집계에 사용';



CREATE TABLE IF NOT EXISTS "public"."home_banners" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "subtitle" "text",
    "emoji" "text",
    "link_url" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."home_banners" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inquiry_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "sender_account_id" "uuid" NOT NULL,
    "sender_role" "text" NOT NULL,
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "photos" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inquiry_messages_sender_role_check" CHECK (("sender_role" = ANY (ARRAY['member'::"text", 'manager'::"text"])))
);


ALTER TABLE "public"."inquiry_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inquiry_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "member_account_id" "uuid" NOT NULL,
    "last_message" "text",
    "last_message_at" timestamp with time zone,
    "member_unread" integer DEFAULT 0 NOT NULL,
    "manager_unread" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."inquiry_threads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "phone" "text",
    "channel" "text",
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "memo" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "leads_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'contacted'::"text", 'converted'::"text", 'dropped'::"text"])))
);


ALTER TABLE "public"."leads" OWNER TO "postgres";


COMMENT ON TABLE "public"."leads" IS '상담고객(등록 전 잠재고객). 등록 전환 시 center_members로 이동';



CREATE TABLE IF NOT EXISTS "public"."locker_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "locker_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "starts_at" "date" DEFAULT CURRENT_DATE NOT NULL,
    "expires_at" "date" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."locker_assignments" OWNER TO "postgres";


COMMENT ON TABLE "public"."locker_assignments" IS '회원별 락커 배정. 회원 탭에 사용중 락커·만료일 표시';



CREATE TABLE IF NOT EXISTS "public"."lockers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."lockers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."manager_centers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_id" "uuid" NOT NULL,
    "center_id" "uuid" NOT NULL,
    "role_id" "uuid",
    "specialty" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "manager_centers_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'active'::"text", 'suspended'::"text"])))
);


ALTER TABLE "public"."manager_centers" OWNER TO "postgres";


COMMENT ON TABLE "public"."manager_centers" IS '계정이 운영/근무하는 센터와 그 센터에서의 역할';



CREATE TABLE IF NOT EXISTS "public"."marketing_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "link" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "target_count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."marketing_messages" OWNER TO "postgres";


COMMENT ON TABLE "public"."marketing_messages" IS '운영자가 전체 회원에게 보낸 마케팅(혜택·이벤트) 알림 발송 이력';



CREATE TABLE IF NOT EXISTS "public"."member_candidate_search_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "caller_account_id" "uuid" NOT NULL,
    "center_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."member_candidate_search_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."member_center_colors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_id" "uuid" NOT NULL,
    "center_id" "uuid" NOT NULL,
    "color" "text" NOT NULL
);


ALTER TABLE "public"."member_center_colors" OWNER TO "postgres";


COMMENT ON TABLE "public"."member_center_colors" IS '통합 캘린더에서 회원이 직접 설정하는 센터별 표시 색상';



CREATE TABLE IF NOT EXISTS "public"."member_coupons" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "coupon_id" "uuid" NOT NULL,
    "center_member_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'available'::"text" NOT NULL,
    "issued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "used_at" timestamp with time zone,
    "order_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "member_coupons_status_check" CHECK (("status" = ANY (ARRAY['available'::"text", 'used'::"text", 'expired'::"text", 'revoked'::"text"])))
);


ALTER TABLE "public"."member_coupons" OWNER TO "postgres";


COMMENT ON TABLE "public"."member_coupons" IS '회원에게 실제 지급된 쿠폰 1장. status로 생애주기 관리(available→used/expired/revoked).';



CREATE TABLE IF NOT EXISTS "public"."member_grades" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "color" "text",
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."member_grades" OWNER TO "postgres";


COMMENT ON TABLE "public"."member_grades" IS '센터가 정의하는 회원 등급. 회원목록 필터/배지에 사용';



CREATE TABLE IF NOT EXISTS "public"."member_memos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "center_id" "uuid" NOT NULL,
    "author_account_id" "uuid" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."member_memos" OWNER TO "postgres";


COMMENT ON TABLE "public"."member_memos" IS '회원에 대한 스태프 메모. 본인 작성분만 수정/삭제(오너는 전체) — 회원 본인은 절대 조회 불가.';



CREATE TABLE IF NOT EXISTS "public"."membership_product_grades" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "grade_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."membership_product_grades" OWNER TO "postgres";


COMMENT ON TABLE "public"."membership_product_grades" IS '수강권(products)이 visibility_type=grades일 때 공개 대상 등급. product/grade 둘 다 같은 센터 소속이어야 의미가 있다 — RLS와 애플리케이션 레벨(관리자 UI가 같은 센터의 member_grades만 보여줌) 둘 다에서 강제한다.';



CREATE TABLE IF NOT EXISTS "public"."membership_product_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "center_member_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."membership_product_members" OWNER TO "postgres";


COMMENT ON TABLE "public"."membership_product_members" IS '수강권이 visibility_type=selected_members일 때 공개 대상 회원(center_members 기준 — 이미 center_id를 담고 있어 다른 센터 회원 매핑을 구조적으로 막기 쉽다).';



CREATE TABLE IF NOT EXISTS "public"."membership_schedule_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "day_of_week" integer,
    "start_time" time without time zone,
    "class_title" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "product_id" "uuid",
    CONSTRAINT "membership_schedule_rules_day_of_week_check" CHECK ((("day_of_week" >= 0) AND ("day_of_week" <= 6)))
);


ALTER TABLE "public"."membership_schedule_rules" OWNER TO "postgres";


COMMENT ON TABLE "public"."membership_schedule_rules" IS '수강권별 예약가능 요일/시간/수업 조건. 수강권을 요일별로 쪼개지 않아도 되게 함 (센터 피드백 반영)';



CREATE TABLE IF NOT EXISTS "public"."membership_session_amounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "membership_id" "uuid" NOT NULL,
    "session_index" integer NOT NULL,
    "amount" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "membership_session_amounts_amount_check" CHECK (("amount" >= 0)),
    CONSTRAINT "membership_session_amounts_session_index_check" CHECK (("session_index" >= 1))
);


ALTER TABLE "public"."membership_session_amounts" OWNER TO "postgres";


COMMENT ON TABLE "public"."membership_session_amounts" IS '수업매출 캘린더: 횟수제 수강권의 회차별(session_index, 1-based) 매출 귀속 금액
     커스텀 오버라이드. 행이 없는 회차는 (그 membership에 연결된 payments.total_amount
     합계 ÷ memberships.total_count)로 균등분배 계산한다. 쓰기는 set_membership_session_
     amounts() RPC 전용(총액 검증 때문 — 직접 RLS insert/update/delete 정책 없음).';



CREATE TABLE IF NOT EXISTS "public"."membership_transfers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "membership_id" "uuid" NOT NULL,
    "from_profile_id" "uuid" NOT NULL,
    "to_profile_id" "uuid" NOT NULL,
    "remaining_count_at_transfer" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."membership_transfers" OWNER TO "postgres";


COMMENT ON TABLE "public"."membership_transfers" IS '프로필 간 수강권 양도 이력. memberships.profile_id를 변경하면서 기록';



CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "channel" "text" NOT NULL,
    "title" "text",
    "content" "text" NOT NULL,
    "target_profile_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "scheduled_at" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "byte_size" integer,
    "point_cost" integer,
    "sender_account_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "content_blocks" "jsonb",
    "rule_id" "uuid",
    "rule_membership_id" "uuid",
    "aligo_template_code" "text",
    CONSTRAINT "messages_channel_check" CHECK (("channel" = ANY (ARRAY['sms'::"text", 'lms'::"text", 'push'::"text", 'alimtalk'::"text"]))),
    CONSTRAINT "messages_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'scheduled'::"text", 'sent'::"text", 'cancelled'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


COMMENT ON TABLE "public"."messages" IS '문자/앱푸시 발송 이력. 예약발송(scheduled)은 취소 가능';



COMMENT ON COLUMN "public"."messages"."content_blocks" IS '텍스트/사진 블록 배열([{"type":"text","value":"..."},{"type":"image","url":"..."}]). 예약 발송에만 사용, 즉시 발송은 content만 씀';



COMMENT ON COLUMN "public"."messages"."aligo_template_code" IS '알림톡 큐잉 당시 사용한 알리고 템플릿 코드(승인된 템플릿에서 복사) — dispatch-alimtalk cron이 sendViaAligo() 호출 시 이 값을 실어야 SMS 대체발송이 아니라 진짜 카카오 알림톡으로 나간다';



CREATE TABLE IF NOT EXISTS "public"."native_push_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_id" "uuid" NOT NULL,
    "platform" "text" NOT NULL,
    "token" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "native_push_tokens_platform_check" CHECK (("platform" = ANY (ARRAY['ios'::"text", 'android'::"text"])))
);


ALTER TABLE "public"."native_push_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "profile_id" "uuid",
    "rule_id" "uuid",
    "channel" "text" NOT NULL,
    "cost" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'sent'::"text" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "notification_logs_status_check" CHECK (("status" = ANY (ARRAY['sent'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."notification_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."notification_logs" IS '알림 발송 기록. 건당 수수료 정산 근거';



CREATE TABLE IF NOT EXISTS "public"."notification_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "trigger_type" "text" NOT NULL,
    "days_before" integer,
    "threshold_count" integer,
    "minutes_before" integer,
    "send_push" boolean DEFAULT true NOT NULL,
    "send_sms" boolean DEFAULT false NOT NULL,
    "message_template" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "send_alimtalk" boolean DEFAULT false NOT NULL,
    "template_id" "uuid",
    "product_id" "uuid",
    CONSTRAINT "notification_rules_trigger_type_check" CHECK (("trigger_type" = ANY (ARRAY['membership_expiring'::"text", 'count_low'::"text", 'pause_ending'::"text", 'expired_rebuy'::"text", 'class_reminder'::"text", 'waitlist_promoted'::"text", 'class_cancelled'::"text", 'birthday'::"text"])))
);


ALTER TABLE "public"."notification_rules" OWNER TO "postgres";


COMMENT ON TABLE "public"."notification_rules" IS '센터별 자동알림 규칙. 재등록 유도용';



COMMENT ON COLUMN "public"."notification_rules"."trigger_type" IS 'waitlist_promoted는 실시간·birthday는 15시 고정(시점 설정 불가)';



CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipient_account_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "center_id" "uuid",
    "link" "text",
    "data" "jsonb",
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pushed_at" timestamp with time zone,
    "pinned" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "center_id" "uuid" NOT NULL,
    "membership_id" "uuid",
    "product_pass_id" "uuid",
    "sale_type" "text" DEFAULT 'new'::"text" NOT NULL,
    "revenue_category" "text" DEFAULT 'membership'::"text" NOT NULL,
    "card_amount" integer DEFAULT 0 NOT NULL,
    "cash_amount" integer DEFAULT 0 NOT NULL,
    "transfer_amount" integer DEFAULT 0 NOT NULL,
    "point_amount" integer DEFAULT 0 NOT NULL,
    "total_amount" integer DEFAULT 0 NOT NULL,
    "unpaid_amount" integer DEFAULT 0 NOT NULL,
    "penalty_amount" integer DEFAULT 0 NOT NULL,
    "per_session_amount" integer,
    "total_sessions" integer,
    "trainer_account_id" "uuid",
    "paid_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "memo" "text",
    "pg_transaction_id" "text",
    "status" "text" DEFAULT 'paid'::"text" NOT NULL,
    "virtual_account_bank" "text",
    "virtual_account_number" "text",
    "virtual_account_due_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "direct_amount" integer DEFAULT 0 NOT NULL,
    "payment_provider" "text",
    "settlement_status" "text" DEFAULT 'not_applicable'::"text" NOT NULL,
    "linked_unpaid_payment_id" "uuid",
    "order_id" "uuid",
    CONSTRAINT "payments_payment_provider_check" CHECK ((("payment_provider" IS NULL) OR ("payment_provider" = ANY (ARRAY['mock'::"text", 'toss'::"text", 'portone'::"text"])))),
    CONSTRAINT "payments_revenue_category_check" CHECK (("revenue_category" = ANY (ARRAY['membership'::"text", 'class'::"text", 'etc'::"text"]))),
    CONSTRAINT "payments_sale_type_check" CHECK (("sale_type" = ANY (ARRAY['new'::"text", 'renew'::"text", 'trial'::"text", 'upgrade'::"text", 'refund'::"text", 'unpaid_pay'::"text", 'transfer_fee'::"text", 'service'::"text"]))),
    CONSTRAINT "payments_settlement_status_check" CHECK (("settlement_status" = ANY (ARRAY['not_applicable'::"text", 'pending'::"text", 'requested'::"text", 'paid_out'::"text", 'failed'::"text"]))),
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'paid'::"text", 'refunded'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


COMMENT ON TABLE "public"."payments" IS '매출 원장. 분할결제(카드/현금/계좌이체/포인트) 지원, 미수금·위약금 포함';



COMMENT ON COLUMN "public"."payments"."sale_type" IS '신규/재결제/체험/업그레이드/환불/미수금결제/양도·환불수수료';



COMMENT ON COLUMN "public"."payments"."payment_provider" IS '이 매출 행이 Mock(테스트) 결제로 발급됐는지(mock) 실제 결제(toss/portone)인지. NULL=매니저
     직접 입력 등 실제 매출 경로(fulfill_order/직접결제/환불/미배치 발급 등) — 통계는 이 값이
     mock이 아닌 행만 실제 매출로 집계해야 한다.';



COMMENT ON COLUMN "public"."payments"."settlement_status" IS '센터 정산 진행 상태. not_applicable(수기 입력 등 정산 대상 아님)/pending/requested/paid_out/failed. 지금은 전부 not_applicable로만 남고, 실제 전이 로직은 Toss 지급대행 계약 확정 후 별도 구현';



COMMENT ON COLUMN "public"."payments"."linked_unpaid_payment_id" IS '미수금 회수용 결제(sale_type=unpaid_pay)가 어느 원본 결제의 미수금을 갚는 것인지 참조. null이면 일반 결제.';



CREATE TABLE IF NOT EXISTS "public"."permissions" (
    "key" "text" NOT NULL,
    "category" "text" NOT NULL,
    "parent_key" "text",
    "label" "text" NOT NULL,
    "description" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "permissions_category_check" CHECK (("category" = ANY (ARRAY['facility'::"text", 'customer'::"text", 'pass'::"text", 'schedule'::"text", 'board'::"text", 'message'::"text", 'contract'::"text"])))
);


ALTER TABLE "public"."permissions" OWNER TO "postgres";


COMMENT ON TABLE "public"."permissions" IS '역할별 권한설정 화면을 구성하는 권한 목록 (고정 카탈로그)';



CREATE TABLE IF NOT EXISTS "public"."phone_verifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "phone" "text" NOT NULL,
    "code_hash" "text" NOT NULL,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "verified_at" timestamp with time zone,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."phone_verifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."point_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "center_id" "uuid",
    "profile_id" "uuid",
    "balance" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."point_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."point_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "center_id" "uuid",
    "profile_id" "uuid",
    "amount" integer,
    "reason" "text",
    "memo" "text"
);


ALTER TABLE "public"."point_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."point_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "center_id" "uuid" NOT NULL,
    "amount" integer NOT NULL,
    "reason" "text",
    "payment_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "order_id" "uuid",
    "reverses_id" "uuid"
);


ALTER TABLE "public"."point_transactions" OWNER TO "postgres";


COMMENT ON TABLE "public"."point_transactions" IS '포인트 적립/사용 내역. 잔여 포인트 = 합계';



COMMENT ON COLUMN "public"."point_transactions"."order_id" IS '결제 시 포인트를 사용한 경우, 그 포인트를 소비한 주문. SEC-118 금액 검증에서
     "실제로 차감된 포인트인지" 확인하는 데 쓰인다';



CREATE TABLE IF NOT EXISTS "public"."popup_notices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid",
    "title" "text" NOT NULL,
    "content" "text",
    "image_url" "text",
    "starts_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ends_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."popup_notices" OWNER TO "postgres";


COMMENT ON TABLE "public"."popup_notices" IS '앱 접속 시 즉시 노출되는 팝업 공지 (하이파이브의 무료 푸시알림 참고 기능 확장)';



CREATE TABLE IF NOT EXISTS "public"."product_count_prices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "count" integer NOT NULL,
    "price" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "product_count_prices_count_check" CHECK (("count" >= 1)),
    CONSTRAINT "product_count_prices_price_check" CHECK (("price" > 0))
);


ALTER TABLE "public"."product_count_prices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_passes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "remaining_count" integer,
    "expires_at" "date",
    "linked_membership_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."product_passes" OWNER TO "postgres";


COMMENT ON TABLE "public"."product_passes" IS '회원이 구매한 상품권. linked_membership_id 있으면 예약 시 수강권과 동시 차감';



CREATE OR REPLACE VIEW "public"."product_sale_counts" AS
 SELECT "product_id",
    ("count"(*))::integer AS "sold_count"
   FROM "public"."memberships"
  WHERE (("product_id" IS NOT NULL) AND ("status" <> 'refunded'::"text"))
  GROUP BY "product_id";


ALTER VIEW "public"."product_sale_counts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profile_center_fields" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "center_id" "uuid" NOT NULL,
    "field_key" "text" NOT NULL,
    "value" "text"
);


ALTER TABLE "public"."profile_center_fields" OWNER TO "postgres";


COMMENT ON TABLE "public"."profile_center_fields" IS '회원이 각 센터에 입력한 추가정보 값 (신발사이즈 등). 관리자만 조회';



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "label" "text",
    "birth_date" "date",
    "is_primary" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "gender" "text",
    "shoe_size" "text",
    "phone" "text",
    "avatar_url" "text",
    "memo" "text",
    "nickname" "text",
    "cloth_size" "text",
    "address" "text",
    "deleted_at" timestamp with time zone
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."profiles" IS '회원 역할의 실제 수강 주체(본인 및 추가 프로필). 예약/수강권/진도는 이 프로필에 연결';



COMMENT ON COLUMN "public"."profiles"."deleted_at" IS '이 프로필을 회원이 "삭제"한 시각. 실제 행은 지우지 않고 개인정보만 익명화한다
     (계정 탈퇴와 동일한 이유 — reservations 등 이력 보존). null이면 삭제 안 된 상태.
     계정 탈퇴(delete-account Edge Function)와는 별개 — 계정 탈퇴는 이 값을 건드리지 않고
     모든 프로필의 개인정보를 직접 익명화한다.';



CREATE TABLE IF NOT EXISTS "public"."progress_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "parent_id" "uuid",
    "name" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "node_type" "text" NOT NULL,
    CONSTRAINT "progress_categories_node_type_check" CHECK (("node_type" = ANY (ARRAY['category'::"text", 'skill'::"text"]))),
    CONSTRAINT "progress_categories_skill_has_parent" CHECK ((("node_type" = 'category'::"text") OR ("parent_id" IS NOT NULL)))
);


ALTER TABLE "public"."progress_categories" OWNER TO "postgres";


COMMENT ON TABLE "public"."progress_categories" IS '진도표용 무한 중첩 카테고리. 센터가 직접 생성/수정 (개수 제한 없음)';



CREATE TABLE IF NOT EXISTS "public"."progress_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "category_id" "uuid" NOT NULL,
    "coach_account_id" "uuid",
    "lesson_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."progress_records" OWNER TO "postgres";


COMMENT ON TABLE "public"."progress_records" IS '회원별 날짜별 진도 기록. 코치가 클릭으로 기록 (예: 7/12 왈츠점프, 스파이럴 배움)';



CREATE TABLE IF NOT EXISTS "public"."purchase_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "product_id" "uuid",
    "product_name" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "purchase_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'done'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."purchase_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."push_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_id" "uuid" NOT NULL,
    "endpoint" "text" NOT NULL,
    "p256dh" "text" NOT NULL,
    "auth" "text" NOT NULL,
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."refund_notification_events" (
    "membership_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."refund_notification_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reservation_goods_usages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reservation_id" "uuid" NOT NULL,
    "goods_membership_id" "uuid" NOT NULL,
    "center_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "product_name_snapshot" "text" NOT NULL,
    "size_snapshot" "text",
    "size_source" "text" DEFAULT 'none'::"text" NOT NULL,
    "unlimited" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'deducted'::"text" NOT NULL,
    "deducted_at" timestamp with time zone,
    "restored_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reservation_goods_usages_size_source_check" CHECK (("size_source" = ANY (ARRAY['membership'::"text", 'profile'::"text", 'none'::"text"]))),
    CONSTRAINT "reservation_goods_usages_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'deducted'::"text", 'restored'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."reservation_goods_usages" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."revenue_summary" AS
 SELECT (("paid_at" AT TIME ZONE 'Asia/Seoul'::"text"))::"date" AS "결제일",
    "center_id" AS "센터_id",
    "revenue_category" AS "매출종류",
    "count"(*) AS "결제건수",
    "sum"("total_amount") AS "총매출",
    "sum"("card_amount") AS "카드",
    "sum"("cash_amount") AS "현금",
    "sum"("transfer_amount") AS "계좌이체",
    "sum"("point_amount") AS "포인트",
    "sum"("unpaid_amount") AS "미수금"
   FROM "public"."payments" "p"
  WHERE ("status" = 'paid'::"text")
  GROUP BY ((("paid_at" AT TIME ZONE 'Asia/Seoul'::"text"))::"date"), "center_id", "revenue_category";


ALTER VIEW "public"."revenue_summary" OWNER TO "postgres";


COMMENT ON VIEW "public"."revenue_summary" IS '일자/센터/매출종류별 매출 요약 (한국시간 기준). 수단별 금액·미수금 포함';



CREATE TABLE IF NOT EXISTS "public"."review_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "review_id" "uuid" NOT NULL,
    "reporter_account_id" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "detail" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_at" timestamp with time zone,
    "reviewed_by" "uuid",
    CONSTRAINT "review_reports_reason_check" CHECK (("reason" = ANY (ARRAY['inappropriate'::"text", 'abuse'::"text", 'spam'::"text", 'misleading'::"text", 'privacy'::"text", 'other'::"text"]))),
    CONSTRAINT "review_reports_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'reviewed'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."review_reports" OWNER TO "postgres";


COMMENT ON TABLE "public"."review_reports" IS '센터 후기 신고. 1행 = 이 계정이 이 후기를 신고했다는 기록(중복 신고는 unique 제약으로 차단).';



COMMENT ON COLUMN "public"."review_reports"."status" IS 'pending(대기) → reviewed(운영자 확인 완료) 또는 dismissed(신고 기각). 운영자만 변경 가능.';



CREATE TABLE IF NOT EXISTS "public"."reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reviewer_account_id" "uuid" NOT NULL,
    "target_account_id" "uuid",
    "target_center_id" "uuid",
    "rating" integer NOT NULL,
    "content" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "center_id" "uuid",
    "profile_id" "uuid",
    CONSTRAINT "review_target_check" CHECK (((("target_account_id" IS NOT NULL) AND ("target_center_id" IS NULL)) OR (("target_account_id" IS NULL) AND ("target_center_id" IS NOT NULL)))),
    CONSTRAINT "reviews_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5))),
    CONSTRAINT "reviews_rating_range" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);


ALTER TABLE "public"."reviews" OWNER TO "postgres";


COMMENT ON TABLE "public"."reviews" IS '회원↔센터, 회원↔강사 간 상호 평점/리뷰 (당근온도 참고 기능)';



CREATE TABLE IF NOT EXISTS "public"."role_permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_id" "uuid" NOT NULL,
    "permission_key" "text" NOT NULL
);


ALTER TABLE "public"."role_permissions" OWNER TO "postgres";


COMMENT ON TABLE "public"."role_permissions" IS '역할에 부여된 권한. 오너가 매니저/강사/커스텀 역할에 권한 지정';



CREATE TABLE IF NOT EXISTS "public"."rooms" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "capacity" integer,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "memo" "text",
    "address" "text",
    "latitude" double precision,
    "longitude" double precision,
    "detail_address" "text"
);


ALTER TABLE "public"."rooms" OWNER TO "postgres";


COMMENT ON TABLE "public"."rooms" IS '센터의 룸. 수업 장소로 사용 (권한: facility.room)';



COMMENT ON COLUMN "public"."rooms"."detail_address" IS '상세주소(건물명/층/호수 등, 선택). address(도로명주소)와 별개로 보관 — 사용자가
   직접 입력한 값만 들어가며, 좌표(latitude/longitude)나 address 값에 영향을 주지
   않는다. 기존 GRANT(anon/authenticated/service_role)는 테이블 단위라 새 컬럼에도
   그대로 적용되고, RLS도 행 단위 정책이라 추가 정책이 필요 없다.';



CREATE TABLE IF NOT EXISTS "public"."schedule_memos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "class_id" "uuid",
    "staff_schedule_id" "uuid",
    "author_account_id" "uuid" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "schedule_memos_check" CHECK (((("class_id" IS NOT NULL) AND ("staff_schedule_id" IS NULL)) OR (("class_id" IS NULL) AND ("staff_schedule_id" IS NOT NULL))))
);


ALTER TABLE "public"."schedule_memos" OWNER TO "postgres";


COMMENT ON TABLE "public"."schedule_memos" IS '일정 상세페이지 메모. 본인 작성분만 수정/삭제 (오너는 전체)';



CREATE TABLE IF NOT EXISTS "public"."schedule_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "template" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."schedule_templates" OWNER TO "postgres";


COMMENT ON TABLE "public"."schedule_templates" IS '저장해둔 스케줄. 매달 불러와서 한 번에 수업 생성';



CREATE TABLE IF NOT EXISTS "public"."service_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "label" "text" NOT NULL,
    "emoji" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."service_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."staff_candidate_search_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "caller_account_id" "uuid" NOT NULL,
    "center_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."staff_candidate_search_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."staff_salaries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "employment_type" "text" DEFAULT 'fulltime'::"text" NOT NULL,
    "base_salary" integer,
    "per_class_pay" integer,
    "commission_rate" numeric(5,2),
    "memo" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "staff_salaries_employment_type_check" CHECK (("employment_type" = ANY (ARRAY['fulltime'::"text", 'parttime'::"text", 'substitute'::"text"])))
);


ALTER TABLE "public"."staff_salaries" OWNER TO "postgres";


COMMENT ON TABLE "public"."staff_salaries" IS '스태프 급여 설정. 급여 정보는 권한(본인/타인)에 따라 조회·수정 제한';



CREATE TABLE IF NOT EXISTS "public"."staff_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "start_time" timestamp with time zone NOT NULL,
    "end_time" timestamp with time zone NOT NULL,
    "memo" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."staff_schedules" OWNER TO "postgres";


COMMENT ON TABLE "public"."staff_schedules" IS '수업 외 기타 일정(휴가·미팅 등). 일정 화면에 함께 표시';



CREATE TABLE IF NOT EXISTS "public"."subscription_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "monthly_price" integer DEFAULT 0 NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "max_rooms" integer,
    "max_staff" integer,
    "max_members" integer,
    "max_products" integer,
    "is_default" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."subscription_plans" OWNER TO "postgres";


COMMENT ON TABLE "public"."subscription_plans" IS '플랫폼이 정의하는 센터 대상 월 구독 플랜 카탈로그. 가격/이름은 운영자가 조정 가능';



COMMENT ON COLUMN "public"."subscription_plans"."max_rooms" IS '이 플랜의 최대 룸 개수. null=무제한';



COMMENT ON COLUMN "public"."subscription_plans"."max_staff" IS '이 플랜의 최대 스태프 수(오너 제외). null=무제한';



COMMENT ON COLUMN "public"."subscription_plans"."max_members" IS '이 플랜의 최대 회원 수. null=무제한';



COMMENT ON COLUMN "public"."subscription_plans"."max_products" IS '이 플랜의 최대 판매 중 상품 종류 수. null=무제한';



COMMENT ON COLUMN "public"."subscription_plans"."is_default" IS '신규 센터 가입 시 자동 배정되는 기본 플랜(정확히 하나만 true)';



CREATE TABLE IF NOT EXISTS "public"."terms" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "center_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "content" "text" NOT NULL,
    "is_required" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."terms" OWNER TO "postgres";


COMMENT ON TABLE "public"."terms" IS '약관 (권한: contract.terms.manage)';



ALTER TABLE ONLY "public"."account_auth_identities"
    ADD CONSTRAINT "account_auth_identities_auth_id_key" UNIQUE ("auth_id");



ALTER TABLE ONLY "public"."account_auth_identities"
    ADD CONSTRAINT "account_auth_identities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."account_center_permissions"
    ADD CONSTRAINT "account_center_permissions_manager_center_id_permission_key_key" UNIQUE ("manager_center_id", "permission_key");



ALTER TABLE ONLY "public"."account_center_permissions"
    ADD CONSTRAINT "account_center_permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."account_link_requests"
    ADD CONSTRAINT "account_link_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."accounts"
    ADD CONSTRAINT "accounts_auth_id_key" UNIQUE ("auth_id");



ALTER TABLE ONLY "public"."accounts"
    ADD CONSTRAINT "accounts_phone_key" UNIQUE ("phone");



ALTER TABLE ONLY "public"."accounts"
    ADD CONSTRAINT "accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_action_logs"
    ADD CONSTRAINT "admin_action_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."alimtalk_templates"
    ADD CONSTRAINT "alimtalk_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cart_items"
    ADD CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."center_announcements"
    ADD CONSTRAINT "center_announcements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."center_contacts"
    ADD CONSTRAINT "center_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."center_holidays"
    ADD CONSTRAINT "center_holidays_center_id_holiday_date_key" UNIQUE ("center_id", "holiday_date");



ALTER TABLE ONLY "public"."center_holidays"
    ADD CONSTRAINT "center_holidays_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."center_member_fields"
    ADD CONSTRAINT "center_member_fields_center_id_field_key_key" UNIQUE ("center_id", "field_key");



ALTER TABLE ONLY "public"."center_member_fields"
    ADD CONSTRAINT "center_member_fields_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."center_members"
    ADD CONSTRAINT "center_members_center_id_profile_id_key" UNIQUE ("center_id", "profile_id");



ALTER TABLE ONLY "public"."center_members"
    ADD CONSTRAINT "center_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."center_payout_accounts"
    ADD CONSTRAINT "center_payout_accounts_center_id_key" UNIQUE ("center_id");



ALTER TABLE ONLY "public"."center_payout_accounts"
    ADD CONSTRAINT "center_payout_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."center_reviews"
    ADD CONSTRAINT "center_reviews_center_id_profile_id_key" UNIQUE ("center_id", "profile_id");



ALTER TABLE ONLY "public"."center_reviews"
    ADD CONSTRAINT "center_reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."center_roles"
    ADD CONSTRAINT "center_roles_center_id_name_key" UNIQUE ("center_id", "name");



ALTER TABLE ONLY "public"."center_roles"
    ADD CONSTRAINT "center_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."center_settings"
    ADD CONSTRAINT "center_settings_pkey" PRIMARY KEY ("center_id");



ALTER TABLE ONLY "public"."center_settlement_accounts"
    ADD CONSTRAINT "center_settlement_accounts_center_id_key" UNIQUE ("center_id");



ALTER TABLE ONLY "public"."center_settlement_accounts"
    ADD CONSTRAINT "center_settlement_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."center_subscription_charges"
    ADD CONSTRAINT "center_subscription_charges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."center_subscriptions"
    ADD CONSTRAINT "center_subscriptions_center_id_key" UNIQUE ("center_id");



ALTER TABLE ONLY "public"."center_subscriptions"
    ADD CONSTRAINT "center_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."centers"
    ADD CONSTRAINT "centers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."change_logs"
    ADD CONSTRAINT "change_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."class_allowed_products"
    ADD CONSTRAINT "class_allowed_products_class_id_product_id_key" UNIQUE ("class_id", "product_id");



ALTER TABLE ONLY "public"."class_allowed_products"
    ADD CONSTRAINT "class_allowed_products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."class_trainers"
    ADD CONSTRAINT "class_trainers_class_id_account_id_key" UNIQUE ("class_id", "account_id");



ALTER TABLE ONLY "public"."class_trainers"
    ADD CONSTRAINT "class_trainers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."class_types"
    ADD CONSTRAINT "class_types_center_id_name_key" UNIQUE ("center_id", "name");



ALTER TABLE ONLY "public"."class_types"
    ADD CONSTRAINT "class_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."classes"
    ADD CONSTRAINT "classes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."community_comments"
    ADD CONSTRAINT "community_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."community_posts"
    ADD CONSTRAINT "community_posts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."competitions"
    ADD CONSTRAINT "competitions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contract_templates"
    ADD CONSTRAINT "contract_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coupon_products"
    ADD CONSTRAINT "coupon_products_coupon_id_product_id_key" UNIQUE ("coupon_id", "product_id");



ALTER TABLE ONLY "public"."coupon_products"
    ADD CONSTRAINT "coupon_products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_check_attempts"
    ADD CONSTRAINT "email_check_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."home_banners"
    ADD CONSTRAINT "home_banners_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inquiry_messages"
    ADD CONSTRAINT "inquiry_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inquiry_threads"
    ADD CONSTRAINT "inquiry_threads_center_id_member_account_id_key" UNIQUE ("center_id", "member_account_id");



ALTER TABLE ONLY "public"."inquiry_threads"
    ADD CONSTRAINT "inquiry_threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."locker_assignments"
    ADD CONSTRAINT "locker_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lockers"
    ADD CONSTRAINT "lockers_center_id_name_key" UNIQUE ("center_id", "name");



ALTER TABLE ONLY "public"."lockers"
    ADD CONSTRAINT "lockers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."manager_centers"
    ADD CONSTRAINT "manager_centers_account_id_center_id_key" UNIQUE ("account_id", "center_id");



ALTER TABLE ONLY "public"."manager_centers"
    ADD CONSTRAINT "manager_centers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_messages"
    ADD CONSTRAINT "marketing_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."member_candidate_search_attempts"
    ADD CONSTRAINT "member_candidate_search_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."member_center_colors"
    ADD CONSTRAINT "member_center_colors_account_id_center_id_key" UNIQUE ("account_id", "center_id");



ALTER TABLE ONLY "public"."member_center_colors"
    ADD CONSTRAINT "member_center_colors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."member_coupons"
    ADD CONSTRAINT "member_coupons_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."member_grades"
    ADD CONSTRAINT "member_grades_center_id_name_key" UNIQUE ("center_id", "name");



ALTER TABLE ONLY "public"."member_grades"
    ADD CONSTRAINT "member_grades_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."member_memos"
    ADD CONSTRAINT "member_memos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."membership_product_grades"
    ADD CONSTRAINT "membership_product_grades_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."membership_product_grades"
    ADD CONSTRAINT "membership_product_grades_product_id_grade_id_key" UNIQUE ("product_id", "grade_id");



ALTER TABLE ONLY "public"."membership_product_members"
    ADD CONSTRAINT "membership_product_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."membership_product_members"
    ADD CONSTRAINT "membership_product_members_product_id_center_member_id_key" UNIQUE ("product_id", "center_member_id");



ALTER TABLE ONLY "public"."membership_schedule_rules"
    ADD CONSTRAINT "membership_schedule_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."membership_session_amounts"
    ADD CONSTRAINT "membership_session_amounts_membership_id_session_index_key" UNIQUE ("membership_id", "session_index");



ALTER TABLE ONLY "public"."membership_session_amounts"
    ADD CONSTRAINT "membership_session_amounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."membership_transfers"
    ADD CONSTRAINT "membership_transfers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."native_push_tokens"
    ADD CONSTRAINT "native_push_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."native_push_tokens"
    ADD CONSTRAINT "native_push_tokens_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."notification_logs"
    ADD CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_rules"
    ADD CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."phone_verifications"
    ADD CONSTRAINT "phone_verifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."point_accounts"
    ADD CONSTRAINT "point_accounts_center_profile_key" UNIQUE ("center_id", "profile_id");



ALTER TABLE ONLY "public"."point_accounts"
    ADD CONSTRAINT "point_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."point_logs"
    ADD CONSTRAINT "point_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."point_transactions"
    ADD CONSTRAINT "point_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."popup_notices"
    ADD CONSTRAINT "popup_notices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_count_prices"
    ADD CONSTRAINT "product_count_prices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_count_prices"
    ADD CONSTRAINT "product_count_prices_product_id_count_key" UNIQUE ("product_id", "count");



ALTER TABLE ONLY "public"."product_passes"
    ADD CONSTRAINT "product_passes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profile_center_fields"
    ADD CONSTRAINT "profile_center_fields_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profile_center_fields"
    ADD CONSTRAINT "profile_center_fields_profile_id_center_id_field_key_key" UNIQUE ("profile_id", "center_id", "field_key");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."progress_categories"
    ADD CONSTRAINT "progress_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."progress_records"
    ADD CONSTRAINT "progress_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_requests"
    ADD CONSTRAINT "purchase_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_endpoint_key" UNIQUE ("endpoint");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."refund_notification_events"
    ADD CONSTRAINT "refund_notification_events_pkey" PRIMARY KEY ("membership_id");



ALTER TABLE ONLY "public"."reservation_goods_usages"
    ADD CONSTRAINT "reservation_goods_usages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reservation_goods_usages"
    ADD CONSTRAINT "reservation_goods_usages_reservation_id_goods_membership_id_key" UNIQUE ("reservation_id", "goods_membership_id");



ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."review_reports"
    ADD CONSTRAINT "review_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."review_reports"
    ADD CONSTRAINT "review_reports_review_id_reporter_account_id_key" UNIQUE ("review_id", "reporter_account_id");



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_center_profile_key" UNIQUE ("center_id", "profile_id");



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_role_id_permission_key_key" UNIQUE ("role_id", "permission_key");



ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_memos"
    ADD CONSTRAINT "schedule_memos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_templates"
    ADD CONSTRAINT "schedule_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."service_categories"
    ADD CONSTRAINT "service_categories_label_key" UNIQUE ("label");



ALTER TABLE ONLY "public"."service_categories"
    ADD CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."staff_candidate_search_attempts"
    ADD CONSTRAINT "staff_candidate_search_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."staff_salaries"
    ADD CONSTRAINT "staff_salaries_center_id_account_id_key" UNIQUE ("center_id", "account_id");



ALTER TABLE ONLY "public"."staff_salaries"
    ADD CONSTRAINT "staff_salaries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."staff_schedules"
    ADD CONSTRAINT "staff_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_plans"
    ADD CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."terms"
    ADD CONSTRAINT "terms_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "centers_business_number_normalized_unique" ON "public"."centers" USING "btree" ("regexp_replace"("business_number", '\D'::"text", ''::"text", 'g'::"text")) WHERE (("business_number" IS NOT NULL) AND ("regexp_replace"("business_number", '\D'::"text", ''::"text", 'g'::"text") <> ''::"text"));



CREATE INDEX "idx_account_auth_identities_account" ON "public"."account_auth_identities" USING "btree" ("account_id");



CREATE UNIQUE INDEX "idx_account_link_requests_one_pending" ON "public"."account_link_requests" USING "btree" ("requester_account_id") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "idx_account_link_requests_pending_code" ON "public"."account_link_requests" USING "btree" ("code") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_admin_action_logs_center" ON "public"."admin_action_logs" USING "btree" ("center_id", "created_at" DESC);



CREATE INDEX "idx_admin_action_logs_reservation" ON "public"."admin_action_logs" USING "btree" ("reservation_id");



CREATE UNIQUE INDEX "idx_alimtalk_templates_aligo_code_unique" ON "public"."alimtalk_templates" USING "btree" ("aligo_template_code") WHERE ("aligo_template_code" IS NOT NULL);



COMMENT ON INDEX "public"."idx_alimtalk_templates_aligo_code_unique" IS '같은 알리고 템플릿 코드가 우리 DB의 서로 다른 두 행(센터)에 동시에 연결되는 것을 막는다. null(초안/미승인)은 여러 개 허용';



CREATE INDEX "idx_announcements_center" ON "public"."center_announcements" USING "btree" ("center_id", "created_at" DESC);



CREATE INDEX "idx_center_payout_accounts_status" ON "public"."center_payout_accounts" USING "btree" ("status");



CREATE INDEX "idx_center_reviews" ON "public"."center_reviews" USING "btree" ("center_id", "created_at" DESC);



CREATE INDEX "idx_center_subscription_charges_sub" ON "public"."center_subscription_charges" USING "btree" ("subscription_id", "charged_at" DESC);



CREATE INDEX "idx_center_subscriptions_status" ON "public"."center_subscriptions" USING "btree" ("status");



CREATE INDEX "idx_class_trainers_class_order" ON "public"."class_trainers" USING "btree" ("class_id", "sort_order");



CREATE INDEX "idx_classes_recurring_group" ON "public"."classes" USING "btree" ("recurring_group_id");



CREATE INDEX "idx_coupon_products_coupon" ON "public"."coupon_products" USING "btree" ("coupon_id");



CREATE INDEX "idx_coupons_center" ON "public"."coupons" USING "btree" ("center_id");



CREATE INDEX "idx_email_check_attempts_ip_created" ON "public"."email_check_attempts" USING "btree" ("ip_hash", "created_at" DESC);



CREATE INDEX "idx_member_candidate_search_attempts_caller_created" ON "public"."member_candidate_search_attempts" USING "btree" ("caller_account_id", "created_at" DESC);



CREATE INDEX "idx_member_candidate_search_attempts_created" ON "public"."member_candidate_search_attempts" USING "btree" ("created_at");



CREATE INDEX "idx_member_coupons_center_member" ON "public"."member_coupons" USING "btree" ("center_member_id", "status");



CREATE INDEX "idx_member_coupons_coupon" ON "public"."member_coupons" USING "btree" ("coupon_id");



CREATE INDEX "idx_member_coupons_order" ON "public"."member_coupons" USING "btree" ("order_id");



CREATE INDEX "idx_member_memos_profile" ON "public"."member_memos" USING "btree" ("profile_id", "created_at");



CREATE INDEX "idx_messages_thread" ON "public"."inquiry_messages" USING "btree" ("thread_id", "created_at");



CREATE INDEX "idx_mp_grades_product" ON "public"."membership_product_grades" USING "btree" ("product_id");



CREATE INDEX "idx_mp_members_center_member" ON "public"."membership_product_members" USING "btree" ("center_member_id");



CREATE INDEX "idx_mp_members_product" ON "public"."membership_product_members" USING "btree" ("product_id");



CREATE INDEX "idx_native_push_tokens_account" ON "public"."native_push_tokens" USING "btree" ("account_id");



CREATE INDEX "idx_notifications_recipient" ON "public"."notifications" USING "btree" ("recipient_account_id", "created_at" DESC);



CREATE INDEX "idx_notifications_recipient_pinned" ON "public"."notifications" USING "btree" ("recipient_account_id", "pinned" DESC, "created_at" DESC);



CREATE INDEX "idx_notifications_unpushed" ON "public"."notifications" USING "btree" ("created_at") WHERE ("pushed_at" IS NULL);



CREATE INDEX "idx_notifications_unread" ON "public"."notifications" USING "btree" ("recipient_account_id") WHERE ("read_at" IS NULL);



CREATE INDEX "idx_orders_member_coupon" ON "public"."orders" USING "btree" ("member_coupon_id");



CREATE INDEX "idx_payments_center_date" ON "public"."payments" USING "btree" ("center_id", "paid_at");



CREATE INDEX "idx_payments_order" ON "public"."payments" USING "btree" ("order_id");



CREATE INDEX "idx_phone_verifications_phone_created" ON "public"."phone_verifications" USING "btree" ("phone", "created_at" DESC);



CREATE INDEX "idx_point_logs_profile" ON "public"."point_logs" USING "btree" ("profile_id", "created_at" DESC);



CREATE INDEX "idx_product_count_prices_product" ON "public"."product_count_prices" USING "btree" ("product_id");



CREATE INDEX "idx_push_subscriptions_account" ON "public"."push_subscriptions" USING "btree" ("account_id");



CREATE INDEX "idx_reservation_goods_usages_goods" ON "public"."reservation_goods_usages" USING "btree" ("goods_membership_id");



CREATE INDEX "idx_reservation_goods_usages_reservation" ON "public"."reservation_goods_usages" USING "btree" ("reservation_id");



CREATE INDEX "idx_reservations_type_source" ON "public"."reservations" USING "btree" ("reservation_type", "reservation_source");



CREATE INDEX "idx_review_reports_review" ON "public"."review_reports" USING "btree" ("review_id");



CREATE INDEX "idx_review_reports_status" ON "public"."review_reports" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_reviews_center" ON "public"."reviews" USING "btree" ("center_id", "created_at" DESC);



CREATE INDEX "idx_staff_candidate_search_attempts_caller_created" ON "public"."staff_candidate_search_attempts" USING "btree" ("caller_account_id", "created_at" DESC);



CREATE INDEX "idx_staff_candidate_search_attempts_created" ON "public"."staff_candidate_search_attempts" USING "btree" ("created_at");



CREATE UNIQUE INDEX "idx_subscription_plans_one_default" ON "public"."subscription_plans" USING "btree" ("is_default") WHERE "is_default";



CREATE INDEX "idx_threads_center" ON "public"."inquiry_threads" USING "btree" ("center_id", "last_message_at" DESC);



CREATE INDEX "idx_threads_member" ON "public"."inquiry_threads" USING "btree" ("member_account_id", "last_message_at" DESC);



CREATE UNIQUE INDEX "notification_rules_unique_all_products" ON "public"."notification_rules" USING "btree" ("center_id", "trigger_type") WHERE ("product_id" IS NULL);



CREATE UNIQUE INDEX "notification_rules_unique_per_product" ON "public"."notification_rules" USING "btree" ("center_id", "trigger_type", "product_id") WHERE ("product_id" IS NOT NULL);



CREATE UNIQUE INDEX "profiles_one_active_primary_per_account" ON "public"."profiles" USING "btree" ("account_id") WHERE (("is_primary" = true) AND ("deleted_at" IS NULL));



CREATE UNIQUE INDEX "uniq_member_coupon_active" ON "public"."member_coupons" USING "btree" ("coupon_id", "center_member_id") WHERE ("status" = 'available'::"text");



CREATE UNIQUE INDEX "unique_active_reservation" ON "public"."reservations" USING "btree" ("class_id", "profile_id") WHERE ("status" = ANY (ARRAY['confirmed'::"text", 'waitlisted'::"text"]));



CREATE UNIQUE INDEX "uq_point_tx_order_debit" ON "public"."point_transactions" USING "btree" ("order_id") WHERE (("order_id" IS NOT NULL) AND ("reason" = '결제 시 사용'::"text") AND ("amount" < 0));



CREATE UNIQUE INDEX "uq_point_tx_reverses_id" ON "public"."point_transactions" USING "btree" ("reverses_id") WHERE ("reverses_id" IS NOT NULL);



CREATE OR REPLACE TRIGGER "guard_center_sensitive_fields_change_trigger" BEFORE UPDATE ON "public"."centers" FOR EACH ROW EXECUTE FUNCTION "public"."guard_center_sensitive_fields_change"();



CREATE OR REPLACE TRIGGER "manager_centers_protect_last_owner" BEFORE UPDATE ON "public"."manager_centers" FOR EACH ROW EXECUTE FUNCTION "public"."manager_centers_protect_last_owner"();



CREATE OR REPLACE TRIGGER "memberships_guard_expiry_update" BEFORE UPDATE OF "expires_at" ON "public"."memberships" FOR EACH ROW EXECUTE FUNCTION "public"."memberships_guard_expiry_update"();



CREATE OR REPLACE TRIGGER "memberships_guard_pg_refund" BEFORE UPDATE OF "remaining_count", "pg_refund_started_at" ON "public"."memberships" FOR EACH ROW EXECUTE FUNCTION "public"."memberships_guard_pg_refund"();



CREATE OR REPLACE TRIGGER "notify_new_order" AFTER INSERT ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."trg_notify_new_order"();



CREATE OR REPLACE TRIGGER "notify_new_review" AFTER INSERT ON "public"."center_reviews" FOR EACH ROW EXECUTE FUNCTION "public"."trg_notify_new_review"();



CREATE OR REPLACE TRIGGER "notify_reservation_insert" AFTER INSERT ON "public"."reservations" FOR EACH ROW EXECUTE FUNCTION "public"."trg_notify_reservation_insert"();



CREATE OR REPLACE TRIGGER "notify_reservation_update" AFTER UPDATE ON "public"."reservations" FOR EACH ROW EXECUTE FUNCTION "public"."trg_notify_reservation_update"();



CREATE OR REPLACE TRIGGER "orders_force_server_fields_on_insert" BEFORE INSERT ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."orders_force_server_fields_on_insert"();



CREATE OR REPLACE TRIGGER "orders_guard_snapshot_update" BEFORE UPDATE OF "selected_count", "product_amount_snapshot", "product_id" ON "public"."orders" FOR EACH ROW WHEN ((("old"."selected_count" IS DISTINCT FROM "new"."selected_count") OR ("old"."product_amount_snapshot" IS DISTINCT FROM "new"."product_amount_snapshot") OR ("old"."product_id" IS DISTINCT FROM "new"."product_id"))) EXECUTE FUNCTION "public"."orders_guard_snapshot_update"();



CREATE OR REPLACE TRIGGER "orders_guard_status_transition" BEFORE UPDATE OF "status" ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."orders_guard_status_transition"();



CREATE OR REPLACE TRIGGER "orders_require_schedule_selection" BEFORE INSERT ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."orders_require_schedule_selection"();



CREATE OR REPLACE TRIGGER "orders_restore_points_on_cancel" AFTER UPDATE OF "status" ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."orders_restore_points_on_cancel"();



CREATE OR REPLACE TRIGGER "orders_snapshot_product_amount" BEFORE INSERT ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."orders_snapshot_product_amount"();



CREATE OR REPLACE TRIGGER "progress_categories_guard_tree" BEFORE INSERT OR UPDATE OF "parent_id", "center_id", "node_type" ON "public"."progress_categories" FOR EACH ROW EXECUTE FUNCTION "public"."progress_categories_guard_tree"();



CREATE OR REPLACE TRIGGER "progress_records_guard_skill" BEFORE INSERT OR UPDATE OF "category_id" ON "public"."progress_records" FOR EACH ROW EXECUTE FUNCTION "public"."progress_records_guard_skill"();



CREATE OR REPLACE TRIGGER "reservation_goods_restore_on_delete" BEFORE DELETE ON "public"."reservations" FOR EACH ROW EXECUTE FUNCTION "public"."trg_reservation_goods_restore_on_delete"();



CREATE OR REPLACE TRIGGER "reservation_goods_sync" AFTER UPDATE OF "status" ON "public"."reservations" FOR EACH ROW EXECUTE FUNCTION "public"."trg_reservation_goods_sync"();



CREATE OR REPLACE TRIGGER "reservations_guard_pg_refund_lock" BEFORE INSERT OR UPDATE OF "status", "membership_id" ON "public"."reservations" FOR EACH ROW EXECUTE FUNCTION "public"."reservations_guard_pg_refund_lock"();



CREATE OR REPLACE TRIGGER "trg_accounts_is_platform_admin_admin_only" BEFORE UPDATE ON "public"."accounts" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_accounts_is_platform_admin_admin_only"();



CREATE OR REPLACE TRIGGER "trg_accounts_merged_into_via_linking_only" BEFORE UPDATE ON "public"."accounts" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_accounts_merged_into_via_linking_only"();



CREATE OR REPLACE TRIGGER "trg_accounts_pg_checkout_override_admin_only" BEFORE UPDATE ON "public"."accounts" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_pg_checkout_override_admin_only"();



CREATE OR REPLACE TRIGGER "trg_accounts_phone_verified" BEFORE UPDATE ON "public"."accounts" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_phone_verified_before_change"();



CREATE OR REPLACE TRIGGER "trg_center_subscriptions_billing_review_override_admin_only" BEFORE UPDATE ON "public"."center_subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_billing_review_override_admin_only"();



CREATE OR REPLACE TRIGGER "trg_create_default_center_payout_account" AFTER INSERT ON "public"."centers" FOR EACH ROW EXECUTE FUNCTION "public"."create_default_center_payout_account"();



CREATE OR REPLACE TRIGGER "trg_create_default_center_roles" AFTER INSERT ON "public"."centers" FOR EACH ROW EXECUTE FUNCTION "public"."create_default_center_roles"();



CREATE OR REPLACE TRIGGER "trg_create_default_center_settlement_account" AFTER INSERT ON "public"."centers" FOR EACH ROW EXECUTE FUNCTION "public"."create_default_center_settlement_account"();



CREATE OR REPLACE TRIGGER "trg_create_default_center_subscription" AFTER INSERT ON "public"."centers" FOR EACH ROW EXECUTE FUNCTION "public"."create_default_center_subscription"();



CREATE OR REPLACE TRIGGER "trg_enforce_member_limit" BEFORE INSERT ON "public"."center_members" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_member_limit"();



CREATE OR REPLACE TRIGGER "trg_enforce_product_limit" BEFORE INSERT ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_product_limit"();



CREATE OR REPLACE TRIGGER "trg_enforce_product_sale_limit" BEFORE INSERT OR UPDATE OF "product_id", "status" ON "public"."memberships" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_product_sale_limit"();



CREATE OR REPLACE TRIGGER "trg_enforce_room_limit" BEFORE INSERT ON "public"."rooms" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_room_limit"();



CREATE OR REPLACE TRIGGER "trg_enforce_staff_limit" BEFORE INSERT ON "public"."manager_centers" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_staff_limit"();



CREATE OR REPLACE TRIGGER "trg_guard_center_status" BEFORE UPDATE ON "public"."centers" FOR EACH ROW EXECUTE FUNCTION "public"."guard_center_status_change"();



CREATE OR REPLACE TRIGGER "trg_manager_centers_role_center_match" BEFORE INSERT OR UPDATE ON "public"."manager_centers" FOR EACH ROW EXECUTE FUNCTION "public"."manager_centers_enforce_role_center_match"();



CREATE CONSTRAINT TRIGGER "trg_refund_completed_managers" AFTER UPDATE ON "public"."memberships" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((("old"."status" IS DISTINCT FROM "new"."status") AND ("new"."status" = 'refunded'::"text"))) EXECUTE FUNCTION "public"."notify_refund_completed_managers"();



ALTER TABLE ONLY "public"."account_auth_identities"
    ADD CONSTRAINT "account_auth_identities_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."account_center_permissions"
    ADD CONSTRAINT "account_center_permissions_manager_center_id_fkey" FOREIGN KEY ("manager_center_id") REFERENCES "public"."manager_centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."account_center_permissions"
    ADD CONSTRAINT "account_center_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."account_link_requests"
    ADD CONSTRAINT "account_link_requests_requester_account_id_fkey" FOREIGN KEY ("requester_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."accounts"
    ADD CONSTRAINT "accounts_merged_into_fkey" FOREIGN KEY ("merged_into") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."admin_action_logs"
    ADD CONSTRAINT "admin_action_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."admin_action_logs"
    ADD CONSTRAINT "admin_action_logs_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."admin_action_logs"
    ADD CONSTRAINT "admin_action_logs_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."admin_action_logs"
    ADD CONSTRAINT "admin_action_logs_member_profile_id_fkey" FOREIGN KEY ("member_profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."admin_action_logs"
    ADD CONSTRAINT "admin_action_logs_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id");



ALTER TABLE ONLY "public"."admin_action_logs"
    ADD CONSTRAINT "admin_action_logs_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."admin_action_logs"
    ADD CONSTRAINT "admin_action_logs_source_unassigned_id_fkey" FOREIGN KEY ("source_unassigned_id") REFERENCES "public"."memberships"("id");



ALTER TABLE ONLY "public"."alimtalk_templates"
    ADD CONSTRAINT "alimtalk_templates_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."cart_items"
    ADD CONSTRAINT "cart_items_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cart_items"
    ADD CONSTRAINT "cart_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cart_items"
    ADD CONSTRAINT "cart_items_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."center_announcements"
    ADD CONSTRAINT "center_announcements_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."center_announcements"
    ADD CONSTRAINT "center_announcements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."center_contacts"
    ADD CONSTRAINT "center_contacts_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."center_holidays"
    ADD CONSTRAINT "center_holidays_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."center_member_fields"
    ADD CONSTRAINT "center_member_fields_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."center_members"
    ADD CONSTRAINT "center_members_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."center_members"
    ADD CONSTRAINT "center_members_grade_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "public"."member_grades"("id");



ALTER TABLE ONLY "public"."center_members"
    ADD CONSTRAINT "center_members_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."center_payout_accounts"
    ADD CONSTRAINT "center_payout_accounts_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."center_reviews"
    ADD CONSTRAINT "center_reviews_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."center_reviews"
    ADD CONSTRAINT "center_reviews_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."center_roles"
    ADD CONSTRAINT "center_roles_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."center_settings"
    ADD CONSTRAINT "center_settings_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."center_settlement_accounts"
    ADD CONSTRAINT "center_settlement_accounts_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."center_subscription_charges"
    ADD CONSTRAINT "center_subscription_charges_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."center_subscriptions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."center_subscriptions"
    ADD CONSTRAINT "center_subscriptions_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."center_subscriptions"
    ADD CONSTRAINT "center_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id");



ALTER TABLE ONLY "public"."change_logs"
    ADD CONSTRAINT "change_logs_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."change_logs"
    ADD CONSTRAINT "change_logs_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_receiver_account_id_fkey" FOREIGN KEY ("receiver_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_sender_account_id_fkey" FOREIGN KEY ("sender_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."class_allowed_products"
    ADD CONSTRAINT "class_allowed_products_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."class_allowed_products"
    ADD CONSTRAINT "class_allowed_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."class_trainers"
    ADD CONSTRAINT "class_trainers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."class_trainers"
    ADD CONSTRAINT "class_trainers_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."class_types"
    ADD CONSTRAINT "class_types_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."classes"
    ADD CONSTRAINT "classes_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."classes"
    ADD CONSTRAINT "classes_class_type_id_fkey" FOREIGN KEY ("class_type_id") REFERENCES "public"."class_types"("id");



ALTER TABLE ONLY "public"."classes"
    ADD CONSTRAINT "classes_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id");



ALTER TABLE ONLY "public"."community_comments"
    ADD CONSTRAINT "community_comments_author_account_id_fkey" FOREIGN KEY ("author_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."community_comments"
    ADD CONSTRAINT "community_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id");



ALTER TABLE ONLY "public"."community_posts"
    ADD CONSTRAINT "community_posts_author_account_id_fkey" FOREIGN KEY ("author_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."community_posts"
    ADD CONSTRAINT "community_posts_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."contract_templates"
    ADD CONSTRAINT "contract_templates_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id");



ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."contract_templates"("id");



ALTER TABLE ONLY "public"."coupon_products"
    ADD CONSTRAINT "coupon_products_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coupon_products"
    ADD CONSTRAINT "coupon_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."inquiry_messages"
    ADD CONSTRAINT "inquiry_messages_sender_account_id_fkey" FOREIGN KEY ("sender_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."inquiry_messages"
    ADD CONSTRAINT "inquiry_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."inquiry_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inquiry_threads"
    ADD CONSTRAINT "inquiry_threads_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inquiry_threads"
    ADD CONSTRAINT "inquiry_threads_member_account_id_fkey" FOREIGN KEY ("member_account_id") REFERENCES "public"."accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."locker_assignments"
    ADD CONSTRAINT "locker_assignments_locker_id_fkey" FOREIGN KEY ("locker_id") REFERENCES "public"."lockers"("id");



ALTER TABLE ONLY "public"."locker_assignments"
    ADD CONSTRAINT "locker_assignments_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."lockers"
    ADD CONSTRAINT "lockers_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."manager_centers"
    ADD CONSTRAINT "manager_centers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."manager_centers"
    ADD CONSTRAINT "manager_centers_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."manager_centers"
    ADD CONSTRAINT "manager_centers_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."center_roles"("id");



ALTER TABLE ONLY "public"."marketing_messages"
    ADD CONSTRAINT "marketing_messages_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."member_center_colors"
    ADD CONSTRAINT "member_center_colors_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."member_center_colors"
    ADD CONSTRAINT "member_center_colors_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."member_coupons"
    ADD CONSTRAINT "member_coupons_center_member_id_fkey" FOREIGN KEY ("center_member_id") REFERENCES "public"."center_members"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."member_coupons"
    ADD CONSTRAINT "member_coupons_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."member_coupons"
    ADD CONSTRAINT "member_coupons_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."member_grades"
    ADD CONSTRAINT "member_grades_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."member_memos"
    ADD CONSTRAINT "member_memos_author_account_id_fkey" FOREIGN KEY ("author_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."member_memos"
    ADD CONSTRAINT "member_memos_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."member_memos"
    ADD CONSTRAINT "member_memos_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."membership_product_grades"
    ADD CONSTRAINT "membership_product_grades_grade_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "public"."member_grades"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."membership_product_grades"
    ADD CONSTRAINT "membership_product_grades_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."membership_product_members"
    ADD CONSTRAINT "membership_product_members_center_member_id_fkey" FOREIGN KEY ("center_member_id") REFERENCES "public"."center_members"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."membership_product_members"
    ADD CONSTRAINT "membership_product_members_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."membership_session_amounts"
    ADD CONSTRAINT "membership_session_amounts_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."membership_transfers"
    ADD CONSTRAINT "membership_transfers_from_profile_id_fkey" FOREIGN KEY ("from_profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."membership_transfers"
    ADD CONSTRAINT "membership_transfers_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id");



ALTER TABLE ONLY "public"."membership_transfers"
    ADD CONSTRAINT "membership_transfers_to_profile_id_fkey" FOREIGN KEY ("to_profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_bound_profile_id_fkey" FOREIGN KEY ("bound_profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_product_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_trainer_account_id_fkey" FOREIGN KEY ("trainer_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."notification_rules"("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_sender_account_id_fkey" FOREIGN KEY ("sender_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."membership_schedule_rules"
    ADD CONSTRAINT "msr_product_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."native_push_tokens"
    ADD CONSTRAINT "native_push_tokens_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_logs"
    ADD CONSTRAINT "notification_logs_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."notification_logs"
    ADD CONSTRAINT "notification_logs_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."notification_logs"
    ADD CONSTRAINT "notification_logs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."notification_rules"("id");



ALTER TABLE ONLY "public"."notification_rules"
    ADD CONSTRAINT "notification_rules_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."notification_rules"
    ADD CONSTRAINT "notification_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."notification_rules"
    ADD CONSTRAINT "notification_rules_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."alimtalk_templates"("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_recipient_account_id_fkey" FOREIGN KEY ("recipient_account_id") REFERENCES "public"."accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_member_coupon_id_fkey" FOREIGN KEY ("member_coupon_id") REFERENCES "public"."member_coupons"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_linked_unpaid_payment_id_fkey" FOREIGN KEY ("linked_unpaid_payment_id") REFERENCES "public"."payments"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_product_pass_fk" FOREIGN KEY ("product_pass_id") REFERENCES "public"."product_passes"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_trainer_account_id_fkey" FOREIGN KEY ("trainer_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_parent_key_fkey" FOREIGN KEY ("parent_key") REFERENCES "public"."permissions"("key");



ALTER TABLE ONLY "public"."point_accounts"
    ADD CONSTRAINT "point_accounts_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."point_accounts"
    ADD CONSTRAINT "point_accounts_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."point_logs"
    ADD CONSTRAINT "point_logs_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."point_logs"
    ADD CONSTRAINT "point_logs_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."point_transactions"
    ADD CONSTRAINT "point_transactions_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."point_transactions"
    ADD CONSTRAINT "point_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id");



ALTER TABLE ONLY "public"."point_transactions"
    ADD CONSTRAINT "point_transactions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id");



ALTER TABLE ONLY "public"."point_transactions"
    ADD CONSTRAINT "point_transactions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."point_transactions"
    ADD CONSTRAINT "point_transactions_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "public"."point_transactions"("id");



ALTER TABLE ONLY "public"."popup_notices"
    ADD CONSTRAINT "popup_notices_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."product_count_prices"
    ADD CONSTRAINT "product_count_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_passes"
    ADD CONSTRAINT "product_passes_linked_membership_id_fkey" FOREIGN KEY ("linked_membership_id") REFERENCES "public"."memberships"("id");



ALTER TABLE ONLY "public"."product_passes"
    ADD CONSTRAINT "product_passes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."product_passes"
    ADD CONSTRAINT "product_passes_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."profile_center_fields"
    ADD CONSTRAINT "profile_center_fields_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."profile_center_fields"
    ADD CONSTRAINT "profile_center_fields_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."progress_categories"
    ADD CONSTRAINT "progress_categories_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."progress_categories"
    ADD CONSTRAINT "progress_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."progress_categories"("id");



ALTER TABLE ONLY "public"."progress_records"
    ADD CONSTRAINT "progress_records_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."progress_categories"("id");



ALTER TABLE ONLY "public"."progress_records"
    ADD CONSTRAINT "progress_records_coach_account_id_fkey" FOREIGN KEY ("coach_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."progress_records"
    ADD CONSTRAINT "progress_records_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."purchase_requests"
    ADD CONSTRAINT "purchase_requests_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_requests"
    ADD CONSTRAINT "purchase_requests_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchase_requests"
    ADD CONSTRAINT "purchase_requests_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."refund_notification_events"
    ADD CONSTRAINT "refund_notification_events_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reservation_goods_usages"
    ADD CONSTRAINT "reservation_goods_usages_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reservation_goods_usages"
    ADD CONSTRAINT "reservation_goods_usages_goods_membership_id_fkey" FOREIGN KEY ("goods_membership_id") REFERENCES "public"."memberships"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reservation_goods_usages"
    ADD CONSTRAINT "reservation_goods_usages_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reservation_goods_usages"
    ADD CONSTRAINT "reservation_goods_usages_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_created_by_account_id_fkey" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id");



ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."review_reports"
    ADD CONSTRAINT "review_reports_reporter_account_id_fkey" FOREIGN KEY ("reporter_account_id") REFERENCES "public"."accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."review_reports"
    ADD CONSTRAINT "review_reports_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "public"."center_reviews"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."review_reports"
    ADD CONSTRAINT "review_reports_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_reviewer_account_id_fkey" FOREIGN KEY ("reviewer_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_target_center_id_fkey" FOREIGN KEY ("target_center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."center_roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."schedule_memos"
    ADD CONSTRAINT "schedule_memos_author_account_id_fkey" FOREIGN KEY ("author_account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."schedule_memos"
    ADD CONSTRAINT "schedule_memos_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_memos"
    ADD CONSTRAINT "schedule_memos_staff_schedule_id_fkey" FOREIGN KEY ("staff_schedule_id") REFERENCES "public"."staff_schedules"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_templates"
    ADD CONSTRAINT "schedule_templates_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."staff_salaries"
    ADD CONSTRAINT "staff_salaries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."staff_salaries"
    ADD CONSTRAINT "staff_salaries_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."staff_schedules"
    ADD CONSTRAINT "staff_schedules_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."staff_schedules"
    ADD CONSTRAINT "staff_schedules_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE ONLY "public"."terms"
    ADD CONSTRAINT "terms_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");



ALTER TABLE "public"."account_auth_identities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."account_center_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."account_link_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_action_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."alimtalk_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cart_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."center_announcements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."center_contacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."center_holidays" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."center_member_fields" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."center_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."center_payout_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."center_reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."center_roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."center_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."center_settlement_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."center_subscription_charges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."center_subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."centers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."change_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chat_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."class_allowed_products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."class_trainers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."class_types" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."classes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."community_comments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."community_posts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."competitions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contract_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contracts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coupon_products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coupons" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_check_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."expenses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."home_banners" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inquiry_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inquiry_threads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."leads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."locker_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lockers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."manager_centers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."member_candidate_search_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."member_center_colors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."member_coupons" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."member_grades" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."member_memos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."membership_product_grades" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."membership_product_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."membership_schedule_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."membership_session_amounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."membership_transfers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."memberships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."native_push_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."phone_verifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."point_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."point_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."point_transactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."popup_notices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_count_prices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_passes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profile_center_fields" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."progress_categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."progress_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."purchase_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."push_subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."refund_notification_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reservation_goods_usages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reservations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."review_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rooms" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."schedule_memos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."schedule_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."service_categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."staff_candidate_search_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."staff_salaries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."staff_schedules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscription_plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."terms" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "개인권한 삭제" ON "public"."account_center_permissions" FOR DELETE USING (("manager_center_id" IN ( SELECT "mc"."id"
   FROM "public"."manager_centers" "mc"
  WHERE "public"."has_permission"("mc"."center_id", 'facility.role_permission'::"text"))));



CREATE POLICY "개인권한 생성" ON "public"."account_center_permissions" FOR INSERT WITH CHECK (("manager_center_id" IN ( SELECT "mc"."id"
   FROM "public"."manager_centers" "mc"
  WHERE "public"."has_permission"("mc"."center_id", 'facility.role_permission'::"text"))));



CREATE POLICY "개인권한 수정" ON "public"."account_center_permissions" FOR UPDATE USING (("manager_center_id" IN ( SELECT "mc"."id"
   FROM "public"."manager_centers" "mc"
  WHERE "public"."has_permission"("mc"."center_id", 'facility.role_permission'::"text")))) WITH CHECK (("manager_center_id" IN ( SELECT "mc"."id"
   FROM "public"."manager_centers" "mc"
  WHERE "public"."has_permission"("mc"."center_id", 'facility.role_permission'::"text"))));



CREATE POLICY "개인권한 조회" ON "public"."account_center_permissions" FOR SELECT USING ((("manager_center_id" IN ( SELECT "manager_centers"."id"
   FROM "public"."manager_centers"
  WHERE ("manager_centers"."account_id" = "public"."my_account_id"()))) OR ("manager_center_id" IN ( SELECT "mc"."id"
   FROM "public"."manager_centers" "mc"
  WHERE "public"."has_permission"("mc"."center_id", 'facility.role_permission'::"text")))));



CREATE POLICY "계정 조회" ON "public"."accounts" FOR SELECT USING ((("auth_id" = "auth"."uid"()) OR ("id" IN ( SELECT "account_auth_identities"."account_id"
   FROM "public"."account_auth_identities"
  WHERE ("account_auth_identities"."auth_id" = "auth"."uid"()))) OR ("id" IN ( SELECT "mc"."account_id"
   FROM "public"."manager_centers" "mc"
  WHERE ("mc"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")))) OR ("id" IN ( SELECT "p"."account_id"
   FROM ("public"."profiles" "p"
     JOIN "public"."center_members" "cm" ON (("cm"."profile_id" = "p"."id")))
  WHERE ("cm"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))))));



CREATE POLICY "공지 매니저 삭제" ON "public"."center_announcements" FOR DELETE USING (("public"."has_permission"("center_id", 'board.notice.delete'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "공지 매니저 수정" ON "public"."center_announcements" FOR UPDATE USING (("public"."has_permission"("center_id", 'board.notice.write'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "공지 매니저 작성" ON "public"."center_announcements" FOR INSERT WITH CHECK (("public"."has_permission"("center_id", 'board.notice.write'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "공지 회원 열람" ON "public"."center_announcements" FOR SELECT USING ((("center_id" IN ( SELECT "public"."my_related_center_ids"() AS "my_related_center_ids")) OR ("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "관리자 로그 조회" ON "public"."admin_action_logs" FOR SELECT USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "구독 플랜 공개 조회" ON "public"."subscription_plans" FOR SELECT USING (true);



CREATE POLICY "구독 플랜 운영자 관리" ON "public"."subscription_plans" USING ("public"."is_platform_admin"()) WITH CHECK ("public"."is_platform_admin"());



CREATE POLICY "구매신청 매니저 수정" ON "public"."purchase_requests" FOR UPDATE USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "구매신청 매니저 조회" ON "public"."purchase_requests" FOR SELECT USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "구매신청 본인 생성" ON "public"."purchase_requests" FOR INSERT WITH CHECK (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "구매신청 본인 조회" ON "public"."purchase_requests" FOR SELECT USING (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "권한 보유 스태프 알림발송기록 조회" ON "public"."notification_logs" FOR SELECT USING (("public"."has_permission"("center_id", 'message.sms.view'::"text") OR "public"."has_permission"("center_id", 'message.push.view'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "권한 보유자 회원메모 조회" ON "public"."member_memos" FOR SELECT USING (("public"."has_permission"("center_id", 'customer.memo.view'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "권한 카탈로그 조회" ON "public"."permissions" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "급여 등록 (본인/타인 권한 분리)" ON "public"."staff_salaries" FOR INSERT WITH CHECK (((("account_id" = "public"."my_account_id"()) AND "public"."has_permission"("center_id", 'facility.salary.own.update'::"text")) OR (("account_id" <> "public"."my_account_id"()) AND "public"."has_permission"("center_id", 'facility.salary.other.update'::"text"))));



CREATE POLICY "급여 삭제" ON "public"."staff_salaries" FOR DELETE USING ("public"."has_permission"("center_id", 'facility.salary.other.update'::"text"));



CREATE POLICY "급여 수정 (본인/타인 권한 분리)" ON "public"."staff_salaries" FOR UPDATE USING (((("account_id" = "public"."my_account_id"()) AND "public"."has_permission"("center_id", 'facility.salary.own.update'::"text")) OR (("account_id" <> "public"."my_account_id"()) AND "public"."has_permission"("center_id", 'facility.salary.other.update'::"text")))) WITH CHECK (((("account_id" = "public"."my_account_id"()) AND "public"."has_permission"("center_id", 'facility.salary.own.update'::"text")) OR (("account_id" <> "public"."my_account_id"()) AND "public"."has_permission"("center_id", 'facility.salary.other.update'::"text"))));



CREATE POLICY "급여 조회 (본인/타인 권한 분리)" ON "public"."staff_salaries" FOR SELECT USING (((("account_id" = "public"."my_account_id"()) AND "public"."has_permission"("center_id", 'facility.salary.own.view'::"text")) OR (("account_id" <> "public"."my_account_id"()) AND "public"."has_permission"("center_id", 'facility.salary.other.view'::"text"))));



CREATE POLICY "내 상품권 조회" ON "public"."product_passes" FOR SELECT USING (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "내 센터 권한 조회" ON "public"."role_permissions" FOR SELECT USING (("role_id" IN ( SELECT "center_roles"."id"
   FROM "public"."center_roles"
  WHERE ("center_roles"."center_id" IN ( SELECT "manager_centers"."center_id"
           FROM "public"."manager_centers"
          WHERE ("manager_centers"."account_id" = "public"."my_account_id"()))))));



CREATE POLICY "내 센터 역할 조회" ON "public"."center_roles" FOR SELECT USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "내 쿠폰 조회" ON "public"."member_coupons" FOR SELECT USING (("center_member_id" IN ( SELECT "cm"."id"
   FROM "public"."center_members" "cm"
  WHERE ("cm"."profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")))));



CREATE POLICY "내 프로필 예약 조회" ON "public"."reservations" FOR SELECT USING (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "네이티브 푸시 토큰 본인 등록" ON "public"."native_push_tokens" FOR INSERT WITH CHECK (("account_id" = "public"."my_account_id"()));



CREATE POLICY "네이티브 푸시 토큰 본인 삭제" ON "public"."native_push_tokens" FOR DELETE USING (("account_id" = "public"."my_account_id"()));



CREATE POLICY "네이티브 푸시 토큰 본인 수정" ON "public"."native_push_tokens" FOR UPDATE USING (("account_id" = "public"."my_account_id"())) WITH CHECK (("account_id" = "public"."my_account_id"()));



CREATE POLICY "네이티브 푸시 토큰 본인 조회" ON "public"."native_push_tokens" FOR SELECT USING (("account_id" = "public"."my_account_id"()));



CREATE POLICY "당사자 또는 권한 보유 스태프 양도이력 조회" ON "public"."membership_transfers" FOR SELECT USING ((("from_profile_id" IN ( SELECT "profiles"."id"
   FROM "public"."profiles"
  WHERE ("profiles"."account_id" = "public"."my_account_id"()))) OR ("to_profile_id" IN ( SELECT "profiles"."id"
   FROM "public"."profiles"
  WHERE ("profiles"."account_id" = "public"."my_account_id"()))) OR (EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."id" = "membership_transfers"."membership_id") AND "public"."has_permission"("m"."center_id", 'customer.member.pass_detail'::"text")))) OR "public"."is_platform_admin"()));



CREATE POLICY "로그인 사용자 휴무일 조회" ON "public"."center_holidays" FOR SELECT USING ((("auth"."role"() = 'authenticated'::"text") AND "public"."center_rows_visible"("center_id")));



CREATE POLICY "로그인 사용자는 리뷰 조회 가능" ON "public"."reviews" FOR SELECT USING ((("auth"."role"() = 'authenticated'::"text") AND "public"."center_rows_visible"("target_center_id")));



CREATE POLICY "로그인 사용자는 커뮤니티 게시글 조회 가능" ON "public"."community_posts" FOR SELECT USING ((("auth"."role"() = 'authenticated'::"text") AND "public"."center_rows_visible"("center_id")));



CREATE POLICY "룸 공개 조회" ON "public"."rooms" FOR SELECT USING ("public"."center_rows_visible"("center_id"));



CREATE POLICY "룸 매니저 삭제" ON "public"."rooms" FOR DELETE USING (("public"."has_permission"("center_id", 'facility.room'::"text") OR "public"."has_permission"("center_id", 'facility.room.manage'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "룸 매니저 생성" ON "public"."rooms" FOR INSERT WITH CHECK (("public"."has_permission"("center_id", 'facility.room'::"text") OR "public"."has_permission"("center_id", 'facility.room.manage'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "룸 매니저 수정" ON "public"."rooms" FOR UPDATE USING (("public"."has_permission"("center_id", 'facility.room'::"text") OR "public"."has_permission"("center_id", 'facility.room.manage'::"text") OR "public"."is_platform_admin"())) WITH CHECK (("public"."has_permission"("center_id", 'facility.room'::"text") OR "public"."has_permission"("center_id", 'facility.room.manage'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "룸 매니저 조회" ON "public"."rooms" FOR SELECT USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "매니저 강사 삭제" ON "public"."class_trainers" FOR DELETE USING (("class_id" IN ( SELECT "classes"."id"
   FROM "public"."classes"
  WHERE ("classes"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")))));



CREATE POLICY "매니저 강사 생성" ON "public"."class_trainers" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."classes" "c"
     JOIN "public"."manager_centers" "mc" ON (("mc"."center_id" = "c"."center_id")))
  WHERE (("c"."id" = "class_trainers"."class_id") AND ("c"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) AND ("mc"."account_id" = "class_trainers"."account_id") AND ("mc"."status" = 'active'::"text")))));



CREATE POLICY "매니저 강사 수정" ON "public"."class_trainers" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."classes" "c"
  WHERE (("c"."id" = "class_trainers"."class_id") AND ("c"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."classes" "c"
     JOIN "public"."manager_centers" "mc" ON (("mc"."center_id" = "c"."center_id")))
  WHERE (("c"."id" = "class_trainers"."class_id") AND ("c"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) AND ("mc"."account_id" = "class_trainers"."account_id") AND ("mc"."status" = 'active'::"text")))));



CREATE POLICY "매니저 등급 삭제" ON "public"."member_grades" FOR DELETE USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 등급 생성" ON "public"."member_grades" FOR INSERT WITH CHECK (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 등급 수정" ON "public"."member_grades" FOR UPDATE USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))) WITH CHECK (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 등급 조회" ON "public"."member_grades" FOR SELECT USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 매출 등록" ON "public"."payments" FOR INSERT WITH CHECK ("public"."has_permission"("center_id", 'pass.payment.create'::"text"));



CREATE POLICY "매니저 매출 삭제" ON "public"."payments" FOR DELETE USING ("public"."has_permission"("center_id", 'pass.payment.delete'::"text"));



CREATE POLICY "매니저 매출 수정" ON "public"."payments" FOR UPDATE USING ("public"."has_permission"("center_id", 'pass.payment.update'::"text")) WITH CHECK ("public"."has_permission"("center_id", 'pass.payment.update'::"text"));



CREATE POLICY "매니저 매출 조회" ON "public"."payments" FOR SELECT USING (("public"."has_permission"("center_id", 'pass.sales.view'::"text") OR "public"."has_permission"("center_id", 'customer.member.pass_detail'::"text") OR ("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "매니저 상담채널 삭제" ON "public"."center_contacts" FOR DELETE USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 상담채널 생성" ON "public"."center_contacts" FOR INSERT WITH CHECK (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 상담채널 수정" ON "public"."center_contacts" FOR UPDATE USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))) WITH CHECK (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 상품 삭제" ON "public"."products" FOR DELETE USING (("public"."has_permission"("center_id", 'pass.update'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "매니저 상품 생성" ON "public"."products" FOR INSERT WITH CHECK (("public"."has_permission"("center_id", 'pass.create'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "매니저 상품 수정" ON "public"."products" FOR UPDATE USING (("public"."has_permission"("center_id", 'pass.update'::"text") OR "public"."is_platform_admin"())) WITH CHECK (("public"."has_permission"("center_id", 'pass.update'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "매니저 상품등급공개범위 관리" ON "public"."membership_product_grades" USING (("product_id" IN ( SELECT "products"."id"
   FROM "public"."products"
  WHERE ("products"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))))) WITH CHECK ((("product_id" IN ( SELECT "products"."id"
   FROM "public"."products"
  WHERE ("products"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")))) AND ("grade_id" IN ( SELECT "mg"."id"
   FROM ("public"."member_grades" "mg"
     JOIN "public"."products" "p" ON (("p"."center_id" = "mg"."center_id")))
  WHERE ("p"."id" = "membership_product_grades"."product_id")))));



CREATE POLICY "매니저 상품지정회원공개범위 관리" ON "public"."membership_product_members" USING (("product_id" IN ( SELECT "products"."id"
   FROM "public"."products"
  WHERE ("products"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))))) WITH CHECK ((("product_id" IN ( SELECT "products"."id"
   FROM "public"."products"
  WHERE ("products"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")))) AND ("center_member_id" IN ( SELECT "cm"."id"
   FROM ("public"."center_members" "cm"
     JOIN "public"."products" "p" ON (("p"."center_id" = "cm"."center_id")))
  WHERE ("p"."id" = "membership_product_members"."product_id")))));



CREATE POLICY "매니저 설정 생성" ON "public"."center_settings" FOR INSERT WITH CHECK ("public"."has_permission"("center_id", 'facility.operation'::"text"));



CREATE POLICY "매니저 설정 수정" ON "public"."center_settings" FOR UPDATE USING ("public"."has_permission"("center_id", 'facility.operation'::"text")) WITH CHECK ("public"."has_permission"("center_id", 'facility.operation'::"text"));



CREATE POLICY "매니저 센터 수정" ON "public"."centers" FOR UPDATE USING (("public"."has_permission"("id", 'facility.info'::"text") OR "public"."is_platform_admin"())) WITH CHECK (("public"."has_permission"("id", 'facility.info'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "매니저 센터 예약 조회" ON "public"."reservations" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."classes" "c"
  WHERE (("c"."id" = "reservations"."class_id") AND (("c"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"())))));



CREATE POLICY "매니저 센터회원 등록" ON "public"."center_members" FOR INSERT WITH CHECK ("public"."has_permission"("center_id", 'customer.member.create'::"text"));



CREATE POLICY "매니저 센터회원 삭제" ON "public"."center_members" FOR DELETE USING ("public"."has_permission"("center_id", 'customer.member.delete'::"text"));



CREATE POLICY "매니저 센터회원 수정" ON "public"."center_members" FOR UPDATE USING ("public"."has_permission"("center_id", 'customer.member.update'::"text")) WITH CHECK ("public"."has_permission"("center_id", 'customer.member.update'::"text"));



CREATE POLICY "매니저 센터회원 프로필 조회" ON "public"."profiles" FOR SELECT USING ((("account_id" = "public"."my_account_id"()) OR ("id" IN ( SELECT "cm"."profile_id"
   FROM "public"."center_members" "cm"
  WHERE ("cm"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")))) OR ("id" IN ( SELECT "r"."profile_id"
   FROM ("public"."reservations" "r"
     JOIN "public"."classes" "c" ON (("c"."id" = "r"."class_id")))
  WHERE ("c"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")))) OR "public"."is_platform_admin"()));



CREATE POLICY "매니저 수강권 발급" ON "public"."memberships" FOR INSERT WITH CHECK ("public"."has_permission"("center_id", 'customer.member.issue_pass'::"text"));



CREATE POLICY "매니저 수강권 수정" ON "public"."memberships" FOR UPDATE USING (("public"."has_permission"("center_id", 'customer.member.issue_pass'::"text") OR "public"."has_permission"("center_id", 'customer.member.pass_detail'::"text") OR "public"."is_platform_admin"())) WITH CHECK (("public"."has_permission"("center_id", 'customer.member.issue_pass'::"text") OR "public"."has_permission"("center_id", 'customer.member.pass_detail'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "매니저 수강권 조회" ON "public"."memberships" FOR SELECT USING ((("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")) OR "public"."has_permission"("center_id", 'customer.member.view'::"text") OR "public"."has_permission"("center_id", 'customer.member.pass_detail'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "매니저 수업 삭제" ON "public"."classes" FOR DELETE USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) AND "public"."can_write_class"("id", "center_id", "class_format", "start_time", 'delete'::"text")));



CREATE POLICY "매니저 수업 생성" ON "public"."classes" FOR INSERT WITH CHECK ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) AND "public"."can_write_class"(NULL::"uuid", "center_id", "class_format", "start_time", 'create'::"text")));



CREATE POLICY "매니저 수업 수정" ON "public"."classes" FOR UPDATE USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) AND "public"."can_write_class"("id", "center_id", "class_format", "start_time", 'update'::"text"))) WITH CHECK ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) AND "public"."can_write_class"("id", "center_id", "class_format", "start_time", 'update'::"text")));



CREATE POLICY "매니저 알림규칙 관리" ON "public"."notification_rules" USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))) WITH CHECK (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 지출 등록" ON "public"."expenses" FOR INSERT WITH CHECK (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 지출 삭제" ON "public"."expenses" FOR DELETE USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 지출 수정" ON "public"."expenses" FOR UPDATE USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))) WITH CHECK (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 지출 조회" ON "public"."expenses" FOR SELECT USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 취소예약 정리" ON "public"."reservations" FOR DELETE USING ((("status" = ANY (ARRAY['cancelled'::"text", 'no_show'::"text"])) AND ("class_id" IN ( SELECT "classes"."id"
   FROM "public"."classes"
  WHERE ("classes"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))))));



CREATE POLICY "매니저 쿠폰 관리" ON "public"."coupons" USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"())) WITH CHECK ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "매니저 쿠폰적용대상 관리" ON "public"."coupon_products" USING (("coupon_id" IN ( SELECT "coupons"."id"
   FROM "public"."coupons"
  WHERE ("coupons"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))))) WITH CHECK ((("coupon_id" IN ( SELECT "coupons"."id"
   FROM "public"."coupons"
  WHERE ("coupons"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")))) AND ("product_id" IN ( SELECT "p"."id"
   FROM ("public"."products" "p"
     JOIN "public"."coupons" "c" ON (("c"."center_id" = "p"."center_id")))
  WHERE ("c"."id" = "coupon_products"."coupon_id")))));



CREATE POLICY "매니저 템플릿 관리" ON "public"."schedule_templates" USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))) WITH CHECK (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 포인트 등록" ON "public"."point_transactions" FOR INSERT WITH CHECK ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) AND ("order_id" IS NULL) AND ("reverses_id" IS NULL)));



CREATE POLICY "매니저 항목 삭제" ON "public"."center_member_fields" FOR DELETE USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 항목 생성" ON "public"."center_member_fields" FOR INSERT WITH CHECK (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 항목 수정" ON "public"."center_member_fields" FOR UPDATE USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))) WITH CHECK (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 회원정보 조회" ON "public"."profile_center_fields" FOR SELECT USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 회원쿠폰 관리" ON "public"."member_coupons" USING ((("coupon_id" IN ( SELECT "coupons"."id"
   FROM "public"."coupons"
  WHERE ("coupons"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")))) OR "public"."is_platform_admin"())) WITH CHECK ((("coupon_id" IN ( SELECT "coupons"."id"
   FROM "public"."coupons"
  WHERE ("coupons"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")))) AND ("center_member_id" IN ( SELECT "cm"."id"
   FROM ("public"."center_members" "cm"
     JOIN "public"."coupons" "c" ON (("c"."center_id" = "cm"."center_id")))
  WHERE ("c"."id" = "member_coupons"."coupon_id")))));



CREATE POLICY "매니저 휴무일 삭제" ON "public"."center_holidays" FOR DELETE USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 휴무일 생성" ON "public"."center_holidays" FOR INSERT WITH CHECK (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저 휴무일 수정" ON "public"."center_holidays" FOR UPDATE USING (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))) WITH CHECK (("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")));



CREATE POLICY "매니저센터 생성" ON "public"."manager_centers" FOR INSERT WITH CHECK ((("account_id" = "public"."my_account_id"()) AND ("role_id" IS NULL) AND (NOT "public"."manager_centers_has_any_row"("center_id")) AND "public"."center_is_pending"("center_id")));



CREATE POLICY "문의메시지 조회" ON "public"."inquiry_messages" FOR SELECT USING (("thread_id" IN ( SELECT "inquiry_threads"."id"
   FROM "public"."inquiry_threads"
  WHERE (("inquiry_threads"."member_account_id" = "public"."my_account_id"()) OR ("inquiry_threads"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()))));



CREATE POLICY "문의방 매니저 조회" ON "public"."inquiry_threads" FOR SELECT USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "문의방 회원 조회" ON "public"."inquiry_threads" FOR SELECT USING (("member_account_id" = "public"."my_account_id"()));



CREATE POLICY "발송이력 삭제" ON "public"."messages" FOR DELETE USING (((("channel" = ANY (ARRAY['sms'::"text", 'lms'::"text"])) AND "public"."has_permission"("center_id", 'message.sms.delete'::"text")) OR (("channel" = 'push'::"text") AND "public"."has_permission"("center_id", 'message.push.delete'::"text"))));



CREATE POLICY "발송이력 생성" ON "public"."messages" FOR INSERT WITH CHECK (((("channel" = ANY (ARRAY['sms'::"text", 'lms'::"text"])) AND "public"."has_permission"("center_id", 'message.sms.send'::"text")) OR (("channel" = 'push'::"text") AND "public"."has_permission"("center_id", 'message.push.send'::"text"))));



CREATE POLICY "발송이력 수정" ON "public"."messages" FOR UPDATE USING (((("channel" = ANY (ARRAY['sms'::"text", 'lms'::"text"])) AND "public"."has_permission"("center_id", 'message.sms.update'::"text")) OR (("channel" = 'push'::"text") AND "public"."has_permission"("center_id", 'message.push.update'::"text")))) WITH CHECK (((("channel" = ANY (ARRAY['sms'::"text", 'lms'::"text"])) AND "public"."has_permission"("center_id", 'message.sms.update'::"text")) OR (("channel" = 'push'::"text") AND "public"."has_permission"("center_id", 'message.push.update'::"text"))));



CREATE POLICY "발송이력 조회" ON "public"."messages" FOR SELECT USING (((("channel" = ANY (ARRAY['sms'::"text", 'lms'::"text"])) AND "public"."has_permission"("center_id", 'message.sms.view'::"text")) OR (("channel" = 'push'::"text") AND "public"."has_permission"("center_id", 'message.push.view'::"text"))));



CREATE POLICY "배너 공개 조회" ON "public"."home_banners" FOR SELECT USING (true);



CREATE POLICY "배너 운영자 관리" ON "public"."home_banners" USING ("public"."is_platform_admin"()) WITH CHECK ("public"."is_platform_admin"());



CREATE POLICY "본인 계정 삭제" ON "public"."accounts" FOR DELETE USING ((("auth_id" = "auth"."uid"()) OR ("id" IN ( SELECT "account_auth_identities"."account_id"
   FROM "public"."account_auth_identities"
  WHERE ("account_auth_identities"."auth_id" = "auth"."uid"())))));



CREATE POLICY "본인 계정 생성" ON "public"."accounts" FOR INSERT WITH CHECK ((("auth_id" = "auth"."uid"()) AND (("phone" IS NULL) OR "public"."_is_phone_recently_verified"("phone"))));



CREATE POLICY "본인 계정 수정" ON "public"."accounts" FOR UPDATE USING ((("auth_id" = "auth"."uid"()) OR ("id" IN ( SELECT "account_auth_identities"."account_id"
   FROM "public"."account_auth_identities"
  WHERE ("account_auth_identities"."auth_id" = "auth"."uid"()))))) WITH CHECK ((("auth_id" = "auth"."uid"()) OR ("id" IN ( SELECT "account_auth_identities"."account_id"
   FROM "public"."account_auth_identities"
  WHERE ("account_auth_identities"."auth_id" = "auth"."uid"())))));



CREATE POLICY "본인 또는 권한 보유 스태프 계약서 조회" ON "public"."contracts" FOR SELECT USING ((("profile_id" IN ( SELECT "profiles"."id"
   FROM "public"."profiles"
  WHERE ("profiles"."account_id" = "public"."my_account_id"()))) OR "public"."has_permission"("center_id", 'contract.list.view'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "본인 또는 오너 일정메모 삭제" ON "public"."schedule_memos" FOR DELETE USING ((("class_id" IS NOT NULL) AND ((("author_account_id" = "public"."my_account_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."classes" "c"
  WHERE (("c"."id" = "schedule_memos"."class_id") AND ("public"."has_permission"("c"."center_id", 'schedule.memo.delete'::"text") OR "public"."is_platform_admin"()))))) OR (EXISTS ( SELECT 1
   FROM "public"."classes" "c"
  WHERE (("c"."id" = "schedule_memos"."class_id") AND ("public"."_is_owner_of_center"("c"."center_id") OR "public"."is_platform_admin"())))))));



CREATE POLICY "본인 또는 오너 일정메모 수정" ON "public"."schedule_memos" FOR UPDATE USING ((("class_id" IS NOT NULL) AND ((("author_account_id" = "public"."my_account_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."classes" "c"
  WHERE (("c"."id" = "schedule_memos"."class_id") AND ("public"."has_permission"("c"."center_id", 'schedule.memo.update'::"text") OR "public"."is_platform_admin"()))))) OR (EXISTS ( SELECT 1
   FROM "public"."classes" "c"
  WHERE (("c"."id" = "schedule_memos"."class_id") AND ("public"."_is_owner_of_center"("c"."center_id") OR "public"."is_platform_admin"()))))))) WITH CHECK ((("class_id" IS NOT NULL) AND ("staff_schedule_id" IS NULL) AND ((("author_account_id" = "public"."my_account_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."classes" "c"
  WHERE (("c"."id" = "schedule_memos"."class_id") AND ("public"."has_permission"("c"."center_id", 'schedule.memo.update'::"text") OR "public"."is_platform_admin"()))))) OR (EXISTS ( SELECT 1
   FROM "public"."classes" "c"
  WHERE (("c"."id" = "schedule_memos"."class_id") AND ("public"."_is_owner_of_center"("c"."center_id") OR "public"."is_platform_admin"())))))));



CREATE POLICY "본인 또는 오너 회원메모 삭제" ON "public"."member_memos" FOR DELETE USING (((("author_account_id" = "public"."my_account_id"()) AND ("public"."has_permission"("center_id", 'customer.memo.delete'::"text") OR "public"."is_platform_admin"())) OR "public"."_is_owner_of_center"("center_id") OR "public"."is_platform_admin"()));



CREATE POLICY "본인 또는 오너 회원메모 수정" ON "public"."member_memos" FOR UPDATE USING (((("author_account_id" = "public"."my_account_id"()) AND ("public"."has_permission"("center_id", 'customer.memo.update'::"text") OR "public"."is_platform_admin"())) OR "public"."_is_owner_of_center"("center_id") OR "public"."is_platform_admin"())) WITH CHECK (((("author_account_id" = "public"."my_account_id"()) AND ("public"."has_permission"("center_id", 'customer.memo.update'::"text") OR "public"."is_platform_admin"())) OR "public"."_is_owner_of_center"("center_id") OR "public"."is_platform_admin"()));



CREATE POLICY "본인 색상 설정 관리" ON "public"."member_center_colors" USING (("account_id" = "public"."my_account_id"())) WITH CHECK (("account_id" = "public"."my_account_id"()));



CREATE POLICY "본인 예약 메모 수정" ON "public"."reservations" FOR UPDATE USING (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids"))) WITH CHECK (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "본인 일정메모 작성" ON "public"."schedule_memos" FOR INSERT WITH CHECK ((("class_id" IS NOT NULL) AND ("staff_schedule_id" IS NULL) AND ("author_account_id" = "public"."my_account_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."classes" "c"
  WHERE (("c"."id" = "schedule_memos"."class_id") AND ("public"."has_permission"("c"."center_id", 'schedule.memo.create'::"text") OR "public"."is_platform_admin"()))))));



CREATE POLICY "본인 입력값 삭제" ON "public"."profile_center_fields" FOR DELETE USING (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "본인 입력값 생성" ON "public"."profile_center_fields" FOR INSERT WITH CHECK (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "본인 입력값 수정" ON "public"."profile_center_fields" FOR UPDATE USING (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids"))) WITH CHECK (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "본인 프로필 삭제" ON "public"."profiles" FOR DELETE USING (("account_id" = "public"."my_account_id"()));



CREATE POLICY "본인 프로필 생성" ON "public"."profiles" FOR INSERT WITH CHECK (("account_id" = "public"."my_account_id"()));



CREATE POLICY "본인 프로필 수정" ON "public"."profiles" FOR UPDATE USING (("account_id" = "public"."my_account_id"())) WITH CHECK (("account_id" = "public"."my_account_id"()));



CREATE POLICY "본인 회원메모 작성" ON "public"."member_memos" FOR INSERT WITH CHECK ((("author_account_id" = "public"."my_account_id"()) AND ("public"."has_permission"("center_id", 'customer.memo.create'::"text") OR "public"."is_platform_admin"())));



CREATE POLICY "상담고객 등록" ON "public"."leads" FOR INSERT WITH CHECK ("public"."has_permission"("center_id", 'customer.lead.create'::"text"));



CREATE POLICY "상담고객 삭제" ON "public"."leads" FOR DELETE USING ("public"."has_permission"("center_id", 'customer.lead.delete'::"text"));



CREATE POLICY "상담고객 수정" ON "public"."leads" FOR UPDATE USING ("public"."has_permission"("center_id", 'customer.lead.update'::"text")) WITH CHECK ("public"."has_permission"("center_id", 'customer.lead.update'::"text"));



CREATE POLICY "상담고객 조회" ON "public"."leads" FOR SELECT USING ("public"."has_permission"("center_id", 'customer.lead.view'::"text"));



CREATE POLICY "상담채널 조회" ON "public"."center_contacts" FOR SELECT USING ((("auth"."role"() = 'authenticated'::"text") AND "public"."center_rows_visible"("center_id")));



CREATE POLICY "상품 조회" ON "public"."products" FOR SELECT USING ((("center_id" IN ( SELECT "c"."id"
   FROM "public"."centers" "c"
  WHERE (("c"."status" = 'approved'::"text") AND ((NOT "c"."is_internal") OR ("c"."id" IN ( SELECT "public"."my_member_center_ids"() AS "my_member_center_ids")))))) OR ("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))));



CREATE POLICY "설정 조회" ON "public"."center_settings" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "public"."center_rows_visible"("center_id")));



CREATE POLICY "센터 구독 조회" ON "public"."center_subscriptions" FOR SELECT USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "센터 구독 청구내역 조회" ON "public"."center_subscription_charges" FOR SELECT USING ((("subscription_id" IN ( SELECT "center_subscriptions"."id"
   FROM "public"."center_subscriptions"
  WHERE ("center_subscriptions"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")))) OR "public"."is_platform_admin"()));



CREATE POLICY "센터 생성" ON "public"."centers" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "센터 스태프 일정메모 조회" ON "public"."schedule_memos" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."classes" "c"
  WHERE (("c"."id" = "schedule_memos"."class_id") AND ("c"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))))) OR "public"."is_platform_admin"()));



CREATE POLICY "센터 항목 조회" ON "public"."center_member_fields" FOR SELECT USING ((("auth"."role"() = 'authenticated'::"text") AND "public"."center_rows_visible"("center_id")));



CREATE POLICY "센터회원 조회" ON "public"."center_members" FOR SELECT USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR ("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids"))));



CREATE POLICY "센터후기 공개 조회" ON "public"."center_reviews" FOR SELECT USING ("public"."center_rows_visible"("center_id"));



CREATE POLICY "센터후기 매니저 답변" ON "public"."center_reviews" FOR UPDATE USING (("public"."has_permission"("center_id", 'facility.review.reply'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "센터후기 매니저 삭제" ON "public"."center_reviews" FOR DELETE USING (("public"."has_permission"("center_id", 'facility.review.delete'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "센터후기 본인 삭제" ON "public"."center_reviews" FOR DELETE USING (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "센터후기 본인 수정" ON "public"."center_reviews" FOR UPDATE USING (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "센터후기 본인 작성" ON "public"."center_reviews" FOR INSERT WITH CHECK (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "수업 강사 조회" ON "public"."class_trainers" FOR SELECT USING ((("auth"."role"() = 'authenticated'::"text") AND "public"."class_rows_visible"("class_id")));



CREATE POLICY "수업매출 회차금액 조회" ON "public"."membership_session_amounts" FOR SELECT USING (("membership_id" IN ( SELECT "memberships"."id"
   FROM "public"."memberships"
  WHERE "public"."has_permission"("memberships"."center_id", 'pass.sales.view'::"text"))));



CREATE POLICY "수업수강권 삭제" ON "public"."class_allowed_products" FOR DELETE USING (("class_id" IN ( SELECT "classes"."id"
   FROM "public"."classes"
  WHERE ("classes"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")))));



CREATE POLICY "수업수강권 생성" ON "public"."class_allowed_products" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."classes" "c"
     JOIN "public"."products" "p" ON (("p"."id" = "class_allowed_products"."product_id")))
  WHERE (("c"."id" = "class_allowed_products"."class_id") AND ("c"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) AND ("p"."center_id" = "c"."center_id") AND ("p"."product_kind" = 'pass'::"text")))));



CREATE POLICY "수업수강권 조회" ON "public"."class_allowed_products" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "public"."class_rows_visible"("class_id")));



CREATE POLICY "승인된 센터 수업 조회" ON "public"."classes" FOR SELECT USING ((("center_id" IN ( SELECT "c"."id"
   FROM "public"."centers" "c"
  WHERE (("c"."status" = 'approved'::"text") AND ((NOT "c"."is_internal") OR ("c"."id" IN ( SELECT "public"."my_member_center_ids"() AS "my_member_center_ids")))))) OR ("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))));



CREATE POLICY "승인된 센터 조회" ON "public"."centers" FOR SELECT USING (((("status" = 'approved'::"text") AND ((NOT "is_internal") OR ("id" IN ( SELECT "public"."my_member_center_ids"() AS "my_member_center_ids")))) OR ("id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR ("id" IN ( SELECT "public"."my_center_ids_any_status"() AS "my_center_ids_any_status")) OR "public"."is_platform_admin"()));



CREATE POLICY "알림 본인 삭제" ON "public"."notifications" FOR DELETE USING (("recipient_account_id" = "public"."my_account_id"()));



CREATE POLICY "알림 본인 수정" ON "public"."notifications" FOR UPDATE USING (("recipient_account_id" = "public"."my_account_id"()));



CREATE POLICY "알림 본인 조회" ON "public"."notifications" FOR SELECT USING (("recipient_account_id" = "public"."my_account_id"()));



CREATE POLICY "알림규칙 매니저 관리" ON "public"."notification_rules" USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"())) WITH CHECK ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "알림톡템플릿 매니저 삭제" ON "public"."alimtalk_templates" FOR DELETE USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "알림톡템플릿 매니저 생성" ON "public"."alimtalk_templates" FOR INSERT WITH CHECK ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "알림톡템플릿 매니저 수정" ON "public"."alimtalk_templates" FOR UPDATE USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"())) WITH CHECK ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "알림톡템플릿 조회" ON "public"."alimtalk_templates" FOR SELECT USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR (("center_id" IS NULL) AND ("auth"."uid"() IS NOT NULL)) OR "public"."is_platform_admin"()));



CREATE POLICY "예약 상품 사용 조회" ON "public"."reservation_goods_usages" FOR SELECT USING ((("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")) OR ("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "예약조건 삭제" ON "public"."membership_schedule_rules" FOR DELETE USING (("product_id" IN ( SELECT "products"."id"
   FROM "public"."products"
  WHERE "public"."has_permission"("products"."center_id", 'pass.update'::"text"))));



CREATE POLICY "예약조건 생성" ON "public"."membership_schedule_rules" FOR INSERT WITH CHECK (("product_id" IN ( SELECT "products"."id"
   FROM "public"."products"
  WHERE "public"."has_permission"("products"."center_id", 'pass.update'::"text"))));



CREATE POLICY "예약조건 조회" ON "public"."membership_schedule_rules" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "public"."product_rows_visible"("product_id")));



CREATE POLICY "오너 스태프 삭제" ON "public"."manager_centers" FOR DELETE USING (((("account_id" = "public"."my_account_id"()) OR "public"."has_permission"("center_id", 'facility.staff.delete'::"text")) AND "public"."manager_centers_has_any_row"("center_id", "id") AND (NOT "public"."manager_centers_is_last_active_owner"("center_id", "id")) AND ((NOT "public"."role_id_is_owner_for_center"("role_id", "center_id")) OR "public"."is_center_owner"("center_id"))));



CREATE POLICY "오너 스태프 수정" ON "public"."manager_centers" FOR UPDATE USING (((("account_id" = "public"."my_account_id"()) AND ("role_id" IS NULL) AND (NOT "public"."manager_centers_has_any_row"("center_id", "id"))) OR ("public"."has_permission"("center_id", 'facility.staff.update'::"text") AND ((NOT "public"."role_id_is_owner_for_center"("role_id", "center_id")) OR "public"."is_center_owner"("center_id"))))) WITH CHECK (((("role_id" IS NULL) OR "public"."role_id_belongs_to_center"("role_id", "center_id")) AND ((("account_id" = "public"."my_account_id"()) AND ("status" = 'active'::"text") AND "public"."role_id_is_owner_for_center"("role_id", "center_id") AND (NOT "public"."manager_centers_has_any_row"("center_id", "id"))) OR ("public"."has_permission"("center_id", 'facility.staff.update'::"text") AND ((NOT "public"."role_id_is_owner_for_center"("role_id", "center_id")) OR "public"."is_center_owner"("center_id"))))));



CREATE POLICY "오너 스태프 조회" ON "public"."manager_centers" FOR SELECT USING ((("account_id" = "public"."my_account_id"()) OR ("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))));



CREATE POLICY "오너 스태프 초대" ON "public"."manager_centers" FOR INSERT WITH CHECK (("public"."has_permission"("center_id", 'facility.staff.create'::"text") AND (("role_id" IS NULL) OR ("public"."role_id_belongs_to_center"("role_id", "center_id") AND ((NOT "public"."role_id_is_owner_for_center"("role_id", "center_id")) OR "public"."is_center_owner"("center_id"))))));



CREATE POLICY "오너만 권한 부여 삭제" ON "public"."role_permissions" FOR DELETE USING (("role_id" IN ( SELECT "center_roles"."id"
   FROM "public"."center_roles"
  WHERE "public"."has_permission"("center_roles"."center_id", 'role.manage'::"text"))));



CREATE POLICY "오너만 권한 부여 생성" ON "public"."role_permissions" FOR INSERT WITH CHECK (("role_id" IN ( SELECT "center_roles"."id"
   FROM "public"."center_roles"
  WHERE "public"."has_permission"("center_roles"."center_id", 'role.manage'::"text"))));



CREATE POLICY "오너만 권한 부여 수정" ON "public"."role_permissions" FOR UPDATE USING (("role_id" IN ( SELECT "center_roles"."id"
   FROM "public"."center_roles"
  WHERE "public"."has_permission"("center_roles"."center_id", 'role.manage'::"text")))) WITH CHECK (("role_id" IN ( SELECT "center_roles"."id"
   FROM "public"."center_roles"
  WHERE "public"."has_permission"("center_roles"."center_id", 'role.manage'::"text"))));



CREATE POLICY "오너만 역할 삭제" ON "public"."center_roles" FOR DELETE USING ("public"."has_permission"("center_id", 'role.manage'::"text"));



CREATE POLICY "오너만 역할 생성" ON "public"."center_roles" FOR INSERT WITH CHECK ("public"."has_permission"("center_id", 'role.manage'::"text"));



CREATE POLICY "오너만 역할 수정" ON "public"."center_roles" FOR UPDATE USING ("public"."has_permission"("center_id", 'role.manage'::"text")) WITH CHECK ("public"."has_permission"("center_id", 'role.manage'::"text"));



CREATE POLICY "운영자 마케팅메시지 등록" ON "public"."marketing_messages" FOR INSERT WITH CHECK ("public"."is_platform_admin"());



CREATE POLICY "운영자 마케팅메시지 조회" ON "public"."marketing_messages" FOR SELECT USING ("public"."is_platform_admin"());



CREATE POLICY "장바구니 본인" ON "public"."cart_items" USING (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids"))) WITH CHECK (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "정산계좌 오너 수정" ON "public"."center_settlement_accounts" FOR UPDATE USING ("public"."_is_owner_of_center"("center_id")) WITH CHECK ("public"."_is_owner_of_center"("center_id"));



CREATE POLICY "정산계좌 오너 조회" ON "public"."center_settlement_accounts" FOR SELECT USING (("public"."_is_owner_of_center"("center_id") OR "public"."is_platform_admin"()));



CREATE POLICY "정산계좌 조회" ON "public"."center_payout_accounts" FOR SELECT USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "종목 공개 조회" ON "public"."service_categories" FOR SELECT USING (true);



CREATE POLICY "종목 운영자 관리" ON "public"."service_categories" USING ("public"."is_platform_admin"()) WITH CHECK ("public"."is_platform_admin"());



CREATE POLICY "주문 매니저 수정" ON "public"."orders" FOR UPDATE USING (("public"."has_permission"("center_id", 'pass.payment.create'::"text") OR "public"."is_platform_admin"()));



CREATE POLICY "주문 매니저 조회" ON "public"."orders" FOR SELECT USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "주문 본인 생성" ON "public"."orders" FOR INSERT WITH CHECK ((("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")) AND (("product_id" IS NULL) OR "public"."member_can_purchase_product"("product_id", "profile_id"))));



COMMENT ON POLICY "주문 본인 생성" ON "public"."orders" IS 'QA Fix Batch(2026-09-18): product_id가 있으면 member_can_purchase_product()로 구매 자격까지 확인 — product id를 직접 조작해 비공개 상품을 주문 생성 단계에서부터 막는다.';



CREATE POLICY "주문 본인 조회" ON "public"."orders" FOR SELECT USING (("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")));



CREATE POLICY "주문 본인 취소" ON "public"."orders" FOR UPDATE USING ((("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")) AND ("status" = ANY (ARRAY['pending'::"text", 'paid'::"text"])))) WITH CHECK ((("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")) AND ("status" = 'cancelled'::"text")));



CREATE POLICY "진도 기록 삭제" ON "public"."progress_records" FOR DELETE USING (("category_id" IN ( SELECT "progress_categories"."id"
   FROM "public"."progress_categories"
  WHERE "public"."has_permission"("progress_categories"."center_id", 'customer.progress'::"text"))));



CREATE POLICY "진도 기록 생성" ON "public"."progress_records" FOR INSERT WITH CHECK (("category_id" IN ( SELECT "progress_categories"."id"
   FROM "public"."progress_categories"
  WHERE "public"."has_permission"("progress_categories"."center_id", 'customer.progress'::"text"))));



CREATE POLICY "진도 기록 수정" ON "public"."progress_records" FOR UPDATE USING (("category_id" IN ( SELECT "progress_categories"."id"
   FROM "public"."progress_categories"
  WHERE "public"."has_permission"("progress_categories"."center_id", 'customer.progress'::"text")))) WITH CHECK (("category_id" IN ( SELECT "progress_categories"."id"
   FROM "public"."progress_categories"
  WHERE "public"."has_permission"("progress_categories"."center_id", 'customer.progress'::"text"))));



CREATE POLICY "진도 기록 조회" ON "public"."progress_records" FOR SELECT USING ((("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")) OR ("category_id" IN ( SELECT "progress_categories"."id"
   FROM "public"."progress_categories"
  WHERE "public"."has_permission"("progress_categories"."center_id", 'customer.progress'::"text")))));



CREATE POLICY "진도 카테고리 삭제" ON "public"."progress_categories" FOR DELETE USING ("public"."has_permission"("center_id", 'customer.progress'::"text"));



CREATE POLICY "진도 카테고리 생성" ON "public"."progress_categories" FOR INSERT WITH CHECK ("public"."has_permission"("center_id", 'customer.progress'::"text"));



CREATE POLICY "진도 카테고리 수정" ON "public"."progress_categories" FOR UPDATE USING ("public"."has_permission"("center_id", 'customer.progress'::"text")) WITH CHECK ("public"."has_permission"("center_id", 'customer.progress'::"text"));



CREATE POLICY "진도 카테고리 조회" ON "public"."progress_categories" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "public"."center_rows_visible"("center_id")));



CREATE POLICY "포인트 조회" ON "public"."point_accounts" FOR SELECT USING ((("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")) OR ("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "포인트 조회" ON "public"."point_transactions" FOR SELECT USING ((("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR ("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids"))));



CREATE POLICY "포인트내역 조회" ON "public"."point_logs" FOR SELECT USING ((("profile_id" IN ( SELECT "public"."my_profile_ids"() AS "my_profile_ids")) OR ("center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids")) OR "public"."is_platform_admin"()));



CREATE POLICY "푸시 구독 본인 등록" ON "public"."push_subscriptions" FOR INSERT WITH CHECK (("account_id" = "public"."my_account_id"()));



CREATE POLICY "푸시 구독 본인 삭제" ON "public"."push_subscriptions" FOR DELETE USING (("account_id" = "public"."my_account_id"()));



CREATE POLICY "푸시 구독 본인 조회" ON "public"."push_subscriptions" FOR SELECT USING (("account_id" = "public"."my_account_id"()));



CREATE POLICY "프로필 생성" ON "public"."profiles" FOR INSERT WITH CHECK (("account_id" = "public"."my_account_id"()));



CREATE POLICY "횟수 가격표 조회" ON "public"."product_count_prices" FOR SELECT USING (("public"."is_platform_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."products" "p"
  WHERE (("p"."id" = "product_count_prices"."product_id") AND ("p"."center_id" IN ( SELECT "public"."my_managed_center_ids"() AS "my_managed_center_ids"))))) OR (EXISTS ( SELECT 1
   FROM ( SELECT "public"."my_profile_ids"() AS "pid") "me"
  WHERE "public"."member_can_purchase_product"("product_count_prices"."product_id", "me"."pid")))));



CREATE POLICY "후기신고 본인 생성" ON "public"."review_reports" FOR INSERT WITH CHECK (("reporter_account_id" = "public"."my_account_id"()));



CREATE POLICY "후기신고 운영자 상태변경" ON "public"."review_reports" FOR UPDATE USING ("public"."is_platform_admin"()) WITH CHECK ("public"."is_platform_admin"());



CREATE POLICY "후기신고 운영자 조회" ON "public"."review_reports" FOR SELECT USING ("public"."is_platform_admin"());



REVOKE USAGE ON SCHEMA "public" FROM PUBLIC;
GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT ALL ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."_account_id_for_auth"("p_auth_uid" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."_auto_book_membership_core"("p_membership_id" "uuid", "p_dry_run" boolean) FROM PUBLIC;



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."orders" TO "service_role";



REVOKE ALL ON FUNCTION "public"."_issue_membership_and_record_payment"("p_order" "public"."orders", "p_provider_ref" "text", "p_memo" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."_order_auto_book"("p_membership_id" "uuid", "p_requested" boolean) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."_order_expected_amount"("p_order" "public"."orders", "p_lock" boolean) FROM PUBLIC;



GRANT ALL ON TABLE "public"."memberships" TO "anon";
GRANT ALL ON TABLE "public"."memberships" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."memberships" TO "service_role";



REVOKE ALL ON FUNCTION "public"."_refund_block_reason"("p_mem" "public"."memberships", "p_skip_time" boolean) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."_refund_membership_core"("p_membership_id" "uuid", "p_account_id" "uuid", "p_allow_pg" boolean, "p_skip_time_check" boolean) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."_restore_order_points"("p_order_id" "uuid", "p_reason" "text") FROM PUBLIC;



GRANT ALL ON FUNCTION "public"."admin_center_settlement_summary"("p_start" "date", "p_end" "date") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_list_centers"("p_status" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_list_centers"("p_status" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_list_centers_page"("p_status" "text", "p_keyword" "text", "p_limit" integer, "p_before_created_at" timestamp with time zone, "p_before_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_list_centers_page"("p_status" "text", "p_keyword" "text", "p_limit" integer, "p_before_created_at" timestamp with time zone, "p_before_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."auto_book_membership"("p_membership_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."auto_book_membership"("p_membership_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."can_write_class"("p_class_id" "uuid", "p_center_id" "uuid", "p_class_format" "text", "p_start_time" timestamp with time zone, "p_action" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."cancel_real_payment"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_real_payment"("p_order_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cancel_reservation"("p_reservation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_reservation"("p_reservation_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."center_is_pending"("p_center_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."center_is_pending"("p_center_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."center_is_pending"("p_center_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."center_rows_visible"("p_center_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."center_rows_visible"("p_center_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."center_rows_visible"("p_center_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."center_rows_visible"("p_center_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."class_rows_visible"("p_class_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."class_rows_visible"("p_class_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."class_rows_visible"("p_class_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."class_rows_visible"("p_class_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."class_trainer_names"("p_class_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."class_trainer_names"("p_class_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."confirm_real_payment"("p_order_id" "uuid", "p_payment_key" "text", "p_amount" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_real_payment"("p_order_id" "uuid", "p_payment_key" "text", "p_amount" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."confirm_test_payment"("p_order_id" "uuid", "p_provider_ref" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_test_payment"("p_order_id" "uuid", "p_provider_ref" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."confirm_test_payment"("p_order_id" "uuid", "p_provider_ref" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."consume_email_check_attempt"("p_ip_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_email_check_attempt"("p_ip_hash" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_default_center_roles"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_default_center_roles"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_marketing_message_safe"("p_title" "text", "p_body" "text", "p_link" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_marketing_message_safe"("p_title" "text", "p_body" "text", "p_link" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_order_secure"("p_product_id" "uuid", "p_pay_method" "text", "p_selected_size" "text", "p_point_used" integer, "p_auto_book" boolean, "p_provider" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_order_secure"("p_product_id" "uuid", "p_pay_method" "text", "p_selected_size" "text", "p_point_used" integer, "p_auto_book" boolean, "p_provider" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_phone_verification"("p_phone" "text", "p_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_phone_verification"("p_phone" "text", "p_code" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_test_center_cascade"("p_center_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_test_center_cascade"("p_center_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."email_signup_available"("p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."email_signup_available"("p_email" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."extend_passes_after_dormant"("p_center_member_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."extend_passes_after_dormant"("p_center_member_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."extend_passes_after_dormant"("p_center_member_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."fetch_public_product_schedule_rules"("p_center_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fetch_public_product_schedule_rules"("p_center_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."fetch_public_product_schedule_rules"("p_center_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."fetch_public_storefront_products"("p_center_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fetch_public_storefront_products"("p_center_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."fetch_public_storefront_products"("p_center_id" "uuid") TO "authenticated";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."products" TO "service_role";



REVOKE ALL ON FUNCTION "public"."fetch_purchasable_products"("p_center_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fetch_purchasable_products"("p_center_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fetch_purchasable_products"("p_center_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."filter_eligible_class_ids"("p_membership_ids" "uuid"[], "p_class_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."filter_eligible_class_ids"("p_membership_ids" "uuid"[], "p_class_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."fulfill_order"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fulfill_order"("p_order_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."has_permission"("p_center_id" "uuid", "p_permission" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."has_permission"("p_center_id" "uuid", "p_permission" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."is_membership_eligible_for_class"("p_membership_id" "uuid", "p_class_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_membership_eligible_for_class"("p_membership_id" "uuid", "p_class_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_membership_eligible_for_class"("p_membership_id" "uuid", "p_class_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."kr_phone_digits"("p" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."manager_centers_has_any_row"("p_center_id" "uuid", "p_exclude_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."manager_centers_has_any_row"("p_center_id" "uuid", "p_exclude_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."manager_centers_has_any_row"("p_center_id" "uuid", "p_exclude_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."manager_centers_is_last_active_owner"("p_center_id" "uuid", "p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."manager_centers_is_last_active_owner"("p_center_id" "uuid", "p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."manager_centers_is_last_active_owner"("p_center_id" "uuid", "p_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."manager_centers_protect_last_owner"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."manager_extend_membership_expiry"("p_membership_id" "uuid", "p_mode" "text", "p_days" integer, "p_new_expires_at" "date", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."manager_extend_membership_expiry"("p_membership_id" "uuid", "p_mode" "text", "p_days" integer, "p_new_expires_at" "date", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."manager_extend_membership_expiry"("p_membership_id" "uuid", "p_mode" "text", "p_days" integer, "p_new_expires_at" "date", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."manager_grant_product"("p_center_id" "uuid", "p_profile_id" "uuid", "p_product_id" "uuid", "p_price" integer, "p_pay_method" "text", "p_memo" "text", "p_paid_at" timestamp with time zone, "p_trainer_account_id" "uuid", "p_bound_day_of_week" integer, "p_bound_start_time" time without time zone, "p_selected_size" "text", "p_selected_count" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."manager_grant_product"("p_center_id" "uuid", "p_profile_id" "uuid", "p_product_id" "uuid", "p_price" integer, "p_pay_method" "text", "p_memo" "text", "p_paid_at" timestamp with time zone, "p_trainer_account_id" "uuid", "p_bound_day_of_week" integer, "p_bound_start_time" time without time zone, "p_selected_size" "text", "p_selected_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."manager_grant_product"("p_center_id" "uuid", "p_profile_id" "uuid", "p_product_id" "uuid", "p_price" integer, "p_pay_method" "text", "p_memo" "text", "p_paid_at" timestamp with time zone, "p_trainer_account_id" "uuid", "p_bound_day_of_week" integer, "p_bound_start_time" time without time zone, "p_selected_size" "text", "p_selected_count" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."manager_set_attendance"("p_reservation_id" "uuid", "p_status" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."manager_set_attendance"("p_reservation_id" "uuid", "p_status" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."memberships_guard_expiry_update"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."memberships_guard_pg_refund"() FROM PUBLIC;



GRANT ALL ON FUNCTION "public"."my_account_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."my_account_id"() TO "authenticated";



GRANT ALL ON FUNCTION "public"."my_managed_center_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."my_managed_center_ids"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."my_member_center_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_member_center_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."my_member_center_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."my_member_center_ids"() TO "service_role";



GRANT ALL ON FUNCTION "public"."my_profile_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."my_profile_ids"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."notify_refund_completed_managers"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."orders_force_server_fields_on_insert"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."orders_guard_snapshot_update"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."orders_guard_status_transition"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."orders_require_schedule_selection"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."orders_restore_points_on_cancel"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."orders_snapshot_product_amount"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."pg_order_context"("p_order_id" "uuid", "p_auth_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pg_order_context"("p_order_id" "uuid", "p_auth_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."pg_refund_begin"("p_membership_id" "uuid", "p_auth_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pg_refund_begin"("p_membership_id" "uuid", "p_auth_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."pg_refund_context"("p_membership_id" "uuid", "p_auth_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pg_refund_context"("p_membership_id" "uuid", "p_auth_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."pg_refund_release"("p_membership_id" "uuid", "p_auth_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pg_refund_release"("p_membership_id" "uuid", "p_auth_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."product_rows_visible"("p_product_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."product_rows_visible"("p_product_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."product_rows_visible"("p_product_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."product_rows_visible"("p_product_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."progress_categories_guard_tree"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."progress_records_guard_skill"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."push_notification"("p_recipient" "uuid", "p_kind" "text", "p_title" "text", "p_body" "text", "p_center" "uuid", "p_link" "text", "p_data" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."refund_membership"("p_membership_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refund_membership"("p_membership_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."refund_membership_server"("p_membership_id" "uuid", "p_auth_uid" "uuid", "p_allow_pg" boolean, "p_skip_time_check" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refund_membership_server"("p_membership_id" "uuid", "p_auth_uid" "uuid", "p_allow_pg" boolean, "p_skip_time_check" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reservations_guard_pg_refund_lock"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."reserve_class"("p_class_id" "uuid", "p_profile_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_class"("p_class_id" "uuid", "p_profile_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."reserve_with_goods"("p_class_id" "uuid", "p_profile_id" "uuid", "p_membership_id" "uuid", "p_goods_membership_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_with_goods"("p_class_id" "uuid", "p_profile_id" "uuid", "p_membership_id" "uuid", "p_goods_membership_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reserve_with_goods"("p_class_id" "uuid", "p_profile_id" "uuid", "p_membership_id" "uuid", "p_goods_membership_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reserve_with_membership"("p_class_id" "uuid", "p_profile_id" "uuid", "p_membership_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_with_membership"("p_class_id" "uuid", "p_profile_id" "uuid", "p_membership_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."retry_auto_book_membership_safe"("p_membership_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."retry_auto_book_membership_safe"("p_membership_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."role_id_belongs_to_center"("p_role_id" "uuid", "p_center_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."role_id_belongs_to_center"("p_role_id" "uuid", "p_center_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."role_id_belongs_to_center"("p_role_id" "uuid", "p_center_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."role_id_is_owner_for_center"("p_role_id" "uuid", "p_center_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."role_id_is_owner_for_center"("p_role_id" "uuid", "p_center_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."role_id_is_owner_for_center"("p_role_id" "uuid", "p_center_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."run_autocancel_sweep"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."run_autocancel_sweep"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."search_accounts_for_member"("p_keyword" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."search_member_candidates"("p_center_id" "uuid", "p_keyword" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_member_candidates"("p_center_id" "uuid", "p_keyword" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."search_staff_candidates"("p_center_id" "uuid", "p_phone" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_staff_candidates"("p_center_id" "uuid", "p_phone" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_class_trainers_bulk_safe"("p_class_ids" "uuid"[], "p_account_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_class_trainers_bulk_safe"("p_class_ids" "uuid"[], "p_account_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_class_trainers_bulk_safe"("p_class_ids" "uuid"[], "p_account_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_class_trainers_for_group_safe"("p_class_ids" "uuid"[], "p_account_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_class_trainers_for_group_safe"("p_class_ids" "uuid"[], "p_account_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_class_trainers_for_group_safe"("p_class_ids" "uuid"[], "p_account_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_class_trainers_safe"("p_class_id" "uuid", "p_account_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_class_trainers_safe"("p_class_id" "uuid", "p_account_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_class_trainers_safe"("p_class_id" "uuid", "p_account_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_membership_session_amounts"("p_membership_id" "uuid", "p_amounts" integer[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_membership_session_amounts"("p_membership_id" "uuid", "p_amounts" integer[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_product_count_prices"("p_product_id" "uuid", "p_tiers" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_product_count_prices"("p_product_id" "uuid", "p_tiers" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_product_count_prices"("p_product_id" "uuid", "p_tiers" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."toggle_product_sale_safe"("p_product_id" "uuid", "p_on_sale" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."toggle_product_sale_safe"("p_product_id" "uuid", "p_on_sale" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."trg_reservation_goods_restore_on_delete"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."trg_reservation_goods_sync"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."unplaced_weekday_passes"("p_center_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."unplaced_weekday_passes"("p_center_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unplaced_weekday_passes"("p_center_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_class_group_safe"("p_group_id" "uuid", "p_title" "text", "p_capacity" integer, "p_updates" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_class_group_safe"("p_group_id" "uuid", "p_title" "text", "p_capacity" integer, "p_updates" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_class_group_safe"("p_group_id" "uuid", "p_title" "text", "p_capacity" integer, "p_updates" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."usable_memberships"("p_class_id" "uuid", "p_profile_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."usable_memberships"("p_class_id" "uuid", "p_profile_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."usable_memberships_for_classes"("p_class_ids" "uuid"[], "p_profile_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."usable_memberships_for_classes"("p_class_ids" "uuid"[], "p_profile_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."use_points"("p_center_id" "uuid", "p_profile_id" "uuid", "p_amount" integer, "p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."use_points"("p_center_id" "uuid", "p_profile_id" "uuid", "p_amount" integer, "p_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."use_points"("p_center_id" "uuid", "p_profile_id" "uuid", "p_amount" integer, "p_order_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_product_schedule_selection"("p_product_id" "uuid", "p_day" integer, "p_time" time without time zone) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."verify_phone_otp"("p_phone" "text", "p_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."verify_phone_otp"("p_phone" "text", "p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."verify_phone_otp"("p_phone" "text", "p_code" "text") TO "authenticated";



GRANT ALL ON TABLE "public"."account_auth_identities" TO "anon";
GRANT ALL ON TABLE "public"."account_auth_identities" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."account_auth_identities" TO "service_role";



GRANT ALL ON TABLE "public"."account_center_permissions" TO "anon";
GRANT ALL ON TABLE "public"."account_center_permissions" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."account_center_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."account_link_requests" TO "anon";
GRANT ALL ON TABLE "public"."account_link_requests" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."account_link_requests" TO "service_role";



GRANT ALL ON TABLE "public"."accounts" TO "anon";
GRANT ALL ON TABLE "public"."accounts" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."accounts" TO "service_role";



GRANT ALL ON TABLE "public"."admin_action_logs" TO "anon";
GRANT ALL ON TABLE "public"."admin_action_logs" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."admin_action_logs" TO "service_role";



GRANT ALL ON TABLE "public"."alimtalk_templates" TO "anon";
GRANT ALL ON TABLE "public"."alimtalk_templates" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."alimtalk_templates" TO "service_role";



GRANT ALL ON TABLE "public"."cart_items" TO "anon";
GRANT ALL ON TABLE "public"."cart_items" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."cart_items" TO "service_role";



GRANT ALL ON TABLE "public"."center_announcements" TO "anon";
GRANT ALL ON TABLE "public"."center_announcements" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."center_announcements" TO "service_role";



GRANT ALL ON TABLE "public"."center_contacts" TO "anon";
GRANT ALL ON TABLE "public"."center_contacts" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."center_contacts" TO "service_role";



GRANT ALL ON TABLE "public"."center_holidays" TO "anon";
GRANT ALL ON TABLE "public"."center_holidays" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."center_holidays" TO "service_role";



GRANT ALL ON TABLE "public"."center_member_fields" TO "anon";
GRANT ALL ON TABLE "public"."center_member_fields" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."center_member_fields" TO "service_role";



GRANT ALL ON TABLE "public"."center_members" TO "anon";
GRANT ALL ON TABLE "public"."center_members" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."center_members" TO "service_role";



GRANT ALL ON TABLE "public"."center_payout_accounts" TO "anon";
GRANT ALL ON TABLE "public"."center_payout_accounts" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."center_payout_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."center_reviews" TO "anon";
GRANT ALL ON TABLE "public"."center_reviews" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."center_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."center_roles" TO "anon";
GRANT ALL ON TABLE "public"."center_roles" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."center_roles" TO "service_role";



GRANT ALL ON TABLE "public"."center_settings" TO "anon";
GRANT ALL ON TABLE "public"."center_settings" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."center_settings" TO "service_role";



GRANT ALL ON TABLE "public"."center_settlement_accounts" TO "anon";
GRANT ALL ON TABLE "public"."center_settlement_accounts" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."center_settlement_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."center_subscription_charges" TO "anon";
GRANT ALL ON TABLE "public"."center_subscription_charges" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."center_subscription_charges" TO "service_role";



GRANT ALL ON TABLE "public"."center_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."center_subscriptions" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."center_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."centers" TO "anon";
GRANT ALL ON TABLE "public"."centers" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."centers" TO "service_role";



GRANT ALL ON TABLE "public"."change_logs" TO "anon";
GRANT ALL ON TABLE "public"."change_logs" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."change_logs" TO "service_role";



GRANT ALL ON TABLE "public"."chat_messages" TO "anon";
GRANT ALL ON TABLE "public"."chat_messages" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."chat_messages" TO "service_role";



GRANT ALL ON TABLE "public"."class_allowed_products" TO "anon";
GRANT ALL ON TABLE "public"."class_allowed_products" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."class_allowed_products" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reservations" TO "authenticated";
GRANT MAINTAIN ON TABLE "public"."reservations" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."reservations" TO "service_role";



GRANT UPDATE("member_memo") ON TABLE "public"."reservations" TO "authenticated";



GRANT ALL ON TABLE "public"."class_reservation_counts" TO "anon";
GRANT ALL ON TABLE "public"."class_reservation_counts" TO "authenticated";
GRANT SELECT ON TABLE "public"."class_reservation_counts" TO "service_role";



GRANT ALL ON TABLE "public"."class_trainers" TO "anon";
GRANT ALL ON TABLE "public"."class_trainers" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."class_trainers" TO "service_role";



GRANT ALL ON TABLE "public"."class_types" TO "anon";
GRANT ALL ON TABLE "public"."class_types" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."class_types" TO "service_role";



GRANT ALL ON TABLE "public"."classes" TO "anon";
GRANT ALL ON TABLE "public"."classes" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."classes" TO "service_role";



GRANT ALL ON TABLE "public"."community_comments" TO "anon";
GRANT ALL ON TABLE "public"."community_comments" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."community_comments" TO "service_role";



GRANT ALL ON TABLE "public"."community_posts" TO "anon";
GRANT ALL ON TABLE "public"."community_posts" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."community_posts" TO "service_role";



GRANT ALL ON TABLE "public"."competitions" TO "anon";
GRANT ALL ON TABLE "public"."competitions" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."competitions" TO "service_role";



GRANT ALL ON TABLE "public"."contract_templates" TO "anon";
GRANT ALL ON TABLE "public"."contract_templates" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."contract_templates" TO "service_role";



GRANT ALL ON TABLE "public"."contracts" TO "anon";
GRANT ALL ON TABLE "public"."contracts" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."contracts" TO "service_role";



GRANT ALL ON TABLE "public"."coupon_products" TO "anon";
GRANT ALL ON TABLE "public"."coupon_products" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."coupon_products" TO "service_role";



GRANT ALL ON TABLE "public"."coupons" TO "anon";
GRANT ALL ON TABLE "public"."coupons" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."coupons" TO "service_role";



GRANT ALL ON TABLE "public"."email_check_attempts" TO "anon";
GRANT ALL ON TABLE "public"."email_check_attempts" TO "authenticated";
GRANT SELECT,INSERT ON TABLE "public"."email_check_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."expenses" TO "anon";
GRANT ALL ON TABLE "public"."expenses" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."expenses" TO "service_role";



GRANT ALL ON TABLE "public"."home_banners" TO "anon";
GRANT ALL ON TABLE "public"."home_banners" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."home_banners" TO "service_role";



GRANT ALL ON TABLE "public"."inquiry_messages" TO "anon";
GRANT ALL ON TABLE "public"."inquiry_messages" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."inquiry_messages" TO "service_role";



GRANT ALL ON TABLE "public"."inquiry_threads" TO "anon";
GRANT ALL ON TABLE "public"."inquiry_threads" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."inquiry_threads" TO "service_role";



GRANT ALL ON TABLE "public"."leads" TO "anon";
GRANT ALL ON TABLE "public"."leads" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."leads" TO "service_role";



GRANT ALL ON TABLE "public"."locker_assignments" TO "anon";
GRANT ALL ON TABLE "public"."locker_assignments" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."locker_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."lockers" TO "anon";
GRANT ALL ON TABLE "public"."lockers" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."lockers" TO "service_role";



GRANT ALL ON TABLE "public"."manager_centers" TO "anon";
GRANT ALL ON TABLE "public"."manager_centers" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."manager_centers" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_messages" TO "anon";
GRANT ALL ON TABLE "public"."marketing_messages" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."marketing_messages" TO "service_role";



GRANT ALL ON TABLE "public"."member_center_colors" TO "anon";
GRANT ALL ON TABLE "public"."member_center_colors" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."member_center_colors" TO "service_role";



GRANT ALL ON TABLE "public"."member_coupons" TO "anon";
GRANT ALL ON TABLE "public"."member_coupons" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."member_coupons" TO "service_role";



GRANT ALL ON TABLE "public"."member_grades" TO "anon";
GRANT ALL ON TABLE "public"."member_grades" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."member_grades" TO "service_role";



GRANT ALL ON TABLE "public"."member_memos" TO "anon";
GRANT ALL ON TABLE "public"."member_memos" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."member_memos" TO "service_role";



GRANT ALL ON TABLE "public"."membership_product_grades" TO "anon";
GRANT ALL ON TABLE "public"."membership_product_grades" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."membership_product_grades" TO "service_role";



GRANT ALL ON TABLE "public"."membership_product_members" TO "anon";
GRANT ALL ON TABLE "public"."membership_product_members" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."membership_product_members" TO "service_role";



GRANT ALL ON TABLE "public"."membership_schedule_rules" TO "anon";
GRANT ALL ON TABLE "public"."membership_schedule_rules" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."membership_schedule_rules" TO "service_role";



GRANT ALL ON TABLE "public"."membership_session_amounts" TO "anon";
GRANT ALL ON TABLE "public"."membership_session_amounts" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."membership_session_amounts" TO "service_role";



GRANT ALL ON TABLE "public"."membership_transfers" TO "anon";
GRANT ALL ON TABLE "public"."membership_transfers" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."membership_transfers" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT DELETE ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."native_push_tokens" TO "anon";
GRANT ALL ON TABLE "public"."native_push_tokens" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."native_push_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."notification_logs" TO "anon";
GRANT ALL ON TABLE "public"."notification_logs" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."notification_logs" TO "service_role";



GRANT ALL ON TABLE "public"."notification_rules" TO "anon";
GRANT ALL ON TABLE "public"."notification_rules" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."notification_rules" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."permissions" TO "anon";
GRANT ALL ON TABLE "public"."permissions" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."permissions" TO "service_role";



GRANT ALL ON TABLE "public"."phone_verifications" TO "anon";
GRANT ALL ON TABLE "public"."phone_verifications" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."phone_verifications" TO "service_role";



GRANT ALL ON TABLE "public"."point_accounts" TO "anon";
GRANT ALL ON TABLE "public"."point_accounts" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."point_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."point_logs" TO "anon";
GRANT ALL ON TABLE "public"."point_logs" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."point_logs" TO "service_role";



GRANT ALL ON TABLE "public"."point_transactions" TO "anon";
GRANT ALL ON TABLE "public"."point_transactions" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."point_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."popup_notices" TO "anon";
GRANT ALL ON TABLE "public"."popup_notices" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."popup_notices" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."product_count_prices" TO "authenticated";
GRANT ALL ON TABLE "public"."product_count_prices" TO "service_role";



GRANT ALL ON TABLE "public"."product_passes" TO "anon";
GRANT ALL ON TABLE "public"."product_passes" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."product_passes" TO "service_role";



GRANT ALL ON TABLE "public"."product_sale_counts" TO "anon";
GRANT ALL ON TABLE "public"."product_sale_counts" TO "authenticated";
GRANT SELECT ON TABLE "public"."product_sale_counts" TO "service_role";



GRANT ALL ON TABLE "public"."profile_center_fields" TO "anon";
GRANT ALL ON TABLE "public"."profile_center_fields" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."profile_center_fields" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."progress_categories" TO "anon";
GRANT ALL ON TABLE "public"."progress_categories" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."progress_categories" TO "service_role";



GRANT ALL ON TABLE "public"."progress_records" TO "anon";
GRANT ALL ON TABLE "public"."progress_records" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."progress_records" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_requests" TO "anon";
GRANT ALL ON TABLE "public"."purchase_requests" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."purchase_requests" TO "service_role";



GRANT ALL ON TABLE "public"."push_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."push_subscriptions" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."push_subscriptions" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reservation_goods_usages" TO "authenticated";
GRANT ALL ON TABLE "public"."reservation_goods_usages" TO "service_role";



GRANT SELECT ON TABLE "public"."revenue_summary" TO "service_role";



GRANT ALL ON TABLE "public"."review_reports" TO "anon";
GRANT ALL ON TABLE "public"."review_reports" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."review_reports" TO "service_role";



GRANT ALL ON TABLE "public"."reviews" TO "anon";
GRANT ALL ON TABLE "public"."reviews" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."reviews" TO "service_role";



GRANT ALL ON TABLE "public"."role_permissions" TO "anon";
GRANT ALL ON TABLE "public"."role_permissions" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."role_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."rooms" TO "anon";
GRANT ALL ON TABLE "public"."rooms" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."rooms" TO "service_role";



GRANT ALL ON TABLE "public"."schedule_memos" TO "anon";
GRANT ALL ON TABLE "public"."schedule_memos" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."schedule_memos" TO "service_role";



GRANT ALL ON TABLE "public"."schedule_templates" TO "anon";
GRANT ALL ON TABLE "public"."schedule_templates" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."schedule_templates" TO "service_role";



GRANT ALL ON TABLE "public"."service_categories" TO "anon";
GRANT ALL ON TABLE "public"."service_categories" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."service_categories" TO "service_role";



GRANT ALL ON TABLE "public"."staff_salaries" TO "anon";
GRANT ALL ON TABLE "public"."staff_salaries" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."staff_salaries" TO "service_role";



GRANT ALL ON TABLE "public"."staff_schedules" TO "anon";
GRANT ALL ON TABLE "public"."staff_schedules" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."staff_schedules" TO "service_role";



GRANT ALL ON TABLE "public"."subscription_plans" TO "anon";
GRANT ALL ON TABLE "public"."subscription_plans" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."subscription_plans" TO "service_role";



GRANT ALL ON TABLE "public"."terms" TO "anon";
GRANT ALL ON TABLE "public"."terms" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."terms" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "service_role";







