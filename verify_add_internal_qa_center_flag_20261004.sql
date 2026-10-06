-- READ-ONLY(단일 SELECT): add_internal_qa_center_flag.sql 적용 상태 확인(기존 파일에는 독립 verify가 없어 2026-10-04에 추가). 모든 *_ok가 true일 때만 verdict='APPLIED'
-- (적용 전에는 NOT_APPLIED가 정상). internal_centers_now 는 참고용 정보(적용 직후 0, QA fixture 생성 후 1)이며 verdict에 포함되지 않는다.
-- 정의는 소문자/주석 제거/공백·괄호 제거/public. 제거로 정규화한 뒤 의미 단위를 검사한다.
with col as (
    select data_type, is_nullable, column_default from information_schema.columns
     where table_schema = 'public' and table_name = 'centers' and column_name = 'is_internal'
), fn as (
    select p.proname, p.oid, p.prosecdef, p.proconfig::text as cfg,
           replace(regexp_replace(regexp_replace(lower(pg_get_functiondef(p.oid)), '--[^\n\r]*', '', 'g'), '[\s()]+', '', 'g'), 'public.', '') as n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname in ('my_member_center_ids', 'fetch_public_storefront_products', 'fetch_purchasable_products')
), pol as (
    select tablename, policyname, regexp_replace(lower(coalesce(qual, '')), '[\s()]+', '', 'g') as q
      from pg_policies
     where schemaname = 'public'
       and ((tablename = 'centers' and policyname = '승인된 센터 조회')
         or (tablename = 'classes' and policyname = '승인된 센터 수업 조회')
         or (tablename = 'products' and policyname = '상품 조회'))
), c as (
    select
        coalesce((select data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false' from col), false)                          as flag_column_ok,
        -- 컬럼이 아직 없는 환경에서도 오류 없이 NOT_APPLIED가 나오도록 query_to_xml을 CASE 안에서만 실행한다.
        case when exists (select 1 from col) then (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.centers where is_internal', false, true, '')))[1]::text::int end as internal_centers_now,
        -- 선행 helper(이 파일이 만들지 않는 것)
        exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and p.proname = 'my_center_ids_any_status') as prerequisite_my_center_ids_any_status_ok,
        exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and p.proname = 'my_managed_center_ids')     as prerequisite_my_managed_center_ids_ok,
        exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and p.proname = 'my_profile_ids')             as prerequisite_my_profile_ids_ok,
        -- helper my_member_center_ids: SECURITY DEFINER + search_path 고정 + anon/authenticated 실행 가능(RLS 평가에 필요) + PUBLIC 직접 권한은 없음
        coalesce((select prosecdef and cfg like '%search_path=public%' from fn where proname = 'my_member_center_ids'), false)                  as helper_secdef_pinned_ok,
        coalesce((select has_function_privilege('anon', oid, 'execute') and has_function_privilege('authenticated', oid, 'execute') from fn where proname = 'my_member_center_ids'), false) as helper_exec_ok,
        -- RLS 3개: 승인 + (not is_internal 또는 내 회원 센터), 관리자 센터는 유지
        coalesce((select position('is_internal' in q) > 0 and position('my_member_center_ids' in q) > 0 and position('my_managed_center_ids' in q) > 0 and position('my_center_ids_any_status' in q) > 0 and position('is_platform_admin' in q) > 0 from pol where tablename = 'centers'), false) as centers_policy_ok,
        coalesce((select position('is_internal' in q) > 0 and position('my_member_center_ids' in q) > 0 and position('my_managed_center_ids' in q) > 0 from pol where tablename = 'classes'), false) as classes_policy_ok,
        coalesce((select position('is_internal' in q) > 0 and position('my_member_center_ids' in q) > 0 and position('my_managed_center_ids' in q) > 0 from pol where tablename = 'products'), false) as products_policy_ok,
        -- 공개 storefront RPC: SECURITY DEFINER + search_path 고정 + internal 제외 + anon/authenticated 실행 가능
        coalesce((select prosecdef and cfg like '%search_path=public%' and position('notc.is_internal' in n) > 0 and has_function_privilege('anon', oid, 'execute') and has_function_privilege('authenticated', oid, 'execute')
                    from fn where proname = 'fetch_public_storefront_products'), false)                                                        as storefront_rpc_ok,
        -- 회원용 구매 RPC: SECURITY DEFINER + search_path 고정 + 내부 센터는 회원/관리자만 + anon 실행 불가 + authenticated 가능
        coalesce((select prosecdef and cfg like '%search_path=public%' and position('c.is_internal' in n) > 0 and position('my_member_center_ids' in n) > 0 and position('my_managed_center_ids' in n) > 0
                         and not has_function_privilege('anon', oid, 'execute') and has_function_privilege('authenticated', oid, 'execute')
                    from fn where proname = 'fetch_purchasable_products'), false)                                                             as purchasable_rpc_ok
)
select c.*,
       case when flag_column_ok and prerequisite_my_center_ids_any_status_ok and prerequisite_my_managed_center_ids_ok and prerequisite_my_profile_ids_ok
                 and helper_secdef_pinned_ok and helper_exec_ok and centers_policy_ok and classes_policy_ok and products_policy_ok and storefront_rpc_ok and purchasable_rpc_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from c;
