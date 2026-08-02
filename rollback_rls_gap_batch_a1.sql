-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless proposed_rls_gap_batch_a1.sql was applied ⚠️
-- Batch A1 rollback — 원래 상태(RLS 활성 + 정책 0건, 완전 차단)로 되돌립니다.
-- proposed_rls_gap_batch_a1.sql 적용 후 검증에 실패했을 때만 실행하세요.
--
-- `disable row level security`를 실행하지 않습니다 — 2026-08-02에 개발 Supabase에서 직접
-- 확인한 원래 상태는 "RLS 비활성"이 아니라 "RLS 활성 + 정책 0건"(완전 차단)이었습니다.
-- disable하면 원래보다 더 위험한 상태(전체 공개)가 되므로, 정책만 제거해 원래의 "완전 차단"
-- 상태로 되돌리는 것이 진짜 안전한 롤백입니다. 이번 Batch에서 생성한 정책만 제거합니다.
-- ============================================================

BEGIN;

drop policy if exists "급여 조회 (본인/타인 권한 분리)" on staff_salaries;
drop policy if exists "급여 등록 (본인/타인 권한 분리)" on staff_salaries;
drop policy if exists "급여 수정 (본인/타인 권한 분리)" on staff_salaries;
drop policy if exists "급여 삭제" on staff_salaries;

drop policy if exists "상담고객 조회" on leads;
drop policy if exists "상담고객 등록" on leads;
drop policy if exists "상담고객 수정" on leads;
drop policy if exists "상담고객 삭제" on leads;

drop policy if exists "발송이력 조회" on messages;
drop policy if exists "발송이력 생성" on messages;
drop policy if exists "발송이력 수정" on messages;
drop policy if exists "발송이력 삭제" on messages;

COMMIT;
