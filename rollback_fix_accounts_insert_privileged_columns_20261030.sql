-- fix_accounts_insert_privileged_columns_20261030.sql 되돌리기: 새 트리거·함수만 삭제(기존 행·다른 트리거 불변).
-- ⚠ 롤백하면 가입 시점 권한 컬럼 지정 취약점이 다시 열린다. 오류가 나도 무조건 실행하지 말고 영향을 판단한다(docs/security/ACCOUNTS_INSERT_PRIVILEGE_20261030.md).
begin;
drop trigger if exists trg_accounts_insert_privileged_columns on accounts;
drop function if exists enforce_accounts_insert_privileged_columns();
commit;
