-- rollback: fix_permission_products_rooms_rls.sql
-- products/rooms를 has_permission() 체크 이전(my_managed_center_ids()만 체크)으로 되돌림.

drop policy if exists "매니저 상품 생성" on products;
create policy "매니저 상품 생성"
    on products for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 상품 수정" on products;
create policy "매니저 상품 수정"
    on products for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 상품 삭제" on products;
create policy "매니저 상품 삭제"
    on products for delete
    using (center_id in (select my_managed_center_ids()));

drop policy if exists "룸 매니저 생성" on rooms;
drop policy if exists "룸 매니저 수정" on rooms;
drop policy if exists "룸 매니저 삭제" on rooms;
create policy "룸 매니저 관리"
    on rooms for all
    using (center_id in (select my_managed_center_ids()) or is_platform_admin())
    with check (center_id in (select my_managed_center_ids()) or is_platform_admin());
