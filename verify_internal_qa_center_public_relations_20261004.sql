-- READ-ONLY(단일 SELECT): fix_internal_qa_center_public_relations_20261004.sql 적용 상태(선행: add_internal_qa_center_flag.sql). 모든 *_ok가 true일 때만 verdict='APPLIED'.
-- 12개 대상 테이블 각각: (1) trivial SELECT 정책(true / auth.role()='authenticated' / auth.uid() is not null 단독)이 하나도 남지 않았고 (2) 해당 helper를 쓰는 SELECT 정책이 있다.
-- (라이브 정책 이름이 달라 옛 trivial 정책이 남아 있으면 (1)이 false가 되어 NOT_APPLIED로 드러난다.)
with t(tbl, pol, helper) as (values
        ('rooms','룸 공개 조회','center_rows_visible'),
        ('center_reviews','센터후기 공개 조회','center_rows_visible'),
        ('reviews','로그인 사용자는 리뷰 조회 가능','center_rows_visible'),
        ('center_contacts','상담채널 조회','center_rows_visible'),
        ('center_holidays','로그인 사용자 휴무일 조회','center_rows_visible'),
        ('center_member_fields','센터 항목 조회','center_rows_visible'),
        ('center_settings','설정 조회','center_rows_visible'),
        ('progress_categories','진도 카테고리 조회','center_rows_visible'),
        ('community_posts','로그인 사용자는 커뮤니티 게시글 조회 가능','center_rows_visible'),
        ('class_trainers','수업 강사 조회','class_rows_visible'),
        ('class_allowed_products','수업수강권 조회','class_rows_visible'),
        ('membership_schedule_rules','예약조건 조회','product_rows_visible')
), q as (
    select t.tbl, t.helper,
           (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.tbl and p.cmd in ('SELECT', 'ALL')
               and regexp_replace(lower(coalesce(p.qual, '')), '[\s()]+', '', 'g') in ('true', 'auth.role()=''authenticated''::text', 'auth.role()=''authenticated''', 'auth.uidisnotnull')) as trivial_left,
           (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.tbl and p.cmd = 'SELECT' and p.qual ilike '%' || t.helper || '%') as helper_policies
      from t
), h as (
    select p.proname, p.prosecdef, p.proconfig::text as cfg, p.oid
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('center_rows_visible', 'class_rows_visible', 'product_rows_visible')
), c as (
    select
        (select count(*) from h) = 3                                                                                         as helpers_exist_ok,
        coalesce((select bool_and(prosecdef and cfg like '%search_path=public%') from h), false)                              as helpers_secdef_pinned_ok,
        coalesce((select bool_and(has_function_privilege('anon', oid, 'execute') and has_function_privilege('authenticated', oid, 'execute')) from h), false) as helpers_exec_ok,
        coalesce((select bool_and(trivial_left = 0) from q), false)                                                          as no_trivial_select_policy_left_ok,
        coalesce((select bool_and(helper_policies >= 1) from q), false)                                                      as helper_policy_present_ok,
        coalesce((select array_agg(tbl order by tbl) from q where trivial_left > 0 or helper_policies = 0), '{}'::text[])    as tables_needing_attention,
        -- reviews: 센터 대상 행만 규칙을 따르고 사람 대상(target_center_id is null) 행은 그대로(정책이 target_center_id 기반 helper 호출)
        coalesce((select bool_or(p.qual ilike '%center_rows_visible(target_center_id)%') from pg_policies p where p.schemaname = 'public' and p.tablename = 'reviews' and p.cmd = 'SELECT'), false) as reviews_person_target_kept_ok
)
select c.*,
       case when helpers_exist_ok and helpers_secdef_pinned_ok and helpers_exec_ok and no_trivial_select_policy_left_ok and helper_policy_present_ok and reviews_person_target_kept_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from c;
