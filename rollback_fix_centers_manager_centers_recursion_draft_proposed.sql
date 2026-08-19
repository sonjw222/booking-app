-- ============================================================
-- ROLLBACK for fix_centers_manager_centers_recursion_draft_proposed.sql
--
-- reservation_functions.sql:444-451(add_platform_admin.sql에 동일 재선언)의 원래
-- 정의로 복원한다.
-- ⚠ 이 롤백을 실행하면, manager_centers 정책이 centers를 참조하는 조건(예: SEC-101
-- 후속 orphan 방지 체크)과 결합할 때 무한 재귀가 다시 재현될 수 있다.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

drop policy if exists "승인된 센터 조회" on centers;
create policy "승인된 센터 조회"
    on centers for select using (
        status = 'approved'
        or id in (select my_managed_center_ids())
        or id in (select center_id from manager_centers where account_id = my_account_id())
        or is_platform_admin()
    );

COMMIT;
