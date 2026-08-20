-- ============================================================
-- `leads.test.ts`(P1-8)의 중단된 실행이 다시 남긴 leftover manager_centers/center_roles
-- (2026-08-19 18:42경 최초 발생 → cleanup_leftover_leads_test_staff_role.sql로 정리했으나,
--  이후 같은 공유 통합테스트센터에서 여러 번 더 CI job timeout/cancel이 반복되며 재발)
--
-- [원인] leads.test.ts의 beforeAll이 공유 통합테스트센터(3937eb89-3803-43e9-9a29-
-- e893f779df1a)에 managerB를 이름이 항상 "P1-8 테스트 무권한 역할"인 get-or-create 역할로
-- 초대한다. afterAll이 removeStaff()/deleteRole()로 정리하는데, 오늘 이 센터를 공유하는
-- Integration job이 여러 번 20분 타임아웃/취소로 중간에 끊기면서(P2-24/P2-27 참고) afterAll이
-- 못 돌아 이 두 행이 또 남았다.
--
-- [영향] managerB 계정("통합테스트계정")이 이 센터의 활성 스태프 목록에 leftover로
-- 남아있어, class-trainer-display.spec.ts의 강사 검색 UI가 "통합테스트계정" 이름을 가진
-- 계정을 2개(managerA 자신 + 이 leftover managerB) 찾아 strict mode violation으로 실패한다
-- (PR #68 workflow_dispatch run 32405557536에서 재현 확인, E2E 6건).
--
-- [영향받는 기존 데이터] manager_centers/center_roles 각각 최대 1행 삭제. 이름/센터/계정으로
-- 유일하게 식별되는 get-or-create 전용 fixture 행이라 하드코딩 UUID 없이도 안전하게
-- 특정된다 — 실사용자/실데이터에는 영향 없음. leads.test.ts를 다시 실행하면 beforeAll이
-- 필요시 새로 만든다.
-- [예상 행 수] DELETE 최대 2건(이미 정리됐다면 0건).
-- [위험도] 낮음.
-- ============================================================

BEGIN;

delete from manager_centers
where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and role_id in (
    select id from center_roles
    where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
      and name = 'P1-8 테스트 무권한 역할'
  );

delete from center_roles
where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and name = 'P1-8 테스트 무권한 역할';

COMMIT;

-- 확인(읽기 전용) — 둘 다 0행이어야 정상
select * from manager_centers where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and role_id in (
    select id from center_roles
    where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a' and name = 'P1-8 테스트 무권한 역할'
  );
select * from center_roles
  where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a' and name = 'P1-8 테스트 무권한 역할';
