-- 계정당 "살아 있는" 대표 프로필(is_primary = true AND deleted_at IS NULL)을 최대 1개로 강제하는 partial unique index.
--
-- [상태] 2026-10-04 Production에 이미 수동 적용 및 검증 완료. 이 파일은 schema/migration 이력 기록과 다른 환경 재현용이다.
--        Production에서 재실행할 필요 없다(IF NOT EXISTS라 재실행해도 무해하지만 하지 않는다).
--
-- [범위] account별 live primary 최대 1개만 강제한다.
--        deleted_at 이 있는 과거(삭제/익명화) primary 행과 is_primary = false 추가/가족/자녀 프로필에는 영향 없다.
--
-- [주의] 적용 전에 같은 account에 live primary가 2개 이상인 중복 데이터가 있으면 index 생성이 실패한다.
--        이 migration은 데이터를 수정/정리/자동 demotion 하지 않는다 — 중복이 있으면 조용히 고치지 말고 실패하게 두고 원인을 직접 조사할 것
--        (중복 확인: verify_profiles_active_primary_unique_20261004.sql 의 duplicate_active_primary_accounts).
--        profiles.deleted_at 컬럼(fix_profile_delete_soft_delete.sql)이 먼저 존재해야 한다.
--
-- [중요] CREATE INDEX CONCURRENTLY 는 transaction block 안에서 실행할 수 없다. BEGIN/COMMIT 으로 감싸지 말 것.
--        (Supabase SQL editor/psql 에서 이 문장을 단독 실행한다.)
--
-- 롤백: rollback_add_profiles_active_primary_unique_20261004.sql / 검증: verify_profiles_active_primary_unique_20261004.sql

create unique index concurrently if not exists profiles_one_active_primary_per_account
on public.profiles (account_id)
where is_primary = true
  and deleted_at is null;
