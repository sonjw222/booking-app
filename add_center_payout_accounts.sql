-- ============================================================
-- 센터별 정산계좌(Toss 지급대행/Payouts) 등록 상태 — 1단계(DB/화면만, 실제 API 없음)
--
-- 배경: 회원 결제(카드/카카오페이/토스페이)는 각 센터가 아니라 플랫폼(대표 개인사업자)
--   명의 Toss 가맹점으로 직접 수납되고, 센터에는 별도로 정산해야 하는 구조다(사용자
--   결정, 2026-09-02 — 센터별 개별 PG 계약은 온보딩 부담이 커서 배제). 이 정산을
--   자동화하려면 Toss의 "지급대행(Payouts)" 서비스를 이용해야 하는데, 플랫폼(대표)이
--   이 서비스를 개인사업자로 계약할 수 있는지 등은 Toss 고객센터에 문의 중이라 아직
--   확정되지 않았다.
--
--   add_center_platform_subscription.sql(토스 자동결제 계약 심사 대기)이 이미 증명한
--   패턴 — "외부 계약 심사가 끝나기 전까지 DB/RLS/화면을 전부 완성해두고 플래그로
--   실제 송금 경로만 잠근다" — 을 그대로 따른다. 이 파일은 그 패턴의 1단계만 다룬다.
--
-- 이번 migration에 있는 것:
--   1) center_payout_accounts — 센터별 정산계좌 등록 상태(센터당 1행). 계좌 전체번호는
--      저장하지 않는다(Toss 지급대행이 계좌를 직접 보관/검증하는 구조이므로 우리 쪽은
--      "등록했다는 사실 + 심사 상태 + 확인용 마스킹 정보"만 있으면 됨 —
--      center_subscriptions.card_last4/card_company가 카드 전체번호를 저장하지 않는
--      기존 관례와 동일).
--   2) payments.settlement_status 컬럼 — 이 결제가 정산 대상인지 표시만 해두는 자리.
--      전부 'not_applicable'로 기본값/백필한다. 실제로 이 값을 'pending'으로 바꾸는
--      로직(_issue_membership_and_record_payment 연동)은 이번 범위에 없다 — Toss
--      지급대행 계약이 확정되고 실제 지급 요청/웹훅 처리를 구현할 때(별도 세션) 같이
--      넣는다. 지금 결제 확정 흐름(실제 돈이 오가는 함수)은 전혀 건드리지 않는다.
--   3) RLS: 센터 소속 매니저는 조회만, 플랫폼 운영자는 전체 조회. INSERT/UPDATE는
--      일반 사용자에게 정책을 주지 않아 기본 차단(center_subscriptions와 동일 패턴) —
--      계좌 등록은 반드시 향후 서버 라우트(Toss API 호출 성공 후)를 거쳐야 하고,
--      지금은 그 라우트 자체가 없으므로 화면에서 등록 버튼을 비활성화해둔다
--      (NEXT_PUBLIC_PAYOUTS_ENABLED 플래그, app 쪽 변경, 이 파일과 별개).
--
-- 이번 migration에 의도적으로 없는 것(TODO.md에 근거 기록):
--   - 실제 Toss 지급대행 셀러 등록 API 호출(서버 라우트 필요, 계약 확정 후)
--   - 지급 요청 배치/웹훅 처리, center_payout_batches(지급 이력) 테이블 — 실제 지급
--     로직을 만들 때 같이 추가(지금 만들어봐야 아무도 안 쓰는 빈 테이블이라 범위 밖)
--   - _issue_membership_and_record_payment()의 settlement_status 갱신 로직
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] 센터별 정산계좌 등록 상태 (센터당 1행)
-- ------------------------------------------------------------
create table if not exists center_payout_accounts (
    id                   uuid primary key default gen_random_uuid(),
    center_id            uuid not null unique references centers(id) on delete cascade,

    payout_provider      text not null default 'toss_payouts',

    -- 심사 상태: Toss 지급대행 셀러 상태값을 그대로 매핑
    --   not_registered      아직 계좌를 등록하지 않음(기본값)
    --   approval_required   등록했지만 본인인증 전
    --   partially_approved  본인인증 완료(주 1천만원 미만 지급 가능)
    --   kyc_required        고액 지급을 위한 서류 심사 필요
    --   approved            심사 완료(금액 제한 없음)
    --   rejected / suspended
    status               text not null default 'not_registered'
                          check (status in (
                            'not_registered', 'approval_required', 'partially_approved',
                            'kyc_required', 'approved', 'rejected', 'suspended'
                          )),
    rejection_reason     text,

    -- 표시용 최소 정보만 저장. 계좌 전체번호는 저장하지 않는다.
    bank_name            text,
    bank_account_last4   text,
    account_holder_name  text,

    verified_at          timestamptz,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);

comment on table center_payout_accounts is
    '센터별 Toss 지급대행 셀러 등록·심사 상태(센터당 1행). 계좌 원본 정보는 저장하지 '
    '않음 — Toss가 보관, 여기는 상태·마스킹 정보만. insert/update 정책 없음(service_role 전용)';
comment on column center_payout_accounts.status is
    'not_registered/approval_required/partially_approved/kyc_required/approved/rejected/suspended';

create index if not exists idx_center_payout_accounts_status on center_payout_accounts(status);


-- ------------------------------------------------------------
-- [2] payments에 정산 상태 컬럼 추가 (기존 결제 확정 로직은 건드리지 않음 — 컬럼과
--     기본값/백필만, 실제로 이 값을 바꾸는 로직은 없음)
-- ------------------------------------------------------------
alter table payments
  add column if not exists settlement_status text not null default 'not_applicable'
    check (settlement_status in ('not_applicable', 'pending', 'requested', 'paid_out', 'failed'));

comment on column payments.settlement_status is
    '센터 정산 진행 상태. not_applicable(수기 입력 등 정산 대상 아님)/pending/requested/'
    'paid_out/failed. 지금은 전부 not_applicable로만 남고, 실제 전이 로직은 Toss 지급대행 '
    '계약 확정 후 별도 구현';


-- ------------------------------------------------------------
-- [3] RLS
-- ------------------------------------------------------------
alter table center_payout_accounts enable row level security;

drop policy if exists "정산계좌 조회" on center_payout_accounts;
create policy "정산계좌 조회" on center_payout_accounts for select
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());
-- insert/update/delete 정책은 의도적으로 만들지 않음 — center_subscriptions와 동일하게
-- 일반 매니저 role은 이 테이블을 절대 직접 쓸 수 없다. 최초 행은 트리거([4])가 만들고,
-- 이후 상태 전이는 향후 서버 라우트(service_role)만 담당한다.

grant select, insert, update, delete on center_payout_accounts to service_role;


-- ------------------------------------------------------------
-- [4] 센터 생성 시 기본 정산계좌 행 자동 생성
--     add_center_platform_subscription.sql이 처음에 security definer를 빠뜨렸다가
--     fix_center_subscription_trigger_security_definer.sql로 고친 전례가 있어(일반
--     인증 클라이언트가 centers에 직접 insert하는 시나리오에서 42501로 원본 insert까지
--     롤백시킴), 이번엔 처음부터 security definer로 만든다.
-- ------------------------------------------------------------
create or replace function create_default_center_payout_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into center_payout_accounts (center_id, status)
    values (new.id, 'not_registered')
    on conflict (center_id) do nothing;
    return new;
end;
$$;

drop trigger if exists trg_create_default_center_payout_account on centers;
create trigger trg_create_default_center_payout_account
    after insert on centers
    for each row execute function create_default_center_payout_account();


-- ------------------------------------------------------------
-- [5] 기존 센터 backfill
-- ------------------------------------------------------------
insert into center_payout_accounts (center_id, status)
select c.id, 'not_registered'
from centers c
where not exists (select 1 from center_payout_accounts cpa where cpa.center_id = c.id);


-- ------------------------------------------------------------
-- 확인
-- ------------------------------------------------------------
select count(*) as center_payout_accounts_rows from center_payout_accounts;
select count(*) as centers_total from centers;
select column_name, column_default from information_schema.columns
where table_name = 'payments' and column_name = 'settlement_status';

COMMIT;
