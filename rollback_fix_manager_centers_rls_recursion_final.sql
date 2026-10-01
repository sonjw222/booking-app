-- ============================================================
-- fix_manager_centers_rls_recursion_final.sql 롤백 — 적용 직전 라이브 정책(2026-10-01 조회)으로 복원.
-- ⚠ 롤백하면 "매니저센터 생성" 정책의 raw self-subquery가 되살아나 스태프 추가가 다시
--   "infinite recursion detected in policy for relation manager_centers"로 실패한다(QA 9 이전 상태).
--   새 헬퍼(manager_centers_is_last_active_owner)만 제거하고, 기존 헬퍼 4개는 라이브에 원래 있었으므로 유지한다.
-- ============================================================
BEGIN;

drop policy if exists "매니저센터 생성" on manager_centers;
create policy "매니저센터 생성"
    on manager_centers for insert
    with check (
        account_id = my_account_id()
        and role_id is null
        and not exists (select 1 from manager_centers mc2 where mc2.center_id = manager_centers.center_id)
    );

drop policy if exists "오너 스태프 초대" on manager_centers;
create policy "오너 스태프 초대"
    on manager_centers for insert
    with check (
        has_permission(center_id, 'facility.staff.create')
        and (role_id is null or role_id_belongs_to_center(role_id, center_id))
    );

drop policy if exists "오너 스태프 수정" on manager_centers;
create policy "오너 스태프 수정"
    on manager_centers for update
    using (
        (account_id = my_account_id() and role_id is null and not manager_centers_has_any_row(center_id, id))
        or has_permission(center_id, 'facility.staff.update')
    )
    with check (
        (role_id is null or role_id_belongs_to_center(role_id, center_id))
        and (
            (account_id = my_account_id() and status = 'active' and role_id_is_owner_for_center(role_id, center_id))
            or has_permission(center_id, 'facility.staff.update')
        )
    );

drop policy if exists "오너 스태프 삭제" on manager_centers;
create policy "오너 스태프 삭제"
    on manager_centers for delete
    using (
        (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'))
        and manager_centers_has_any_row(center_id, id)
    );

drop trigger if exists manager_centers_protect_last_owner on manager_centers;
drop function if exists manager_centers_protect_last_owner();
drop function if exists manager_centers_is_last_active_owner(uuid, uuid);

COMMIT;
