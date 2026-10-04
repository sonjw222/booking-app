-- add_profiles_active_primary_unique_20261004.sql 롤백: 해당 index 하나만 제거한다. 데이터는 변경하지 않는다.
--
-- 주의: 롤백하면 multi-tab / multi-context 의 동시 primary insert 를 DB가 다시 막아주지 못한다
--       (account당 live primary 가 2개 생길 수 있는 상태로 돌아감).
-- DROP INDEX CONCURRENTLY 도 transaction block 안에서 실행할 수 없다. BEGIN/COMMIT 으로 감싸지 말 것.

drop index concurrently if exists public.profiles_one_active_primary_per_account;
