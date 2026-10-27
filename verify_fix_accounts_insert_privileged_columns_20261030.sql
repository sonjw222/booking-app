-- 읽기 전용 확인: 트리거가 INSERT 에 걸려 있고 함수가 있다(둘 다 true).
select exists (select 1 from pg_trigger where tgrelid = 'public.accounts'::regclass and tgname = 'trg_accounts_insert_privileged_columns' and (tgtype & 4) > 0 and (tgtype & 2) > 0) as insert_trigger_present,
       to_regprocedure('public.enforce_accounts_insert_privileged_columns()') is not null as function_present;
