-- fix_holiday_delete_restores_classes.sql 롤백
drop function if exists remove_holiday_safe(uuid);
