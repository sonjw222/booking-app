-- ============================================================
-- ⚠️ DEVELOPMENT TEST DATA CLEANUP ONLY — DO NOT RUN ON PRODUCTION ⚠️
--
-- 실제 SELECT 진단(2026-08-03, 사용자 확인)으로 확정된 대상만 정리하는 일회성 스크립트입니다.
-- 이전에 준비했던 cleanup_acl003_test_fixture_proposed.sql은 'ACL-003 테스트 무권한 역할' 0건,
-- account_center_permissions 0건으로 확인되어 대상이 아니었습니다(실행하지 않았고, 앞으로도
-- 이 파일과 무관합니다).
--
-- 확인된 실제 잔여 데이터:
--   - center_roles.name = 'SEC-009 Batch A1 테스트 무권한 역할' (is_owner = false)
--   - 그 역할을 쓰는 manager_centers 1건, status = 'active', account_email = test-manager-b@example.com
--   - account_center_permissions: 이 manager_center_id에 걸린 행 0건(확인됨) — 삭제 대상에서 제외
--
-- 원인(tests/integration/sec009-batch-a1-rls.test.ts): 이 파일의 beforeAll이 MANAGER_B를
-- centerA에 이 역할로 초대하고, afterAll에서 정리를 시도하지만(removeStaff) 과거 어느 실행에서
-- 정리가 완료되지 못한 채 이 행만 남았습니다(이번 배치에서 이 파일의 다른 픽스처인
-- staff_salaries는 get-or-create로 이미 고쳤으나, manager_centers/role 초대 자체는 원래도
-- inviteIfNeeded()로 추적되고 있었습니다 — 이번 잔여물은 그 추적 로직이 도입되기 이전 또는
-- 정리가 중간에 실패했던 과거 실행의 산물로 판단됩니다).
--
-- 실행 순서:
--   1) 아래 STEP 1 미리보기 SELECT 결과를 먼저 직접 확인(예상 정확히 1행)
--   2) 예상과 다르면 절대 진행하지 말고 ROLLBACK
--   3) 사용자의 명시적 실행 승인
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- STEP 1. 삭제 대상 역할/manager_centers 행을 임시 테이블에 고정
-- ------------------------------------------------------------
create temporary table sec009_cleanup_targets on commit drop as
select
    cr.id as role_id,
    cr.center_id,
    mc.id as manager_center_id,
    mc.account_id as staff_account_id,
    mc.status as staff_status
from center_roles cr
join manager_centers mc on mc.role_id = cr.id
where cr.name = 'SEC-009 Batch A1 테스트 무권한 역할'
  and cr.is_owner = false;

-- 미리보기 — 실행 전 반드시 직접 확인하세요. 예상: 정확히 1행.
select * from sec009_cleanup_targets;

-- STEP 1 검증: 정확히 1건이 아니면 즉시 중단(예외 발생 → 트랜잭션 전체 자동 rollback).
do $$
declare
    v_count int;
begin
    select count(*) into v_count from sec009_cleanup_targets;
    if v_count <> 1 then
        raise exception
            'sec009_cleanup_targets 행 수가 예상(1)과 다릅니다: %건. '
            '0건이면 이미 정리된 상태이고, 2건 이상이면 예상치 못한 다른 데이터가 섞여 있는 것이니 '
            '여기서 중단합니다(COMMIT하지 말고 ROLLBACK하세요).', v_count;
    end if;
end $$;

-- ------------------------------------------------------------
-- STEP 2. account_center_permissions 재확인(삭제 대상 아님) — 진단 시점(0건)과
-- 실행 시점 사이에 값이 바뀌었을 가능성에 대비해, 삭제 없이 재검증만 한다.
-- ------------------------------------------------------------
do $$
declare
    v_count int;
begin
    select count(*) into v_count
    from account_center_permissions
    where manager_center_id in (select manager_center_id from sec009_cleanup_targets);
    if v_count <> 0 then
        raise exception
            'account_center_permissions가 0건일 것으로 예상했지만 %건이 발견됐습니다 — '
            '이 스크립트는 그 테이블을 다루지 않으므로 여기서 중단합니다 '
            '(COMMIT하지 말고 ROLLBACK한 뒤 새로 조사하세요).', v_count;
    end if;
end $$;

-- ------------------------------------------------------------
-- STEP 3. 삭제 — manager_centers(자식, FK로 role_id 참조) → center_roles(부모) 순서.
-- manager_centers.role_id → center_roles(id)는 ON DELETE 절이 없어(NO ACTION/RESTRICT),
-- role을 먼저 지우면 FK 위반으로 즉시 실패한다 — 반드시 이 순서를 지킨다.
-- ------------------------------------------------------------
delete from manager_centers
where id in (select manager_center_id from sec009_cleanup_targets);

delete from center_roles
where id in (select role_id from sec009_cleanup_targets);

-- 위 두 DELETE의 실제 삭제 건수를 Supabase SQL Editor 결과 메시지에서 확인하세요
-- (manager_centers 1건, center_roles 1건이어야 정상).

COMMIT;
-- 문제가 발견되면 위 COMMIT 대신 ROLLBACK을 실행하세요.
