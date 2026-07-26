-- ============================================================
-- 3단계: 회원가입에 필요한 권한(RLS) 정책
--
-- 실행 순서:
--   1) schema.sql              (완료)
--   2) reservation_functions.sql
--   3) auth_policies.sql       ← 지금 이 파일
--
-- 이 파일 전체를 그대로 복사해서 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- (파일 전체를 복사해도 됩니다. 전부 실행 가능한 SQL만 들어있어요)
--
-- 왜 필요한가요?
--   RLS(Row Level Security)가 켜져 있으면 기본적으로 모든 쓰기가 막힙니다.
--   회원가입 시 accounts/profiles/centers/manager_centers에 행을 만들어야 하므로
--   "본인 것만 만들 수 있다"는 정책을 열어줍니다.
-- ============================================================


-- 재실행해도 에러 안 나게 기존 정책 먼저 정리
drop policy if exists "본인 계정 생성" on accounts;
drop policy if exists "프로필 생성" on profiles;
drop policy if exists "매니저센터 생성" on manager_centers;
drop policy if exists "센터 생성" on centers;


-- ------------------------------------------------------------
-- 가입 직후: 본인 계정 행 생성 허용
--   auth.uid() = 방금 로그인한 사람의 Supabase Auth ID
-- ------------------------------------------------------------
create policy "본인 계정 생성" on accounts for insert
    with check (auth_id = auth.uid());


-- ------------------------------------------------------------
-- 프로필 생성 허용 (가입 시 본인 대표 프로필 1개 자동 생성)
-- ------------------------------------------------------------
create policy "프로필 생성" on profiles for insert
    with check (account_id = my_account_id());


-- ------------------------------------------------------------
-- 매니저-센터 연결 생성 허용 (매니저로 가입할 때)
-- ------------------------------------------------------------
create policy "매니저센터 생성" on manager_centers for insert
    with check (account_id = my_account_id());


-- ------------------------------------------------------------
-- 센터 생성 허용 (매니저 가입 시 센터 1개 생성)
--   로그인한 사용자면 누구나 센터를 만들 수 있게 하고,
--   승인(status='pending' → 'approved')으로 노출을 통제합니다.
-- ------------------------------------------------------------
alter table centers enable row level security;

create policy "센터 생성" on centers for insert
    with check (auth.role() = 'authenticated');


-- ============================================================
-- 완료!
--
-- 다음 순서:
--   4) Supabase 대시보드 → Authentication → Providers → Email
--      → "Confirm email" 토글 OFF  (개발 중 이메일 인증 건너뛰기)
--   5) 앱에서 /login 으로 회원가입
--   6) 그 다음에 seed_data.sql 실행 (가입한 계정에 테스트 수강권을 붙임)
-- ============================================================
