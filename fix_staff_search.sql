-- ============================================================
-- 스태프 검색 복구 (accounts 조회 정책의 무한 재귀 해결)
--
-- 문제였던 것:
--   accounts 조회 정책이 my_managed_center_ids() 를 호출 →
--   그 함수가 my_account_id() 호출 → accounts 를 다시 조회 →
--   또 이 정책이 발동 → 무한 재귀 → 마이페이지까지 멈춤
--
-- 해결:
--   헬퍼 함수들을 security definer 로 바꿔 RLS를 우회하게 함
--   (함수가 accounts/manager_centers 를 읽어도 정책이 다시 안 걸림)
--   그러면 재귀 없이 스태프 검색 정책을 쓸 수 있음
--
-- DB 재생성 불필요. 파일 전체를 SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================


-- ------------------------------------------------------------
-- [1] 헬퍼 함수를 security definer 로 (재귀 차단의 핵심)
-- ------------------------------------------------------------
create or replace function my_account_id()
returns uuid
language sql stable
security definer
set search_path = public
as $$
    select id from accounts where auth_id = auth.uid();
$$;

create or replace function my_profile_ids()
returns setof uuid
language sql stable
security definer
set search_path = public
as $$
    select id from profiles where account_id = my_account_id();
$$;

create or replace function my_managed_center_ids()
returns setof uuid
language sql stable
security definer
set search_path = public
as $$
    select center_id from manager_centers
    where account_id = my_account_id() and status = 'active';
$$;


-- ------------------------------------------------------------
-- [2] accounts 조회 정책 (재귀 걱정 없이 스태프/회원/검색 허용)
-- ------------------------------------------------------------
drop policy if exists "계정 조회" on accounts;
create policy "계정 조회"
    on accounts for select
    using (
        auth_id = auth.uid()
        -- 내 센터의 스태프 계정
        or id in (
            select mc.account_id from manager_centers mc
            where mc.center_id in (select my_managed_center_ids())
        )
        -- 내 센터 회원의 계정 (회원관리 전화번호 표시)
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
-- 확인: 마이페이지가 열리고, 스태프 검색이 되는지
--   아래 쿼리가 에러 없이 결과를 돌려주면 재귀가 풀린 것
-- ============================================================
select count(*) as 계정수 from accounts;


-- ============================================================
-- 완료!
--   → 마이페이지 정상 (여전히 열려야 함)
--   → 스태프 & 권한 → 스태프 추가 → 이름/전화로 검색 → 추가
-- ============================================================
