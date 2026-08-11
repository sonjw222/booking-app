-- service_role에 payments 테이블 GRANT 추가.
-- 배경: P4 매출 대시보드 통합테스트(dashboard-summary.test.ts)가 알려진 금액의 결제 행을
-- 직접 만들어 manager_dashboard_summary()의 집계 정확성을 검증하려고 admin(service-role)
-- 클라이언트로 payments에 직접 insert를 시도했는데 "permission denied for table payments"가
-- 실제로 재현됐다(fix_service_role_missing_grants_for_e2e_admin_draft_proposed.sql /
-- fix_service_role_missing_grants_products.sql과 같은 부류 — 그때도 payments는 포함되지
-- 않았다). 이 프로젝트의 기존 결제 생성 경로(confirm_test_payment 등)는 전부 SECURITY
-- DEFINER RPC라 이 GRANT 없이도 동작해왔기 때문에 지금까지 드러나지 않았던 gap이다.
grant select, insert, update, delete on payments to service_role;
