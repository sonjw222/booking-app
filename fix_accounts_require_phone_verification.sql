-- ============================================================
-- accounts 생성/전화번호 변경에 휴대폰 인증(OTP) 강제
--
-- add_phone_verification.sql(먼저 적용 필요)이 만든 phone_verifications를 이용해,
-- 실제로 accounts.phone에 값이 쓰이는 시점에 "그 번호로 15분 내 인증 완료"를 요구한다.
--
-- ⚠ 이 파일은 기존 정책을 "넓히는" 게 아니라 "좁히는" 방향으로만 바꾼다 — 기존에
-- 허용되던 쓰기 중 일부가 새로 거부될 수는 있어도(= 회원가입이 막힘, 바로 눈에 띔),
-- 원래 안 되던 쓰기가 새로 허용되는 경우는 없다. 이 프로젝트가 과거 겪은 RLS 회귀
-- (정책을 잘못 넓혀 접근 범위가 조용히 늘어난 사고)와는 반대 방향이라 안전하다.
--
-- ⚠ RLS 정책의 with check 안에서 다른 테이블을 직접 서브쿼리하면, 그 서브쿼리는
-- "정책을 평가하는 호출자 권한"으로 실행된다(security definer가 자동 적용되지 않음).
-- phone_verifications는 add_phone_verification.sql에서 anon/authenticated용 정책을
-- 의도적으로 하나도 안 만들어뒀으므로, 이 정책 안에서 그 테이블을 직접 서브쿼리하면
-- 일반 사용자에게는 RLS가 막아 항상 빈 결과(=검증 실패)로 보여 가입이 전부 막혀버린다.
-- 그래서 my_account_id()/is_platform_admin()과 똑같은 패턴으로, security definer
-- 헬퍼 함수를 하나 두고 정책은 그 함수만 호출한다.
--
create or replace function _is_phone_recently_verified(p_phone text)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from phone_verifications
        where phone = p_phone
          and verified_at is not null
          and verified_at > now() - interval '15 minutes'
    );
$$;

-- INSERT는 RLS "본인 계정 생성" 정책 자체를 좁힌다 — INSERT는 "새 행"만 보면 되니
-- with check에 조건을 더하면 끝난다.
--
--   phone is null 분기가 반드시 필요하다 — lib/authAccount.ts의
--   ensureAccountForCurrentUser()가 소셜 로그인 최초 부트스트랩 시
--   { auth_id, name, is_member: true }만 넣고 phone은 항상 null이다. 이 분기가
--   없으면 모든 소셜 로그인 첫 진입이 즉시 실패한다.
drop policy if exists "본인 계정 생성" on accounts;
create policy "본인 계정 생성" on accounts for insert
    with check (
        auth_id = auth.uid()
        and (phone is null or _is_phone_recently_verified(phone))
    );

-- UPDATE(휴대폰번호 변경)는 정책이 아니라 트리거로 처리한다 — RLS의 with check는
-- NEW 행만 보고 OLD 값에 접근할 수 없어서, "번호가 실제로 바뀌는 UPDATE인지"를 정책
-- 조건만으로 구분할 수 없다(구분 못 하면 예: lib/members.ts의 주소만 바꾸는 UPDATE나,
-- 인증 유효시간이 지난 지 오래된 계정의 무관한 UPDATE까지 전부 막혀버린다). 트리거는
-- OLD/NEW를 둘 다 볼 수 있어 phone이 실제로 바뀔 때만 검사한다(트리거 함수 자체가
-- security definer라 위 헬퍼 없이 직접 조회해도 문제없지만, 일관성을 위해 같은
-- 헬퍼를 재사용한다).
create or replace function enforce_phone_verified_before_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.phone is not null and new.phone is distinct from old.phone then
    if not _is_phone_recently_verified(new.phone) then
      raise exception '휴대폰 번호 인증이 필요해요';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_accounts_phone_verified on accounts;
create trigger trg_accounts_phone_verified
    before update on accounts
    for each row execute function enforce_phone_verified_before_change();

-- ------------------------------------------------------------
-- 확인
-- ------------------------------------------------------------
select
    (select count(*) from pg_policies where tablename = 'accounts' and policyname = '본인 계정 생성') as insert_policy_exists,
    (select count(*) from pg_trigger where tgname = 'trg_accounts_phone_verified') as trigger_exists,
    (select count(*) from pg_proc where proname = '_is_phone_recently_verified') as helper_fn_exists;
