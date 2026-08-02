-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless proposed_rls_gap_batch_b.sql was applied ⚠️
-- Batch B rollback — 원래(RLS 없음) 상태로 되돌립니다.
-- ============================================================

drop policy if exists "센터 스태프 개인일정 조회" on staff_schedules;
drop policy if exists "본인 개인일정 생성" on staff_schedules;
drop policy if exists "본인 개인일정 수정" on staff_schedules;
drop policy if exists "본인 개인일정 삭제" on staff_schedules;
alter table staff_schedules disable row level security;

drop policy if exists "센터 스태프 일정메모 조회" on schedule_memos;
drop policy if exists "본인 일정메모 작성" on schedule_memos;
drop policy if exists "본인 또는 권한 보유자 일정메모 수정" on schedule_memos;
drop policy if exists "본인 또는 권한 보유자 일정메모 삭제" on schedule_memos;
alter table schedule_memos disable row level security;

drop policy if exists "계약서 템플릿 조회" on contract_templates;
drop policy if exists "계약서 템플릿 생성" on contract_templates;
drop policy if exists "계약서 템플릿 수정" on contract_templates;
drop policy if exists "계약서 템플릿 삭제" on contract_templates;
alter table contract_templates disable row level security;

drop policy if exists "누구나 약관 조회" on terms;
drop policy if exists "약관 생성" on terms;
drop policy if exists "약관 수정" on terms;
drop policy if exists "약관 삭제" on terms;
alter table terms disable row level security;
