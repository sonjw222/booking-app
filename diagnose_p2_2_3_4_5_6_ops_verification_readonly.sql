-- ============================================================
-- P2-2/3/4/5/6 운영 상태 확인 (전부 read-only, 아무것도 바꾸지 않음)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전(SELECT만 있음).
-- 각 섹션 결과를 그대로 붙여주시면 그걸 보고 완료/후속작업 여부를 판단하겠습니다.
-- ============================================================


-- ------------------------------------------------------------
-- [P2-2] Realtime publication에 notifications/inquiry_threads/inquiry_messages가
--        포함돼 있는지 + 각 테이블 RLS 정책 목록
-- ------------------------------------------------------------
select 'P2-2 publication' as section, schemaname, tablename
  from pg_publication_tables
 where pubname = 'supabase_realtime'
   and tablename in ('notifications', 'inquiry_threads', 'inquiry_messages')
 order by tablename;

select 'P2-2 rls policies' as section, tablename, policyname, cmd
  from pg_policies
 where tablename in ('notifications', 'inquiry_threads', 'inquiry_messages')
 order by tablename, cmd;


-- ------------------------------------------------------------
-- [P2-3] Storage bucket(avatars/business-licenses) 존재·공개여부 +
--        storage.objects 정책 목록(정의 텍스트 포함)
-- ------------------------------------------------------------
select 'P2-3 buckets' as section, id, name, public, file_size_limit, allowed_mime_types
  from storage.buckets
 where id in ('avatars', 'business-licenses');

select 'P2-3 object policies' as section, policyname, cmd, roles, qual, with_check
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
 order by policyname;


-- ------------------------------------------------------------
-- [P2-4] 핵심 trigger 6개 — 존재·활성상태(tgenabled: O=활성, D=비활성, A=always,
--        R=replica only)·대상 함수
-- ------------------------------------------------------------
select 'P2-4 triggers' as section,
       tgname,
       tgrelid::regclass::text as table_name,
       tgenabled,
       tgfoid::regproc::text as function_name
  from pg_trigger
 where tgname in (
   'trg_create_default_center_roles',
   'trg_guard_center_status',
   'notify_new_order',
   'notify_new_review',
   'notify_reservation_insert',
   'notify_reservation_update'
 )
 order by tgname;


-- ------------------------------------------------------------
-- [P2-5] revenue_summary — 외부 도구(예: BI 툴)가 접근 가능한 role에 GRANT가
--        있는지(있으면 외부 사용 가능성 있음, 정황 증거일 뿐 확정은 아님)
-- ------------------------------------------------------------
select 'P2-5 revenue_summary grants' as section, grantee, privilege_type
  from information_schema.role_table_grants
 where table_name = 'revenue_summary'
 order by grantee, privilege_type;


-- ------------------------------------------------------------
-- [P2-6] purchase_requests — 실제로 쌓이고 있는 row가 있는지(있으면 앱의
--        addToCart() 외에 이 경로를 쓰는 곳이 실제로 있다는 뜻)
-- ------------------------------------------------------------
select 'P2-6 purchase_requests summary' as section,
       count(*) as total_rows,
       max(created_at) as most_recent_created_at
  from purchase_requests;

select 'P2-6 purchase_requests recent rows' as section, id, center_id, profile_id, product_name, status, created_at
  from purchase_requests
 order by created_at desc
 limit 5;
