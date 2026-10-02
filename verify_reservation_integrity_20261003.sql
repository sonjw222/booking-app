-- ============================================================
-- READ-ONLY: fix_reservation_integrity_20261003.sql 적용 전/후 상태 확인(SELECT만, 데이터/정의를 바꾸지 않는다).
-- 적용 "후" 기대: *_must_be_true 항목은 모두 true, *_must_be_false / *_must_be_0 항목은 모두 false/0, verdict='APPLIED'.
-- 적용 "전"에는 verdict='NOT_APPLIED'가 정상이다(취약 상태 확인용).
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
        -- F1: 서버 판정에 LIKE 비교가 없고 정확 일치만 있다
        (elig !~* 'title\s+like' and elig like '%r.class_title = c.title%')                          as f1_exact_title_match_must_be_true,
        -- F2: selected override 제거(서버/UI 모두)
        (elig !~ 'pass_selection_mode = ''selected''' and um !~ 'pass_selection_mode = ''selected'''
            and umc !~ 'pass_selection_mode = ''selected''')                                         as f2_no_selected_override_must_be_true,
        -- F3: 서버 최종 판정에 product_kind='pass'
        (elig like '%pd.product_kind = ''pass''%')                                                   as f3_pass_only_must_be_true,
        -- F5: 예약 자격 날짜 비교에 DB current_date가 남아 있지 않다
        (rc !~ 'current_date' and rwm !~ 'current_date' and um !~ 'current_date' and umc !~ 'current_date')
                                                                                                       as f5_kst_date_must_be_true
    from f
)
select
    c.*,
    -- F4: authenticated는 reservations 전체 UPDATE 권한이 없고 member_memo 컬럼만 가능
    not has_table_privilege('authenticated', 'public.reservations', 'UPDATE')                         as f4_auth_table_update_revoked_must_be_true,
    has_column_privilege('authenticated', 'public.reservations', 'member_memo', 'UPDATE')             as f4_auth_memo_update_must_be_true,
    (select count(*) from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'reservations' and grantee = 'authenticated' and privilege_type = 'UPDATE' and column_name <> 'member_memo') as f4_auth_other_update_columns_must_be_0,
    has_table_privilege('anon', 'public.reservations', 'INSERT')
        or has_table_privilege('anon', 'public.reservations', 'UPDATE')
        or has_table_privilege('anon', 'public.reservations', 'DELETE')                              as f4_anon_write_must_be_false,
    has_function_privilege('anon', 'public.is_membership_eligible_for_class(uuid,uuid)', 'execute')    as eligible_fn_anon_must_be_false,
    has_function_privilege('authenticated', 'public.is_membership_eligible_for_class(uuid,uuid)', 'execute') as eligible_fn_auth_must_be_true,
    has_function_privilege('service_role', 'public.is_membership_eligible_for_class(uuid,uuid)', 'execute') as eligible_fn_service_must_be_true,
    has_table_privilege('service_role', 'public.reservations', 'UPDATE')                              as service_role_update_must_be_true,
    (select count(*) from pg_policy where polrelid = 'public.reservations'::regclass and polname = '본인 예약 메모 수정') as memo_rls_policy_must_be_1,
    -- 참고(변경 대상 아님): product_id 없는 legacy membership 수 — 기존 동작 보존
    (select count(*) from public.memberships where product_id is null)                                as info_null_product_memberships,
    case when c.f1_exact_title_match_must_be_true and c.f2_no_selected_override_must_be_true and c.f3_pass_only_must_be_true and c.f5_kst_date_must_be_true
              and not has_table_privilege('authenticated', 'public.reservations', 'UPDATE')
              and has_column_privilege('authenticated', 'public.reservations', 'member_memo', 'UPDATE')
         then 'APPLIED' else 'NOT_APPLIED' end                                                       as verdict
from checks c;
