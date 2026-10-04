-- READ-ONLY(단일 SELECT): alimtalk_templates.aligo_template_code 중복 방지(fix_alimtalk_template_code_unique.sql) 적용 상태 + 기존 중복 데이터 진단.
-- 모델(저장소 조사): 알리고 계정은 플랫폼에서 하나를 모든 센터가 공유하고 코드에는 "센터" 개념이 없으므로, 같은 코드는 센터 전용(center_id)이든 공통(center_id is null)이든
--   "전체에서 최대 1행"이어야 한다 → (center_id, code) 복합이 아니라 code 단독 partial unique index(where aligo_template_code is not null)가 맞다
--   (복합 unique는 center_id NULL 때문에 공통 행 중복을 못 막고, 센터가 다르면 같은 코드를 허용해 "다른 센터 문구 공유" 사고를 못 막는다). 코드가 null인 초안/미승인 행은 여러 개 허용.
-- 적용 전 duplicate_code_groups 가 0이 아니면 index 생성이 실패한다 — 자동 병합/삭제는 하지 않는다(duplicate_codes 목록을 보고 운영에서 직접 정리).
with dup as (
    select aligo_template_code, count(*) as n
      from public.alimtalk_templates
     where aligo_template_code is not null
     group by aligo_template_code having count(*) > 1
), idx as (
    select i.indisunique, i.indisvalid, i.indisready, i.indnkeyatts, i.indnatts,
           (select a.attname from pg_attribute a where a.attrelid = i.indrelid and a.attnum = i.indkey[0]) as first_key,
           regexp_replace(lower(coalesce(pg_get_expr(i.indpred, i.indrelid), '')), '[()[:space:]]', '', 'g') as pred
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'idx_alimtalk_templates_aligo_code_unique'
       and i.indrelid = 'public.alimtalk_templates'::regclass
), r as (
    select
        (select count(*)::int from dup)                                                           as duplicate_code_groups,
        coalesce((select array_agg(aligo_template_code order by aligo_template_code) from dup), '{}'::text[]) as duplicate_codes,
        exists (select 1 from idx)                                                                as index_exists,
        coalesce((select indisunique from idx), false)                                            as is_unique,
        coalesce((select indisvalid from idx), false)                                             as is_valid,
        coalesce((select indisready from idx), false)                                             as is_ready,
        coalesce((select indnkeyatts = 1 and indnatts = 1 and first_key = 'aligo_template_code' from idx), false) as key_is_code_only,
        coalesce((select pred in ('aligo_template_codeisnotnull') from idx), false)               as predicate_is_code_not_null
)
select r.*,
       case when duplicate_code_groups = 0 and index_exists and is_unique and is_valid and is_ready and key_is_code_only and predicate_is_code_not_null
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from r;
