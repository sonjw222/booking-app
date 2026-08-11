-- ============================================================
-- P4(매출/통계 대시보드 배치): manager_dashboard_summary() RPC 신규
--
-- 기존 구조 감사 결과: lib/sales.ts의 summarize()는 이미 불러온 payments 행 배열을
-- 클라이언트에서 reduce하는 방식뿐이라(DB 집계 아님), 이 프로젝트가 이미 한 번 실제로
-- 겪은 PostgREST 기본 1000행 응답 제한 문제(fetchClasses/fetchUsableMembershipsByClass,
-- 이번 세션에서 발견·수정)와 같은 종류의 위험이 있다 — 결제 건수가 많은 센터/기간에서는
-- 통계가 조용히 잘릴 수 있다. 이 RPC는 SQL 집계 함수(SUM/COUNT)로 DB 안에서 직접 계산해
-- 그 위험 자체를 없앤다("숫자가 DB 원장과 반드시 일치해야 한다" 요구사항과도 부합).
--
-- Mock 결제 제외: fix_payments_payment_provider_draft_proposed.sql이 먼저 적용돼 있어야
-- 한다(payments.payment_provider 컬럼) — 이 RPC의 모든 집계는 payment_provider가 'mock'인
-- 행을 명시적으로 제외한다.
--
-- 수강권/상품 매출 구분의 알려진 한계: payments.revenue_category는 registerPayment()가
-- 실제로는 항상 'membership'만 저장해(코드 감사로 확인, lib/sales.ts) 신뢰할 수 없다.
-- 대신 payments.membership_id → memberships.product_id → products.product_kind를
-- 조인해 실제 상품 종류로 구분한다 — 다만 한 결제에 "추가 상품"(extraProducts)이 함께
-- 발급된 경우 그 추가 상품의 매출은 이 결제 건의 대표 membership_id 하나로만 잡혀
-- 별도 집계되지 않는다(기존 스키마의 한계, 이번 배치에서 새로 만들지 않음 — 정확히
-- 표현 못 하는 상품별 세부 분해가 필요하면 별도 스키마 변경이 필요하다는 것을 문서화만 함).
--
-- 영향받는 기존 데이터: 없음(신규 함수만 추가, 테이블 변경 없음).
-- 위험도: 낮음.
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

-- ============================================================
-- 확인
-- ============================================================
select pg_get_functiondef('manager_dashboard_summary(uuid, date, date)'::regprocedure);
