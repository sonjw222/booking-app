-- fix_refund_manager_notification_20261002.sql 롤백 — 이미 생성된 알림 행은 지우지 않는다(마커 테이블만 제거).
begin;
drop trigger if exists trg_refund_completed_managers on public.memberships;
drop function if exists public.notify_refund_completed_managers();
drop table if exists public.refund_notification_events;
-- push_notification 실행 권한을 이전 상태(PUBLIC 기본 + authenticated)로 되돌린다
grant execute on function public.push_notification(uuid, text, text, text, uuid, text, jsonb) to public, anon, authenticated;
commit;
