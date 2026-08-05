-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless fix_reservation_cancel_source_column_draft_proposed.sql was applied ⚠️
-- 롤백 — reservations.cancel_source 컬럼을 제거한다.
--
-- ⚠️ 주의: fix_reservation_cancel_grace_period_draft_proposed.sql / fix_holiday_history_and_notification_draft_proposed.sql이
-- 아직 적용돼 있다면(cancel_source를 계속 쓰는 함수 본문이 남아 있으면) 이 컬럼을 먼저
-- 지우면 그 함수들이 실행 시점에 에러를 낸다 — 반드시 그 두 함수를 먼저 롤백한 뒤 이 파일을
-- 실행할 것(역순 롤백).
-- ============================================================

BEGIN;

alter table reservations drop constraint if exists reservations_cancel_source_check;
alter table reservations drop column if exists cancel_source;

COMMIT;
