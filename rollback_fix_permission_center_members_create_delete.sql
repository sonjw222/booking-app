-- rollback: fix_permission_center_members_create_delete.sql

drop policy if exists "매니저 센터회원 등록" on center_members;
create policy "매니저 센터회원 등록"
    on center_members for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 센터회원 삭제" on center_members;
create policy "매니저 센터회원 삭제"
    on center_members for delete
    using (center_id in (select my_managed_center_ids()));
