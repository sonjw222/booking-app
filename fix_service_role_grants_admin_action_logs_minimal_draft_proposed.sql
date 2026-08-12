-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- admin_action_logs에 service_role GRANT 추가 — 최소 권한 버전
--
-- 배경: Live DB 직접 조회(information_schema.role_table_grants, 2026-08-12) 결과
-- service_role에 admin_action_logs 관련 privilege가 0행 — GRANT 자체가 없음을 확인했다.
-- 이 gap은 앱 런타임과 무관하다 — admin_action_logs 행은 항상 admin_assign_reservation/
-- admin_cancel_reservation(둘 다 security definer RPC) 내부에서만 INSERT되고, 이 두 RPC는
-- 함수 소유자 권한으로 실행돼 service_role GRANT와 무관하게 이미 정상 동작한다(lib/**,
-- app/** 전체에 service_role 사용 없음, grep 확인).
--
-- 유일한 사용처는 테스트/정리 스크립트다:
--   - SELECT: cleanup_shared_test_center_pollution_draft_proposed.sql 주석 —
--             "진단 쿼리로 정확한 참조 건수를 셀 수 없었다(service_role GRANT가 없어
--             PostgREST로 조회 불가)"
--   - DELETE: 같은 파일 — "그 센터의 admin_action_logs를 통째로 먼저 지운다"(테스트
--             오염 정리 목적)
--   - INSERT/UPDATE: service_role 클라이언트가 직접 호출하는 코드를 찾지 못함(로그는
--             항상 위 RPC를 통해서만 생성됨) — 포함하지 않음
--
-- 이 GRANT를 적용하면 얻는 것: (1) 위 cleanup 스크립트가 매번 "정확한 건수를 셀 수 없다"는
-- 제약 없이 진단 가능해짐 (2) admin_action_logs가 P2-13에 이미 기록된 "17개 테이블 RLS Gap"과
-- 같은 부류 문제이므로 그때 함께 처리해도 무방 — 이 파일은 독립 실행도 가능하도록 분리했다.
-- ============================================================

BEGIN;

grant select, delete on admin_action_logs to service_role;

COMMIT;
