-- ============================================================
-- (별도 보안 초안 · 이번 NICEPAY 변경과 독립 · 운영 미실행) accounts INSERT 시점의 특권 컬럼 보호 — 2026-10-30
--
-- 발견: "본인 계정 생성" RLS 정책은 `auth_id = auth.uid()` 만 확인하고(컬럼 값 미확인), authenticated 에 accounts 전체 컬럼 INSERT 권한이 있으며,
--   기존 보호 트리거 3개(is_platform_admin / pg_checkout_override / merged_into)는 모두 BEFORE UPDATE 전용이다.
--   → 신규 가입자(계정 행이 아직 없는 인증 사용자)가 계정 행을 만들 때 is_platform_admin=true / pg_checkout_override=true / merged_into=<다른 계정 id> 를 직접 지정할 수 있다.
--   로컬 일회용 Supabase 에서 실제 인증(signUp)+REST 로 재현: is_platform_admin()=true, my_account_id()==다른 계정 id. 운영도 같은 정책·트리거·권한 구성임을 읽기 전용으로 확인(트리거 4개 전부 INSERT 미적용).
-- 해결: BEFORE INSERT 트리거 1개 — 호출자가 인증 사용자(auth.uid() 있음)이고 플랫폼 관리자가 아니면 세 값을 거부한다.
--   · 서버(service_role)·SQL Editor(auth.uid() is null)·플랫폼 관리자는 통과. merged_into 는 기존 UPDATE 가드와 같은 예외(app.allow_merged_into_change)를 따른다.
--   · 정상 가입(앱 가입 화면은 이 컬럼들을 보내지 않음 → 기본값)은 그대로 통과. 기존 행·기존 트리거 변경 없음(새 트리거만 추가).
-- 롤백: rollback_fix_accounts_insert_privileged_columns_20261030.sql. 검증: verify_fix_accounts_insert_privileged_columns_20261030.sql(읽기 전용).
-- ============================================================
begin;
create or replace function enforce_accounts_insert_privileged_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_platform_admin() then
    if new.is_platform_admin or new.pg_checkout_override then
      raise exception '이 값은 운영자만 변경할 수 있어요';
    end if;
    if new.merged_into is not null and coalesce(current_setting('app.allow_merged_into_change', true), 'false') <> 'true' then
      raise exception 'merged_into는 계정 연동 절차(link_accounts_by_code)를 통해서만 변경할 수 있어요';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_accounts_insert_privileged_columns on accounts;
create trigger trg_accounts_insert_privileged_columns before insert on accounts
  for each row execute function enforce_accounts_insert_privileged_columns();
commit;
