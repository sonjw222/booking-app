-- ============================================================
-- admin_center_settlement_summary() 판별 기준 수정: settlement_status → payment_provider
--
-- add_center_settlement_accounts.sql이 처음에 payments.settlement_status(이번에 새로
-- 추가한 컬럼, 기본값 'not_applicable')로 "정산 대상 여부"를 걸렀는데, 이 컬럼을 실제로
-- 채우는 로직이 아직 없다(add_center_payout_accounts.sql 주석에 명시한 대로 Toss
-- 지급대행 계약 확정 후 별도 구현 예정) — 그래서 이 RPC가 항상 빈 결과만 반환했다
-- (실측 확인, 2026-09-04).
--
-- 이미 있는 payments.payment_provider 컬럼(fix_payments_payment_provider_draft_proposed.sql)이
-- 정확히 이 용도에 맞는, 이미 채워지고 있는 값이다 — "NULL이면 수기 입력(실제 매출이지만
-- PG를 안 거침), 'mock'이면 테스트 결제(실제 돈 안 움직임), 'toss'/'portone'이면 실제
-- PG 결제"라는 기존 관례가 이미 확립돼 있다. 정산 대상은 "실제로 대표 Toss 가맹점에
-- 돈이 들어온 건"이므로 payment_provider in ('toss', 'portone')로 판별하는 게 맞다.
--
-- settlement_status 컬럼 자체는 그대로 둔다(나중에 Toss 지급대행 실제 연동 시
-- 지급 진행 상태를 표시하는 용도로 여전히 필요 — add_center_payout_accounts.sql 참고).
-- 이 파일은 이 RPC의 필터 조건만 고친다.
--
-- 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
-- ============================================================

create or replace function admin_center_settlement_summary(p_start date, p_end date)
returns table (
    center_id           uuid,
    center_name         text,
    bank_name           text,
    account_number      text,
    account_holder_name text,
    total_amount        bigint
)
language plpgsql
security definer
set search_path = public
as $$
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

-- ============================================================
-- 확인
-- ============================================================
select proname, pg_get_functiondef(oid) like '%payment_provider in (%' as uses_payment_provider
from pg_proc where proname = 'admin_center_settlement_summary';
