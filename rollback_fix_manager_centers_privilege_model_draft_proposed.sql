-- ============================================================
-- ROLLBACK for fix_manager_centers_privilege_model_draft_proposed.sql
--
-- add_staff_permissions.sql의 원래(2026-07-26 초기 스냅샷) 4개 정책으로 정확히 복원하고,
-- 신규 trigger를 제거하고, has_permission()을 center_id join 조건 없는 원래 정의로 되돌리고,
-- center_roles "내 센터 역할 조회" 정책도 원래의 raw manager_centers 서브쿼리로 되돌린다.
--
-- ⚠ 이 롤백은 SEC-101(임의 센터 self-join)/SEC-112(self-promote)/SEC-113(마지막 행
-- self-delete → orphan → 재클레임)과 has_permission() defense-in-depth를 전부 그대로
--되돌린다. 회귀 테스트가 실제로 이 수정 때문에 실패하는 것으로 확인된 경우에만, 그리고
-- 근본 원인을 먼저 규명한 뒤에만 사용할 것.
--
-- ⚠⚠ 주의: center_roles 정책을 raw 서브쿼리로 되돌리면 fix 파일의 [7]에서 고친
-- "infinite recursion detected in policy for relation manager_centers" 버그(2026-08-13
-- CI에서 실증 확인, 스태프 초대 기능이 깨짐)가 다시 재현된다. 이 recursion은 fix 파일의
-- [1]~[6]과 무관하게 has_permission()이 center_roles를 조회하는 모든 manager_centers
-- 정책(이 롤백이 복원하는 원본 정책들도 전부 has_permission()을 호출함)에서 재현될 수
-- 있으므로, **이 롤백 전체를 적용하면 사실상 [7] 이전 상태 = 버그가 있는 상태로 돌아간다**.
-- 정말로 필요한 경우가 아니면 [7]만 남기고 나머지만 롤백하는 것을 검토할 것.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

drop trigger if exists trg_manager_centers_role_center_match on manager_centers;
drop function if exists manager_centers_enforce_role_center_match();

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

create or replace function has_permission(p_center_id uuid, p_permission text)
returns boolean
language sql stable
as $$
    with me as (
        select mc.id as mc_id, r.is_owner, mc.role_id
        from manager_centers mc
        join center_roles r on r.id = mc.role_id
        where mc.account_id = my_account_id()
          and mc.center_id = p_center_id
          and mc.status = 'active'
        limit 1
    )
    select coalesce((
        select
            case
                when m.is_owner then true
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'deny'
                ) then false
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'allow'
                ) then true
                when exists (
                    select 1 from role_permissions rp
                    where rp.role_id = m.role_id
                      and rp.permission_key = p_permission
                ) then true
                else false
            end
        from me m
    ), false);
$$;

drop policy if exists "내 센터 역할 조회" on center_roles;
create policy "내 센터 역할 조회"
    on center_roles for select
    using (center_id in (select center_id from manager_centers where account_id = my_account_id()));

COMMIT;

-- ============================================================
-- 완료. add_staff_permissions.sql 원본 4개 정책 + 원래 has_permission() 정의 +
-- 원래 center_roles "내 센터 역할 조회" 정책(raw 서브쿼리)으로 정확히 복원됨.
-- 신규 trigger는 제거됨.
-- ============================================================
