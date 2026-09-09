-- ============================================================
-- 룸 관리 권한 카탈로그(facility.room.manage)가 실제 RLS에 연결 안 되던 버그 수정
--
-- 배경: /manager/staff → 역할별 권한 → 시설 관리 탭에는 "룸 관리 설정"(facility.room)과
-- 별개로 "룸 조회"(facility.room.view) / "룸 추가·수정·삭제"(facility.room.manage) 체크박스가
-- 있다. 그런데 rooms 테이블의 INSERT/UPDATE/DELETE RLS는 오직 facility.room 키만 확인해서,
-- facility.room.manage를 체크해도 실제로는 방 추가/수정/삭제 권한이 전혀 부여되지 않았다
-- (2026-09-09 QA에서 실제로 권한을 켜고 라이브 RLS를 대조해 재현 확인). 라이브 DB에 이미
-- facility.room.manage/facility.room.view를 부여받은 role_permissions 행이 20건 있어서,
-- 이 관리자들은 "권한을 켰다"고 믿었지만 실제로는 아무 효과가 없었다.
--
-- facility.room.view는 수정하지 않는다 — 조회(SELECT) 정책은 원래부터 그 센터를 관리하는
-- 매니저 전원에게 무조건 열려 있어서(권한 체크 없음) 이 키는 애초에 필요 없는 설계다.
--
-- 수정: INSERT/UPDATE/DELETE 정책이 facility.room 또는 facility.room.manage 둘 중 하나만
-- 있어도 통과하도록 OR 조건 추가. 기존에 facility.room으로만 권한을 부여받은 역할은 그대로
-- 동작하고(하위 호환), facility.room.manage로 부여받은 20건도 이제부터 실제로 동작한다.
--
-- DB 재생성 불필요. 여러 번 실행해도 안전(drop/create policy if exists).
-- ============================================================

drop policy if exists "룸 매니저 삭제" on rooms;
drop policy if exists "룸 매니저 생성" on rooms;
drop policy if exists "룸 매니저 수정" on rooms;

create policy "룸 매니저 삭제"
    on rooms for delete
    using (has_permission(center_id, 'facility.room') or has_permission(center_id, 'facility.room.manage') or is_platform_admin());

create policy "룸 매니저 생성"
    on rooms for insert
    with check (has_permission(center_id, 'facility.room') or has_permission(center_id, 'facility.room.manage') or is_platform_admin());

create policy "룸 매니저 수정"
    on rooms for update
    using (has_permission(center_id, 'facility.room') or has_permission(center_id, 'facility.room.manage') or is_platform_admin())
    with check (has_permission(center_id, 'facility.room') or has_permission(center_id, 'facility.room.manage') or is_platform_admin());

-- ============================================================
-- 확인
-- ============================================================
select policyname, cmd from pg_policies where tablename = 'rooms';
