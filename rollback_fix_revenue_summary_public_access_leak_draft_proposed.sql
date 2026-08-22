-- ============================================================
-- fix_revenue_summary_public_access_leak_draft_proposed.sql 롤백
-- 발견 당시 실제로 부여돼 있던 권한 그대로 복원(왜 이랬는지는 불명 — 아마 스키마 생성 시
-- 일괄 GRANT의 부수효과, 의도된 설계는 아니었을 가능성이 높음. 롤백은 원상복구 목적일 뿐
-- 이 상태로 되돌리는 걸 권장하는 게 아니다).
-- ============================================================

grant delete, insert, references, select, trigger, truncate, update
  on revenue_summary to anon, authenticated;

-- 확인
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_name = 'revenue_summary'
 order by grantee, privilege_type;
