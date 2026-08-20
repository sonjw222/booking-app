-- fix_rls_gap_batch_a2_contracts_notification_logs_draft_proposed.sql 롤백
--
-- SELECT 정책 2개를 제거해 적용 이전 상태(정책 0건 — 오너 포함 아무도 조회 불가)로
-- 되돌린다. ⚠ 앱에 이 두 테이블을 쓰는 기능이 아직 없어 되돌려도 실사용에 영향은 없지만,
-- 이 정책에 의존해 새로 작성한 통합 테스트(있다면)는 다시 실패하게 된다.
--
-- GRANT는 되돌리지 않는다 — service_role GRANT 철회는 진단/테스트 도구를 다시 못 쓰게
-- 만들 뿐 보안 이득이 없다(service_role은 애초에 RLS를 우회하는 신뢰된 키).
--
-- 여러 번 실행해도 안전.

BEGIN;

drop policy if exists "본인 또는 권한 보유 스태프 계약서 조회" on contracts;
drop policy if exists "권한 보유 스태프 알림발송기록 조회" on notification_logs;

COMMIT;
