-- add_account_deactivation.sql 롤백
alter table accounts drop column if exists deactivated_at;
