-- add_notification_pin.sql 롤백
drop index if exists idx_notifications_recipient_pinned;
alter table notifications drop column if exists pinned;
