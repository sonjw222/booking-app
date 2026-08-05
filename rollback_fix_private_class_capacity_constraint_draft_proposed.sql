-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless fix_private_class_capacity_constraint_draft_proposed.sql was applied ⚠️
-- CLASS-001(D-2) 롤백 — 프라이빗 수업 정원=1 CHECK 제약을 제거한다.
-- ============================================================

BEGIN;

alter table classes
    drop constraint if exists classes_private_capacity_check;

COMMIT;
