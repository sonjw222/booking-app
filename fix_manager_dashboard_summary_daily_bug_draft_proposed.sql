-- ============================================================
-- P4 후속 수정: manager_dashboard_summary()의 daily 컬럼 별칭 오류
--
-- 증상(CI 통합테스트로 발견, dashboard-summary.test.ts 6건 실패):
--   "column d.date does not exist"
--
-- 원인(add_manager_dashboard_summary_draft_proposed.sql의 실수):
--   daily 필드를 만드는 서브쿼리에서 날짜 목록은 `days`(컬럼: date), 결제 합계는
--   `d`(컬럼: pdate, revenue)로 별칭을 나눠 LEFT JOIN 했는데, json_build_object와
--   order by에서 `d.date`를 참조했다 — `d`에는 `date`라는 컬럼이 없다(있는 건 pdate).
--   `days.date`를 썼어야 했다.
--
-- 영향받는 기존 데이터: 없음(함수 본문 재정의만, daily 필드 계산 로직만 수정).
-- 위험도: 낮음 — 이 함수는 아직 UI 롤아웃 전이라 실사용 영향 없음.
-- ============================================================

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

COMMIT;

-- ============================================================
-- 확인
-- ============================================================
select pg_get_functiondef('manager_dashboard_summary(uuid, date, date)'::regprocedure);
