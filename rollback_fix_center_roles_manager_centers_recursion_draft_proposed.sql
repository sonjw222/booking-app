-- ============================================================
-- ROLLBACK for fix_center_roles_manager_centers_recursion_draft_proposed.sql
--
-- reservation_functions.sql:574-576의 원래 정의로 정확히 복원한다.
-- ⚠ 이 롤백을 실행하면 "infinite recursion detected in policy for relation
-- manager_centers" 버그가 다시 재현된다(스태프 초대가 다시 깨짐) — 회귀 테스트가
-- 실제로 이 수정 때문에 실패하는 것으로 확인된 경우에만 사용할 것.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

drop policy if exists "내 센터 역할 조회" on center_roles;
create policy "내 센터 역할 조회"
    on center_roles for select
    using (center_id in (select center_id from manager_centers where account_id = my_account_id()));

COMMIT;

-- ============================================================
-- 완료. reservation_functions.sql 원본 정의로 정확히 복원됨.
-- ============================================================
