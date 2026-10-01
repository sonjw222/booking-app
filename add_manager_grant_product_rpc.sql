-- ============================================================
-- 관리자 회원 상세 "수강권/상품 지급"을 서버 원자 RPC로 통일 (2026-10-01)
--
-- [감사 결과 — 기존 lib/sales.ts grantProductToMember()]
--   · 클라이언트가 memberships INSERT → payments INSERT를 순서대로 따로 호출하는 2단계 구조.
--     payments가 실패하면 클라이언트가 memberships를 DELETE로 "수동 롤백"했다(RLS가 DELETE를 막거나
--     네트워크가 끊기면 결제 기록 없는 수강권/상품이 무상으로 남을 수 있음).
--   · 상품 사이즈(orders.selected_size에 해당하는 값)를 저장하지 않았다 → 대여화 사이즈 유실.
--   · goods인데도 payments.revenue_category가 항상 'membership'.
--   · rolling_month 만료 설정을 반영하지 않았다(fulfill_order와 불일치).
--   · 판매수량 제한은 memberships의 trg_enforce_product_sale_limit(INSERT)가 이미 모든 경로에 적용 —
--     이 RPC도 같은 INSERT를 쓰므로 그대로 재사용하고, 사전 점검으로 더 명확한 메시지를 준다.
--   · 권한: memberships INSERT RLS = customer.member.issue_pass, payments INSERT RLS = pass.payment.create.
--     상품(goods) 전용 지급 권한은 아직 없어(pass.goods.view는 카탈로그 조회용) 두 권한을 그대로 함께 요구한다.
--
-- [이 RPC] manager_grant_product():
--   · 권한(issue_pass AND pass.payment.create, 또는 플랫폼 관리자) + 같은 센터 회원 + 같은 센터 활성 상품 검증을
--     서버에서 한다(다른 센터 회원/상품 불가).
--   · memberships + payments를 한 함수(=한 트랜잭션)에서 만든다 → 반쪽 데이터 없음.
--   · 상품 정의대로 지급: total_count/remaining_count(무제한이면 null), 만료 설정(none/days/date/rolling_month).
--   · 상품에 sizes가 있으면 p_selected_size 필수(목록 안의 값만) → memberships.selected_size에 저장
--     (add_reservation_goods_usage.sql / fix_order_issuance_and_auto_booking.sql이 쓰는 같은 컬럼 재사용).
--   · 수강권 중 weekday_selectable이면 요일(+time_selectable이면 시간) 필수 → bound_day_of_week/bound_start_time.
--   · goods: 자동예약 없음. pass: 기존처럼 자동예약 없음(관리자 지급은 원래 자동예약을 실행하지 않음).
--   · payments.revenue_category: goods → 'etc'(기존 CHECK에 있는 값 — 새 값 만들지 않음), pass → 'membership'.
--     (revenue_category를 집계에 쓰는 앱 코드/함수는 없다: 읽는 곳은 refund/unpaid 복사뿐.)
--   · 가격 0원 = sale_type 'service'(무상 지급, 매출 0원), 가격>0은 card/cash/transfer(센터가 직접 받은 금액 기록 —
--     Toss 온라인 PG를 실행하지 않는다).
--   · 지급자 기록: payments에 granted_by 컬럼이 없어, 새 테이블 없이 memo 앞에 "[관리자 지급 · 이름]"을 붙인다.
--
-- 선행: fix_order_issuance_and_auto_booking.sql(memberships.selected_size 컬럼). 여러 번 실행해도 안전.
-- 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================

alter table memberships add column if not exists selected_size text;

create or replace function manager_grant_product(
    p_center_id uuid,
    p_profile_id uuid,
    p_product_id uuid,
    p_price integer,
    p_pay_method text,
    p_memo text default null,
    p_paid_at timestamptz default null,
    p_trainer_account_id uuid default null,
    p_bound_day_of_week integer default null,
    p_bound_start_time time default null,
    p_selected_size text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_product     products;
    v_is_goods    boolean;
    v_unlimited   boolean;
    v_count       int;
    v_expires     date;
    v_starts      date := current_date;
    v_rm          record;
    v_size        text;
    v_bound_dow   int;
    v_bound_time  time;
    v_sold        int;
    v_granter     text;
    v_memo        text;
    v_membership_id uuid;
    v_payment_id    uuid;
begin
    if not (
        (has_permission(p_center_id, 'customer.member.issue_pass') and has_permission(p_center_id, 'pass.payment.create'))
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

    -- 같은 센터 회원에게만 지급(다른 센터 회원 불가)
    if not exists (
        select 1 from center_members cm
        where cm.center_id = p_center_id and cm.profile_id = p_profile_id
    ) then
        raise exception '이 센터의 회원이 아니에요';
    end if;

    -- 같은 센터 상품만. 행을 잠가 동시 지급의 판매수량 확인을 직렬화한다.
    select * into v_product from products
     where id = p_product_id and center_id = p_center_id
     for update;
    if not found then
        raise exception '이 센터의 상품이 아니에요';
    end if;
    if not coalesce(v_product.is_active, false) then
        raise exception '삭제되었거나 비활성화된 상품이에요';
    end if;
    -- 관리자 직접 지급은 판매중지(is_on_sale=false) 상품도 허용한다(보상/서비스 목적).

    v_is_goods := v_product.product_kind = 'goods';

    -- 사이즈: 상품에 sizes가 정의돼 있으면 필수 + 목록 안의 값만
    if v_product.sizes is not null and coalesce(array_length(v_product.sizes, 1), 0) > 0 then
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

    -- 요일/시간 선택형 수강권(goods에는 해당 없음)
    if not v_is_goods and coalesce(v_product.weekday_selectable, false) then
        if p_bound_day_of_week is null or p_bound_day_of_week < 0 or p_bound_day_of_week > 6 then
            raise exception '이용 요일을 선택해주세요';
        end if;
        v_bound_dow := p_bound_day_of_week;
        if coalesce(v_product.time_selectable, false) then
            if p_bound_start_time is null then
                raise exception '이용 시간을 선택해주세요';
            end if;
            v_bound_time := p_bound_start_time;
        end if;
    end if;

    -- 판매수량 제한(trg_enforce_product_sale_limit와 같은 기준 — 여기선 더 명확한 메시지)
    if v_product.max_quantity is not null then
        select count(*) into v_sold from memberships
         where product_id = v_product.id and status <> 'refunded';
        if v_sold >= v_product.max_quantity then
            raise exception '지급 가능한 수량이 없어요(판매 수량이 모두 소진됐어요)';
        end if;
    end if;

    -- 횟수/만료는 상품 정의 그대로
    v_unlimited := case when v_is_goods then coalesce(v_product.unlimited, false) else coalesce(v_product.unlimited_pass, false) end;
    v_count := case when v_unlimited then null else v_product.total_count end;
    if v_product.expiry_mode = 'rolling_month' then
        select * into v_rm from calc_rolling_month_dates(now(), v_product.rolling_month_cutoff_day);
        v_expires := v_rm.expires_at;
        if not coalesce(v_product.rolling_month_allow_early_use, false) then
            v_starts := v_rm.starts_at;
        end if;
    elsif v_product.expiry_mode = 'date' then
        v_expires := v_product.expiry_date;
    elsif v_product.expiry_mode = 'days' then
        v_expires := (now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval)::date;
    else
        v_expires := null;
    end if;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, starts_at, status,
        bound_day_of_week, bound_start_time, selected_size
    ) values (
        p_profile_id, p_center_id, v_product.id, v_product.name,
        'count', v_count, v_count, v_expires, v_starts, 'active',
        v_bound_dow, v_bound_time, v_size
    ) returning id into v_membership_id;

    select name into v_granter from accounts where id = my_account_id();
    v_memo := '[관리자 지급' || coalesce(' · ' || v_granter, '') || ']'
              || coalesce(' ' || nullif(btrim(coalesce(p_memo, '')), ''), '');

    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, trainer_account_id, paid_at, memo, status
    ) values (
        p_center_id, p_profile_id, v_membership_id,
        case when p_pay_method = 'service' then 'service' else 'new' end,
        case when v_is_goods then 'etc' else 'membership' end,
        case when p_pay_method = 'card' then p_price else 0 end,
        case when p_pay_method = 'cash' then p_price else 0 end,
        case when p_pay_method = 'transfer' then p_price else 0 end,
        0,
        p_price, 0, p_trainer_account_id, coalesce(p_paid_at, now()), v_memo, 'paid'
    ) returning id into v_payment_id;

    return json_build_object(
        'membership_id', v_membership_id,
        'payment_id', v_payment_id,
        'product_kind', v_product.product_kind,
        'selected_size', v_size
    );
end;
$$;

revoke all on function manager_grant_product(uuid, uuid, uuid, integer, text, text, timestamptz, uuid, integer, time, text) from public, anon;
grant execute on function manager_grant_product(uuid, uuid, uuid, integer, text, text, timestamptz, uuid, integer, time, text) to authenticated, service_role;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select
    to_regprocedure('manager_grant_product(uuid,uuid,uuid,integer,text,text,timestamptz,uuid,integer,time,text)') is not null as fn_ok,
    has_function_privilege('anon', 'manager_grant_product(uuid,uuid,uuid,integer,text,text,timestamptz,uuid,integer,time,text)', 'execute') as anon_must_be_false;
