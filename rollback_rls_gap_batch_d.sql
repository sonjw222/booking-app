-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless proposed_rls_gap_batch_d.sql was applied ⚠️
-- Batch D rollback — 원래(RLS 없음) 상태로 되돌립니다.
-- ============================================================

drop policy if exists "누구나 팝업공지 조회" on popup_notices;
drop policy if exists "팝업공지 생성" on popup_notices;
drop policy if exists "팝업공지 수정" on popup_notices;
drop policy if exists "팝업공지 삭제" on popup_notices;
alter table popup_notices disable row level security;

drop policy if exists "누구나 대회정보 조회" on competitions;
drop policy if exists "플랫폼 운영자 대회정보 관리" on competitions;
alter table competitions disable row level security;

drop policy if exists "로그인 사용자 댓글 조회" on community_comments;
drop policy if exists "본인 댓글 작성" on community_comments;
drop policy if exists "본인 댓글 수정" on community_comments;
drop policy if exists "본인 댓글 삭제" on community_comments;
alter table community_comments disable row level security;

drop policy if exists "센터 스태프 변경이력 조회" on change_logs;
drop policy if exists "권한 보유 스태프 변경이력 조회" on change_logs;
alter table change_logs disable row level security;
