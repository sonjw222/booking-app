-- ============================================================
-- 회원관리 기능 추가 (RLS 정책)
--
-- 하는 일:
--   1) center_members / member_grades 에 RLS 켜고 정책 부여
--      (지금은 RLS가 꺼져 있어서 아무나 모든 센터의 회원 목록을
--       읽을 수 있는 상태 → 개인정보 문제. 반드시 적용 필요)
--   2) 매니저가 자기 센터 회원의 '이름'을 볼 수 있게 profiles 정책 조정
--
-- DB 재생성 불필요. 파일 전체를 SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================


-- ------------------------------------------------------------
-- [1] 회원 등급
-- ------------------------------------------------------------
alter table member_grades enable row level security;

drop policy if exists "매니저 등급 조회" on member_grades;
create policy "매니저 등급 조회"
    on member_grades for select
    using (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 등급 생성" on member_grades;
create policy "매니저 등급 생성"
    on member_grades for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 등급 수정" on member_grades;
create policy "매니저 등급 수정"
    on member_grades for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 등급 삭제" on member_grades;
create policy "매니저 등급 삭제"
    on member_grades for delete
    using (center_id in (select my_managed_center_ids()));


-- ------------------------------------------------------------
-- [2] 센터 회원 명단
-- ------------------------------------------------------------
alter table center_members enable row level security;

-- 매니저는 자기 센터 회원만, 회원 본인은 자기 행만
drop policy if exists "센터회원 조회" on center_members;
create policy "센터회원 조회"
    on center_members for select
    using (
        center_id in (select my_managed_center_ids())
        or profile_id in (select my_profile_ids())
    );

drop policy if exists "매니저 센터회원 등록" on center_members;
create policy "매니저 센터회원 등록"
    on center_members for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 센터회원 수정" on center_members;
create policy "매니저 센터회원 수정"
    on center_members for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 센터회원 삭제" on center_members;
create policy "매니저 센터회원 삭제"
    on center_members for delete
    using (center_id in (select my_managed_center_ids()));


-- ------------------------------------------------------------
-- [3] profiles 정책 조정
--
--   기존 "본인 프로필만 관리"(for all)는 SELECT 에도 조건이 걸려서,
--   매니저가 회원 이름을 조회하는 정책과 충돌합니다.
--   (같은 명령에 정책이 여러 개면 전부 통과해야 하므로 조회 불가)
--   → 쓰기는 본인만, 조회는 별도 정책으로 분리합니다.
-- ------------------------------------------------------------
drop policy if exists "본인 프로필만 관리" on profiles;

drop policy if exists "본인 프로필 생성" on profiles;
create policy "본인 프로필 생성"
    on profiles for insert
    with check (account_id = my_account_id());

drop policy if exists "본인 프로필 수정" on profiles;
create policy "본인 프로필 수정"
    on profiles for update
    using (account_id = my_account_id())
    with check (account_id = my_account_id());

drop policy if exists "본인 프로필 삭제" on profiles;
create policy "본인 프로필 삭제"
    on profiles for delete
    using (account_id = my_account_id());

-- 조회: 본인 프로필 + 내 센터 회원/예약자의 프로필
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
    );


-- ============================================================
-- 확인
-- ============================================================
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('center_members', 'member_grades', 'profiles')
order by tablename, cmd;


-- ============================================================
-- 완료!
--   → 매니저 계정으로 로그인 → 매니저 대시보드 → "회원 관리"
--   → 회원이 안 보이면 "예약자 동기화" 버튼을 누르세요
--     (앱으로 예약한 회원을 센터 회원 명단에 등록합니다)
-- ============================================================
