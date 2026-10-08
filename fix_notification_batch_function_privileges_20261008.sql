-- ============================================================
-- 알림 배치 함수 3개 실행 권한 축소 (P2, 2026-10-08)
-- ============================================================
-- 대상: evaluate_notification_rules(), notify_expiring_passes(), notify_upcoming_reservations()
-- 문제: 라이브 덤프에 REVOKE/GRANT가 없어 기본 ACL(PUBLIC EXECUTE)이라 anon/authenticated가 PostgREST로 직접 호출할 수 있다. 본문에 호출자 확인이 없어
--       cron 시각 밖에서 알림 큐(messages/notifications) 생성이 일어나고 전체 테이블 스캔을 반복 호출할 수 있다(중복은 exists 검사로 막히지만 비용/스팸 우려).
-- 근거(호출처): app/ lib/ tests/ supabase/functions 에서 rpc로 부르는 곳이 없고(코드 주석/정적 검사만), 다른 함수가 부르는 경우도 없다.
--       실행 주체는 pg_cron(postgres 소유 job)이며 EXECUTE 회수의 영향을 받지 않는다.
-- 수정: PUBLIC/anon/authenticated의 EXECUTE를 회수하고 service_role에만 남긴다. 함수 본문/로직은 바꾸지 않는다(알림 로직은 별도 운영 안정성 작업 소관).
-- 롤백: rollback_fix_notification_batch_function_privileges_20261008.sql / 확인: verify_fix_notification_batch_function_privileges_20261008.sql
-- ⚠ Claude Code 세션에서 실행되지 않았다 — 사용자가 SQL Editor에서 직접 확인 후 실행.
-- ============================================================

revoke all on function public.evaluate_notification_rules() from public, anon, authenticated;
revoke all on function public.notify_expiring_passes() from public, anon, authenticated;
revoke all on function public.notify_upcoming_reservations() from public, anon, authenticated;

grant execute on function public.evaluate_notification_rules() to service_role;
grant execute on function public.notify_expiring_passes() to service_role;
grant execute on function public.notify_upcoming_reservations() to service_role;
