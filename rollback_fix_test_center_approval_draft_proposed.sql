-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless fix_test_center_approval_draft_proposed.sql was applied ⚠️
-- P2-15 롤백 — `통합테스트센터-` 접두사 센터를 다시 'pending'으로 되돌린다.
-- 데이터 되돌리기라 실제로 되돌릴 필요가 거의 없지만(테스트 센터 승인 상태는 운영에
-- 영향이 없음), 요청 시 실행할 수 있도록 짝을 맞춘다. 안전장치(행 수 검증, 트랜잭션 내
-- 트리거 on/off)는 원본 스크립트와 동일하게 유지한다.
-- ============================================================


-- ------------------------------------------------------------
-- 0) 사전 확인용 SELECT (읽기 전용 — 이것만 먼저 실행해 대상을 눈으로 확인하세요)
-- ------------------------------------------------------------
-- select id, name, status, created_at
-- from centers
-- where name like '통합테스트센터-%'
--   and status = 'approved'
-- order by created_at;


BEGIN;

do $$
declare
    v_count int;
begin
    select count(*) into v_count
    from centers
    where name like '통합테스트센터-%'
      and status = 'approved';

    if v_count < 1 or v_count > 2 then
        raise exception 'P2-15 롤백 안전장치: 예상 범위(1~2건)를 벗어난 %건이 대상입니다 — 자동 중단합니다.', v_count;
    end if;

    raise notice 'P2-15 롤백: %건의 테스트 센터를 pending으로 되돌립니다.', v_count;
end;
$$;

alter table centers disable trigger trg_guard_center_status;

update centers
set status = 'pending'
where name like '통합테스트센터-%'
  and status = 'approved';

alter table centers enable trigger trg_guard_center_status;

COMMIT;
