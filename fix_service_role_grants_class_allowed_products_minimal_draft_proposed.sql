-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- class_allowed_products에 service_role GRANT 추가 — 최소 권한 버전
--
-- 배경: Live DB 직접 조회(information_schema.role_table_grants, 2026-08-12) 결과
-- service_role에 class_allowed_products 관련 privilege가 0행 — GRANT 자체가 없음을
-- 확인했다(기존에 이미 작성돼 있던 fix_service_role_missing_grants_class_allowed_products_
-- draft_proposed.sql과 동일한 진단, 이 파일은 그 대안). 이 gap은 앱 런타임과 무관하다 —
-- lib/**, app/** 전체에 service_role 사용이 전혀 없고(grep 확인), 이 앱은 항상 RLS가 걸린
-- anon/authenticated 클라이언트 또는 security definer RPC(함수 소유자 권한으로 실행, GRANT와
-- 무관)만 쓴다. 유일한 사용처는 tests/integration/setup.ts의 getFixtureAdminClient()
-- (테스트 fixture 준비/정리). CI에서 실제 재현됨: "permission denied for table
-- class_allowed_products"(tests/e2e/admin/membership-schedule-rules.spec.ts:153-156 주석).
--
-- 기존 파일과의 차이: 기존 fix_service_role_missing_grants_class_allowed_products_draft_
-- proposed.sql은 SELECT/INSERT/UPDATE/DELETE 4종 전부를 부여한다. 이 파일은 테스트 코드
-- 전수 검색 결과 실제로 쓰이는 오퍼레이션(.insert()/.delete()/암묵적 select)만 최소로
-- 부여한다 — UPDATE를 직접 호출하는 테스트/헬퍼를 찾지 못했다. 두 파일 중 하나만 실행하면
-- 되며, 어느 쪽을 쓸지는 사용자 결정이 필요하다(이 파일은 기존 파일을 대체하려는 것이지
-- 함께 실행하라는 뜻이 아니다).
--
-- 근거(직접 확인한 코드 위치):
--   - INSERT: tests/e2e/admin/class-allowed-products.spec.ts,
--             tests/integration/schedule-rule-override.test.ts,
--             tests/integration/class-trainers-and-pass-selection-mode.test.ts
--   - DELETE: tests/integration/class-trainers-and-pass-selection-mode.test.ts:68
--             (정리 단계), cleanup 스크립트 패턴
--   - SELECT: fixture 검증/진단 단계에서 암묵적으로 필요(직접 호출은 못 찾았으나 INSERT
--             결과 확인·중복 방지 목적으로 필요할 가능성 높아 안전하게 포함)
--   - UPDATE: 근거를 찾지 못함 — 포함하지 않음(필요해지면 그때 추가)
-- ============================================================

BEGIN;

grant select, insert, delete on class_allowed_products to service_role;

COMMIT;
