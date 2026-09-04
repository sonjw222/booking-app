-- ============================================================
-- add_phone_verification.sql의 함수들이 gen_salt()/crypt()를 못 찾는 문제 수정
--
-- 원인: 이 Supabase 프로젝트는 pgcrypto가 public이 아니라 extensions 스키마에 설치돼
-- 있다(Supabase 프로젝트의 흔한 기본 배치). create_phone_verification()/verify_phone_otp()
-- 둘 다 `set search_path = public`로만 고정해뒀더니 gen_salt/crypt를 못 찾아
-- "function gen_salt(unknown) does not exist" 에러가 남(실측 확인, 2026-09-05).
--
-- 로직은 전혀 안 바꾸고 search_path에 extensions만 추가한다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create or replace function create_phone_verification(p_phone text, p_code text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into phone_verifications (phone, code_hash, expires_at)
  values (p_phone, crypt(p_code, gen_salt('bf')), now() + interval '5 minutes');
end;
$$;

create or replace function verify_phone_otp(p_phone text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
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

-- ------------------------------------------------------------
-- 확인: pgcrypto가 실제로 어느 스키마에 있는지(참고용 — 실제 동작 확인은 이 SQL
-- 적용 후 send-phone-otp를 다시 호출해서 확인한다)
-- ------------------------------------------------------------
select extname, extnamespace::regnamespace as schema from pg_extension where extname = 'pgcrypto';
