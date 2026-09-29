-- ============================================================
-- 이메일 회원가입 사전 중복 확인(2026-09-29) — OTP 발송 전에 이미 가입된 이메일인지 먼저 안내.
--
-- 배경: 기존 흐름은 이메일/비밀번호 → 휴대폰 OTP 인증 → 최종 가입 시점에야 이미 가입된
-- 이메일임을 알 수 있었다(불필요한 알림톡/SMS 발송). app/login/page.tsx의 "다음" 버튼이
-- OTP 단계로 넘어가기 전에 이 함수를 먼저 호출한다(supabase/functions/check-signup-email
-- Edge Function을 통해서만 — 클라이언트가 직접 이 함수를 호출할 수 없다, 아래 grant 참고).
--
-- 왜 auth.users.email만 비교하지 않는가: 네이버 로그인(supabase/functions/naver-login)은
-- 실제 네이버 이메일을 auth.users.email로 쓰지 않고 합성 이메일(naver-<id>@naver.
-- socialauth.invalid)을 쓴다(DEC-004, 계정 자동 병합 방지 목적) — 실제 네이버 이메일은
-- user_metadata.naver_email에만 보조 정보로 남아 있다. auth.users.email만 비교하면 "네이버로
-- 이미 가입된 실제 이메일"로 또 이메일 회원가입을 시도하는 경우를 놓친다. 카카오는 이메일
-- scope 자체가 없어(AUTH_SETUP.md 3-1절) 비교 대상 없음 — 항상 매치되지 않는다.
--
-- 이 변경은 이 함수 하나와 그 rate-limit 보조 테이블 하나만 추가한다. 기존 테이블/컬럼/
-- RLS 정책은 전혀 건드리지 않는다. DB 재생성 불필요, 여러 번 실행해도 안전(멱등).
-- ============================================================

-- ------------------------------------------------------------
-- [1] 이메일 중복 판정 함수 — 결과는 boolean 하나(가입 가능 여부)뿐이고, 어떤 계정/provider와
--     겹치는지는 절대 알려주지 않는다(enumeration 최소화). 클라이언트가 직접 호출하지
--     못하도록 anon/authenticated 실행 권한을 명시적으로 회수하고 service_role에만 준다 —
--     supabase/functions/check-signup-email이 service_role 키로만 호출한다(자체 rate limit
--     포함, 그 함수 상단 주석 참고).
-- ------------------------------------------------------------
create or replace function email_signup_available(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from auth.users
    where lower(email) = lower(trim(p_email))
       or lower(raw_user_meta_data->>'naver_email') = lower(trim(p_email))
  );
$$;

revoke all on function email_signup_available(text) from public;
revoke all on function email_signup_available(text) from anon;
revoke all on function email_signup_available(text) from authenticated;
grant execute on function email_signup_available(text) to service_role;

-- ------------------------------------------------------------
-- [2] Edge Function 자체 rate-limit용 최소 로그 테이블 — phone_verifications와 동일한
--     패턴(RLS 활성화, anon/authenticated 정책 없음 = 전부 차단, service_role만 접근).
--     이메일 원문이 아니라 클라이언트 IP의 해시만 저장한다(개인정보 최소화 — 확인하려는
--     이메일 자체는 이 테이블에 전혀 남지 않는다).
-- ------------------------------------------------------------
create table if not exists email_check_attempts (
    id          uuid primary key default gen_random_uuid(),
    ip_hash     text not null,
    created_at  timestamptz not null default now()
);

create index if not exists idx_email_check_attempts_ip_created
    on email_check_attempts (ip_hash, created_at desc);

alter table email_check_attempts enable row level security;

grant select, insert on email_check_attempts to service_role;

-- ============================================================
-- 확인
-- ============================================================
select 'email_signup_available 함수' as 항목,
       (select count(*)::text from pg_proc where proname = 'email_signup_available') as 값
union all
select 'email_check_attempts 테이블',
       (select count(*)::text from pg_tables where tablename = 'email_check_attempts')
union all
select 'anon/authenticated 실행 권한 없음(기대값 0)',
       (select count(*)::text from information_schema.role_routine_grants
         where routine_name = 'email_signup_available' and grantee in ('anon', 'authenticated'));
