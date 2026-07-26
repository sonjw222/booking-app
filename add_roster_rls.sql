-- ============================================================
-- 예약자 명단이 안 뜨는 문제 해결 (RLS)
--
-- 원인:
--   1) reservations 에 "매니저가 자기 센터 수업의 예약을 조회" 정책이 없었음
--      → 회원 본인 것만 보이므로 매니저 화면에서 명단이 비어 보임
--   2) profiles 는 매니저가 대표 프로필(is_primary=true)만 볼 수 있었음
--      → 가족 프로필로 예약한 회원의 이름이 안 나옴
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 1) 매니저: 자기 센터 수업의 예약 조회
drop policy if exists "매니저 센터 예약 조회" on reservations;
create policy "매니저 센터 예약 조회"
    on reservations for select
    using (
        exists (
            select 1 from classes c
            where c.id = reservations.class_id
              and (c.center_id in (select my_managed_center_ids()) or is_platform_admin())
        )
    );

-- 2) 프로필 조회 정책 (본인 + 매니저)
--    ⚠ 반드시 "account_id = my_account_id()" 를 포함해야 합니다.
--       빠뜨리면 회원이 본인 프로필도 못 읽어 로그인 후 오류가 납니다.
drop policy if exists "매니저 예약자 프로필 조회" on profiles;
drop policy if exists "매니저 센터회원 프로필 조회" on profiles;
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
-- 확인
-- ============================================================
select policyname from pg_policies where tablename in ('reservations','profiles') order by tablename, policyname;


-- ============================================================
-- 완료!
--   관리자 모드 → 오늘 수업 → 예약 n/N → 명단이 보여야 해요
-- ============================================================
