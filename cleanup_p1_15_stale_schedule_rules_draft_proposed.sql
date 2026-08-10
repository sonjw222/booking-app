-- ============================================================
-- P1-15: 실제 QA 센터("센터1")의 "수강권" 상품에 걸린 membership_schedule_rules 2건 정리
-- (draft, 미실행)
--
-- 배경(read-only 진단으로 확인, 추측 아님 — CI run 31382599793/31413532650,
-- tests/integration/_diag_real_qa_membership_gap.test.ts):
--   - centerId 04d08f3c-1025-4f69-8a34-aaa51fb81f6e("센터1")의 "수강권" 상품
--     (product_id f6010b96-f83a-4f23-8205-9897aa8b6621)에 membership_schedule_rules 2건이
--     걸려 있어, 이 조건과 안 맞는 신규 수업("테스트")에서 회원의 기존/신규 구매 pass가
--     전부 "사용 가능한 수강권 없음"으로 탈락하는 것이 실제 QA 버그의 root cause였다
--     (docs/TODO.md P1-15).
--   - 이 규칙 2건이 가리키는 "수업"이라는 제목의 class가 실제로 존재하는지 확인한 결과,
--     정확히 일치하는 class가 2건 있었다:
--       * class 00494e21-8f51-4242-a85a-5f9e37ff83b2, start_time 2026-08-04T07:00:00+00:00
--         (KST 화요일 16:00), created_at 2026-08-03T15:16:03.0875
--       * class 93a6c842-0dcc-4bfa-af3a-68d80f2df275, start_time 2026-08-05T06:00:00+00:00
--         (KST 수요일 15:00), created_at 2026-08-05T05:41:25.004293
--   - 규칙 2건의 day_of_week/start_time이 각 class의 요일/시간과 정확히 일치하고, 무엇보다
--     규칙의 created_at이 대응하는 class의 created_at과 초 단위로(0.5~0.6초 차이) 거의
--     동시에 생성됐다:
--       * rule 1a5a520e-ac16-4092-9c90-4286c23ad955(화요일 16:00, "수업")
--         created_at 2026-08-03T15:16:03.634919 ↔ class 00494e21... created_at
--         2026-08-03T15:16:03.0875 (같은 초)
--       * rule dbd529d7-e20e-4cb2-b1ec-db4d82a42e8e(수요일 15:00, "수업")
--         created_at 2026-08-05T05:41:25.555622 ↔ class 93a6c842... created_at
--         2026-08-05T05:41:25.004293 (같은 초)
--   - 이 동시 생성 패턴은 이 저장소에 이미 문서화돼 있던, 지금은 고쳐진 버그(수업 등록
--     화면이 class_allowed_products 저장의 부수효과로 membership_schedule_rules를 자동
--     추가하던 것, tests/e2e/admin/class-allowed-products.spec.ts의 beforeAll 주석 참고)와
--     정확히 같은 신호다 — 즉 관리자가 /manager/membership-rules 화면에서 의도적으로 이
--     조건을 설정한 것이 아니라, 그때 그 class를 만드는 부수효과로 자동 생성됐을 가능성이
--     매우 높다.
--   - 두 class 모두 이미 지난 날짜(2026-08-04/05, 진단 시점 2026-08-10 기준 과거)이고, 이
--     센터에는 이 두 class 외에 "수업"이라는 제목의 다른 class가 없다(반복 일정으로
--     이어지고 있지 않음) — 즉 이 규칙이 앞으로도 계속 쓰일 특정 반복수업을 가리키고
--     있지 않다.
--
-- FK 감사: membership_schedule_rules를 참조하는 테이블은 저장소 전체에 없다(순수 leaf
-- 테이블) — 삭제해도 다른 테이블에 영향 없음.
--
-- 안전장치:
--   - id를 정확히 지정(2건, LIKE 없음) — product_id/센터로 범위를 넓히지 않음.
--   - 삭제 전 대상 재계산(락 확보 후) + 정확히 2건인지 확인(그 이상/이하면 중단).
--   - 삭제 직후 실제 삭제된 행 수가 대상 건수와 정확히 같은지 검증.
--   - 하나라도 어긋나면 RAISE EXCEPTION으로 전체 트랜잭션을 롤백한다.
--
-- ⚠ 실행 순서: A(선택, 언제 실행해도 안전) 확인 → B 전체를 한 번에 복사해 Supabase
-- SQL Editor에 붙여넣고 **한 번만 Run** → C로 결과 확인.
-- ============================================================


-- ============================================================
-- A. READ-ONLY PREVIEW — DB를 전혀 수정하지 않음. B 실행 전 몇 번이든 따로 실행해도 안전.
-- ============================================================

-- A-1. 삭제 대상 2건 상세 확인
select id, product_id, day_of_week, start_time, class_title, created_at
  from membership_schedule_rules
 where id in ('1a5a520e-ac16-4092-9c90-4286c23ad955', 'dbd529d7-e20e-4cb2-b1ec-db4d82a42e8e');

-- A-2. 이 상품("수강권")에 다른 규칙이 더 있는지(있다면 이 2건 삭제 후에도 남아 있어야
-- 정상 — 이 스크립트는 이 2건만 지운다)
select id, day_of_week, start_time, class_title, created_at
  from membership_schedule_rules
 where product_id = 'f6010b96-f83a-4f23-8205-9897aa8b6621';


-- ============================================================
-- B. ATOMIC CLEANUP — 아래 BEGIN부터 COMMIT까지 전체를 그대로 복사해서
--    Supabase SQL Editor에 붙여넣고 **한 번의 Run**으로 실행하세요.
-- ============================================================

BEGIN;

lock table membership_schedule_rules in share row exclusive mode;

do $$
declare
  v_target_ids   uuid[] := array['1a5a520e-ac16-4092-9c90-4286c23ad955'::uuid, 'dbd529d7-e20e-4cb2-b1ec-db4d82a42e8e'::uuid];
  v_found_count  int;
  v_deleted      int;
begin
  select count(*) into v_found_count
    from membership_schedule_rules
   where id = any(v_target_ids);

  raise notice '[B] 삭제 대상 확인된 건수: %건 (기대값 2건)', v_found_count;

  if v_found_count <> 2 then
    raise exception '[B] 대상 건수가 2건이 아닙니다(%건) — 이미 정리됐거나 조건이 어긋납니다. 중단합니다.', v_found_count;
  end if;

  delete from membership_schedule_rules where id = any(v_target_ids);
  get diagnostics v_deleted = row_count;
  raise notice '[B] 실제 삭제된 행 수: %건', v_deleted;

  if v_deleted <> 2 then
    raise exception '[B] 삭제된 행 수(%건)가 2건이 아닙니다 — 롤백합니다.', v_deleted;
  end if;

  raise notice '[B] 검증 통과 — COMMIT 진행';
end $$;

COMMIT;


-- ============================================================
-- C. POST-COMMIT VERIFICATION — B가 COMMIT된 뒤 별도로 실행해서 확인
-- ============================================================

-- C-1. 삭제 대상 2건이 더 이상 없어야 함(0건이 정상)
select count(*) as remaining_target_rules
  from membership_schedule_rules
 where id in ('1a5a520e-ac16-4092-9c90-4286c23ad955', 'dbd529d7-e20e-4cb2-b1ec-db4d82a42e8e');

-- C-2. "수강권" 상품의 남은 규칙(정상: 0건 — 다른 규칙을 추가한 적 없다면)
select id, day_of_week, start_time, class_title
  from membership_schedule_rules
 where product_id = 'f6010b96-f83a-4f23-8205-9897aa8b6621';
