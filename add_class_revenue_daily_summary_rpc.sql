-- ============================================================
-- 수업매출 캘린더 기능 [3/4]: 날짜별 요약 RPC (캘린더 그리드용)
--
-- class_revenue_daily_summary(p_center_id, p_from, p_to): 기간 내 날짜별 매출 합계.
-- 캘린더 월 그리드는 이거 하나만 불러서 각 날짜 칸에 금액을 표시한다(상세 breakdown은
-- [4] class_revenue_for_date에서 날짜 클릭 시 별도 조회 — 여기서는 성능을 위해 합계만).
--
-- 귀속 규칙(계획 문서 기준):
--   - classRevenue(횟수제): 그 예약이 실제 있었던 수업 날짜에, 회차별 금액(오버라이드
--     있으면 그 값, 없으면 결제총액을 총횟수로 균등분배 — 나머지는 앞 회차부터 1원씩
--     더해 총액이 정확히 일치하게 함)을 귀속.
--   - periodPassRevenue(정기권/기간제): center_settings.unlimited_pass_revenue_mode가
--     'usage_split'이면 결제총액 ÷ 그 수강권 전체 이용횟수(현재까지, 매 조회 시 동적
--     재계산)를 각 이용 수업 날짜에 배분. 'purchase_date_full'이면 결제총액 전체를
--     구매일(paid_at)에 표시.
--   - goodsRevenue: product_kind='goods'는 세션 개념 없이 구매일에 그대로.
--   - refundAmount: sale_type='refund' 결제는 원 세션으로 소급 배분하지 않고 환불
--     결제 자체의 paid_at 날짜에 그대로(음수) 표시.
--   - 공통 제외: status not in (confirmed/attended/no_show인 예약만), classes.status
--     <> 'cancelled', payment_provider is distinct from 'mock'.
--
-- [영향받는 기존 데이터] 없음(읽기 전용 신규 함수).
-- [위험도] 낮음.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

create or replace function class_revenue_daily_summary(p_center_id uuid, p_from date, p_to date)
returns json
language plpgsql
security definer
stable
set search_path = public
as $$
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
        join memberships m on m.id = r.membership_id and m.center_id = p_center_id and m.pass_type = 'count'
        join products pr on pr.id = m.product_id and pr.product_kind = 'pass'
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
        join memberships m on m.id = r.membership_id and m.center_id = p_center_id and m.pass_type = 'period'
        join products pr on pr.id = m.product_id and pr.product_kind = 'pass'
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
        join memberships m on m.id = p.membership_id and m.center_id = p_center_id and m.pass_type = 'period'
        join products pr on pr.id = m.product_id and pr.product_kind = 'pass'
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

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select pg_get_functiondef('class_revenue_daily_summary(uuid, date, date)'::regprocedure);
