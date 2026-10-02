-- ============================================================
-- READ-ONLY: fix_reservation_integrity_20261003.sql 적용 전/후 상태 확인(단일 SELECT, 데이터/정의/권한을 바꾸지 않는다).
-- verdict='APPLIED'는 아래 *_ok 컬럼이 "전부" true일 때만 나온다(하나라도 어긋나면 NOT_APPLIED). info_* 컬럼은 정보용이며 verdict에 포함되지 않는다.
-- 적용 "전"에는 NOT_APPLIED가 정상(취약 상태 확인용). 적용 후에는 모든 *_ok = true, verdict = APPLIED 여야 한다.
-- ============================================================
with f as (
    select
        pg_get_functiondef('public.is_membership_eligible_for_class(uuid,uuid)'::regprocedure) as elig,
        pg_get_functiondef('public.usable_memberships(uuid,uuid)'::regprocedure) as um,
        pg_get_functiondef('public.usable_memberships_for_classes(uuid[],uuid)'::regprocedure) as umc,
        pg_get_functiondef('public.reserve_class(uuid,uuid)'::regprocedure) as rc,
        pg_get_functiondef('public.reserve_with_membership(uuid,uuid,uuid)'::regprocedure) as rwm
), checks as (
    select
        -- F1: 수업명 정확 일치(LIKE 없음)
        (elig !~* 'title\s+like' and elig like '%r.class_title = c.title%')                                     as f1_exact_title_ok,
        -- F2: selected override 없음(서버 + UI 함수 모두)
        (elig !~ 'pass_selection_mode = ''selected''' and um !~ 'pass_selection_mode = ''selected'''
            and umc !~ 'pass_selection_mode = ''selected''')                                                    as f2_no_selected_override_ok,
        -- F3: 서버 최종 판정에 product_kind='pass'
        (elig like '%pd.product_kind = ''pass''%')                                                              as f3_pass_only_ok,
        -- F5: 예약 자격 날짜 비교에 DB current_date 없음 + KST 날짜 사용
        (rc !~ 'current_date' and rwm !~ 'current_date' and um !~ 'current_date' and umc !~ 'current_date'
            and rc like '%Asia/Seoul'')::date%' and rwm like '%Asia/Seoul'')::date%'
            and um like '%Asia/Seoul'')::date%' and umc like '%Asia/Seoul'')::date%')                           as f5_kst_date_ok,
        -- 보완: reserve_class 자동선택이 status='active'를 직접 강제
        (rc like '%and m.status = ''active''%')                                                                  as reserve_class_active_ok,
        -- 보완: usable_memberships()가 NULL 만료 허용 + starts_at 검사(usable_memberships_for_classes와 동일 semantics)
        (um like '%m.expires_at is null or m.expires_at >=%' and um like '%m.starts_at is null or m.starts_at <=%') as usable_single_dates_ok
    from f
), perms as (
    select
        -- F4: authenticated는 reservations 테이블 단위 UPDATE 없음, member_memo 컬럼만 UPDATE, 그 외 UPDATE 컬럼 0개
        not has_table_privilege('authenticated', 'public.reservations', 'UPDATE')                               as f4_auth_no_table_update_ok,
        has_column_privilege('authenticated', 'public.reservations', 'member_memo', 'UPDATE')                   as f4_auth_memo_update_ok,
        ((select count(*) from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'reservations' and grantee = 'authenticated'
             and privilege_type = 'UPDATE' and column_name <> 'member_memo') = 0)                              as f4_auth_no_other_update_columns_ok,
        -- F4: anon 쓰기 권한 없음(INSERT/UPDATE/DELETE/TRUNCATE) + authenticated TRUNCATE 없음
        not has_table_privilege('anon', 'public.reservations', 'INSERT')                                        as f4_anon_no_insert_ok,
        not has_table_privilege('anon', 'public.reservations', 'UPDATE')                                        as f4_anon_no_update_ok,
        not has_table_privilege('anon', 'public.reservations', 'DELETE')                                        as f4_anon_no_delete_ok,
        not has_table_privilege('anon', 'public.reservations', 'TRUNCATE')                                      as f4_anon_no_truncate_ok,
        not has_table_privilege('authenticated', 'public.reservations', 'TRUNCATE')                             as f4_auth_no_truncate_ok,
        -- 함수 권한: anon 불가 / authenticated 가능 / service_role 가능
        not has_function_privilege('anon', 'public.is_membership_eligible_for_class(uuid,uuid)', 'execute')     as eligible_fn_anon_denied_ok,
        has_function_privilege('authenticated', 'public.is_membership_eligible_for_class(uuid,uuid)', 'execute') as eligible_fn_auth_ok,
        has_function_privilege('service_role', 'public.is_membership_eligible_for_class(uuid,uuid)', 'execute') as eligible_fn_service_ok,
        -- 정상 서버 권한: service_role의 reservations UPDATE 유지
        has_table_privilege('service_role', 'public.reservations', 'UPDATE')                                    as service_role_update_ok,
        -- RLS: "본인 예약 메모 수정" 정책 정확히 1개
        ((select count(*) from pg_policy where polrelid = 'public.reservations'::regclass and polname = '본인 예약 메모 수정') = 1) as memo_rls_policy_ok
)
select
    c.*, p.*,
    -- 정보용(verdict 미포함)
    (select count(*) from public.memberships where product_id is null)                                           as info_null_product_memberships,
    has_table_privilege('authenticated', 'public.reservations', 'INSERT')                                         as info_auth_reservations_insert_privilege,
    has_table_privilege('authenticated', 'public.reservations', 'DELETE')                                         as info_auth_reservations_delete_privilege,
    case when c.f1_exact_title_ok and c.f2_no_selected_override_ok and c.f3_pass_only_ok and c.f5_kst_date_ok
              and c.reserve_class_active_ok and c.usable_single_dates_ok
              and p.f4_auth_no_table_update_ok and p.f4_auth_memo_update_ok and p.f4_auth_no_other_update_columns_ok
              and p.f4_anon_no_insert_ok and p.f4_anon_no_update_ok and p.f4_anon_no_delete_ok and p.f4_anon_no_truncate_ok and p.f4_auth_no_truncate_ok
              and p.eligible_fn_anon_denied_ok and p.eligible_fn_auth_ok and p.eligible_fn_service_ok
              and p.service_role_update_ok and p.memo_rls_policy_ok
         then 'APPLIED' else 'NOT_APPLIED' end                                                                    as verdict
from checks c cross join perms p;
