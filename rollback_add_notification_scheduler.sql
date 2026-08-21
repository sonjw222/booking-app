-- add_notification_scheduler.sql 롤백
select cron.unschedule('daily-notifications');
-- pg_cron 확장 자체는 다른 job이 의존할 수 있어 drop extension은 하지 않는다.
