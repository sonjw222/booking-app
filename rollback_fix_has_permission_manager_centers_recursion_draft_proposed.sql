-- ============================================================
-- ROLLBACK for fix_has_permission_manager_centers_recursion_draft_proposed.sql
--
-- reservation_functions.sql:31-의 원래(security definer 아닌) 정의로 복원한다.
-- ⚠ 이 롤백을 실행하면 무한 재귀 버그(스태프 초대 실패)가 다시 재현될 수 있다.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

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

COMMIT;
