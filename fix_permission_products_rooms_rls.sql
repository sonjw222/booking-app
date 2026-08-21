-- ============================================================
-- P1-5b (Bucket 2) — products / rooms: 실제 세분권한 연결
--
-- 배경: app/manager/goods/page.tsx, app/manager/membership-rules/page.tsx(상품 CRUD 부분),
--   app/manager/rooms/page.tsx는 권한 카탈로그(permissions)에 대응 개념이 있지만
--   (수강권=pass.create/pass.update, 룸=facility.room), 실제 RLS는 그 센터 소속
--   스태프면 누구나 통과하는 my_managed_center_ids()만 체크했다(P1-5 4차 조사로 확인).
--   즉 지금까지는 "수강권 관리 권한이 없는" 스태프도 상품을 등록/삭제하거나 룸을
--   추가/삭제할 수 있었다.
--
-- ⚠ 동작 변경(breaking change) 주의: 이 SQL을 적용하면, 해당 권한 키를 아직 역할에
--   부여하지 않은 기존 센터의 스태프는 더 이상 상품/룸을 추가·수정·삭제하지 못한다.
--   센터 오너는 "스태프 & 권한" 화면에서 필요한 스태프에게 pass.create/pass.update
--   (수강권), facility.room(룸)을 미리 부여해두는 게 좋다. 오너 계정은 항상 전권이라
--   영향 없음.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- products: pass.create(등록) / pass.update(수정·삭제)
-- ------------------------------------------------------------
drop policy if exists "매니저 상품 생성" on products;
create policy "매니저 상품 생성"
    on products for insert
    with check (has_permission(center_id, 'pass.create') or is_platform_admin());

drop policy if exists "매니저 상품 수정" on products;
create policy "매니저 상품 수정"
    on products for update
    using (has_permission(center_id, 'pass.update') or is_platform_admin())
    with check (has_permission(center_id, 'pass.update') or is_platform_admin());

drop policy if exists "매니저 상품 삭제" on products;
create policy "매니저 상품 삭제"
    on products for delete
    using (has_permission(center_id, 'pass.update') or is_platform_admin());

-- ------------------------------------------------------------
-- rooms: facility.room (등록/수정/삭제 공통 — 세분화된 키 없음)
--   "룸 공개 조회"(select using true)는 그대로 둔다 — 별도 permissive select 정책이라
--   for all에서 select 부분만 걷어내도 조회는 그대로 열려 있다.
-- ------------------------------------------------------------
drop policy if exists "룸 매니저 관리" on rooms;
drop policy if exists "룸 매니저 생성" on rooms;
create policy "룸 매니저 생성"
    on rooms for insert
    with check (has_permission(center_id, 'facility.room') or is_platform_admin());

drop policy if exists "룸 매니저 수정" on rooms;
create policy "룸 매니저 수정"
    on rooms for update
    using (has_permission(center_id, 'facility.room') or is_platform_admin())
    with check (has_permission(center_id, 'facility.room') or is_platform_admin());

drop policy if exists "룸 매니저 삭제" on rooms;
create policy "룸 매니저 삭제"
    on rooms for delete
    using (has_permission(center_id, 'facility.room') or is_platform_admin());

-- ============================================================
-- 확인
-- ============================================================
select tablename, policyname, cmd from pg_policies
 where tablename in ('products', 'rooms')
 order by tablename, cmd;
