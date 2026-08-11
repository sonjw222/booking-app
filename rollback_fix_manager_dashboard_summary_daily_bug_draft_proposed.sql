-- fix_manager_dashboard_summary_daily_bug_draft_proposed.sql 롤백
-- daily 필드 계산을 수정 이전(버그 있는) 본문으로 되돌린다 — add_manager_dashboard_summary_draft_proposed.sql의 원래 정의와 동일.

BEGIN;

create or replace function manager_dashboard_summary(p_center_id uuid, p_from date, p_to date)
returns json
language plpgsql
security definer
stable
as $$
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
            select json_agg(json_build_object('date', d.date, 'revenue', coalesce(d.revenue, 0)) order by d.date)
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

COMMIT;
