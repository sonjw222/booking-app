-- ============================================================
-- 수업매출 캘린더 기능 [4/4]: 특정 날짜 상세 breakdown RPC
--
-- class_revenue_for_date(p_center_id, p_date): 날짜 클릭 시 그 날의 상세 내역.
-- [3] class_revenue_daily_summary와 같은 귀속 규칙을 쓰되, 합계가 아니라 개별 행을
-- 반환한다. 행 종류(type):
--   'class'       — 실제 수업에 귀속된 매출(횟수제 회차 분배 + 정기권 usage_split 모두
--                    포함, 둘 다 특정 수업 하나에 실제로 귀속되므로 같은 타입). classId/
--                    classTitle/time/place/profileName/amount를 채운다 — 프론트에서
--                    classId로 grouping하면 "이 수업으로 총 얼마" + 클릭 시 회원/시간/
--                    장소를 볼 수 있다. 횟수제(count) 행에는 추가로 membershipId/
--                    sessionIndex/totalSessions를 채워 프론트가 "회차별 금액 편집" UI를
--                    띄울 수 있게 한다(정기권 usage_split 행은 회차 개념이 없어 null).
--   'period_pass' — 정기권이 purchase_date_full 모드일 때만(특정 수업에 안 붙음).
--                    productName/profileName/amount.
--   'goods'       — product_kind='goods' 구매(수업과 무관). productName/profileName/amount.
--   'refund'      — 환불 결제(원 세션으로 소급 배분 안 함). profileName/amount, amount는
--                    음수.
--
-- [영향받는 기존 데이터] 없음(읽기 전용 신규 함수).
-- [위험도] 낮음.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

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
        -- session_index는 이 membership의 "전체" 세션(날짜 무관)에 대해 계산해야 한다 —
        -- 여기서 날짜로 먼저 필터링하면 partition이 항상 1행짜리가 돼 row_number()가
        -- 매번 1로만 나오는 버그가 생긴다(실측 확인, 통합테스트로 발견). 날짜 필터는
        -- 아래 rows_union의 JOIN 조건에서 적용한다.
        select
            r.membership_id, r.profile_id, c.id as class_id, c.start_time as class_start_time,
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
    period_usage as (
        select membership_id, count(*) as total_used
        from reservations r2
        join classes c2 on c2.id = r2.class_id and c2.status <> 'cancelled'
        where r2.status in ('confirmed', 'attended', 'no_show')
        group by membership_id
    ),
    rows_union as (
        -- 횟수제: 회차별 귀속(오버라이드 우선, 없으면 균등분배 + 나머지 앞회차 보정)
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

        -- 정기권(usage_split 모드): 이용 횟수로 나눈 금액을 이 수업 날짜에 귀속(회차 개념 없음)
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
        join memberships m on m.id = r.membership_id and m.center_id = p_center_id and m.pass_type = 'period'
        join products pr on pr.id = m.product_id and pr.product_kind = 'pass'
        left join profiles pf on pf.id = r.profile_id
        left join membership_paid mp on mp.membership_id = r.membership_id
        left join period_usage pu on pu.membership_id = r.membership_id
        where r.status in ('confirmed', 'attended', 'no_show')
          and (c.start_time at time zone 'Asia/Seoul')::date = p_date
          and v_mode = 'usage_split'

        union all

        -- 정기권(purchase_date_full 모드): 구매일에 전액, 특정 수업에 안 붙음
        select
            'period_pass'::text as type,
            null::uuid, null::text, null::timestamptz, null::text,
            pr.name as product_name,
            coalesce(pf.name, '(회원)') as profile_name,
            p.total_amount as amount,
            null::uuid, null::int, null::int
        from payments p
        join memberships m on m.id = p.membership_id and m.center_id = p_center_id and m.pass_type = 'period'
        join products pr on pr.id = m.product_id and pr.product_kind = 'pass'
        left join profiles pf on pf.id = p.profile_id
        where p.center_id = p_center_id and p.payment_provider is distinct from 'mock' and p.sale_type <> 'refund'
          and v_mode = 'purchase_date_full'
          and (p.paid_at at time zone 'Asia/Seoul')::date = p_date

        union all

        -- 상품(대여품 등, 수업과 무관): 구매일에 그대로
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

        -- 환불: 원 세션으로 소급 재분배하지 않고 환불 결제 자체의 날짜에 그대로(음수)
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

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select pg_get_functiondef('class_revenue_for_date(uuid, date)'::regprocedure);
