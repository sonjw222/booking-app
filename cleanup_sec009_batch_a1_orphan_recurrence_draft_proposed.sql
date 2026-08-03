-- ============================================================
-- ⚠️ DEVELOPMENT TEST DATA CLEANUP ONLY — DO NOT RUN ON PRODUCTION ⚠️
--
-- 이 파일은 cleanup_sec009_test_fixture_proposed.sql(2026-08-03, 이미 실행 완료)이 지웠던
-- 것과 완전히 동일한 모양의 잔여 데이터가 "다시" 발견되어(재발) 만든 별도 파일입니다.
-- 같은 파일명을 재사용하지 않고 새 파일로 분리했습니다 — 기존 파일은 그때 그 실행의
-- 기록으로 그대로 남겨둡니다.
--
-- 재발 원인: tests/integration/classes-row-limit-regression.test.ts 검증을 위해 CI를
-- 재실행하던 중, 아직 실행 중이던 이전 워크플로 실행이 있는 상태에서 새 커밋을 push해
-- GitHub Actions의 concurrency(cancel-in-progress: true)가 그 실행을 중간에 취소시켰습니다.
-- 그 시점에 tests/integration/sec009-batch-a1-rls.test.ts의 beforeAll이 이미
-- MANAGER_B를 centerA에 'SEC-009 Batch A1 테스트 무권한 역할'로 초대해둔 뒤였고,
-- afterAll(정리 코드)이 실행되지 못한 채 워크플로가 죽었습니다. 이 파일의 get-or-create
-- 방식은 "이번 실행이 새로 만든 것만" 정리 대상으로 추적하므로, 다음 실행부터는 이 남은
-- 행을 "이미 있던 것"으로 보고 재사용만 할 뿐 다시는 정리 대상에 넣지 않아 스스로
-- 복구되지 않았습니다(이번에 이 테스트 파일 자체를 beforeAll+afterAll 양쪽에서 정리하도록
-- 고쳐 재발을 막습니다 — 별도 커밋 참고).
--
-- 실제 읽기 전용 SELECT 진단(2026-08-03, 사용자 확인)으로 확정된 대상:
--   - center_roles.name = 'SEC-009 Batch A1 테스트 무권한 역할' (is_owner = false)
--   - 그 역할을 쓰는 manager_centers 1건, status = 'active', account_email = test-manager-b@example.com
--   - account_center_permissions: 이 manager_center_id에 걸린 행이 실제 존재할 때만 삭제(FK는
--     on delete cascade라 manager_centers 삭제만으로도 자동 정리되지만, 이 스크립트는 그것과
--     무관하게 명시적으로 먼저 지우고 그 행 수를 눈으로 확인할 수 있게 한다)
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
create temporary table sec009_recur_cleanup_targets on commit drop as
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
select * from sec009_recur_cleanup_targets;

-- STEP 1 검증: 정확히 1건이 아니면 즉시 중단(예외 발생 → 트랜잭션 전체 자동 rollback).
do $$
declare
    v_count int;
begin
    select count(*) into v_count from sec009_recur_cleanup_targets;
    if v_count <> 1 then
        raise exception
            'sec009_recur_cleanup_targets 행 수가 예상(1)과 다릅니다: %건. '
            '0건이면 이미 정리된 상태이고, 2건 이상이면 예상치 못한 다른 데이터가 섞여 있는 것이니 '
            '여기서 중단합니다(COMMIT하지 말고 ROLLBACK하세요).', v_count;
    end if;
end $$;

-- ------------------------------------------------------------
-- STEP 2. account_center_permissions — 실제 존재할 때만 삭제. 여기서 명시적으로
-- 지우고 삭제된 행 수를 직접 확인하세요(0건이어도 정상 — 그 경우 아래 DELETE는 아무 행도
-- 지우지 않고 조용히 끝난다. manager_centers의 FK가 on delete cascade라 STEP 3에서
-- manager_centers를 지우면 어차피 함께 정리되지만, 이 스크립트는 그것과 무관하게
-- 명시적으로 먼저 지워 행 수를 눈으로 볼 수 있게 한다).
-- ------------------------------------------------------------
delete from account_center_permissions
where manager_center_id in (select manager_center_id from sec009_recur_cleanup_targets);

-- ------------------------------------------------------------
-- STEP 3. 삭제 — manager_centers(자식, FK로 role_id 참조) → center_roles(부모) 순서.
-- manager_centers.role_id → center_roles(id)는 ON DELETE 절이 없어(NO ACTION/RESTRICT),
-- role을 먼저 지우면 FK 위반으로 즉시 실패한다 — 반드시 이 순서를 지킨다.
-- ------------------------------------------------------------
delete from manager_centers
where id in (select manager_center_id from sec009_recur_cleanup_targets);

delete from center_roles
where id in (select role_id from sec009_recur_cleanup_targets);

-- 위 DELETE들의 실제 삭제 건수를 Supabase SQL Editor 결과 메시지에서 확인하세요
-- (manager_centers 1건, center_roles 1건이어야 정상. account_center_permissions는 0건 또는 그 이상).

COMMIT;
-- 문제가 발견되면 위 COMMIT 대신 ROLLBACK을 실행하세요.
