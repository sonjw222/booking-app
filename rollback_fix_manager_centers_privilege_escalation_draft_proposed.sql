-- ============================================================
-- ROLLBACK for fix_manager_centers_privilege_escalation_draft_proposed.sql
-- (SEC-101 + SEC-112 + SEC-113)
--
-- add_staff_permissions.sql의 원래(2026-07-26 초기 스냅샷) 4개 정책으로 정확히 복원한다.
-- ⚠ 이 롤백은 SEC-101(임의 센터 self-join)/SEC-112(self-promote)/SEC-113(마지막 행
-- self-delete → orphan → 재클레임)을 전부 그대로 되돌린다 — 회귀 테스트가 실제로 이
-- 수정 때문에 실패하는 것으로 확인된 경우에만, 그리고 근본 원인을 먼저 규명한 뒤에만
-- 사용할 것.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

drop policy if exists "매니저센터 생성" on manager_centers;
create policy "매니저센터 생성"
    on manager_centers for insert
    with check (account_id = my_account_id());

drop policy if exists "오너 스태프 초대" on manager_centers;
create policy "오너 스태프 초대"
    on manager_centers for insert
    with check (has_permission(center_id, 'facility.staff.create'));

drop policy if exists "오너 스태프 수정" on manager_centers;
create policy "오너 스태프 수정"
    on manager_centers for update
    using (account_id = my_account_id() or has_permission(center_id, 'facility.staff.update'))
    with check (account_id = my_account_id() or has_permission(center_id, 'facility.staff.update'));

drop policy if exists "오너 스태프 삭제" on manager_centers;
create policy "오너 스태프 삭제"
    on manager_centers for delete
    using (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'));

COMMIT;

-- ============================================================
-- 완료. add_staff_permissions.sql 원본 4개 정책으로 정확히 복원됨.
-- ============================================================
