-- ============================================================
-- fix_progress_records_missing_update_rls_draft_proposed.sql 롤백
-- "진도 기록 수정" UPDATE 정책만 제거(원래 상태 = UPDATE 정책 없음, 기본 거부).
-- ============================================================

drop policy if exists "진도 기록 수정" on progress_records;

-- 확인 (cmd='UPDATE' 행이 없어야 정상)
select tablename, policyname, cmd from pg_policies
 where tablename = 'progress_records'
 order by cmd;
