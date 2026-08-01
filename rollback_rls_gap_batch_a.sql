-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless proposed_rls_gap_batch_a.sql was applied ⚠️
-- Batch A rollback — 원래(RLS 없음) 상태로 되돌립니다.
-- proposed_rls_gap_batch_a.sql 적용 후 검증에 실패했을 때만 실행하세요.
-- ============================================================

drop policy if exists "급여 조회 (본인/타인 권한 분리)" on staff_salaries;
drop policy if exists "급여 등록 (본인/타인 권한 분리)" on staff_salaries;
drop policy if exists "급여 수정 (본인/타인 권한 분리)" on staff_salaries;
drop policy if exists "급여 삭제" on staff_salaries;
alter table staff_salaries disable row level security;

drop policy if exists "본인 또는 권한 보유 스태프 계약서 조회" on contracts;
drop policy if exists "권한 보유 스태프 계약서 생성" on contracts;
alter table contracts disable row level security;

drop policy if exists "상담고객 조회" on leads;
drop policy if exists "상담고객 등록" on leads;
drop policy if exists "상담고객 수정" on leads;
drop policy if exists "상담고객 삭제" on leads;
alter table leads disable row level security;

drop policy if exists "발송이력 조회" on messages;
drop policy if exists "발송이력 생성" on messages;
drop policy if exists "발송이력 수정" on messages;
drop policy if exists "발송이력 삭제" on messages;
alter table messages disable row level security;

drop policy if exists "센터 스태프 알림발송기록 조회" on notification_logs;
drop policy if exists "권한 보유 스태프 알림발송기록 조회" on notification_logs;
alter table notification_logs disable row level security;
