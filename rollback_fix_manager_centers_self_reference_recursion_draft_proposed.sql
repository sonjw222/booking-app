-- ============================================================
-- ROLLBACK for fix_manager_centers_self_reference_recursion_draft_proposed.sql
--
-- manager_centers 4개 정책을 raw self-subquery 버전(v3 적용 이전, v1/v2는 유지된
-- 상태)으로 되돌린다. helper 함수 3개는 drop하지 않는다(다른 곳에서 참조 중일 수
-- 있는지 확인 전에는 남겨둬도 무해함 — 필요하면 별도로 drop function).
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

drop policy if exists "매니저센터 생성" on manager_centers;
create policy "매니저센터 생성"
    on manager_centers for insert
    with check (
        account_id = my_account_id()
        and role_id is null
        and not exists (
            select 1 from manager_centers mc2
            where mc2.center_id = manager_centers.center_id
        )
    );

drop policy if exists "오너 스태프 초대" on manager_centers;
create policy "오너 스태프 초대"
    on manager_centers for insert
    with check (
        has_permission(center_id, 'facility.staff.create')
        and (
            role_id is null
            or role_id in (
                select id from center_roles cr
                where cr.center_id = manager_centers.center_id
            )
        )
    );

drop policy if exists "오너 스태프 수정" on manager_centers;
create policy "오너 스태프 수정"
    on manager_centers for update
    using (
        (account_id = my_account_id() and role_id is null)
        or has_permission(center_id, 'facility.staff.update')
    )
    with check (
        (
            role_id is null
            or role_id in (
                select id from center_roles cr
                where cr.center_id = manager_centers.center_id
            )
        )
        and (
            (
                account_id = my_account_id()
                and status = 'active'
                and role_id in (
                    select id from center_roles cr
                    where cr.center_id = manager_centers.center_id and cr.is_owner = true
                )
            )
            or has_permission(center_id, 'facility.staff.update')
        )
    );

drop policy if exists "오너 스태프 삭제" on manager_centers;
create policy "오너 스태프 삭제"
    on manager_centers for delete
    using (
        (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'))
        and exists (
            select 1 from manager_centers mc2
            where mc2.center_id = manager_centers.center_id
              and mc2.id <> manager_centers.id
        )
    );

COMMIT;
