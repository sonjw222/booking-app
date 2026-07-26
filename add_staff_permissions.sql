-- ============================================================
-- 스태프 & 권한 관리 기능 추가
--
-- 하는 일:
--   1) role_permissions.permission_key 에 FK 추가 (오타 방지)
--   2) permissions 카탈로그 조회 정책 (매니저가 권한 목록을 읽어야 함)
--   3) 스태프 초대: 오너가 자기 센터에 다른 계정을 추가할 수 있게
--   4) accounts / manager_centers 조회 정책 확장
--      (오너가 스태프/회원/초대대상 계정을 검색·조회할 수 있게)
--
-- DB 재생성 불필요. 파일 전체를 SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================


-- ------------------------------------------------------------
-- [1] role_permissions.permission_key 외래키
--     (permissions 에 없는 키가 들어가는 걸 DB가 막아줌)
-- ------------------------------------------------------------
-- 혹시 카탈로그에 없는 잘못된 키가 이미 있으면 먼저 제거
delete from role_permissions
where permission_key not in (select key from permissions);

alter table role_permissions
    drop constraint if exists role_permissions_key_fk;
alter table role_permissions
    add constraint role_permissions_key_fk
    foreign key (permission_key) references permissions(key) on delete cascade;


-- ------------------------------------------------------------
-- [2] 권한 카탈로그 조회 (모든 센터 공유 고정 목록)
-- ------------------------------------------------------------
alter table permissions enable row level security;

drop policy if exists "권한 카탈로그 조회" on permissions;
create policy "권한 카탈로그 조회"
    on permissions for select
    using (auth.uid() is not null);


-- ------------------------------------------------------------
-- [3] manager_centers 정책 재정비 (스태프 초대/조회)
--     기존 for all 정책을 쓰기 전용으로 나누고,
--     오너가 스태프를 초대/관리할 수 있는 정책을 추가
-- ------------------------------------------------------------
drop policy if exists "본인 매니저센터만 관리" on manager_centers;
drop policy if exists "본인 매니저센터 수정" on manager_centers;
drop policy if exists "본인 매니저센터 삭제" on manager_centers;
drop policy if exists "본인 매니저센터 조회" on manager_centers;
drop policy if exists "매니저센터 생성" on manager_centers;
drop policy if exists "오너 스태프 초대" on manager_centers;
drop policy if exists "오너 스태프 조회" on manager_centers;
drop policy if exists "오너 스태프 수정" on manager_centers;
drop policy if exists "오너 스태프 삭제" on manager_centers;

-- 가입 시 본인 연결 생성 (회원가입 플로우)
create policy "매니저센터 생성"
    on manager_centers for insert
    with check (account_id = my_account_id());

-- 오너가 스태프 초대 (staff.create 권한 필요)
create policy "오너 스태프 초대"
    on manager_centers for insert
    with check (has_permission(center_id, 'facility.staff.create'));

-- 조회: 본인 것 + 내가 관리하는 센터의 스태프
create policy "오너 스태프 조회"
    on manager_centers for select
    using (
        account_id = my_account_id()
        or center_id in (select my_managed_center_ids())
    );

-- 수정: 본인 것 + staff.update 권한
create policy "오너 스태프 수정"
    on manager_centers for update
    using (account_id = my_account_id() or has_permission(center_id, 'facility.staff.update'))
    with check (account_id = my_account_id() or has_permission(center_id, 'facility.staff.update'));

-- 삭제: 본인 것 + staff.delete 권한
create policy "오너 스태프 삭제"
    on manager_centers for delete
    using (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'));


-- ------------------------------------------------------------
-- [4] accounts 정책 재정비 (스태프/회원/초대대상 조회)
-- ------------------------------------------------------------
drop policy if exists "본인 계정만 접근" on accounts;
drop policy if exists "본인 계정 수정" on accounts;
drop policy if exists "본인 계정 삭제" on accounts;
drop policy if exists "계정 조회" on accounts;

create policy "본인 계정 수정"
    on accounts for update
    using (auth_id = auth.uid())
    with check (auth_id = auth.uid());

create policy "본인 계정 삭제"
    on accounts for delete
    using (auth_id = auth.uid());

create policy "계정 조회"
    on accounts for select
    using (
        auth_id = auth.uid()
        -- 내 센터의 스태프 계정
        or id in (
            select mc.account_id from manager_centers mc
            where mc.center_id in (select my_managed_center_ids())
        )
        -- 내 센터 회원의 계정
        or id in (
            select p.account_id from profiles p
            join center_members cm on cm.profile_id = p.id
            where cm.center_id in (select my_managed_center_ids())
        )
        -- 스태프 등록 권한이 있으면 초대 대상 검색 가능
        or exists (
            select 1 from manager_centers mc
            join center_roles r on r.id = mc.role_id
            where mc.account_id = my_account_id()
              and mc.status = 'active'
              and (r.is_owner = true
                   or exists (select 1 from role_permissions rp
                              where rp.role_id = r.id
                                and rp.permission_key = 'facility.staff.create'))
        )
    );


-- ============================================================
-- 확인
-- ============================================================
select 'permissions 카탈로그' as 항목, count(*)::text as 값 from permissions
union all
select '권한 정책', count(*)::text from pg_policies where tablename = 'permissions'
union all
select 'manager_centers 정책', count(*)::text from pg_policies where tablename = 'manager_centers';


-- ============================================================
-- 완료!
--   → 매니저 대시보드 → "스태프 & 권한"
--   → [역할별 권한] 탭에서 강사/매니저 역할에 권한 부여
--   → [스태프] 탭에서 다른 계정을 검색해 추가
-- ============================================================
