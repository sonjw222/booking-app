-- ============================================================
-- 계정 연동 — 가입 시점에 같은 이메일이 이미 있으면 바로 병합 제안(반응형 흐름)
--
-- 배경: add_account_linking.sql이 만든 "코드 교환" 방식은 이미 따로 생긴 두 계정을 나중에
-- 합치는 데는 안전하지만, 로그아웃→다른 계정 로그인→코드 입력을 왕복해야 해서 번거롭다.
-- 사용자 요청(2026-09-09): 구글/애플처럼 실제 이메일을 쓰는 provider로 신규 가입할 때, 그
-- 이메일로 이미 계정이 있으면 그 자리에서 비밀번호만 확인받고 바로 합쳐준다.
--
-- 카카오/네이버는 합성 이메일(*.socialauth.invalid)을 써서 이 충돌 자체가 원천적으로 안
-- 생긴다(DEC-004) — 이 RPC는 모든 provider에 걸어도 안전하지만 카카오/네이버에서는 그냥
-- 항상 매치가 없다.
--
-- 이 함수는 "겹치는 계정이 있는지"만 알려주고, 실제 병합은 여전히 기존
-- create_account_link_code()/link_accounts_by_code() 두 RPC로 처리한다(클라이언트가 별도
-- isolated Supabase 클라이언트로 그 계정의 비밀번호를 검증한 뒤, 그 계정 세션으로
-- create_account_link_code()를 호출해 코드를 받고, 지금 세션에서 바로 소비한다) — 새로운
-- 병합 로직을 추가하지 않고 이미 검증된 안전한 경로를 그대로 재사용한다.
--
-- DB 재생성 불필요. 여러 번 실행해도 안전(create or replace).
-- ============================================================

create or replace function find_mergeable_account_by_my_email()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_my_email text;
    v_other_auth_id uuid;
begin
    select email into v_my_email from auth.users where id = auth.uid();
    if v_my_email is null then
        return null;
    end if;

    select au.id into v_other_auth_id
    from auth.users au
    join accounts a on a.auth_id = au.id
    where au.email = v_my_email
      and au.id <> auth.uid()
      and a.merged_into is null
    limit 1;

    if v_other_auth_id is null then
        return null;
    end if;

    return json_build_object('email', v_my_email);
end;
$$;
