-- ============================================================
-- 공유 통합테스트 센터의 daily_book_limit_enabled 잔재 리셋
--
-- 원인: 어떤 daily-book-limit 계열 테스트가 center_settings.daily_book_limit_enabled=true,
-- daily_book_limit=1로 설정한 뒤 afterAll에서 원상복구하지 못하고 죽은 것으로 추정됨(동료
-- 세션 교차 확인, 코드 직접 검증은 아님). 이 값이 라이브에 남아 있으면, 같은 공유 fixture
-- 센터에서 하루에 2개 이상 예약하는 다른 모든 통합/E2E 테스트가 "하루 예약 가능
-- 횟수(1회)를 초과했어요"로 전부 실패한다 — PR #50(SEC-114/115) CI에서 schedule-rule-override,
-- class-allowed-products-enforcement, class-deadline-override-and-private 등 SEC-114/115와
-- 무관한 테스트들이 이 메시지로 실패하는 것을 확인함.
--
-- 대상 center_id: 3937eb89-3803-43e9-9a29-e893f779df1a
--   (getOrCreateOwnedTestCenter(managerA), 동료 세션이 cleanup_shared_test_center_pollution_draft_proposed.sql
--   진단 과정에서 CI로 직접 확인한 값 — 이 파일도 그 값을 그대로 재사용)
--
-- 이 UPDATE는 정확히 이 하나의 센터 행만 대상으로 하며(WHERE center_id로 완전히 좁힘),
-- 다른 센터/설정에는 영향 없음. 여러 번 실행해도 안전(idempotent).
-- ============================================================

-- [0] 실행 전 현재 값 확인
select center_id, daily_book_limit_enabled, daily_book_limit
  from center_settings
 where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';

BEGIN;

update center_settings
   set daily_book_limit_enabled = false
 where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
   and daily_book_limit_enabled = true;

COMMIT;

-- 확인
select center_id, daily_book_limit_enabled, daily_book_limit
  from center_settings
 where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';
