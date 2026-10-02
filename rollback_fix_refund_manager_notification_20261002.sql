-- fix_refund_manager_notification_20261002.sql 롤백 — 이미 생성된 알림 행은 지우지 않는다(마커 테이블만 제거).
begin;
drop trigger if exists trg_refund_completed_managers on public.memberships;
drop function if exists public.notify_refund_completed_managers();
drop function if exists public.member_cancel_pending_order(uuid);
drop table if exists public.refund_notification_events;
commit;
