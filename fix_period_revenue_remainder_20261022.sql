-- ============================================================
-- [감사 F16] 기간제/무제한 수강권 "이용 횟수로 분배" 매출의 합계 누락
--
-- 확정된 원인(운영 함수 정의를 읽기 전용으로 읽어 격리 PGlite 로 재현, 2026-10-22):
--   기간제 분배(period_usage)는 amount = floor(결제액 / 이용 횟수) 라 나머지가 버려진다. 1,000원/3회 → 333×3 = 999원(1원 누락).
--   횟수제(count) 분배는 이미 "나머지를 앞 회차부터 1원씩" 보정하고 있어 합계가 보존된다 — 기간제에도 같은 규칙을 적용한다.
--
-- 수정(두 함수 모두, 최소 패치):
--   · class_revenue_daily_summary : period_usage_sessions 에 usage_index(수업 시작 시각, 같으면 예약 id 순) 추가, amount 에 나머지 1원 보정.
--   · class_revenue_for_date      : period_usage 를 (예약별) total_used + usage_index 로 바꿔 같은 규칙 적용.
--   두 함수의 분배 기준이 같아 일별 요약과 날짜별 상세의 합계가 일치한다. 이용 횟수가 늘면 재계산되는 "추정치" 성격은 그대로다.
-- 보존: 취소·폐강(classes.status='cancelled' 제외)·노쇼 포함·mock 결제 제외·환불 별도 집계·purchase_date_full 모드는 건드리지 않는다.
-- 방식: pg_get_functiondef 로 현재 정의를 읽어 정확히 1곳씩만 치환(위치가 1곳이 아니면 예외로 중단 — 아무것도 바꾸지 않음). 여러 번 실행해도 안전(마커 검사).
-- 되돌리기: rollback_fix_period_revenue_remainder_20261022.sql
-- ============================================================
create or replace function pg_temp.f16_replace_once(p_def text, p_old text, p_new text, p_label text)
returns text language plpgsql as $$
declare v_count int;
begin
    v_count := (length(p_def) - length(replace(p_def, p_old, ''))) / nullif(length(p_old), 0);
    if v_count <> 1 then
        raise exception 'F16 패치 중단: % 위치가 %곳(기대 1곳) — 운영 정의가 예상과 다릅니다. 변경하지 않았어요', p_label, v_count;
    end if;
    return replace(p_def, p_old, p_new);
end;
$$;

do $f16$
declare
    v_def text;
begin
    -- 1) 일별 요약
    v_def := pg_get_functiondef('public.class_revenue_daily_summary(uuid,date,date)'::regprocedure);
    if position('-- f16-remainder' in v_def) = 0 then
        v_def := pg_temp.f16_replace_once(v_def,
            E'            count(*) over (partition by r.membership_id) as total_used\n',
            E'            count(*) over (partition by r.membership_id) as total_used,\n            row_number() over (partition by r.membership_id order by c.start_time, r.id) as usage_index -- f16-remainder\n',
            'daily:usage_index');
        v_def := pg_temp.f16_replace_once(v_def,
            'coalesce(floor(coalesce(mp.paid_total, 0)::numeric / nullif(pus.total_used, 0))::int, 0) as amount',
            'coalesce(floor(coalesce(mp.paid_total, 0)::numeric / nullif(pus.total_used, 0))::int + (case when pus.usage_index <= (coalesce(mp.paid_total, 0) % nullif(pus.total_used, 0)) then 1 else 0 end), 0) as amount',
            'daily:amount');
        execute v_def;
    end if;

    -- 2) 날짜별 상세
    v_def := pg_get_functiondef('public.class_revenue_for_date(uuid,date)'::regprocedure);
    if position('-- f16-remainder' in v_def) = 0 then
        v_def := pg_temp.f16_replace_once(v_def,
            E'    period_usage as (\n        select membership_id, count(*) as total_used\n        from reservations r2\n        join classes c2 on c2.id = r2.class_id and c2.status <> ''cancelled''\n        where r2.status in (''confirmed'', ''attended'', ''no_show'')\n        group by membership_id\n    ),\n',
            E'    period_usage as ( -- f16-remainder\n        select r2.id as reservation_id, r2.membership_id,\n               count(*) over (partition by r2.membership_id) as total_used,\n               row_number() over (partition by r2.membership_id order by c2.start_time, r2.id) as usage_index\n        from reservations r2\n        join classes c2 on c2.id = r2.class_id and c2.status <> ''cancelled''\n        where r2.status in (''confirmed'', ''attended'', ''no_show'')\n    ),\n',
            'detail:period_usage');
        v_def := pg_temp.f16_replace_once(v_def,
            'left join period_usage pu on pu.membership_id = r.membership_id',
            'left join period_usage pu on pu.reservation_id = r.id',
            'detail:join');
        v_def := pg_temp.f16_replace_once(v_def,
            'coalesce(floor(coalesce(mp.paid_total, 0)::numeric / nullif(pu.total_used, 0))::int, 0) as amount,',
            'coalesce(floor(coalesce(mp.paid_total, 0)::numeric / nullif(pu.total_used, 0))::int + (case when pu.usage_index <= (coalesce(mp.paid_total, 0) % nullif(pu.total_used, 0)) then 1 else 0 end), 0) as amount,',
            'detail:amount');
        execute v_def;
    end if;
end
$f16$;
