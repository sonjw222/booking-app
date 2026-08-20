-- ============================================================
-- P2-25: 공유 통합테스트센터(5aa6e0b6-7e4a-47a3-b705-afc9a0cae4d7,
-- "통합테스트센터-e920be7a")에 남은 leftover center_holidays 1건 정리
--
-- [원인] holiday-history-and-notification.test.ts 계열의 이전 실행이 20분 CI
-- job timeout으로 강제 종료되면서 afterAll 정리가 못 돌아, 2026-08-27 휴무일
-- 등록이 그대로 남았다. tests/integration/auto-book-membership-security.test.ts의
-- AUTO-SEC-K/AUTO-SEC-M이 매번 이 날짜로 수렴하는 수업을 만들면서(둘 다
-- new Date().getDay() 기반 createClassOnDow 기본 인자 사용), auto_book_membership()의
-- "센터 휴무일이면 건너뛴다" 로직에 걸려 booked=0으로 계속 실패했다.
--
-- [영향받는 기존 데이터] center_holidays 1행 삭제. 이 센터는 순수 통합테스트
-- fixture(실제 운영 센터 아님) — 실사용자/실데이터에는 영향 없음.
-- [예상 행 수] DELETE 1건.
-- [위험도] 낮음.
-- ============================================================

BEGIN;

delete from center_holidays
where id = '792d805e-9822-48c1-935a-ec39c29ccc7b'
  and center_id = '5aa6e0b6-7e4a-47a3-b705-afc9a0cae4d7'
  and holiday_date = '2026-08-27';

COMMIT;

-- 확인(읽기 전용)
select * from center_holidays where center_id = '5aa6e0b6-7e4a-47a3-b705-afc9a0cae4d7';
