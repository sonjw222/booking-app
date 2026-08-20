-- Rollback for cleanup_p2_25_leftover_test_center_holiday.sql
-- 원래 leftover 행을 그대로 복원한다(테스트 데이터라 실질적 의미는 없음).

BEGIN;

insert into center_holidays (id, center_id, holiday_date)
values ('792d805e-9822-48c1-935a-ec39c29ccc7b', '5aa6e0b6-7e4a-47a3-b705-afc9a0cae4d7', '2026-08-27')
on conflict (center_id, holiday_date) do nothing;

COMMIT;
