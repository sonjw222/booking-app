-- ============================================================
-- 센터 → 플랫폼 월 구독료(자동결제/빌링) 구조
--
-- 배경:
--   이 앱의 결제는 두 종류로 나뉜다.
--     A. 센터가 플랫폼(우리)에게 내는 월 구독료 — 이 migration의 범위
--     B. 일반 회원이 센터의 클래스/이용권을 결제 — app/checkout, lib/payments/*,
--        app/api/payments/* (다른 세션이 병렬 작업 중, 이 파일과 무관)
--
--   토스페이먼츠 자동결제(빌링) API는 계약 심사가 끝나야 카드 등록(빌링키 발급)이
--   가능하다(심사 안 된 테스트 키로 연동하면 에러가 난다는 것이 토스 공식 문서로
--   확인됨). 아직 심사가 끝나지 않아 실제 카드 등록/청구를 테스트할 방법이 없다.
--   그래서 이번 migration은 "토스 승인과 무관하게 지금 할 수 있는 것" — DB 구조와
--   RLS — 까지만 다룬다. 실제 카드 등록(토스 빌링 SDK 호출) 화면은
--   NEXT_PUBLIC_BILLING_ENABLED 플래그로 꺼둔 채 준비만 해둔다(app 쪽 변경, 이
--   파일과 별개).
--
-- 하는 일:
--   1) subscription_plans        — 플랫폼이 정의하는 구독 플랜 카탈로그
--   2) center_subscriptions      — 센터별 구독 상태(센터당 1행, status로 전이)
--   3) center_subscription_charges — 청구 이력(성공/실패)
--   4) RLS: 센터 오너/스태프는 자기 센터 것만 SELECT, 플랫폼 운영자는 전체 SELECT.
--      INSERT/UPDATE는 일반 사용자에게 아예 정책을 주지 않아 기본 차단 —
--      service_role(또는 향후 security definer RPC)만 쓸 수 있다. 신규 센터의
--      최초 행은 트리거가 만드는데, 센터 생성 자체가 이미 security definer RPC인
--      register_center_for_account_safe() 안에서만 일어나므로(lib/centers.ts가
--      centers에 직접 insert하지 않고 이 RPC만 호출하는 것을 확인함) 트리거 함수는
--      create_default_center_roles()와 동일하게 security definer가 필요 없다.
--      [2026-08-26 정정] 이 판단은 틀렸음이 CI에서 확인됨 — 통합테스트가 이 RPC를
--      거치지 않고 일반 클라이언트로 centers에 직접 insert하는 시나리오도 검증하는데,
--      그 경로에선 트리거가 42501로 막혀 원본 insert까지 롤백시켰다. 실제 앱 흐름은
--      영향 없음(lib/centers.ts는 항상 이 RPC만 씀). 수정은
--      fix_center_subscription_trigger_security_definer.sql 참고 — 이 파일은 최초
--      적용 기록 보존을 위해 원문 그대로 둠(CLAUDE.md 규칙 4).
--   5) 기본 플랜 1개 seed + 기존 센터 backfill(전부 pending_billing_setup으로 시작)
--   6) service_role GRANT — 이 저장소에서 새 테이블에 service_role GRANT를
--      빠뜨려 "permission denied for table X"가 반복 발생한 이력이 있어(예:
--      fix_service_role_missing_grants_orders.sql 등 다수) 이번엔 처음부터 포함.
--
-- 이번 migration에 없는 것(의도적으로 범위 밖, docs/TODO.md에 근거 기록):
--   - 실제 토스 authKey → billing_key 교환/저장 처리(서버 필요, 이 앱은 API 서버가
--     없어 이번 배치 범위 밖)
--   - 매월 자동 청구 실행(pg_cron/외부 스케줄러 필요)
--   - 구독 해지 화면/정책(상태값 'canceled'는 준비해두지만 전환 로직 없음)
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다(create if not exists / drop policy if exists 사용).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] 구독 플랜 카탈로그
-- ------------------------------------------------------------
create table if not exists subscription_plans (
    id             uuid primary key default gen_random_uuid(),
    name           text not null,                                -- 예: "기본 플랜"
    monthly_price  int not null default 0,                       -- 월 구독료(원). 사업 결정 전이라 0으로 시작 가능
    description    text,
    is_active      boolean not null default true,                -- 신규 센터에 기본 배정할 후보인지
    created_at     timestamptz not null default now()
);

comment on table subscription_plans is
    '플랫폼이 정의하는 센터 대상 월 구독 플랜 카탈로그. 가격/이름은 운영자가 조정 가능';


-- ------------------------------------------------------------
-- [2] 센터별 구독 상태 (센터당 1행)
-- ------------------------------------------------------------
create table if not exists center_subscriptions (
    id                    uuid primary key default gen_random_uuid(),
    center_id             uuid not null unique references centers(id) on delete cascade,
    plan_id               uuid not null references subscription_plans(id),
    status                text not null default 'pending_billing_setup'
                          check (status in ('pending_billing_setup', 'active', 'past_due', 'canceled')),
    billing_key           text,                                  -- 토스 빌링키 (카드 등록 완료 후 발급)
    billing_customer_key  text,                                  -- 토스 API가 요구하는 우리 쪽 고유 고객 식별자
    card_last4            text,                                  -- 등록된 카드 끝 4자리 (표시용)
    card_company          text,                                  -- 카드사명 (표시용)
    next_billing_date     date,                                  -- 다음 청구 예정일
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

comment on table center_subscriptions is
    '센터별 플랫폼 구독 상태. 센터당 1행(center_id unique), status로 생애주기 전이. '
    'insert/update 정책 없음 — service_role 또는 security definer RPC만 기록 가능';
comment on column center_subscriptions.status is
    'pending_billing_setup(카드 미등록) / active(정상) / past_due(연체) / canceled(해지)';

create index if not exists idx_center_subscriptions_status on center_subscriptions(status);


-- ------------------------------------------------------------
-- [3] 청구 이력 (append 전용)
-- ------------------------------------------------------------
create table if not exists center_subscription_charges (
    id               uuid primary key default gen_random_uuid(),
    subscription_id  uuid not null references center_subscriptions(id) on delete cascade,
    amount           int not null,
    status           text not null check (status in ('succeeded', 'failed')),
    toss_payment_key text,
    failure_reason   text,
    charged_at       timestamptz not null default now()
);

comment on table center_subscription_charges is
    '센터 플랫폼 구독료 청구 이력(성공/실패). append 전용 — insert/update 정책 없음';

create index if not exists idx_center_subscription_charges_sub
    on center_subscription_charges(subscription_id, charged_at desc);


-- ------------------------------------------------------------
-- [4] RLS
-- ------------------------------------------------------------
alter table subscription_plans enable row level security;
alter table center_subscriptions enable row level security;
alter table center_subscription_charges enable row level security;

-- 플랜 카탈로그: 민감정보 아님 — 매니저 화면이 조인해서 이름/가격을 보여줘야 하므로
-- service_categories/home_banners와 동일하게 공개 SELECT + 운영자만 관리
drop policy if exists "구독 플랜 공개 조회" on subscription_plans;
create policy "구독 플랜 공개 조회" on subscription_plans for select using (true);

drop policy if exists "구독 플랜 운영자 관리" on subscription_plans;
create policy "구독 플랜 운영자 관리" on subscription_plans for all
    using (is_platform_admin())
    with check (is_platform_admin());

-- 센터 구독: 소속 매니저(오너/스태프 구분 없이 소속이면 조회 가능 — 결제 정보 자체를
-- 숨길 이유는 없고, 기존 center_settings 조회도 같은 방식) + 플랫폼 운영자
drop policy if exists "센터 구독 조회" on center_subscriptions;
create policy "센터 구독 조회" on center_subscriptions for select
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());
-- insert/update/delete 정책은 의도적으로 만들지 않음: 일반 매니저 role은 이 테이블을
-- 절대 직접 쓸 수 없다. 최초 행은 트리거(아래 [5])가, 이후 상태 전이는 service_role
-- 또는 향후 security definer RPC만 담당한다.

drop policy if exists "센터 구독 청구내역 조회" on center_subscription_charges;
create policy "센터 구독 청구내역 조회" on center_subscription_charges for select
    using (
        subscription_id in (
            select id from center_subscriptions where center_id in (select my_managed_center_ids())
        )
        or is_platform_admin()
    );
-- insert/update/delete 정책 없음 — admin_action_logs와 동일한 append-only 패턴

-- service_role GRANT — 이 저장소에서 반복된 "permission denied for table X" 사고를
-- 막기 위해 새 테이블 3개 모두 명시적으로 부여
grant select, insert, update, delete on subscription_plans to service_role;
grant select, insert, update, delete on center_subscriptions to service_role;
grant select, insert, update, delete on center_subscription_charges to service_role;


-- ------------------------------------------------------------
-- [5] 센터 생성 시 기본 구독 행 자동 생성
--     [2026-08-26 정정] 여기 정의된 대로 security definer 없이 최초 적용됐으나 CI에서
--     문제 확인 — fix_center_subscription_trigger_security_definer.sql로 security
--     definer 추가 필요(위 [4] 절 주석 참고). 이 파일 자체는 원문 보존.
-- ------------------------------------------------------------
create or replace function create_default_center_subscription()
returns trigger
language plpgsql
as $$
declare
    v_plan_id uuid;
begin
    select id into v_plan_id
    from subscription_plans
    where is_active
    order by created_at asc
    limit 1;

    if v_plan_id is not null then
        insert into center_subscriptions (center_id, plan_id, status)
        values (new.id, v_plan_id, 'pending_billing_setup')
        on conflict (center_id) do nothing;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_create_default_center_subscription on centers;
create trigger trg_create_default_center_subscription
    after insert on centers
    for each row execute function create_default_center_subscription();


-- ------------------------------------------------------------
-- [6] 기본 플랜 seed + 기존 센터 backfill
-- ------------------------------------------------------------
insert into subscription_plans (name, monthly_price, description, is_active)
select '기본 플랜', 0, '가격 미정 — 사업 결정 후 운영자가 조정 예정', true
where not exists (select 1 from subscription_plans);

insert into center_subscriptions (center_id, plan_id, status)
select
    c.id,
    (select id from subscription_plans where is_active order by created_at asc limit 1),
    'pending_billing_setup'
from centers c
where not exists (select 1 from center_subscriptions cs where cs.center_id = c.id);

COMMIT;
