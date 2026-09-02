-- ============================================================
-- 수업매출 캘린더 — 새 방식 무제한 수강권(unlimited_pass) 매출 0원 버그 수정
--
-- class_revenue_daily_summary()/class_revenue_for_date()가 "정기권(period)" 매출을
-- m.pass_type = 'period' 기준으로만 판별하는데, add_product_expiry_options.sql로 만든
-- 새 방식 무제한 수강권(unlimited_pass=true)은 pass_type을 하위호환 위해 계속 'count'로
-- 저장한다(2026-09-01 사용자 결정) — 그 결과 이 매출 함수들이 이런 수강권을 "횟수제"
-- 버킷(count_sessions)으로 잘못 분류하고, total_count가 NULL이라 나누기 결과가 NULL이 돼
-- 매출이 0원으로 집계되는 버그가 있었다(2026-09-01 감사에서 발견, 실제 화면 동작은 아직
-- 확인 전 — 코드 분석으로 확정).
--
-- pass_type='period'(기존, 레거시) 뿐 아니라 products.unlimited_pass=true(신규)도 "정기권"
-- 버킷으로 분류하도록 판정 조건을 확장한다. 나머지 로직(회차 분배, usage_split/
-- purchase_date_full 모드, refund 등)은 그대로.
--
-- 여러 번 실행해도 안전.
-- ============================================================

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

create or replace function class_revenue_for_date(p_center_id uuid, p_date date)
returns json
language plpgsql
security definer
stable
set search_path = public
as $$
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

-- ============================================================
-- 확인
-- ============================================================
select proname from pg_proc where proname in ('class_revenue_daily_summary', 'class_revenue_for_date');
