-- ============================================================
-- 회원가입 휴대폰 인증(OTP)
--
-- 목적: 소셜/이메일 회원가입 시 전화번호를 검증 없이 그대로 받아 다른 사람 번호로도
-- 가입할 수 있던 문제를 막는다. 카카오 알림톡(승인 전까지는 자동 SMS 대체발송)으로
-- 인증번호를 보내 본인 소유 확인만 한다(실명 확인 아님).
--
-- 설계 요약(docs/TODO.md P1-2c 참고):
--   1) 이 테이블은 anon/authenticated에 어떤 정책도 안 줘서 REST로 직접 조회/변경이
--      전혀 안 된다 — service_role을 쥔 Edge Function(발송)과, 아래 verify_phone_otp()
--      RPC(검증, anon 허용)로만 접근 가능.
--   2) verify_phone_otp()는 이 프로젝트 최초로 anon에 execute를 준 함수다 — 계정이
--      생기기 전(로그인 전)에 호출해야 해서 auth.uid()에 기댈 수 없다. 보안은
--      코드 해시(평문 미저장) + 시도 횟수 제한 + 만료 시간으로 담보한다.
--   3) 실제 회원가입 시점 강제는 이 파일이 아니라 fix_accounts_require_phone_
--      verification.sql(기존 accounts INSERT 정책을 좁히고, UPDATE는 트리거로 처리)에서
--      한다 — 이 파일은 순수 인증 인프라만 만든다.
--
-- ⚠ create_phone_verification()은 코드를 실제로 발송하지 않는다(Aligo HTTP 호출은
--   SQL에서 할 수 없음) — supabase/functions/send-phone-otp가 이 함수를 호출해 코드를
--   DB에 기록한 다음, 별도로 Aligo를 호출해 실제 발송한다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create extension if not exists "pgcrypto";

create table if not exists phone_verifications (
    id            uuid primary key default gen_random_uuid(),
    phone         text not null,
    code_hash     text not null,              -- crypt(code, gen_salt('bf')) — 평문 코드는 저장 안 함
    attempt_count int not null default 0,
    verified_at   timestamptz,
    expires_at    timestamptz not null,
    created_at    timestamptz not null default now()
);

create index if not exists idx_phone_verifications_phone_created
    on phone_verifications(phone, created_at desc);

alter table phone_verifications enable row level security;
-- 의도적으로 anon/authenticated 정책을 하나도 안 만든다 — 이 테이블은 REST로 아예
-- 안 보인다. service_role(Edge Function)과 보안정의자 함수 2개로만 접근한다.

grant select, insert, update on phone_verifications to service_role;

-- ------------------------------------------------------------
-- 발송 단계: send-phone-otp Edge Function(service_role)만 호출
-- ------------------------------------------------------------
create or replace function create_phone_verification(p_phone text, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into phone_verifications (phone, code_hash, expires_at)
  values (p_phone, crypt(p_code, gen_salt('bf')), now() + interval '5 minutes');
end;
$$;

revoke all on function create_phone_verification(text, text) from public, anon, authenticated;
grant execute on function create_phone_verification(text, text) to service_role;

-- ------------------------------------------------------------
-- 검증 단계: 순수 SQL이라 Edge Function 없이 클라이언트가 직접 호출(anon 허용,
-- 이 프로젝트 최초의 anon 대상 grant — 로그인 전에 호출해야 하는 특성상 불가피).
-- 시도 5회 초과, 만료 시간 지남, 코드 자체를 아직 요청 안 함 중 하나면 예외를 던진다
-- (클라이언트는 이 예외 메시지를 그대로 사용자에게 보여줌).
-- ------------------------------------------------------------
create or replace function verify_phone_otp(p_phone text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row phone_verifications%rowtype;
begin
  select * into v_row from phone_verifications
    where phone = p_phone order by created_at desc limit 1;

  if v_row.id is null then
    raise exception '인증번호를 먼저 요청해주세요';
  end if;
  if v_row.expires_at < now() then
    raise exception '인증번호가 만료됐어요. 다시 요청해주세요';
  end if;
  if v_row.attempt_count >= 5 then
    raise exception '시도 횟수를 초과했어요. 다시 요청해주세요';
  end if;

  update phone_verifications set attempt_count = attempt_count + 1 where id = v_row.id;

  if v_row.code_hash <> crypt(p_code, v_row.code_hash) then
    return false;
  end if;

  update phone_verifications set verified_at = now() where id = v_row.id;
  return true;
end;
$$;

revoke all on function verify_phone_otp(text, text) from public;
grant execute on function verify_phone_otp(text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 확인
-- ------------------------------------------------------------
select
    (select count(*) from pg_proc where proname = 'create_phone_verification') as create_fn_exists,
    (select count(*) from pg_proc where proname = 'verify_phone_otp') as verify_fn_exists,
    (select relrowsecurity from pg_class where relname = 'phone_verifications') as rls_enabled;
