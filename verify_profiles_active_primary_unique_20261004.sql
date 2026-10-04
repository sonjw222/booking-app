-- READ-ONLY 검증: INSERT/UPDATE/DELETE/DDL 없음. 한 번 실행하면 verdict 가 APPLIED 또는 NOT_APPLIED 로 나온다.
-- (index 이름만 보지 않고 pg_catalog 의 실제 정의 — unique/valid/ready/key 컬럼/partial predicate — 까지 검사한다.)
with dup as (
  select count(*)::int as n
  from (
    select account_id from public.profiles
    where is_primary = true and deleted_at is null
    group by account_id having count(*) > 1
  ) d
), idx as (
  select i.indisunique, i.indisvalid, i.indisready, i.indnkeyatts, i.indnatts,
         (select a.attname from pg_attribute a where a.attrelid = i.indrelid and a.attnum = i.indkey[0]) as first_key,
         regexp_replace(lower(coalesce(pg_get_expr(i.indpred, i.indrelid), '')), '[()[:space:]]', '', 'g') as pred
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'profiles_one_active_primary_per_account'
    and i.indrelid = 'public.profiles'::regclass
), r as (
  select
    (select n from dup) as duplicate_active_primary_accounts,
    exists (select 1 from idx) as index_exists,
    coalesce((select indisunique from idx), false) as is_unique,
    coalesce((select indisvalid from idx), false) as is_valid,
    coalesce((select indisready from idx), false) as is_ready,
    coalesce((select indnkeyatts = 1 and indnatts = 1 and first_key = 'account_id' from idx), false) as key_is_account_id_only,
    coalesce((select pred in ('is_primary=trueanddeleted_atisnull', 'deleted_atisnullandis_primary=true',
                              'is_primaryanddeleted_atisnull', 'deleted_atisnullandis_primary') from idx), false) as predicate_is_live_primary
)
select r.*,
       case when duplicate_active_primary_accounts = 0 and index_exists and is_unique and is_valid and is_ready
                 and key_is_account_id_only and predicate_is_live_primary
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from r;
