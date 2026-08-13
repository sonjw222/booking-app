-- 정기 알림 스케줄러 (P0-5).
--
-- add_notifications.sql이 만든 notify_upcoming_reservations()/notify_expiring_passes()는
-- 함수만 존재할 뿐 저절로 실행되지 않는다(README.md 5절, docs/TODO.md P0-5) — 지금까지는
-- 사람이 수동으로 호출해야 했다. Supabase가 기본 지원하는 pg_cron으로 매일 자동 실행되게
-- 등록한다(무료 플랜 포함 전 플랜에서 사용 가능, 외부 서비스/사업자 등록 불필요).
--
-- 두 함수 모두 이미 멱등하다(같은 예약/같은 수강권에 같은 종류 알림이 있으면 건너뜀,
-- add_notifications.sql 참고) — 재실행되거나 이 마이그레이션을 다시 적용해도 중복 알림이
-- 쌓이지 않는다. cron.schedule()도 같은 job 이름으로 다시 호출하면 기존 스케줄을
-- 덮어쓰므로(pg_cron 표준 동작) 이 파일을 다시 실행해도 안전하다.

create extension if not exists pg_cron with schema extensions;

-- 매일 UTC 0시(= KST 오전 9시)에 두 함수를 순서대로 실행.
select cron.schedule(
    'daily-notifications',
    '0 0 * * *',
    $$ select notify_upcoming_reservations(); select notify_expiring_passes(); $$
);
