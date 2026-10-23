-- 롤백: Supabase 기본 상태(authenticated/anon 의 테이블 전체 쓰기 권한)로 복원. 보안 결함이 되살아나므로 필요할 때만.
-- ⚠ 적용 직전의 실제 ACL 백업이 우선이다(정확한 복원은 Codex 가 적용 전에 information_schema.role_table_grants / column_privileges 를 백업).
grant insert, update on center_reviews to authenticated;
grant insert, update on center_reviews to anon;
notify pgrst, 'reload schema';
