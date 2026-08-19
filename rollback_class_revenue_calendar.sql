-- ============================================================
-- 수업매출 캘린더 기능 롤백
--
-- add_class_revenue_schema.sql / add_set_membership_session_amounts_rpc.sql /
-- add_class_revenue_daily_summary_rpc.sql / add_class_revenue_for_date_rpc.sql를
-- 전부 되돌린다. 기존 기능(매출/예약/수강권 등)은 전혀 건드리지 않으므로 안전.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

drop function if exists class_revenue_for_date(uuid, date);
drop function if exists class_revenue_daily_summary(uuid, date, date);
drop function if exists set_membership_session_amounts(uuid, int[]);

alter table center_settings drop column if exists unlimited_pass_revenue_mode;

drop table if exists membership_session_amounts;

COMMIT;
