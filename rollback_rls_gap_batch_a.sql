-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless proposed_rls_gap_batch_a.sql was applied ⚠️
-- Batch A rollback — 원래 상태로 되돌립니다.
-- proposed_rls_gap_batch_a.sql 적용 후 검증에 실패했을 때만 실행하세요.
--
-- [2026-08-02 정정] SEC-007 문서는 이 5개 테이블을 "RLS가 없거나 정책 0건"으로 분류했지만,
-- SEC-009 작업 중 실제 라이브 개발 Supabase에서 재확인한 결과 5개 테이블 전부 RLS는 이미
-- "활성화"되어 있고 정책만 0건인 상태였다(둘은 Postgres에서 서로 다른 별개 상태 —
-- "정책 0건"이 "RLS 비활성화"를 의미하지 않는다). 즉 원래 상태는 "RLS 활성 + 정책 0건"
-- (완전 차단, 오너 포함 아무도 접근 불가)이지 "RLS 비활성"(전체 공개)이 아니다.
-- 따라서 이 롤백은 `disable row level security`를 실행하지 않는다 — 그렇게 하면 원래보다
-- 더 위험한 상태(전체 공개)로 만들어버리게 된다. 정책만 제거해 원래의 "완전 차단" 상태로
-- 되돌리는 것이 진짜 안전한 롤백이다.
-- ============================================================

drop policy if exists "급여 조회 (본인/타인 권한 분리)" on staff_salaries;
drop policy if exists "급여 등록 (본인/타인 권한 분리)" on staff_salaries;
drop policy if exists "급여 수정 (본인/타인 권한 분리)" on staff_salaries;
drop policy if exists "급여 삭제" on staff_salaries;
-- alter table ... disable row level security 실행하지 않음 (위 정정 사유 참고)

drop policy if exists "본인 또는 권한 보유 스태프 계약서 조회" on contracts;
drop policy if exists "권한 보유 스태프 계약서 생성" on contracts;

drop policy if exists "상담고객 조회" on leads;
drop policy if exists "상담고객 등록" on leads;
drop policy if exists "상담고객 수정" on leads;
drop policy if exists "상담고객 삭제" on leads;

drop policy if exists "발송이력 조회" on messages;
drop policy if exists "발송이력 생성" on messages;
drop policy if exists "발송이력 수정" on messages;
drop policy if exists "발송이력 삭제" on messages;

drop policy if exists "센터 스태프 알림발송기록 조회" on notification_logs;
drop policy if exists "권한 보유 스태프 알림발송기록 조회" on notification_logs;
