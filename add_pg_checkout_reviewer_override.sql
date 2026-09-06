-- ============================================================
-- 토스페이먼츠 카드사 심사용 "심사관 전용 계정" PG 결제 노출
--
-- 배경: 토스 PG 계약 심사 중 카드사 심사(10~14 영업일) 기간에는 실제 결제창이 동작하는
-- 걸 심사관이 확인해야 하는데, 방법은 두 가지다 — (1) 비회원도 결제창까지 갈 수 있게
-- 열어두거나 (2) 심사관 전용 테스트 계정(아이디/비밀번호)을 전달. 이 앱은 지금
-- PG_CHECKOUT_ENABLED를 꺼서(2026-09-04, 직접결제만 출시) 일반 고객에게는 온라인 결제를
-- 안 보여주기로 했는데, 심사관에게도 안 보이면 심사 자체가 진행이 안 된다. (2)번 방식을
-- 택해, 특정 계정 하나만 이 전역 게이트와 무관하게 온라인 결제(카드/카카오페이/토스페이/
-- 계좌이체)를 볼 수 있게 한다 — 일반 고객 노출은 전혀 안 바뀐다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table accounts add column if not exists pg_checkout_override boolean not null default false;

-- ⚠ "본인 계정 수정" RLS 정책은 auth_id = auth.uid()만 확인하고 어떤 컬럼이 바뀌는지는
-- 안 본다 — 이 컬럼을 아무 보호 없이 추가하면 누구나 본인 계정에서 그냥
-- .update({pg_checkout_override: true})를 호출해 스스로 켤 수 있다(전역 게이트를
-- 우회하는 구멍이 됨). add_phone_verification 배치의 트리거와 같은 패턴으로, 운영자만
-- 이 컬럼을 바꿀 수 있게 막는다. auth.uid() is null(= SQL Editor/service_role 직접
-- 실행)은 항상 허용한다.
create or replace function enforce_pg_checkout_override_admin_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.pg_checkout_override is distinct from old.pg_checkout_override then
    if auth.uid() is not null and not is_platform_admin() then
      raise exception '이 값은 운영자만 변경할 수 있어요';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_accounts_pg_checkout_override_admin_only on accounts;
create trigger trg_accounts_pg_checkout_override_admin_only
    before update on accounts
    for each row execute function enforce_pg_checkout_override_admin_only();

-- ------------------------------------------------------------
-- 심사관 전용 계정 지정 (예시 — 실제 심사관 전달용 테스트 계정 이메일로 바꿔서 실행)
-- 이 UPDATE는 SQL Editor에서 postgres/service_role로 직접 실행하는 것이라(auth.uid() is
-- null) 위 트리거를 그대로 통과한다.
-- ------------------------------------------------------------
-- update accounts set pg_checkout_override = true
-- where auth_id = (select id from auth.users where email = '심사관용_테스트계정_이메일');

-- ------------------------------------------------------------
-- 확인
-- ------------------------------------------------------------
select
    (select count(*) from information_schema.columns where table_name = 'accounts' and column_name = 'pg_checkout_override') as column_exists,
    (select count(*) from pg_trigger where tgname = 'trg_accounts_pg_checkout_override_admin_only') as trigger_exists;
