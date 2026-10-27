-- ============================================================
-- accounts INSERT 시점의 특권 컬럼 보호 — 2026-10-30 (보안 수정)
--
-- 문제: "본인 계정 생성" RLS 정책은 `auth_id = auth.uid()`(와 전화번호 인증)만 확인하고 컬럼 값을 보지 않으며, authenticated 에는 accounts 전체 컬럼 INSERT 권한이 있다.
--   그런데 특권 컬럼을 지키는 트리거 3개 — trg_accounts_is_platform_admin_admin_only / trg_accounts_pg_checkout_override_admin_only / trg_accounts_merged_into_via_linking_only — 는
--   모두 BEFORE UPDATE 전용이다. 따라서 계정 행이 아직 없는 인증 사용자가 가입(INSERT) 시점에 다음을 직접 지정할 수 있었다(로컬 일회용 Supabase 에서 실제 인증+REST 로 재현):
--     · is_platform_admin = true            → is_platform_admin() 가 true (플랫폼 관리자 권한)
--     · pg_checkout_override = true          → 토스 심사용 결제 우회 권한
--     · merged_into = <다른 계정 id>         → my_account_id() 가 다른 계정 id 를 반환(그 계정의 데이터에 접근 — 계정 사칭)
--   (참고: trg_accounts_phone_verified 는 별개다 — 이미 있는 행의 phone 이 바뀔 때 "최근 휴대폰 인증"을 요구하는 UPDATE 트리거이며 관리자 권한과 무관하다.
--    INSERT 시점의 휴대폰 인증은 위 RLS 정책의 `phone IS NULL OR _is_phone_recently_verified(phone)` 조건이 담당한다.)
-- 해결: BEFORE INSERT 트리거 1개. 호출자가 인증 사용자(auth.uid() 있음)일 때만 검사한다.
--   · is_platform_admin / pg_checkout_override 가 true 이면 호출자가 플랫폼 관리자가 아닌 한 거부(기존 UPDATE 가드와 같은 문구·같은 기준).
--   · merged_into 가 null 이 아니면 계정 연동 절차(link_accounts_by_code 가 트랜잭션 로컬로 켜는 app.allow_merged_into_change)가 아닌 한 거부(기존 UPDATE 가드와 같은 기준).
--   · 서버(service_role)·SQL Editor(auth.uid() is null)는 통과. 정상 가입(앱 가입 화면은 이 컬럼들을 보내지 않아 기본값)은 검사 함수를 호출하지 않고 통과한다.
--   · upsert(INSERT … ON CONFLICT DO UPDATE)는 INSERT·UPDATE 트리거를 모두 거치므로 같은 기준이다. 삭제 후 재생성도 INSERT 이므로 같은 기준이다.
-- 변경하지 않는 것: 기존 행, 기존 트리거·정책·권한, 계정 연동(UPDATE 경로). 이 SQL 은 이미 만들어진 비정상 권한·계정 연결을 복구하지 않는다(읽기 전용 점검은 docs/security/ACCOUNTS_INSERT_PRIVILEGE_20261030.md).
-- 단일 트랜잭션(BEGIN…COMMIT). 롤백: rollback_fix_accounts_insert_privileged_columns_20261030.sql(롤백하면 취약점이 다시 열린다). 검증: verify_fix_accounts_insert_privileged_columns_20261030.sql(읽기 전용).
-- ============================================================
begin;
create or replace function enforce_accounts_insert_privileged_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- 서버(service_role)·SQL Editor
  if (new.is_platform_admin or new.pg_checkout_override) and not is_platform_admin() then
    raise exception '이 값은 운영자만 변경할 수 있어요';
  end if;
  if new.merged_into is not null and coalesce(current_setting('app.allow_merged_into_change', true), 'false') <> 'true' then
    raise exception 'merged_into는 계정 연동 절차(link_accounts_by_code)를 통해서만 변경할 수 있어요';
  end if;
  return new;
end $$;
drop trigger if exists trg_accounts_insert_privileged_columns on accounts;
create trigger trg_accounts_insert_privileged_columns before insert on accounts
  for each row execute function enforce_accounts_insert_privileged_columns();
select 1/0;
commit;
