-- add_admin_assignment_permission_gate.sql 롤백
create or replace function can_manage_center_reservations(p_center_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select p_center_id in (select my_managed_center_ids()) or is_platform_admin();
$$;
