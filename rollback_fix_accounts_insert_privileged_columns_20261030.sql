-- fix_accounts_insert_privileged_columns_20261030.sql 되돌리기: 새 트리거·함수만 삭제(기존 행·다른 트리거 불변).
begin;
drop trigger if exists trg_accounts_insert_privileged_columns on accounts;
drop function if exists enforce_accounts_insert_privileged_columns();
commit;
