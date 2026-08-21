-- ============================================================
-- `leads.test.ts`(P1-8)의 중단된 실행이 남긴 leftover manager_centers/center_roles
--
-- [원인] leads.test.ts의 beforeAll이 공유 통합테스트센터(3937eb89-3803-43e9-9a29-
-- e893f779df1a, "통합테스트센터-da48c9aa")에 managerB를 "P1-8 테스트 무권한 역할"로
-- 초대하고, afterAll이 정상적으로 removeStaff()/deleteRole()로 정리한다. 하지만 2026-08-19
-- 18:42경 이 테스트를 포함한 실행이 CI job 20분 타임아웃으로 강제 종료되면서 afterAll이
-- 못 돌아 이 두 행이 그대로 남았다.
--
-- [영향] managerB 계정이 "통합테스트계정"이라는 이름으로 이 센터의 활성 스태프 목록에
-- 남아있게 되면서, class-trainer-display.spec.ts의 강사 검색 UI가 "통합테스트계정"이라는
-- 같은 이름을 가진 계정을 2개(managerA 자신 + 이 leftover managerB) 찾아 strict mode
-- violation으로 실패하는 원인이 됐다(E2E: "AUTO-SEC-D/F/A/예약확인상세" 3건 실패,
-- run 32345066347/32290229997에서 재현 확인).
--
-- [영향받는 기존 데이터] manager_centers 1행, center_roles 1행 삭제. 둘 다 순수
-- 통합테스트 fixture 전용 데이터 — 실사용자/실데이터에는 영향 없음. leads.test.ts를
-- 다시 실행하면 beforeAll이 필요시 새로 만든다(get-or-create 패턴).
-- [예상 행 수] DELETE 2건.
-- [위험도] 낮음.
-- ============================================================

BEGIN;

delete from manager_centers
where id = 'f92eb4e3-f0dd-447e-984f-7bf06a5e155d'
  and center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and account_id = '47057f26-c280-4b82-8feb-cd893440e2ee';

delete from center_roles
where id = 'f352b272-8356-45be-8616-850a97290355'
  and center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and name = 'P1-8 테스트 무권한 역할';

COMMIT;

-- 확인(읽기 전용)
select * from manager_centers where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';
select * from center_roles where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';
