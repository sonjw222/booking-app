-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- P2-15: 기존 통합테스트 센터(TEST_MANAGER_A/B)가 status='pending'에 멈춰 있어
-- reserve_class()를 직접 호출하는 통합 테스트(settings-reserve-class-wiring.test.ts)가
-- "아직 승인되지 않은 센터예요"로 항상 막히는 문제.
--
-- 원인: guard_center_status_change() 트리거는 `before update on centers`에만 걸려 있어
-- INSERT는 막지 않는다 — tests/integration/setup.ts의 getOrCreateOwnedTestCenter()를 이미
-- status='approved'로 INSERT하도록 고쳤지만(같은 PR), 그 코드는 "계정에 오너 센터가 없을
-- 때만" 새로 만들고 이미 있으면 그대로 재사용한다. TEST_MANAGER_A/B는 과거 여러 배치에서
-- 이미 status='pending'으로 생성된 센터를 계속 재사용해 왔으므로, 이 기존 행들은 앞으로도
-- 계속 'pending'에 멈춰 있는다.
--
-- 대상 범위: `getOrCreateOwnedTestCenter()`가 만드는 센터 이름은 항상
-- `통합테스트센터-${account_id 앞 8자리}` 형식이다(tests/integration/setup.ts). 이 접두사는
-- 이 테스트 헬퍼만 사용하며 실제 운영 센터는 이 패턴을 쓰지 않는다. 저장소 grep 결과
-- TEST_MANAGER_A/TEST_MANAGER_B 두 계정만 이 헬퍼로 "오너 센터"를 만든다
-- (acl-003-permission-read.test.ts, admin-assignment-security.test.ts,
-- sec009-batch-a1-rls.test.ts, holiday-membership-restore.test.ts,
-- settings-reserve-class-wiring.test.ts에서 managerA/managerB로 호출) — 즉 이 조건에
-- 맞는 행은 최대 2건(계정당 1건, 함수가 기존 오너 센터를 재사용하므로 계정당 중복 생성 안 됨)
-- 이어야 한다. account_id/이메일 자체로 좁히지 않는 이유: 이 파일은 로컬 개발자 세션이
-- 아니라 CI 전용 Secrets(TEST_MANAGER_A_EMAIL 등)에만 존재하는 계정이라 SQL에 실제 값을
-- 하드코딩할 수 없다 — 대신 아래 안전장치(행 수 검증)로 범위를 강제한다.
--
-- 안전장치:
--   1) 트랜잭션 시작 직후 대상 행 수를 세어 1~2건 범위를 벗어나면 즉시 RAISE EXCEPTION으로
--      전체를 중단한다(0건 = 이미 해결됐거나 이름 패턴이 바뀜, 3건 이상 = 예상 밖 데이터라
--      수동 확인 필요 — 둘 다 자동으로 진행하지 않는다).
--   2) 트리거 비활성화(disable)와 재활성화(enable)가 같은 BEGIN/COMMIT 트랜잭션 안에 있다.
--      PostgreSQL의 DDL(ALTER TABLE ... DISABLE/ENABLE TRIGGER 포함)은 전부 트랜잭션에
--      안전하게 포함되므로, 위 1)의 RAISE EXCEPTION이든 다른 어떤 런타임 오류든 트랜잭션이
--      실패하면 disable도 함께 자동 롤백된다 — 트리거가 꺼진 채로 남는 경우는 없다.
--   3) 이 파일을 실행하기 *전에* 아래 "0) 사전 확인용 SELECT"만 따로 실행해 실제로 몇 건이,
--      어떤 센터가 대상인지 먼저 눈으로 확인할 것을 권장한다(이 SELECT는 읽기 전용이라
--      아무 때나 안전하게 실행 가능하고, 메인 트랜잭션의 일부가 아니다).
-- ============================================================


-- ------------------------------------------------------------
-- 0) 사전 확인용 SELECT (읽기 전용 — 이것만 먼저 실행해 대상을 눈으로 확인하세요)
-- ------------------------------------------------------------
-- select id, name, status, created_at
-- from centers
-- where name like '통합테스트센터-%'
--   and status = 'pending'
-- order by created_at;


BEGIN;

do $$
declare
    v_count int;
begin
    select count(*) into v_count
    from centers
    where name like '통합테스트센터-%'
      and status = 'pending';

    if v_count < 1 or v_count > 2 then
        raise exception 'P2-15 안전장치: 예상 범위(1~2건)를 벗어난 %건이 대상입니다 — 자동 중단합니다. 위 0)번 SELECT로 직접 확인 후 이 스크립트의 범위를 다시 검토하세요.', v_count;
    end if;

    raise notice 'P2-15: %건의 테스트 센터를 approved로 전환합니다.', v_count;
end;
$$;

alter table centers disable trigger trg_guard_center_status;

update centers
set status = 'approved'
where name like '통합테스트센터-%'
  and status = 'pending';

alter table centers enable trigger trg_guard_center_status;

COMMIT;
