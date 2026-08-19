-- fix_centers_update_facility_info_permission.sql 롤백
drop policy if exists "매니저 센터 수정" on centers;
create policy "매니저 센터 수정"
    on centers for update
    using (id in (select my_managed_center_ids()) or is_platform_admin())
    with check (id in (select my_managed_center_ids()) or is_platform_admin());
