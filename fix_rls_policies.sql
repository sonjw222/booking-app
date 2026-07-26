-- ============================================================
-- 긴급 패치: RLS 정책에 with check 누락 수정
--
-- 증상: 회원가입 시 "new row violates row-level security policy for table accounts"
--
-- 원인:
--   'for all' 정책에 using()만 있고 with check()가 없으면
--   PostgreSQL은 그 정책의 INSERT를 항상 거부합니다.
--   (using = 읽기/기존행 판단, with check = 새로 쓰는 행 판단)
--   같은 명령에 정책이 여러 개면 전부 통과해야 하므로,
--   "본인 계정 생성"(INSERT) 정책이 있어도 "본인 계정만 접근"(ALL)이 막아버림.
--
-- 이 파일만 실행하면 됩니다. DB를 다시 만들 필요 없어요.
-- 파일 전체를 복사해서 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- ============================================================


-- ------------------------------------------------------------
-- 1. 계정 / 프로필 / 매니저센터 (schema.sql에서 만든 정책)
-- ------------------------------------------------------------
drop policy if exists "본인 계정만 접근" on accounts;
create policy "본인 계정만 접근"
    on accounts for all
    using (auth_id = auth.uid())
    with check (auth_id = auth.uid());

drop policy if exists "본인 프로필만 관리" on profiles;
create policy "본인 프로필만 관리"
    on profiles for all
    using (account_id = my_account_id())
    with check (account_id = my_account_id());

drop policy if exists "본인 매니저센터만 관리" on manager_centers;
create policy "본인 매니저센터만 관리"
    on manager_centers for all
    using (account_id = my_account_id())
    with check (account_id = my_account_id());


-- ------------------------------------------------------------
-- 2. 나머지 정책 (reservation_functions.sql에서 만든 정책)
--    아직 그 파일을 실행 안 했다면 이 섹션은 에러 없이 넘어갑니다.
-- ------------------------------------------------------------
drop policy if exists "본인 색상 설정 관리" on member_center_colors;
create policy "본인 색상 설정 관리"
    on member_center_colors for all
    using (account_id = my_account_id())
    with check (account_id = my_account_id());

drop policy if exists "매니저 강사 배정" on class_trainers;
create policy "매니저 강사 배정"
    on class_trainers for all
    using (class_id in (select id from classes where center_id in (select my_managed_center_ids())))
    with check (class_id in (select id from classes where center_id in (select my_managed_center_ids())));

drop policy if exists "오너만 역할 관리" on center_roles;
create policy "오너만 역할 관리"
    on center_roles for all
    using (has_permission(center_id, 'role.manage'))
    with check (has_permission(center_id, 'role.manage'));

drop policy if exists "오너만 권한 부여" on role_permissions;
create policy "오너만 권한 부여"
    on role_permissions for all
    using (role_id in (select id from center_roles where has_permission(center_id, 'role.manage')))
    with check (role_id in (select id from center_roles where has_permission(center_id, 'role.manage')));

drop policy if exists "매니저 항목 관리" on center_member_fields;
create policy "매니저 항목 관리"
    on center_member_fields for all
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "본인 입력값 관리" on profile_center_fields;
create policy "본인 입력값 관리"
    on profile_center_fields for all
    using (profile_id in (select my_profile_ids()))
    with check (profile_id in (select my_profile_ids()));

drop policy if exists "매니저 상품 관리" on products;
create policy "매니저 상품 관리"
    on products for all
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 상담채널 관리" on center_contacts;
create policy "매니저 상담채널 관리"
    on center_contacts for all
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 템플릿 관리" on schedule_templates;
create policy "매니저 템플릿 관리"
    on schedule_templates for all
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 알림규칙 관리" on notification_rules;
create policy "매니저 알림규칙 관리"
    on notification_rules for all
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));


-- ============================================================
-- 완료! 이제 앱에서 회원가입을 다시 시도해보세요.
-- ============================================================
