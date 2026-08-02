-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless fix_test_center_approval_draft_proposed.sql was applied ⚠️
-- P2-15 롤백 — `통합테스트센터-` 접두사 센터를 다시 'pending'으로 되돌린다.
-- 데이터 되돌리기라 실제로 되돌릴 필요가 거의 없지만(테스트 센터 승인 상태는 운영에
-- 영향이 없음), 요청 시 실행할 수 있도록 짝을 맞춘다.
-- ============================================================

BEGIN;

alter table centers disable trigger trg_guard_center_status;

update centers
set status = 'pending'
where name like '통합테스트센터-%'
  and status = 'approved';

alter table centers enable trigger trg_guard_center_status;

COMMIT;
