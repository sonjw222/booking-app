-- 읽기 전용 확인(적용 후): 모두 true 여야 한다.
--  · 트리거가 존재하고 BEFORE INSERT(행 단위)이며 활성(tgenabled='O')
--  · 함수가 SECURITY DEFINER·search_path 고정이고 service_role/PUBLIC 직접 실행 불가가 아니어도 트리거 함수라 RPC 로 호출되지 않는다(반환형 trigger)
--  · 기존 UPDATE 가드 3개가 그대로 활성
select
  (select count(*) from pg_trigger where tgrelid = 'public.accounts'::regclass and tgname = 'trg_accounts_insert_privileged_columns' and (tgtype & 1) > 0 and (tgtype & 2) > 0 and (tgtype & 4) > 0 and tgenabled = 'O') = 1 as insert_trigger_enabled_before_row_insert,
  (select p.prosecdef and 'search_path=public' = any (p.proconfig) and p.prorettype = 'trigger'::regtype from pg_proc p where p.oid = 'public.enforce_accounts_insert_privileged_columns()'::regprocedure) as function_secdef_pinned_trigger,
  (select count(*) from pg_trigger where tgrelid = 'public.accounts'::regclass and tgname in ('trg_accounts_is_platform_admin_admin_only','trg_accounts_pg_checkout_override_admin_only','trg_accounts_merged_into_via_linking_only') and tgenabled = 'O' and (tgtype & 16) > 0) = 3 as existing_update_guards_still_enabled,
  (select count(*) from pg_trigger where tgrelid = 'public.accounts'::regclass and not tgisinternal) as accounts_trigger_count_info;
