-- P1-13: 센터정보 수정 RLS가 facility.info 권한을 확인하지 않던 문제 수정.
--
-- app/manager/center-info/page.tsx 상단 주석은 "시설 정보 설정 권한(facility.info) 필요 —
-- 오너는 항상 가능"이라고 적혀 있고, app/manager/page.tsx의 메뉴 노출도 이미
-- canSeeMenu("facility.info")로 정확히 가려져 있었다(권한 카탈로그의 facility.info도
-- schema.sql에 이미 정의돼 있었음, sort_order 10). 그런데 centers UPDATE RLS 정책
-- "매니저 센터 수정"은 그 권한을 전혀 확인하지 않고 `id in (select my_managed_center_ids())`
-- (= 그 센터 소속 active 스태프면 누구나)만 확인했다 — 메뉴는 가려져 있지만 URL을 직접
-- 열면 권한 없는 스태프(트레이너 등)도 센터 소개·주소·연락처를 그대로 수정할 수 있었다.
--
-- 수정: has_permission(id, 'facility.info')로 좁힌다. has_permission()이 오너는 자동
-- 통과시키므로(is_owner=true) 오너 동작은 그대로 유지되고, 이 함수 자체가 이미
-- "그 센터 active 스태프인지"까지 함께 확인하므로 my_managed_center_ids() 조건을 따로
-- 유지할 필요가 없다(add_staff_permissions.sql의 다른 정책들과 동일한 패턴).
--
-- 기존 스태프에게 이 권한을 자동으로 부여하지 않는다 — 오너가 필요하면 매니저 →
-- 스태프 → 역할별 권한 화면(이미 있는 기존 UI, facility.info가 카탈로그에 있어 바로
-- 체크박스로 나타남)에서 직접 켜주면 된다.

drop policy if exists "매니저 센터 수정" on centers;
create policy "매니저 센터 수정"
    on centers for update
    using (has_permission(id, 'facility.info') or is_platform_admin())
    with check (has_permission(id, 'facility.info') or is_platform_admin());
