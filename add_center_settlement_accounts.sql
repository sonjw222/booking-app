-- ============================================================
-- 센터 정산 계좌(수동 대량이체용) + 운영자 정산 요약 RPC
--
-- 배경: Toss 지급대행(Payouts) 월 고정 이용료가 30만원(+VAT)으로 확인됐는데(2026-09-04,
-- Toss 고객센터 회신), 지금 규모에서는 배보다 배꼽이 크다고 판단해(사용자 결정) 당분간
-- 자동 정산(add_center_payout_accounts.sql, PAYOUTS_ENABLED 플래그로 계속 잠가둠) 대신
-- "은행 인터넷뱅킹의 대량이체(엑셀 업로드) 기능"으로 수동 정산하기로 했다. 이 파일은 그
-- 수동 정산에 필요한 두 가지만 다룬다.
--   1) 센터가 자기 정산 계좌(전체 계좌번호)를 직접 입력하는 곳 — center_payout_accounts는
--      Toss 지급대행 전용으로 설계돼 있어(계좌 전체번호를 의도적으로 저장 안 함, 주석 참고)
--      이 용도에 못 쓴다. 완전히 별도 테이블로 분리한다.
--   2) 운영자(대표)가 기간을 골라 "센터별로 얼마를 어느 계좌로 보내야 하는지" 합계를
--      뽑아보는 조회 전용 RPC — 은행 대량이체 파일을 만들 때 참고용.
--
-- 보안 유의점(중요): centers 테이블의 SELECT 정책("승인된 센터 조회")은
-- status='approved'인 센터를 로그인 없이도 전부 공개 조회할 수 있게 열려 있다(공개
-- 센터 상세 페이지용). 그래서 계좌번호를 centers 테이블에 컬럼만 추가하는 방식은 절대
-- 안 된다 — 즉시 전 세계에 계좌번호가 공개된다. 반드시 별도 테이블 + 별도(좁은) RLS로
-- 분리해야 한다.
--
-- 같은 이유로 payments 테이블의 기존 SELECT 정책("매니저 매출 조회")도 건드리지 않는다
-- (has_permission 기반이라 운영자가 자동으로 전체 센터 매출을 못 봄 — 이게 의도된
-- 설계인지 재검토 없이 넓히면 또 다른 회귀를 만들 위험이 있다, 2026-09-02 RLS 회귀 사고
-- 참고). 대신 운영자 전용 집계 RPC(security definer)로 필요한 합계만 노출한다 — 원본
-- payments 행 자체에 대한 새 SELECT 권한은 아무에게도 주지 않는다.
--
-- 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] 센터 정산 계좌 (센터당 1행, 계좌 전체번호 저장)
-- ------------------------------------------------------------
create table if not exists center_settlement_accounts (
    id                   uuid primary key default gen_random_uuid(),
    center_id            uuid not null unique references centers(id) on delete cascade,
    bank_name            text,
    account_number       text,
    account_holder_name  text,
    updated_at           timestamptz not null default now()
);

comment on table center_settlement_accounts is
    '수동(은행 대량이체) 정산용 센터 계좌 정보. 계좌 전체번호를 저장하므로 RLS를 '
    '오너/운영자로만 좁게 유지해야 한다 — centers 테이블처럼 공개 SELECT 정책을 절대 '
    '추가하지 말 것';

alter table center_settlement_accounts enable row level security;

drop policy if exists "정산계좌 오너 조회" on center_settlement_accounts;
create policy "정산계좌 오너 조회" on center_settlement_accounts for select
    using (_is_owner_of_center(center_id) or is_platform_admin());

drop policy if exists "정산계좌 오너 수정" on center_settlement_accounts;
create policy "정산계좌 오너 수정" on center_settlement_accounts for update
    using (_is_owner_of_center(center_id))
    with check (_is_owner_of_center(center_id));
-- insert 정책 없음 — 최초 행은 트리거([2])가 만든다. delete 정책도 없음(센터 삭제 시
-- on delete cascade로만 정리).

grant select, insert, update, delete on center_settlement_accounts to service_role;


-- ------------------------------------------------------------
-- [2] 센터 생성 시 기본 행 자동 생성 (add_center_payout_accounts.sql과 동일 패턴)
-- ------------------------------------------------------------
create or replace function create_default_center_settlement_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into center_settlement_accounts (center_id)
    values (new.id)
    on conflict (center_id) do nothing;
    return new;
end;
$$;

drop trigger if exists trg_create_default_center_settlement_account on centers;
create trigger trg_create_default_center_settlement_account
    after insert on centers
    for each row execute function create_default_center_settlement_account();

insert into center_settlement_accounts (center_id)
select c.id
from centers c
where not exists (select 1 from center_settlement_accounts csa where csa.center_id = c.id);


-- ------------------------------------------------------------
-- [3] 운영자 전용 정산 요약 RPC (조회 전용, payments 원본 행 접근 권한은 안 줌)
-- ------------------------------------------------------------
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
       and p.settlement_status <> 'not_applicable'
       and p.paid_at::date between p_start and p_end
    group by c.id, c.name, csa.bank_name, csa.account_number, csa.account_holder_name
    having coalesce(sum(p.total_amount), 0) <> 0
    order by c.name;
end;
$$;

grant execute on function admin_center_settlement_summary(date, date) to authenticated;


-- ------------------------------------------------------------
-- 확인
-- ------------------------------------------------------------
select count(*) as center_settlement_accounts_rows from center_settlement_accounts;
select count(*) as centers_total from centers;

COMMIT;
