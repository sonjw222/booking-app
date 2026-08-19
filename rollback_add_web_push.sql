-- add_web_push.sql 롤백
select cron.unschedule('dispatch-web-push');

drop index if exists idx_notifications_unpushed;
alter table notifications drop column if exists pushed_at;

drop policy if exists "푸시 구독 본인 삭제" on push_subscriptions;
drop policy if exists "푸시 구독 본인 등록" on push_subscriptions;
drop policy if exists "푸시 구독 본인 조회" on push_subscriptions;
drop table if exists push_subscriptions;

-- pg_net은 다른 기능이 쓸 수 있어 확장 자체는 제거하지 않음
