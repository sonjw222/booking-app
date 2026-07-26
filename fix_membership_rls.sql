-- ============================================================
-- 수강권 발급 + 회원 추가 RLS 수정 (묶음)
--
-- 문제 1: memberships 에 SELECT 정책만 있어 매니저가 수강권 발급 불가
--          ("new row violates row-level security policy for memberships")
-- 문제 2: 신규 회원을 센터에 등록하려 해도, 아직 센터에 없는 사람의
--          대표 프로필을 검색할 수 없어 "회원 추가"가 안 됨
--          (수강권 발급 대상에 뜨려면 먼저 센터 회원으로 등록 필요)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================


-- ------------------------------------------------------------
-- [1] memberships: 매니저 발급/수정/조회
-- ------------------------------------------------------------
drop policy if exists "내 프로필 수강권 조회" on memberships;

drop policy if exists "매니저 수강권 조회" on memberships;
create policy "매니저 수강권 조회"
    on memberships for select
    using (
        profile_id in (select my_profile_ids())
        or has_permission(center_id, 'customer.member.view')
    );

drop policy if exists "매니저 수강권 발급" on memberships;
create policy "매니저 수강권 발급"
    on memberships for insert
    with check (has_permission(center_id, 'customer.member.issue_pass'));

drop policy if exists "매니저 수강권 수정" on memberships;
create policy "매니저 수강권 수정"
    on memberships for update
    using (has_permission(center_id, 'customer.member.issue_pass'))
    with check (has_permission(center_id, 'customer.member.issue_pass'));


-- ------------------------------------------------------------
-- [2] profiles: 매니저가 신규 회원(대표 프로필) 검색 가능
--     센터를 운영 중인 매니저만, 대표 프로필의 이름만 노출
-- ------------------------------------------------------------
drop policy if exists "매니저 대표프로필 검색" on profiles;
create policy "매니저 대표프로필 검색"
    on profiles for select
    using (
        is_primary = true
        and exists (
            select 1 from manager_centers mc
            where mc.account_id = my_account_id() and mc.status = 'active'
        )
    );


-- ------------------------------------------------------------
-- [3] accounts: 매니저가 전화번호로 회원 검색 가능
-- ------------------------------------------------------------
drop policy if exists "매니저 계정 검색" on accounts;
create policy "매니저 계정 검색"
    on accounts for select
    using (
        exists (
            select 1 from manager_centers mc
            where mc.account_id = my_account_id() and mc.status = 'active'
        )
    );


-- ============================================================
-- 확인
-- ============================================================
select tablename, policyname, cmd
from pg_policies
where tablename in ('memberships', 'profiles')
order by tablename, cmd;


-- ============================================================
-- 완료!  이제 이 흐름이 됩니다:
--   회원 관리 → "+회원" → 이름 검색 → 등록
--   → 매출 관리 → +등록 → 그 회원 + 상품 선택 → 수강권 발급 성공
-- ============================================================
