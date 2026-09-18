-- ============================================================
-- 수강권/상품별 "쿠폰 적용 불가" 옵션(2026-09-19)
-- ============================================================
-- 배경: 지금까지의 쿠폰 시스템(add_membership_visibility_and_coupons.sql)은 "이 쿠폰이
-- 어떤 상품에 적용되는지"를 쿠폰 쪽(coupons.applies_to/coupon_products)에서만 정했다.
-- 이 마이그레이션은 반대 방향 — "이 상품에는 어떤 쿠폰도 절대 적용 안 됨"을 상품 자체에
-- 거는 옵션을 추가한다(매니저가 수강권/상품을 만들거나 수정할 때 설정). 쿠폰 쪽
-- applies_to='all'이어도, 이 상품이 coupon_eligible=false면 그 어떤 쿠폰도 못 쓴다 —
-- 상품의 이 설정이 쿠폰 설정보다 항상 우선한다(더 강한 제약이 이긴다).
--
-- 기존 상품은 전부 기본값 true(기존과 동일하게 쿠폰 적용 가능) — 마이그레이션 후 갑자기
-- 쿠폰을 못 쓰게 되는 회귀가 없도록 한다(요청 원칙과 동일한 안전 기본값 패턴).
--
-- 서버 강제: _issue_membership_and_record_payment()에서 member_coupon_id가 있는 주문을
-- 확정하기 직전에 상품의 coupon_eligible을 재확인한다 — 클라이언트가 이 값을 몰랐거나
-- 무시하고 쿠폰을 골라 보내도(직접 API 호출 포함) 서버가 차단한다("UI에서만 숨기는 방식
-- 금지" 원칙 그대로 재사용).
--
-- 이 SQL은 Claude Code 세션에서 직접 실행되지 않았다 — 이 저장소에는 Supabase에 직접
-- SQL을 실행할 수 있는 수단(DATABASE_URL/직접 DB 연결)이 없으며, 실행 여부는 반드시
-- 사용자가 Supabase SQL Editor에서 직접 확인 후 실행해야 한다(CLAUDE.md 규칙 3/4).
-- ============================================================

alter table products add column if not exists coupon_eligible boolean not null default true;

comment on column products.coupon_eligible is
    '이 상품에 쿠폰을 적용할 수 있는지. false면 어떤 쿠폰 정의(coupons.applies_to)로도 '
    '이 상품에는 쿠폰을 쓸 수 없다 — 쿠폰 쪽 설정보다 이 값이 항상 우선한다. '
    '기본값 true(기존 상품 전부 기존과 동일하게 쿠폰 적용 가능, 회귀 없음).';

-- ============================================================
-- 결제 확정 재검증에 coupon_eligible 체크 추가. 함수 본문 자체는
-- add_membership_visibility_and_coupons.sql의 최신본을 그대로 가져오고, member_coupon_id
-- 처리 블록 맨 앞에 이 상품이 coupon_eligible=false면 즉시 차단하는 검사만 추가한다
-- (나머지 로직 — 소유자/센터/유효기간/최소금액/적용대상/할인계산 — 전혀 안 바꿈).
-- ============================================================
create or replace function _issue_membership_and_record_payment(p_order orders, p_provider_ref text, p_memo text)
returns json
language plpgsql
security definer
as $$
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
$$;

-- ============================================================
-- 확인(read-only) — Supabase SQL Editor에서 실행해 적용 여부 확인
-- ============================================================
-- select column_name, column_default from information_schema.columns
--  where table_name='products' and column_name='coupon_eligible';
-- select pg_get_functiondef(oid) like '%coupon_eligible%' as has_fix
--  from pg_proc where proname = '_issue_membership_and_record_payment';
