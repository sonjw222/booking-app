-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- P2-15: 기존 통합테스트 센터(TEST_MANAGER_A/B 등)가 status='pending'에 멈춰 있어
-- reserve_class()를 직접 호출하는 통합 테스트(settings-reserve-class-wiring.test.ts)가
-- "아직 승인되지 않은 센터예요"로 항상 막히는 문제.
--
-- 원인: guard_center_status_change() 트리거는 `before update on centers`에만 걸려 있어
-- INSERT는 막지 않는다 — tests/integration/setup.ts의 getOrCreateOwnedTestCenter()를 이미
-- status='approved'로 INSERT하도록 고쳤지만(같은 PR), 그 코드는 "계정에 오너 센터가 없을
-- 때만" 새로 만들고 이미 있으면 그대로 재사용한다. TEST_MANAGER_A 등은 과거 여러 배치에서
-- 이미 status='pending'으로 생성된 센터를 계속 재사용해 왔으므로, 이 기존 행들은 앞으로도
-- 계속 'pending'에 멈춰 있는다.
--
-- 이 스크립트가 하는 일: `통합테스트센터-` 접두사로 시작하는(=이 테스트 헬퍼가 만든 것만)
-- pending 센터만 골라 approved로 바꾼다. 실제 운영 센터는 이 이름 패턴을 쓰지 않으므로
-- 영향받지 않는다. guard_center_status_change 트리거는 플랫폼 운영자만 status 변경을
-- 허용하므로, 이 UPDATE 직전에 트리거를 잠시 끄고 직후 다시 켠다(같은 트랜잭션 안).
--
-- 안전장치: WHERE 절이 `name like '통합테스트센터-%' and status = 'pending'`으로 좁혀져
-- 있어 다른 센터에는 영향이 없다. 몇 건이 바뀌었는지 GET DIAGNOSTICS로 확인해 볼 수 있다.
-- ============================================================

BEGIN;

alter table centers disable trigger trg_guard_center_status;

update centers
set status = 'approved'
where name like '통합테스트센터-%'
  and status = 'pending';

alter table centers enable trigger trg_guard_center_status;

COMMIT;
