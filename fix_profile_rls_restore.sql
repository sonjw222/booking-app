-- ============================================================
-- ⚠ 긴급 복구: "프로필을 찾을 수 없어요" 오류 해결
--
-- 원인:
--   add_roster_rls.sql 이 기존 "매니저 센터회원 프로필 조회" 정책을
--   같은 이름으로 덮어쓰면서, 원래 있던
--       account_id = my_account_id()   ← "내 프로필은 내가 본다"
--   조건이 빠졌습니다. 그래서 로그인해도 본인 프로필을 못 읽었어요.
--
-- 이 파일이 본인 조회 + 매니저 조회를 모두 포함한 올바른 버전으로 되돌립니다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 잘못 덮어쓴 정책 정리
drop policy if exists "매니저 예약자 프로필 조회" on profiles;
drop policy if exists "매니저 센터회원 프로필 조회" on profiles;

-- 올바른 통합 정책 복원
--   1) 본인 계정의 프로필  (★ 이게 빠져서 오류가 났습니다)
--   2) 내가 관리하는 센터의 회원 프로필
--   3) 내가 관리하는 센터 수업의 예약자 프로필 (예약자 명단용)
create policy "매니저 센터회원 프로필 조회"
    on profiles for select
    using (
        account_id = my_account_id()
        or id in (
            select cm.profile_id from center_members cm
            where cm.center_id in (select my_managed_center_ids())
        )
        or id in (
            select r.profile_id from reservations r
            join classes c on c.id = r.class_id
            where c.center_id in (select my_managed_center_ids())
        )
        or is_platform_admin()
    );


-- ============================================================
-- 확인 1: profiles 정책 목록
-- ============================================================
select policyname, cmd from pg_policies
where tablename = 'profiles'
order by policyname;

-- ============================================================
-- 확인 2: 본인 조회 조건이 들어있는지 (account_id 문구가 보여야 정상)
-- ============================================================
select policyname, qual
from pg_policies
where tablename = 'profiles' and policyname = '매니저 센터회원 프로필 조회';


-- ============================================================
-- 완료!
--   로그아웃 후 다시 로그인해보세요.
-- ============================================================
