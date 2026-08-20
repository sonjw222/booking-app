-- ============================================================
-- RLS Gap Batch A2 — contracts(SELECT만), notification_logs(SELECT만)
--
-- [배경] docs/22_RLS_Gap_A2_Investigation.md에서 조사 완료(2026-08 초). RLS는 활성화돼
-- 있지만 정책이 0건이라 오너를 포함해 아무도 조회할 수 없는 "완전 차단" 상태였다. 두
-- 테이블 다 앱 코드에서 실사용 0건(계약서 발급/알림 로그 기록 기능 자체가 아직 미구현) —
-- 지금 정책을 추가해도 기존 기능에 영향 없음.
--
-- INSERT/UPDATE/DELETE는 의도적으로 정책을 넣지 않는다(기본 거부 유지):
--   - contracts: 계약 발급은 실제 기능 구현 시 RPC(security definer)로 원자적 처리하는 게
--     맞음(클라이언트 직접 INSERT는 계약 내용 조작 방지 관점에서 약한 보장). 서명된 계약서는
--     법적 증빙이라 UPDATE/DELETE도 영구히 클라이언트에 열지 않음.
--   - notification_logs: append-only 감사/정산 로그, 서버 트리거 전용으로 설계(그 트리거
--     자체는 아직 미구현) — 클라이언트가 직접 쓸 이유가 없음.
--
-- service_role GRANT는 이미 Live에 적용돼 있음을 2026-08-18 read-only로 확인함(이 파일은
-- GRANT를 다시 실행하지 않음 — 이미 있는 걸 재실행해도 무해하지만 불필요).
-- ============================================================

BEGIN;

drop policy if exists "본인 또는 권한 보유 스태프 계약서 조회" on contracts;
create policy "본인 또는 권한 보유 스태프 계약서 조회"
    on contracts for select
    using (
        profile_id in (select id from profiles where account_id = my_account_id())
        or has_permission(center_id, 'contract.list.view')
        or is_platform_admin()
    );
-- INSERT/UPDATE/DELETE: 의도적으로 정책 없음 → 기본 거부.

drop policy if exists "권한 보유 스태프 알림발송기록 조회" on notification_logs;
create policy "권한 보유 스태프 알림발송기록 조회"
    on notification_logs for select
    using (
        has_permission(center_id, 'message.sms.view')
        or has_permission(center_id, 'message.push.view')
        or is_platform_admin()
    );
-- INSERT/UPDATE/DELETE: 의도적으로 정책 없음 → 기본 거부(서버 트리거 전용, 아직 미구현).

COMMIT;

-- ============================================================
-- 완료 후 아래로 확인:
--   select tablename, policyname, cmd, qual from pg_policies
--   where tablename in ('contracts', 'notification_logs');
-- ============================================================
