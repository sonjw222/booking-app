-- ============================================================
-- 이메일 회원가입 사전 중복 확인(2026-09-29, 2026-09-30 보안 보완) — OTP 발송 전에 이미
-- 가입된 이메일인지 먼저 안내.
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
-- 2026-09-30 보안 보완(코드 리뷰 반영):
--   1) 두 SECURITY DEFINER 함수 모두 `set search_path = ''`로 강화 — 호출자가 세션 search_path를
--      조작해 이름이 겹치는 다른 테이블/함수를 가로채는 경로(search_path hijacking)를 원천
--      차단한다. 이 때문에 모든 테이블 참조에 스키마를 명시해야 한다(auth.users, public.
--      email_check_attempts 등 — search_path가 비어 있으면 스키마 없는 이름은 전혀 풀리지
--      않는다).
--   2) rate limit을 "조회 후 삽입" 2단계(Edge Function에서 각각 별도 요청)에서 DB RPC
--      하나(consume_email_check_attempt)로 합쳤다 — 기존 방식은 동시 요청 여러 개가 모두
--      "아직 20회 안 됐다"는 조회 결과를 보고 나서야 각자 insert해 실제로는 제한을 넘길 수
--      있었다(check-then-act race). 새 함수는 advisory lock으로 같은 IP 해시에 대한 동시
--      실행을 직렬화한 뒤 원자적으로 확인+기록한다.
--
-- 이 변경은 함수 2개와 rate-limit 보조 테이블 1개만 추가한다. 기존 테이블/컬럼/RLS 정책은
-- 전혀 건드리지 않는다. DB 재생성 불필요, 여러 번 실행해도 안전(멱등).
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
set search_path = ''
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

-- ------------------------------------------------------------
-- [3] rate limit을 원자적으로 소비하는 RPC — "조회 → 삽입" 2단계를 Edge Function 밖에서
--     각각 별도 요청으로 하면 동시 요청 사이에 race가 생긴다(둘 다 "아직 19번째"라고 보고
--     둘 다 insert해 실질적으로 제한을 넘김). 같은 IP 해시 값 하나를 64비트 정수로 해시해
--     pg_advisory_xact_lock으로 잠가 동시 실행을 직렬화한 뒤, 그 안에서 카운트 확인과
--     insert를 한 트랜잭션으로 처리한다 — 트랜잭션이 끝나면(Edge Function 호출 1건이 곧
--     1개의 statement/트랜잭션) 잠금은 자동 해제된다.
--     반환값: true = 이번 요청을 허용하고 기록함, false = 이미 한도(20회/10분)에 도달해
--     기록하지 않고 거부함.
-- ------------------------------------------------------------
create or replace function consume_email_check_attempt(p_ip_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_lock_key bigint;
    v_recent_count int;
begin
    -- advisory lock 키는 ip_hash 문자열(이미 SHA-256 hex)을 64비트 정수로 접어 만든다 —
    -- hashtext()는 세션 search_path와 무관하게 항상 pg_catalog에 있어 search_path=''에서도
    -- 안전하게 호출된다.
    v_lock_key := ('x' || substr(md5(p_ip_hash), 1, 16))::bit(64)::bigint;
    perform pg_advisory_xact_lock(v_lock_key);

    select count(*) into v_recent_count
    from public.email_check_attempts
    where ip_hash = p_ip_hash
      and created_at >= now() - interval '10 minutes';

    if v_recent_count >= 20 then
        return false;
    end if;

    insert into public.email_check_attempts (ip_hash) values (p_ip_hash);
    return true;
end;
$$;

revoke all on function consume_email_check_attempt(text) from public;
revoke all on function consume_email_check_attempt(text) from anon;
revoke all on function consume_email_check_attempt(text) from authenticated;
grant execute on function consume_email_check_attempt(text) to service_role;

-- ============================================================
-- 확인
-- ============================================================
select 'email_signup_available 함수' as 항목,
       (select count(*)::text from pg_proc where proname = 'email_signup_available') as 값
union all
select 'consume_email_check_attempt 함수',
       (select count(*)::text from pg_proc where proname = 'consume_email_check_attempt')
union all
select 'email_check_attempts 테이블',
       (select count(*)::text from pg_tables where tablename = 'email_check_attempts')
union all
select 'anon/authenticated 실행 권한 없음(기대값 0, 두 함수 합산)',
       (select count(*)::text from information_schema.role_routine_grants
         where routine_name in ('email_signup_available', 'consume_email_check_attempt')
           and grantee in ('anon', 'authenticated'))
union all
select 'search_path hardening 적용 확인(기대값 2, 두 함수 모두 search_path=)',
       (select count(*)::text from pg_proc
         where proname in ('email_signup_available', 'consume_email_check_attempt')
           and array_to_string(proconfig, ',') like '%search_path=%');
