-- READ-ONLY(단일 SELECT): add_member_candidate_search_20261003.sql 적용 상태 확인. 모든 *_ok가 true일 때만 verdict='APPLIED'(적용 전에는 NOT_APPLIED가 정상).
-- [formatting-safe] 함수 본문은 pg_get_functiondef() 문자열이라 CRLF/들여쓰기/공백 차이에 정확한 LIKE가 깨진다. 정의를 (1) 소문자, (2) -- 주석 제거, (3) 모든 공백 제거, (4) 'public.' 접두사 제거로 정규화한 뒤
--   position()으로 "의미 단위"를 검사한다(정규화 문자열은 공백이 없으므로 패턴도 공백 없이 쓴다). SECURITY DEFINER / search_path / 실행 권한은 pg_proc·권한 함수로 직접 확인한다.
with fn as (
    select p.oid, p.prosecdef, p.proconfig::text as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'search_member_candidates'
       and pg_get_function_identity_arguments(p.oid) = 'p_center_id uuid, p_keyword text'
), hp as (
    select p.oid, p.proconfig::text as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'kr_phone_digits' and pg_get_function_identity_arguments(p.oid) = 'p text'
), old as (
    select to_regprocedure('public.search_accounts_for_member(text)') as oid
), body as (
    select replace(regexp_replace(regexp_replace(lower(pg_get_functiondef(oid)), '--[^\n\r]*', '', 'g'), '\s+', '', 'g'), 'public.', '') as n from fn
), c as (
    select
        -- 함수: 존재 / SECURITY DEFINER / search_path 고정 / anon·PUBLIC 실행 불가 / authenticated 실행 가능
        exists (select 1 from fn)                                                                                         as function_exists_ok,
        coalesce((select prosecdef from fn), false)                                                                       as security_definer_ok,
        coalesce((select cfg like '%search_path=public%' from fn), false)                                                 as search_path_pinned_ok,
        coalesce((select not has_function_privilege('anon', oid, 'execute') from fn), false)                              as anon_denied_ok,
        coalesce((select not has_function_privilege('public', oid, 'execute') from fn), false)                            as public_denied_ok,
        coalesce((select has_function_privilege('authenticated', oid, 'execute') from fn), false)                         as authenticated_allowed_ok,
        -- 기존 전역 부분일치 RPC: authenticated/anon/PUBLIC 모두 실행 불가(함수가 없으면 true)
        coalesce((select not has_function_privilege('authenticated', oid, 'execute') from old where oid is not null), true) as old_global_search_revoked_ok,
        coalesce((select not has_function_privilege('anon', oid, 'execute') and not has_function_privilege('public', oid, 'execute') from old where oid is not null), true) as old_global_search_anon_denied_ok,
        -- 본문: 권한 검사(create) + 전화번호 권한(phone, platform admin, v_can_phone) — 권한 검사는 return query(데이터 조회)보다 앞
        coalesce((select position('has_permission(p_center_id,''customer.member.create'')' in n) > 0 from body), false)   as body_create_permission_ok,
        coalesce((select position('has_permission(p_center_id,''customer.member.phone'')' in n) > 0 and position('is_platform_admin()' in n) > 0 and position('v_can_phone' in n) > 0 from body), false) as phone_permission_gate_ok,
        coalesce((select position('has_permission(p_center_id,''customer.member.create'')' in n) < position('returnquery' in n)
                     and position('has_permission(p_center_id,''customer.member.phone'')' in n) < position('returnquery' in n) from body), false) as permission_checked_before_read_ok,
        -- 센터 회원: 전화번호 반환/부분검색 모두 v_can_phone으로 제한
        coalesce((select position('casewhenv_can_phonethena.phoneelsenullend' in n) > 0 and position('v_can_phoneandlength(v_digits)>=2' in n) > 0 from body), false) as member_phone_gated_ok,
        -- 정규화: 입력과 저장된 phone 모두 kr_phone_digits, 센터 밖 회원은 정확한 전체 번호 비교
        coalesce((select position('v_digits' in n) > 0 and position('kr_phone_digits(p_keyword)' in n) > 0 and position('kr_phone_digits(a.phone)=v_exact' in n) > 0 and position('position(v_digitsinkr_phone_digits(a.phone))' in n) > 0 from body), false) as phone_canonical_compare_ok,
        -- 부분일치는 position() 기반(ILIKE/LIKE wildcard 없음)
        coalesce((select position('ilike' in n) = 0 and position('position(lower(v_kw)inlower(' in n) > 0 from body), false)  as position_search_no_ilike_ok,
        -- 센터 밖 결과는 마스킹된 번호만(전체 번호 반환 금지)
        coalesce((select position('selecte.pid,e.pname,left(v_exact,3)||''-****-''||right(v_exact,4),falsefromexact' in n) > 0 and position('selecte.pid,e.pname,e.pphone' in n) = 0 from body), false) as masked_exact_result_ok,
        -- helper: 존재 / search_path 고정 / 내부 전용(anon·authenticated·PUBLIC 실행 불가)
        exists (select 1 from hp)                                                                                         as canonical_helper_exists_ok,
        coalesce((select cfg like '%search_path=public%' from hp), false)                                                 as canonical_helper_search_path_ok,
        coalesce((select not has_function_privilege('anon', oid, 'execute') and not has_function_privilege('authenticated', oid, 'execute')
                          and not has_function_privilege('public', oid, 'execute') from hp), false)                        as canonical_helper_internal_ok
)
select c.*,
       case when function_exists_ok and security_definer_ok and search_path_pinned_ok and anon_denied_ok and public_denied_ok and authenticated_allowed_ok
                 and old_global_search_revoked_ok and old_global_search_anon_denied_ok and body_create_permission_ok and phone_permission_gate_ok and permission_checked_before_read_ok
                 and member_phone_gated_ok and phone_canonical_compare_ok and position_search_no_ilike_ok and masked_exact_result_ok
                 and canonical_helper_exists_ok and canonical_helper_search_path_ok and canonical_helper_internal_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from c;
