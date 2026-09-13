-- ============================================================
-- 토스페이먼츠 빌링(자동결제) 계약 심사용 "심사관 전용 센터" 카드등록 버튼 노출
--
-- 배경: add_pg_checkout_reviewer_override.sql과 정확히 같은 문제의 Billing판이다.
-- NEXT_PUBLIC_BILLING_ENABLED를 전역으로 켜면 심사관이 카드 등록창을 확인할 수 있게
-- 되지만, 그 순간 실제로 이미 활동 중인 모든 센터 오너에게도 "카드 등록" 버튼이 함께
-- 열려 진짜 청구(월 구독료)가 발생할 위험이 있다(2026-09-11 사용자 결정 — 이 방식은
-- 승인하지 않음). pg_checkout_override가 "심사관 전용 계정 하나"만 전역 게이트와
-- 무관하게 노출시켰던 것과 동일하게, 이번엔 "심사관에게 전달할 심사용 센터 하나"만
-- center_subscriptions.billing_review_override로 표시해 전역 플래그 없이도 그 센터의
-- 카드 등록 버튼만 열어준다. 다른 센터 노출은 전혀 안 바뀐다.
--
-- center_subscriptions(계정이 아니라 센터) 스코프로 둔 이유: Billing 관련 화면·RPC가
-- 전부 centerId 기준으로 짜여 있고(fetchCenterSubscription, requestCenterBillingAuth 등),
-- 심사용 계정이 여러 센터를 소유하게 될 가능성까지 고려하면 계정 전체가 아니라 심사에
-- 실제로 쓸 센터 하나만 정확히 켜는 쪽이 더 안전하다(accounts 스코프였다면 그 계정이
-- 우연히 다른 진짜 센터도 갖게 될 경우 그쪽까지 함께 열리는 과잉 노출이 생김).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table center_subscriptions add column if not exists billing_review_override boolean not null default false;

-- ⚠ center_subscriptions는 애초에 일반 사용자에게 update 정책 자체가 없어(RLS로 이미
-- 막혀 있음, add_center_platform_subscription.sql 참고) pg_checkout_override 때와 같은
-- "본인 계정 update RLS를 통한 자가 우회" 경로는 지금 존재하지 않는다. 그래도 동일한
-- 방어 패턴을 그대로 적용해 향후 이 테이블에 오너용 update 정책/RPC가 추가되더라도
-- 이 컬럼만은 항상 운영자만 바꿀 수 있게 고정해둔다(방어적 일관성, add_pg_checkout_
-- reviewer_override.sql의 enforce_pg_checkout_override_admin_only와 동일 패턴).
create or replace function enforce_billing_review_override_admin_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.billing_review_override is distinct from old.billing_review_override then
    if auth.uid() is not null and not is_platform_admin() then
      raise exception '이 값은 운영자만 변경할 수 있어요';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_center_subscriptions_billing_review_override_admin_only on center_subscriptions;
create trigger trg_center_subscriptions_billing_review_override_admin_only
    before update on center_subscriptions
    for each row execute function enforce_billing_review_override_admin_only();

-- ------------------------------------------------------------
-- 심사용 센터 지정 (예시 — 토스 담당자에게 전달할 심사용 테스트 계정이 오너인 센터의
-- centerId로 바꿔서 실행). 이 UPDATE는 SQL Editor에서 postgres/service_role로 직접
-- 실행하는 것이라(auth.uid() is null) 위 트리거를 그대로 통과한다.
-- ------------------------------------------------------------
-- update center_subscriptions set billing_review_override = true
-- where center_id = '심사용_센터_UUID';

-- ------------------------------------------------------------
-- 확인
-- ------------------------------------------------------------
select
    (select count(*) from information_schema.columns where table_name = 'center_subscriptions' and column_name = 'billing_review_override') as column_exists,
    (select count(*) from pg_trigger where tgname = 'trg_center_subscriptions_billing_review_override_admin_only') as trigger_exists;
